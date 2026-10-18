import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { loadPullRequestContext } from '../../src/handlers/pull-request/context.ts';
import { runValidations } from '../../src/handlers/pull-request/validation.ts';
import { aggregateReport } from '../../src/handlers/pull-request/report.ts';

// What the worker is given per invocation, as wrangler.toml sets it: the
// reserve is what the three closing check-run writes, the pull request comment
// and the label writes are kept inside.
const ENV = { SUBREQUEST_BUDGET_LIMIT: '45', SUBREQUEST_RESERVE_HEADROOM: '15' };
// The run has already spent one attempt minting its installation token.
const TOKEN_MINT_ATTEMPTS = 1;
const APP_ID = 12345;

// A commit the formality audit has nothing to say about, so the only thing
// that can move the formality check-run is the targeting rule under test.
const COMMIT_MESSAGE = [
  'dropbear: tidy up the default config',
  '',
  'Make the shipped configuration readable before the port option is added.',
  '',
  'Signed-off-by: Jane Doe <jane@example.com>'
].join('\n');

const COMMIT_NODE = {
  commit: {
    oid: 'a'.repeat(40),
    url: 'https://github.com/openwrt/openwrt/commit/' + 'a'.repeat(40),
    message: COMMIT_MESSAGE,
    changedFilesIfAvailable: 1,
    author: { name: 'Jane Doe', email: 'jane@example.com', user: { login: 'janedoe' } },
    committer: { name: 'Jane Doe', email: 'jane@example.com', user: { login: 'janedoe' } },
    parents: { totalCount: 1 },
    signature: null
  }
};

// One comment carrying an override, by a user whose association alone does not
// settle anything: OWNER, MEMBER and COLLABORATOR are accepted outright and
// never reach the permission query this file is about.
const overrideComment = (body) => ({
  databaseId: 7,
  body,
  authorAssociation: 'CONTRIBUTOR',
  viewerDidAuthor: false,
  author: { login: 'privatemaintainer', __typename: 'User' }
});

const setupResponse = ({ cfg = { text: '{}' }, labeler = null, comments = [], errors = null } = {}) => {
  const body = {
    data: {
      repository: {
        labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        cfg,
        labeler,
        pullRequest: {
          commits: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [COMMIT_NODE] },
          comments: { totalCount: comments.length, pageInfo: { hasNextPage: false }, nodes: comments }
        }
      }
    }
  };
  if (errors) body.errors = errors;
  return new Response(JSON.stringify(body), { status: 200 });
};

// Head branch `main` is a protected one, so the targeting rule applies and the
// `[allow branch]` override is what decides the check.
const prPayload = (prBody = '') => ({
  action: 'opened',
  pull_request: {
    number: 123,
    title: 'dropbear: tidy up the default config',
    body: prBody,
    state: 'open',
    commits: 1,
    url: 'https://api.github.com/repos/openwrt/openwrt/pulls/123',
    user: { login: 'contributor', type: 'User' },
    author_association: 'CONTRIBUTOR',
    labels: [],
    base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'openwrt/openwrt' } },
    head: { ref: 'main', sha: 'c'.repeat(40), repo: { full_name: 'contributor/openwrt' } }
  }
});

