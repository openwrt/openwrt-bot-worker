import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildCommentBody, syncPrComment } from '../../src/handlers/pull-request/comment-report.ts';
import { GitHubWriteQueue } from '../../src/core/github-write-queue.ts';
import { enqueueCheckRuns } from '../../src/handlers/pull-request/check-run-report.ts';
import { createGitHubClient } from '../../src/core/github-client.ts';

describe('comment-report', () => {
  describe('buildCommentBody', () => {
    test('renders failed title and error blocks when allPassed is false', () => {
      const body = buildCommentBody({
        allPassed: false,
        allFormalityErrors: ['Commit subject is too long.'],
        allMakefileErrors: ['Missing PKG_RELEASE bump.'],
        allPatchesErrors: [],
        allPrWarnings: ['Please consider more descriptive title.'],
        showForcePushTip: true,
        deployHash: 'abcdef123456',
        deployDate: '2026-10-15 12:00:00'
      });

      assert.match(body, /## Formality Check: Failed/);
      assert.match(body, /### 🛑 CRITICAL ERRORS/);
      assert.match(body, /> Commit subject is too long\./);
      assert.match(body, /> Missing PKG_RELEASE bump\./);
      assert.match(body, /### ⚠️ STYLISTIC WARNINGS & SUGGESTIONS/);
      assert.match(body, /> Please consider more descriptive title\./);
      assert.match(body, /> \[!TIP\]/);
      assert.match(body, /git commit --amend/);
      assert.match(body, /Running version \[`abcdef1`\]/);
      assert.match(body, /deployed on 2026-10-15 12:00:00/);
    });

    test('renders suggestions title when allPassed is true but warnings exist', () => {
      const body = buildCommentBody({
        allPassed: true,
        allFormalityErrors: [],
        allMakefileErrors: [],
        allPatchesErrors: [],
        allPrWarnings: ['Minor spelling suggestion.'],
        showForcePushTip: false
      });

      assert.match(body, /## Formality Check: Suggestions Available/);
      assert.doesNotMatch(body, /### 🛑 CRITICAL ERRORS/);
      assert.match(body, /### ⚠️ STYLISTIC WARNINGS & SUGGESTIONS/);
      assert.doesNotMatch(body, /> \[!TIP\]/);
    });
  });

  describe('syncPrComment', () => {
    test('skips enqueueing when enable_comments is false', async () => {
      const queue = new GitHubWriteQueue(1);
      const ctx = {
        config: { enable_comments: false },
        repoFullname: 'openwrt/openwrt',
        prNumber: 100,
        client: {},
        getCommentsScanWithRetry: async () => ({ existingCommentId: null })
      };
      const report = {
        allPassed: false,
        allFormalityErrors: ['Error'],
        allMakefileErrors: [],
        allPatchesErrors: [],
        allPrWarnings: []
      };

      await syncPrComment(ctx, report, queue, {});
      assert.strictEqual(queue.statusWrites.length, 0);
    });

    test('enqueues PR comment creation when new errors exist and no comment exists yet', async () => {
      const queue = new GitHubWriteQueue(1);
      let apiCalled = false;
      const ctx = {
        config: { enable_comments: true, show_force_push_tip: false },
        repoFullname: 'openwrt/openwrt',
        prNumber: 100,
        client: {
          // The live PR re-read goes through the same refusable call the
          // write now uses, so the mock answers both and asserts on the write.
          optionalApiCall: async (url, method, body) => {
            if (url.includes('/pulls/')) return { code: 200, data: { state: 'open' } };
            apiCalled = true;
            assert.match(url, /repos\/openwrt\/openwrt\/issues\/100\/comments/);
            assert.strictEqual(method, 'POST');
            return { code: 201 };
          }
        },
        getCommentsScanWithRetry: async () => ({ existingCommentId: null })
      };
      const report = {
        allPassed: false,
        allFormalityErrors: ['Bad commit message'],
        allMakefileErrors: [],
        allPatchesErrors: [],
        allPrWarnings: []
      };

      await syncPrComment(ctx, report, queue, {});
      assert.strictEqual(apiCalled, false); // Not executed until queue.execute()

      await queue.execute();
      assert.strictEqual(apiCalled, true);
    });

    test('enqueues PR comment removal when all checks pass and previous comment exists', async () => {
      const queue = new GitHubWriteQueue(1);
      let apiCalled = false;
      const ctx = {
        config: { enable_comments: true },
        repoFullname: 'openwrt/openwrt',
        prNumber: 100,
        client: {
          optionalApiCall: async (url, method) => {
            if (url.includes('/pulls/')) return { code: 200, data: { state: 'open' } };
            apiCalled = true;
            assert.match(url, /repos\/openwrt\/openwrt\/issues\/comments\/999/);
            assert.strictEqual(method, 'DELETE');
            return { code: 204 };
          }
        },
        getCommentsScanWithRetry: async () => ({ existingCommentId: 999 })
      };
      const report = {
        allPassed: true,
        allFormalityErrors: [],
        allMakefileErrors: [],
        allPatchesErrors: [],
        allPrWarnings: []
      };

      await syncPrComment(ctx, report, queue, {});
      await queue.execute();
      assert.strictEqual(apiCalled, true);
    });

    test('treats HTTP 404 on PR comment removal as success (idempotent)', async () => {
      const queue = new GitHubWriteQueue(1);
      const ctx = {
        config: { enable_comments: true },
        repoFullname: 'openwrt/openwrt',
        prNumber: 100,
        client: {
          optionalApiCall: async (url) => (url.includes('/pulls/')
            ? { code: 200, data: { state: 'open' } }
            : { code: 404, data: null, raw: 'Not Found' })
        },
        getCommentsScanWithRetry: async () => ({ existingCommentId: 999 })
      };
      const report = {
        allPassed: true,
        allFormalityErrors: [],
        allMakefileErrors: [],
        allPatchesErrors: [],
        allPrWarnings: []
      };

      await syncPrComment(ctx, report, queue, {});
      const error = await queue.execute();
      assert.strictEqual(error, null);
      assert.strictEqual(queue.statusWrites[0].code, 200);
    });

    // The payload is the state this run was sent for, so a re-read GitHub did
    // not answer is no reason to leave the contributor without the report.
    test('still posts the PR comment when the live PR state could not be re-read', async () => {
      const queue = new GitHubWriteQueue(1);
      const ctx = {
        config: { enable_comments: true },
        repoFullname: 'openwrt/openwrt',
        prNumber: 100,
        headSha: 'head123',
        baseBranch: 'main',
        prData: { body: 'original body' },
        client: {
          optionalApiCall: async () => ({ code: 500, data: null, raw: 'Internal Server Error' })
        },
        getCommentsScanWithRetry: async () => ({ existingCommentId: null, incomplete: false })
      };
      const report = {
        allPassed: false,
        allFormalityErrors: ['Error'],
        allMakefileErrors: [],
        allPatchesErrors: [],
        allPrWarnings: []
      };

      await syncPrComment(ctx, report, queue, {});
      assert.deepStrictEqual(queue.queue.map(([what]) => what), ['PR comment']);
    });

    // An unfinished scan cannot say whether this app already reported here, and
    // a second report on the same pull request is worse than none.
    test('leaves the comment alone when the thread could not be read in full', async () => {
      const queue = new GitHubWriteQueue(1);
      const ctx = {
        config: { enable_comments: true },
        repoFullname: 'openwrt/openwrt',
        prNumber: 100,
        headSha: 'head123',
        baseBranch: 'main',
        prData: { body: 'original body' },
        client: {
          optionalApiCall: async () => ({ code: 200, data: { head: { sha: 'head123' }, base: { ref: 'main' }, body: 'original body' } })
        },
        getCommentsScanWithRetry: async () => ({
          hasBranchBypassComment: false,
          hasCherryPickBypassComment: false,
          existingCommentId: null,
          incomplete: true
        })
      };
      const report = {
        allPassed: false,
        allFormalityErrors: ['Error'],
        allMakefileErrors: [],
        allPatchesErrors: [],
        allPrWarnings: []
      };

      await syncPrComment(ctx, report, queue, {});
      assert.strictEqual(queue.queue.length, 0);
    });

    test('skips PR comment sync when live PR base branch moved', async () => {
      const queue = new GitHubWriteQueue(1);
      const ctx = {
        config: { enable_comments: true },
        repoFullname: 'openwrt/openwrt',
        prNumber: 100,
        headSha: 'head123',
        baseBranch: 'main',
        prData: { body: 'original body' },
        client: {
          optionalApiCall: async () => ({
            code: 200,
            data: { head: { sha: 'head123' }, base: { ref: 'openwrt-24.10' }, body: 'original body' }
          })
        },
        getCommentsScanWithRetry: async () => ({ existingCommentId: null })
      };
      const report = {
        allPassed: false,
        allFormalityErrors: ['Error'],
        allMakefileErrors: [],
        allPatchesErrors: [],
        allPrWarnings: []
      };

      await syncPrComment(ctx, report, queue, {});
      assert.strictEqual(queue.queue.length, 0);
    });

    test('skips PR comment sync when live PR body changed', async () => {
      const queue = new GitHubWriteQueue(1);
      const ctx = {
        config: { enable_comments: true },
        repoFullname: 'openwrt/openwrt',
        prNumber: 100,
        headSha: 'head123',
        baseBranch: 'main',
        prData: { body: 'original body' },
        client: {
          optionalApiCall: async () => ({
            code: 200,
            data: { head: { sha: 'head123' }, base: { ref: 'main' }, body: 'modified body with override' }
          })
        },
        getCommentsScanWithRetry: async () => ({ existingCommentId: null })
      };
      const report = {
        allPassed: false,
        allFormalityErrors: ['Error'],
        allMakefileErrors: [],
        allPatchesErrors: [],
        allPrWarnings: []
      };

      await syncPrComment(ctx, report, queue, {});
      assert.strictEqual(queue.queue.length, 0);
    });

    test('does not remove existing comment when allPassed is true but isValidationIncomplete is true and allPrWarnings is empty', async () => {
      const queue = new GitHubWriteQueue(1);
      const ctx = {
        config: { enable_comments: true },
        repoFullname: 'openwrt/openwrt',
        prNumber: 100,
        headSha: 'head123',
        baseBranch: 'main',
        prData: { body: 'original body' },
        client: {
          optionalApiCall: async () => ({
            code: 200,
            data: { state: 'open', head: { sha: 'head123' }, base: { ref: 'main' }, body: 'original body' }
          }),
          trackedApiCall: async () => ({ code: 200 })
        },
        getCommentsScanWithRetry: async () => ({ existingCommentId: 456 })
      };
      const report = {
        allPassed: true,
        isValidationIncomplete: true,
        allFormalityErrors: [],
        allMakefileErrors: [],
        allPatchesErrors: [],
        allPrWarnings: []
      };

      await syncPrComment(ctx, report, queue, {});
      assert.strictEqual(queue.queue.length, 0, 'should not queue PR comment removal when validation is incomplete');
    });

    test('skips PR comment sync when live PR is closed (state !== "open") even if head SHA and body match', async () => {
      const queue = new GitHubWriteQueue(1);
      const ctx = {
        config: { enable_comments: true },
        repoFullname: 'openwrt/openwrt',
        prNumber: 100,
        headSha: 'head123',
        baseBranch: 'main',
        prData: { body: 'original body' },
        client: {
          optionalApiCall: async () => ({
            code: 200,
            data: { state: 'closed', head: { sha: 'head123' }, base: { ref: 'main' }, body: 'original body' }
          }),
          trackedApiCall: async () => ({ code: 200 })
        },
        getCommentsScanWithRetry: async () => ({ existingCommentId: 456 })
      };
      const report = {
        allPassed: false,
        isValidationIncomplete: false,
        allFormalityErrors: ['Error'],
        allMakefileErrors: [],
        allPatchesErrors: [],
        allPrWarnings: []
      };

      await syncPrComment(ctx, report, queue, {});
      assert.strictEqual(queue.queue.length, 0, 'should not queue any comment updates when PR is closed');
    });
  });
});

// What the closing writes really cost, counted the way Cloudflare counts
// them: one per outgoing fetch, retries included. The PR comment is the only
// one of these writes a run may drop, so it must never eat the attempts the
// three check-runs may still need.
describe('the PR comment inside the closing writes budget', () => {
  const PR_URL = 'https://api.github.com/repos/openwrt/openwrt/pulls/100';

  const ctxFor = (client) => ({
    config: { enable_comments: true, show_force_push_tip: false },
    repoFullname: 'openwrt/openwrt',
    prNumber: 100,
    headSha: 'head123',
    headBranch: 'feature',
    baseBranch: 'main',
    baseSha: 'base123',
    prData: {
      url: PR_URL,
      state: 'open',
      head: { sha: 'head123', ref: 'feature' },
      base: { ref: 'main', sha: 'base123' },
      body: 'original body'
    },
    client,
    getCommentsScanWithRetry: async () => ({ existingCommentId: null, incomplete: false })
  });

  const failingReport = {
    allPassed: false,
    isValidationIncomplete: false,
    formalityPassed: false,
    makefilePassed: true,
    patchesPassed: true,
    formalityConclusion: 'failure',
    makefileConclusion: 'success',
    patchesConclusion: 'neutral',
    allFormalityErrors: ['Commit subject is too long.'],
    allMakefileErrors: [],
    allPatchesErrors: [],
    allPrWarnings: [],
    formalityOutputText: '### Formalities\n\n',
    makefileOutputText: '### Makefiles\n\n',
    patchesOutputText: '',
    patchesHeading: '### Patches\n\n',
    unreadPatchNotes: new Set()
  };

  const livePrState = () => new Response(JSON.stringify({
    state: 'open',
    head: { sha: 'head123', ref: 'feature' },
    base: { ref: 'main', sha: 'base123' },
    body: 'original body'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const runClosingWrites = async (used) => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const originalError = console.error;
    const fetchUrls = [];
    const warnings = [];
    globalThis.fetch = async (url) => {
      fetchUrls.push(String(url));
      if (String(url).endsWith('/pulls/100')) return livePrState();
      if (String(url).includes('/issues/100/comments')) return new Response('upstream hiccup', { status: 500 });
      if (String(url).includes('/check-runs')) return new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } });
      throw new Error(`unexpected request: ${url}`);
    };
    console.warn = (msg) => { warnings.push(String(msg)); };
    console.error = () => {};
    try {
      const budget = { limit: 45, reserve: 15, used };
      const client = createGitHubClient('token', budget);
      const ctx = ctxFor(client);
      const queue = new GitHubWriteQueue(100);

      await syncPrComment(ctx, failingReport, queue, {});
      enqueueCheckRuns(ctx, failingReport, queue);
      const response = await queue.execute(budget);

      return { response, queue, budget, fetchUrls, warnings };
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      console.error = originalError;
    }
  };

  const countOf = (urls, part) => urls.filter(u => u.includes(part)).length;

  // The run enters the write phase with 11 attempts left and three check-runs
  // still to write, which may cost nine. The comment gets the one attempt
  // above that reserve and no more: GitHub refusing it is reported as the
  // failed write it is - the budget only stopped the retrying - and the three
  // check-runs still reach GitHub inside the cap.
  test('a comment GitHub refuses costs one attempt, not three, and leaves the check-runs their reserve', async () => {
    const { response, queue, budget, fetchUrls } = await runClosingWrites(34);

    assert.strictEqual(countOf(fetchUrls, '/issues/100/comments'), 1, 'the refused write is not retried into the reserve');
    assert.strictEqual(countOf(fetchUrls, '/check-runs'), 3);
    assert.strictEqual(budget.used, 39);
    assert.ok(budget.used <= budget.limit);
    assert.strictEqual(budget.reserve, 15, 'the queue leaves the budget saying what it said before');
    assert.deepStrictEqual(
      queue.statusWrites.map(w => [w.what, w.code]),
      [['PR comment', 500], ['check-run "Git & Commits"', 201], ['check-run "OpenWrt Makefiles"', 201], ['check-run "Code Patches"', 201]]
    );
    assert.strictEqual(response.status, 502);
    assert.match(await response.text(), /PR comment \(HTTP 500\)/);
  });

  // Control, and the other half of the policy: with nothing above the reserve
  // the queue drops the comment before it is attempted. A write it skips is
  // logged and left out of the status writes, so the run reports success for
  // the three check-runs it did make - a comment skipped, not a failed one.
  test('a comment the reserve leaves no room for is skipped, and the run still succeeds', async () => {
    const { response, queue, budget, fetchUrls, warnings } = await runClosingWrites(35);

    assert.strictEqual(countOf(fetchUrls, '/issues/100/comments'), 0);
    assert.strictEqual(countOf(fetchUrls, '/check-runs'), 3);
    assert.strictEqual(budget.used, 39);
    assert.strictEqual(response, null, 'the run reports success');
    assert.deepStrictEqual(queue.statusWrites.map(w => w.what), [
      'check-run "Git & Commits"', 'check-run "OpenWrt Makefiles"', 'check-run "Code Patches"'
    ]);
    assert.ok(
      warnings.some(w => w.includes("Skipping non-critical write 'PR comment'")),
      'and says in the log that the comment was dropped'
    );
  });
});