describe('loadPullRequestContext', { concurrency: 1 }, () => {
  let originalFetch;
  let originalWarn;
  let warnings;
  let fetchUrls;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWarn = console.warn;
    warnings = [];
    fetchUrls = [];
    console.warn = (msg) => { warnings.push(String(msg)); };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });

  // Every real HTTP attempt, retries included - which is what Cloudflare
  // counts against the 50-subrequest cap, not the number of operations the
  // code planned.
  const mockFetch = (handler) => {
    globalThis.fetch = async (url, options) => {
      fetchUrls.push(String(url));
      return handler(String(url), options);
    };
  };

  const permissionsOnly = (setupOptions, permissionResponse) => mockFetch((url) => {
    if (url.includes('/graphql')) return setupResponse(setupOptions);
    if (url.includes('/collaborators/')) return permissionResponse();
    throw new Error(`unexpected request: ${url}`);
  });

  const loadContext = async (payload = prPayload()) => {
    const result = await loadPullRequestContext(
      payload, 'pull_request', ENV, 'token', 'openwrt/openwrt', APP_ID, TOKEN_MINT_ATTEMPTS
    );
    assert.strictEqual(result.kind, 'context', 'the payload is one the handler accepts');
    return result.context;
  };

  const permissionAttempts = () => fetchUrls.filter(u => u.includes('/collaborators/')).length;

  describe('an [allow branch] override whose author has to be resolved', () => {
    test('honours it when GitHub confirms write access', async () => {
      permissionsOnly(
        { comments: [overrideComment('Looks intentional, [allow branch]')] },
        () => new Response(JSON.stringify({ permission: 'write', user: { permissions: { push: true } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      const ctx = await loadContext();

      assert.strictEqual(ctx.bypassBranchCheck, true);
      assert.strictEqual(ctx.branchCheckError, null);
      assert.strictEqual(ctx.branchCheckWarning, null);
      assert.match(ctx.branchCheckOutputText, /allowed via override command/);
      assert.strictEqual(fetchUrls.length, 2, 'one setup query and one permission lookup');
      assert.strictEqual(permissionAttempts(), 1);
      assert.strictEqual(ctx.client.budget.used, TOKEN_MINT_ATTEMPTS + 2);
    });

    test('withholds it, and fails the rule, when GitHub says the author is no collaborator', async () => {
      permissionsOnly(
        { comments: [overrideComment('Can someone [allow branch] this?')] },
        () => new Response('{"message":"Not Found"}', { status: 404, headers: { 'Content-Type': 'application/json' } })
      );

      const ctx = await loadContext();

      assert.strictEqual(ctx.bypassBranchCheck, false);
      assert.match(ctx.branchCheckError, /PR Targeting Violation/);
      assert.strictEqual(ctx.branchCheckWarning, null, 'GitHub answered, so the rule can carry a verdict');
      assert.strictEqual(fetchUrls.length, 2, 'a 404 is an answer and is not retried');
      assert.strictEqual(ctx.client.budget.used, TOKEN_MINT_ATTEMPTS + 2);
    });

    // The hole: a real maintainer's override, a permission query GitHub would
    // not answer, and a pull request failed on the strength of it.
    test('leaves the rule unchecked when the permission lookup itself fails', async () => {
      const originalError = console.error;
      console.error = () => {};
      try {
        permissionsOnly(
          { comments: [overrideComment('Fine by me, [allow branch]')] },
          () => new Response('upstream hiccup', { status: 503 })
        );

        const ctx = await loadContext();

        assert.strictEqual(ctx.bypassBranchCheck, false, 'write access is never assumed');
        assert.strictEqual(ctx.branchCheckError, null, 'and the rule must not be reported as violated either');
        assert.match(ctx.branchCheckWarning, /write access could not be verified/);
        assert.match(ctx.branchCheckWarning, /left unchecked rather than reported as a failure/);
        assert.match(ctx.branchCheckOutputText, /Could not check whether the pull request/);

        // One logical lookup, three real attempts: the retries are
        // subrequests too, and the comment thread is not re-read, because the
        // thread was read in full and a second pass would answer the same.
        assert.strictEqual(permissionAttempts(), 3);
        assert.strictEqual(fetchUrls.length, 4, 'one setup query plus the three permission attempts');
        assert.strictEqual(ctx.client.budget.used, TOKEN_MINT_ATTEMPTS + 4);
        // Well inside the reserve: the closing writes still fit.
        assert.ok(ctx.client.hasHeadroom());
      } finally {
        console.error = originalError;
      }
    });

    test('leaves the rule unchecked when the override is in the description and its author cannot be resolved', async () => {
      const originalError = console.error;
      console.error = () => {};
      try {
        permissionsOnly({}, () => new Response('upstream hiccup', { status: 503 }));

        const ctx = await loadContext(prPayload('Intentional PR from main.\n\n[allow branch]'));

        assert.strictEqual(ctx.bypassBranchCheck, false);
        assert.strictEqual(ctx.branchCheckError, null);
        assert.match(ctx.branchCheckWarning, /write access could not be verified/);
        assert.strictEqual(permissionAttempts(), 3, 'the description asks the same question a comment does');
      } finally {
        console.error = originalError;
      }
    });
  });

  describe('a repository config the setup query could not read', () => {
    test('says so instead of passing the defaults off as the repository rules', async () => {
      mockFetch(() => setupResponse({
        cfg: null,
        errors: [{ message: 'Something went wrong while executing your query.', path: ['repository', 'cfg'] }]
      }));

      const ctx = await loadContext();

      assert.strictEqual(ctx.configUnread, true);
      assert.strictEqual(ctx.configError, null, 'parsing a null text raises nothing, which is why the flag is needed');
      assert.strictEqual(ctx.config.check_branch, true, 'the default stood in for the unread setting');
      // A repository may have set check_branch false, or to a warning. Failing
      // the rule on the default that filled in for it is a verdict its own
      // rules do not support.
      assert.strictEqual(ctx.branchCheckError, null);
      assert.match(ctx.branchCheckWarning, /formalities\.json` could not be read/);
      assert.match(ctx.branchCheckWarning, /left unchecked rather than reported as a failure/);
      assert.strictEqual(fetchUrls.length, 1, 'no comment or permission lookup is needed to know this');
      assert.strictEqual(ctx.client.budget.used, TOKEN_MINT_ATTEMPTS + 1);
      assert.ok(warnings.some(w => w.includes('.github/formalities.json')));
    });

    test('reads a repository that simply ships no config as exactly that', async () => {
      mockFetch(() => setupResponse({ cfg: null }));

      const ctx = await loadContext();

      assert.strictEqual(ctx.configUnread, false, 'a null text with no error beside it is an absent file');
      assert.strictEqual(ctx.config.check_branch, true);
      assert.match(ctx.branchCheckError, /PR Targeting Violation/, 'the defaults are the right rules here');
      assert.strictEqual(ctx.branchCheckWarning, null);
    });

    test('reports labeler rules lost in transit as unread, not as a repository without them', async () => {
      mockFetch(() => setupResponse({
        labeler: null,
        errors: [{ message: 'Something went wrong while executing your query.', path: ['repository', 'labeler'] }]
      }));

      const ctx = await loadContext();

      assert.strictEqual(ctx.labelerUnread, true);
      assert.strictEqual(ctx.labelerText, null);
      assert.strictEqual(ctx.configUnread, false, 'the error named the labeler alone');
      assert.ok(warnings.some(w => w.includes('.github/labeler.yml')));
    });
  });

  // What the pull request ends up being told. The branch rule's verdict is
  // carried by the formality check-run, and the other two must not move with
  // it: an unreadable override says nothing about Makefiles or patches.
  describe('the three check-run conclusions a run of this kind reports', () => {
    const patchesResult = {
      usePrWidePatch: false,
      prPatch: null,
      patchUnavailable: false,
      upstreamComparisonSkips: 0,
      upstreamFetchFailures: 0,
      commitDetailsIncomplete: false,
      packageStateKnown: true,
      packageState: { isNewPackage: false, isDroppedPackage: false },
      commitDetails: [{
        sha: 'a'.repeat(40),
        html_url: 'https://github.com/openwrt/openwrt/commit/' + 'a'.repeat(40),
        fullCommit: {
          sha: 'a'.repeat(40),
          author: { login: 'janedoe' },
          committer: { login: 'janedoe' },
          parents: [{ sha: 'b'.repeat(40) }],
          commit: {
            message: COMMIT_MESSAGE,
            author: { name: 'Jane Doe', email: 'jane@example.com' },
            committer: { name: 'Jane Doe', email: 'jane@example.com' },
            verification: { verified: true, key_id: 'GPGKEYID' }
          }
        },
        commitPatch: [
          'diff --git a/docs/dropbear.md b/docs/dropbear.md',
          '--- a/docs/dropbear.md',
          '+++ b/docs/dropbear.md',
          '@@ -1,2 +1,3 @@',
          ' dropbear',
          '+a line',
          ''
        ].join('\n'),
        isVerbatim: false
      }]
    };

    // The deep audits read files; this run is about the branch rule, so they
    // are handed a loader that fetches nothing.
    const silentLoader = {
      fetchFileContentCached: async () => null,
      isFileMissing: () => false,
      getRefSource: () => undefined,
      hasRefSource: () => false,
      setRefSource: () => {},
      getBudgetSkipCount: () => 0,
      getFetchFailureCount: () => 0,
      getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
    };

    const conclusionsFor = async (ctx) => {
      const outcome = await runValidations({ ...ctx, fileBatchLoader: silentLoader }, patchesResult);
      const report = aggregateReport({ ...ctx, fileBatchLoader: silentLoader }, patchesResult, outcome);
      return report;
    };

    test('an unverifiable override leaves formality neutral and the other two untouched', async () => {
      const originalError = console.error;
      console.error = () => {};
      try {
        permissionsOnly(
          { comments: [overrideComment('Fine by me, [allow branch]')] },
          () => new Response('upstream hiccup', { status: 503 })
        );

        const report = await conclusionsFor(await loadContext());

        assert.strictEqual(report.formalityConclusion, 'neutral', 'unchecked, not failed and not passed');
        assert.strictEqual(report.makefileConclusion, 'success');
        assert.strictEqual(report.patchesConclusion, 'success');
        assert.strictEqual(report.allPassed, true);
        assert.strictEqual(report.isValidationIncomplete, true);
        assert.ok(
          report.allPrWarnings.some(w => w.includes('write access could not be verified')),
          'and the pull request comment says why the rule was not settled'
        );
      } finally {
        console.error = originalError;
      }
    });

    test('an override GitHub refuses leaves formality failed', async () => {
      permissionsOnly(
        { comments: [overrideComment('Can someone [allow branch] this?')] },
        () => new Response('{"message":"Not Found"}', { status: 404, headers: { 'Content-Type': 'application/json' } })
      );

      const report = await conclusionsFor(await loadContext());

      assert.strictEqual(report.formalityConclusion, 'failure');
      assert.strictEqual(report.makefileConclusion, 'success');
      assert.strictEqual(report.patchesConclusion, 'success');
    });
  });
});
