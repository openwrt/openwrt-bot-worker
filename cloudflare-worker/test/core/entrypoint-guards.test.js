import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  isPullRequestPayload,
  isIssueCommentPayload,
  isIssuesPayload
} from '../../src/types/github.ts';
import { handlePullRequestEvent } from '../../src/handlers/pull-request/index.ts';
import { handleIssuesEvent } from '../../src/handlers/issues.ts';
import { applyIssueLabelling } from '../../src/issue-labeller.js';
import worker from '../../src/index.js';
import { calculateHmac, graphqlLabelsHandler } from '../github-mocks.js';

// Drives one pull_request event from a protected head branch through the whole
// handler with the request budget already down to its reserve, and returns the
// check-runs it published. `thread` is what the REST comment listing serves.
async function runProtectedBranchPr(thread) {
  const originalFetch = globalThis.fetch;
  const checkRuns = [];
  const commit = {
    sha: 'c0ffee1234567890123456789012345678901234',
    html_url: 'https://github.com/test/repo/commit/c0ffee1',
    parents: [{ sha: 'parent' }],
    commit: {
      message: 'readme: fix a typo\n\nSigned-off-by: John Doe <john@doe.com>',
      author: { name: 'John Doe', email: 'john@doe.com' },
      committer: { name: 'John Doe', email: 'john@doe.com' }
    }
  };

  globalThis.fetch = async (url, options) => {
    const method = options?.method || 'GET';
    { const lr = graphqlLabelsHandler(url, options, []); if (lr) return lr; }
    if (url.includes('/contents/.github/formalities.json')) {
      return new Response(JSON.stringify({
        check_branch: true,
        require_linked_github_account: false,
        require_body: false,
        check_uci_config: false,
        check_pkg_release: false
      }), { status: 200 });
    }
    if (url.includes('/contents/')) return new Response('Not Found', { status: 404 });
    if (url.includes('/pulls/123/commits')) {
      return new Response(JSON.stringify(url.includes('page=1') ? [commit] : []), { status: 200 });
    }
    if (url.includes('/issues/123/comments')) {
      // The setup query re-enters this listing for its inline comments. A
      // report by some other app there is what sends the run down the REST
      // road, which is the path the scan's paging lives on.
      if (url.includes('_setup=1')) {
        return new Response(JSON.stringify([
          { id: 7, body: '## Formality Check: Failed', user: { login: 'openwrt[bot]', type: 'Bot' }, author_association: 'NONE' }
        ]), { status: 200 });
      }
      return new Response(JSON.stringify(thread), { status: 200 });
    }
    if (url.includes(`/commits/${commit.sha}`)) {
      return new Response('diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-teh\n+the\n', { status: 200 });
    }
    if (url.includes('/check-runs') && method === 'POST') {
      checkRuns.push(JSON.parse(options.body));
      return new Response('{}', { status: 201 });
    }
    return new Response('{}', { status: 200 });
  };

  try {
    const response = await handlePullRequestEvent(
      {
        action: 'opened',
        pull_request: {
          number: 123,
          title: 'readme: fix a typo',
          body: 'A typo fix.',
          url: 'https://api.github.com/repos/test/repo/pulls/123',
          state: 'open',
          labels: [],
          user: { login: 'johndoe', type: 'User' },
          author_association: 'CONTRIBUTOR',
          head: { ref: 'main', sha: 'headsha' },
          base: { ref: 'main', sha: 'basesha' }
        }
      },
      'pull_request',
      // Nothing but the reserve is left, so every optional lookup has to
      // decide whether it is worth a request.
      { SUBREQUEST_BUDGET_LIMIT: '15', SUBREQUEST_RESERVE_HEADROOM: '15' },
      'fake-token',
      'test/repo',
      12345,
      0
    );
    return { status: response.status, checkRuns };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('override commands under an exhausted request budget', () => {
  test('honours a maintainer\'s [allow branch] comment when only the reserve is left', async () => {
    const { status, checkRuns } = await runProtectedBranchPr([
      { id: 11, body: 'Looks intentional, [allow branch]', user: { login: 'maintainer' }, author_association: 'MEMBER' }
    ]);

    assert.strictEqual(status, 200);
    const commits = checkRuns.find(r => r.name === 'FormalityCheck / Git & Commits');
    assert.ok(commits, 'the Git & Commits check is published');
    assert.notStrictEqual(commits.conclusion, 'failure',
      `a pull request a maintainer waved through must not be failed: ${commits.output.text}`);
    assert.match(commits.output.text, /allowed via override command/);
    assert.doesNotMatch(commits.output.text, /PR Targeting Violation/);
  });

  test('reports the targeting rule as neutral, not failed, when the thread could not be read', async () => {
    // A full first page means more comments are due, and the reserve refuses
    // the request for them: the override may be on the page never read.
    const { status, checkRuns } = await runProtectedBranchPr(
      Array.from({ length: 100 }, (_, i) => ({
        id: i + 100, body: `comment ${i}`, user: { login: 'someone' }, author_association: 'NONE'
      }))
    );

    assert.strictEqual(status, 200);
    const commits = checkRuns.find(r => r.name === 'FormalityCheck / Git & Commits');
    assert.ok(commits, 'the Git & Commits check is published');
    assert.strictEqual(commits.conclusion, 'neutral',
      `an unread thread leaves the rule unchecked, not broken: ${commits.output.text}`);
    assert.doesNotMatch(commits.output.text, /PR Targeting Violation/);
    assert.match(commits.output.text, /Could not check whether the pull request from `main` was allowed/);
  });
});

describe('runtime type guards and entrypoint boundary validation', () => {
  describe('type guards', () => {
    test('isPullRequestPayload validates pull_request objects and rejects comments', () => {
      assert.strictEqual(isPullRequestPayload(null), false);
      assert.strictEqual(isPullRequestPayload('string'), false);
      assert.strictEqual(isPullRequestPayload({}), false);
      assert.strictEqual(isPullRequestPayload({ pull_request: null }), false);
      assert.strictEqual(isPullRequestPayload({ pull_request: {} }), false);
      assert.strictEqual(isPullRequestPayload({ pull_request: { number: 123 } }), false);
      assert.strictEqual(isPullRequestPayload({ pull_request: { number: 123, base: { ref: 'main', sha: 'bsha' } } }), false);
      assert.strictEqual(isPullRequestPayload({ pull_request: { number: 123, head: { ref: 'feat', sha: 'hsha' } } }), false);
      assert.strictEqual(isPullRequestPayload({ pull_request: { number: 123, base: { ref: 'main' }, head: { ref: 'feat' } } }), false);
      assert.strictEqual(isPullRequestPayload({
        pull_request: {
          number: 123,
          base: { ref: 'main', sha: 'bsha' },
          head: { ref: 'feat', sha: 'hsha' }
        }
      }), true);
      // If it also contains comment, it's an issue_comment payload, not pull_request
      assert.strictEqual(isPullRequestPayload({
        pull_request: {
          number: 123,
          base: { ref: 'main', sha: 'bsha' },
          head: { ref: 'feat', sha: 'hsha' }
        },
        comment: { id: 1 }
      }), false);
    });

    test('isIssueCommentPayload validates both comment and issue objects with essential fields', () => {
      assert.strictEqual(isIssueCommentPayload(null), false);
      assert.strictEqual(isIssueCommentPayload({}), false);
      assert.strictEqual(isIssueCommentPayload({ comment: {} }), false);
      assert.strictEqual(isIssueCommentPayload({ issue: {} }), false);
      assert.strictEqual(isIssueCommentPayload({ comment: null, issue: { number: 123 } }), false);
      assert.strictEqual(isIssueCommentPayload({ comment: { id: 1 }, issue: {} }), false);
      assert.strictEqual(isIssueCommentPayload({ comment: {}, issue: { number: 123 } }), true);
      assert.strictEqual(isIssueCommentPayload({ comment: { id: 1 }, issue: { number: 123 } }), true);
    });

    test('isIssuesPayload validates issue object with number and ensures comment is absent', () => {
      assert.strictEqual(isIssuesPayload(null), false);
      assert.strictEqual(isIssuesPayload({}), false);
      assert.strictEqual(isIssuesPayload({ issue: null }), false);
      assert.strictEqual(isIssuesPayload({ issue: {} }), false);
      assert.strictEqual(isIssuesPayload({ issue: { number: 123 } }), true);
      assert.strictEqual(isIssuesPayload({ issue: { number: 123 }, comment: { id: 1 } }), false);
    });
  });

  describe('handler entrypoints', () => {
    test('handlePullRequestEvent rejects malformed pull_request payloads with HTTP 400', async () => {
      const resNull = await handlePullRequestEvent(null, 'pull_request', {}, 'token', 'openwrt/openwrt', null, 0);
      assert.strictEqual(resNull.status, 400);

      const resEmpty = await handlePullRequestEvent({}, 'pull_request', {}, 'token', 'openwrt/openwrt', null, 0);
      assert.strictEqual(resEmpty.status, 400);
      assert.match(await resEmpty.text(), /expected pull_request event payload/);

      const resNoNumber = await handlePullRequestEvent({ pull_request: {} }, 'pull_request', {}, 'token', 'openwrt/openwrt', null, 0);
      assert.strictEqual(resNoNumber.status, 400);
      assert.match(await resNoNumber.text(), /expected pull_request event payload/);

      const resIncomplete = await handlePullRequestEvent(
        { pull_request: { number: 123 } },
        'pull_request',
        {},
        'token',
        'openwrt/openwrt',
        null,
        0
      );
      assert.strictEqual(resIncomplete.status, 400);
      assert.match(await resIncomplete.text(), /expected pull_request event payload/);
    });

    test('handlePullRequestEvent rejects malformed issue_comment payloads with HTTP 400', async () => {
      const resMissingComment = await handlePullRequestEvent(
        { issue: { number: 123 } },
        'issue_comment',
        {},
        'token',
        'openwrt/openwrt',
        null,
        0
      );
      assert.strictEqual(resMissingComment.status, 400);
      assert.match(await resMissingComment.text(), /expected issue_comment event payload/);
    });

    test('handleIssuesEvent rejects malformed issues payloads with HTTP 400', async () => {
      const resNull = await handleIssuesEvent(null, 'token', 'openwrt/openwrt', null);
      assert.strictEqual(resNull.status, 400);

      const resMissingIssue = await handleIssuesEvent({}, 'token', 'openwrt/openwrt', null);
      assert.strictEqual(resMissingIssue.status, 400);
      assert.match(await resMissingIssue.text(), /expected issues event payload/);

      const resNoIssueNumber = await handleIssuesEvent({ issue: {} }, 'token', 'openwrt/openwrt', null);
      assert.strictEqual(resNoIssueNumber.status, 400);
      assert.match(await resNoIssueNumber.text(), /expected issues event payload/);
    });

    test('handleIssuesEvent returns HTTP 502 when issue labelling write operations fail', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        if (url.includes('/graphql')) {
          return new Response(JSON.stringify({
            data: {
              repo0: {
                f0: { oid: 'sha1', text: JSON.stringify({ enable_issue_labeller: true }), isBinary: false },
                f1: { oid: 'sha2', text: 'rules:\n  - label: target/ramips\n    conditions:\n      - field: target\n        format: "^ramips$"\n', isBinary: false }
              }
            }
          }), { status: 200 });
        }
        if (url.includes('/issues/123/labels') && options?.method === 'POST') {
          return new Response('Write forbidden by branch/repo rules', { status: 403 });
        }
        if (url.includes('/issues/123/labels')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.includes('/labels')) {
          return new Response(JSON.stringify([{ name: 'target/ramips' }]), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      };

      try {
        const payload = {
          action: 'opened',
          issue: {
            number: 123,
            title: 'Kernel crash on mt7621',
            body: '### OpenWrt target\n\nramips\n',
            labels: [{ name: 'to-triage' }]
          }
        };
        const res = await handleIssuesEvent(payload, 'token', 'openwrt/openwrt', null);
        assert.strictEqual(res.status, 502);
        assert.match(await res.text(), /Failed to apply issue labelling/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('webhook HTTP entrypoint boundary', () => {
    const secret = 'webhook-test-secret';

    test('rejects malformed pull_request payload at the webhook boundary with HTTP 400', async () => {
      const payload = JSON.stringify({ action: 'opened', pull_request: {} });
      const signature = await calculateHmac(secret, payload);
      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        body: payload,
        headers: {
          'x-hub-signature-256': signature,
          'x-github-event': 'pull_request'
        }
      });
      const response = await worker.fetch(request, { WEBHOOK_SECRET: secret }, {});
      assert.strictEqual(response.status, 400);
      assert.match(await response.text(), /expected pull_request event payload/);
    });

    test('rejects incomplete pull_request payload (missing base/head) with HTTP 400', async () => {
      const payload = JSON.stringify({ action: 'opened', pull_request: { number: 123 } });
      const signature = await calculateHmac(secret, payload);
      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        body: payload,
        headers: {
          'x-hub-signature-256': signature,
          'x-github-event': 'pull_request'
        }
      });
      const response = await worker.fetch(request, { WEBHOOK_SECRET: secret }, {});
      assert.strictEqual(response.status, 400);
      assert.match(await response.text(), /expected pull_request event payload/);
    });

    test('rejects malformed issues payload at the webhook boundary with HTTP 400', async () => {
      const payload = JSON.stringify({ action: 'opened', issue: {} });
      const signature = await calculateHmac(secret, payload);
      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        body: payload,
        headers: {
          'x-hub-signature-256': signature,
          'x-github-event': 'issues'
        }
      });
      const response = await worker.fetch(request, { WEBHOOK_SECRET: secret }, {});
      assert.strictEqual(response.status, 400);
      assert.match(await response.text(), /expected issues event payload/);
    });

    test('rejects malformed issue_comment payload at the webhook boundary with HTTP 400', async () => {
      const payload = JSON.stringify({ action: 'created', comment: {} });
      const signature = await calculateHmac(secret, payload);
      const request = new Request('http://localhost/webhook', {
        method: 'POST',
        body: payload,
        headers: {
          'x-hub-signature-256': signature,
          'x-github-event': 'issue_comment'
        }
      });
      const response = await worker.fetch(request, { WEBHOOK_SECRET: secret }, {});
      assert.strictEqual(response.status, 400);
      assert.match(await response.text(), /expected issue_comment event payload/);
    });
  });
});

// The issue labeller spends the same per-invocation subrequest budget as the
// pull request path: one unit per outgoing request, and the reserve kept off
// the optional lookups so the labelling writes at the end always have room.
// These tests drive the handler with budgets tight enough that a miscounted
// request shows up as a skipped write or a second comment.
describe('issue labeller subrequest budget', () => {
  const INVALID_FORMAT_YML = 'target/ramips:\n  - field: target\n    format: "^ramips$"\n';
  const EXISTS_YML = 'has-target:\n  - field: target\n    exists: "path:target/linux/mediatek"\n';

  // An issue whose form field fails validation: the verdict carries the
  // invalid label (a write), the trigger label removal (a write) and a
  // comment, so every part of the budget is exercised.
  const flaggedIssue = {
    number: 7,
    title: 'Kernel crash',
    body: '### OpenWrt target\n\nmediatek\n',
    labels: [{ name: 'to-triage' }],
    author_association: 'NONE'
  };

  const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

  // Answers everything an issues event asks GitHub and records what really
  // went out. `configFailures` makes the first answers to the config query a
  // 500, so githubApiCall retries it; `commentPages` is the thread.
  function stubIssuesApi({ labellerYml = INVALID_FORMAT_YML, commentPages = [[]], repoLabels = ['invalid'], configFailures = 0 } = {}) {
    const requests = [];
    let configCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method || 'GET';
      requests.push({ url, method, body: options.body ? JSON.parse(options.body) : null });

      if (url.includes('/graphql')) {
        const body = JSON.parse(options.body);
        if (body.query.includes('labels(first:')) {
          return json({ data: { repository: { labels: { nodes: repoLabels.map(name => ({ name })), pageInfo: { hasNextPage: false, endCursor: null } } } } });
        }
        if (body.variables.o0 !== undefined) {
          configCalls++;
          if (configCalls <= configFailures) return new Response('upstream hiccup', { status: 500 });
          return json({
            data: {
              repo0: {
                f0: { oid: 'cfg', text: '{"enable_issue_labeller": true}', isBinary: false },
                f1: { oid: 'yml', text: labellerYml, isBinary: false }
              }
            }
          });
        }
        // Existence probes: nothing the config asks about resolves.
        const aliases = Object.keys(body.variables).filter(k => k.startsWith('expr'));
        return json({ data: { repository: Object.fromEntries(aliases.map((_, i) => [`p${i}`, null])) } });
      }

      if (method === 'GET' && url.includes('/comments?')) {
        const page = Number(new URL(url).searchParams.get('page') || 1);
        return json(commentPages[page - 1] || []);
      }
      return json({});
    };
    return requests;
  }

  const runIssuesEvent = (env, tokenMintAttempts = 0, issue = flaggedIssue) => handleIssuesEvent(
    { action: 'opened', issue, repository: { full_name: 'openwrt/openwrt', default_branch: 'main' } },
    'token',
    'openwrt/openwrt',
    null,
    env,
    tokenMintAttempts
  );

  const commentListings = (requests) => requests.filter(r => r.method === 'GET' && r.url.includes('/comments?'));
  const commentPosts = (requests) => requests.filter(r => r.method === 'POST' && r.url.endsWith('/issues/7/comments'));
  const labelPost = (requests) => requests.find(r => r.method === 'POST' && r.url.endsWith('/issues/7/labels'));

  test('a budget equal to the requests the run really makes carries it to the end', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubIssuesApi();

    // Config query, label listing, one comment page, the comment, the label
    // removal and the label addition: six requests, so a six-unit budget has
    // to cover them. Charging any of them twice starves the writes at the
    // end, and a declined write is the 502 that makes GitHub re-deliver.
    const res = await runIssuesEvent({ SUBREQUEST_BUDGET_LIMIT: '6', SUBREQUEST_RESERVE_HEADROOM: '0' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(requests.length, 6);
    assert.strictEqual(commentListings(requests).length, 1);
    assert.strictEqual(commentPosts(requests).length, 1);
    assert.deepStrictEqual(labelPost(requests).body.labels, ['invalid']);
  });

  for (const [what, env] of [
    ['unset', {}],
    ['unparseable', { SUBREQUEST_BUDGET_LIMIT: 'forty-five', SUBREQUEST_RESERVE_HEADROOM: 'fifteen' }]
  ]) {
    test(`an ${what} budget limit falls back to 45 with 15 reserved for the writes`, async (t) => {
      const realFetch = globalThis.fetch;
      t.after(() => { globalThis.fetch = realFetch; });
      const requests = stubIssuesApi();

      // 30 units are already spent when the handler starts, so the config
      // query and the label listing leave nothing beyond the reserve: the
      // comment scan is skipped, the labelling writes still go out. A
      // ceiling of 50 would page the thread, and an unparseable value must
      // not turn the ceiling into NaN, which never declines anything.
      const res = await runIssuesEvent(env, 30);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(commentListings(requests).length, 0);
      assert.strictEqual(commentPosts(requests).length, 0);
      assert.deepStrictEqual(labelPost(requests).body.labels, ['invalid']);
    });
  }

  test('a retried config query is charged for every attempt it made', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubIssuesApi({ configFailures: 1 });

    // The config query costs two requests (a 500, then the retry) and the
    // label listing one: with four units and one reserved there is nothing
    // left for the thread. Counting the retried query as one request would
    // leave room for a page that the budget cannot actually pay for.
    const res = await runIssuesEvent({ SUBREQUEST_BUDGET_LIMIT: '4', SUBREQUEST_RESERVE_HEADROOM: '1' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(requests.filter(r => r.url.includes('/graphql')).length, 3);
    assert.strictEqual(commentListings(requests).length, 0);
    assert.deepStrictEqual(labelPost(requests).body.labels, ['invalid']);
  });

  test('the existence query the rules ask for is charged too', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubIssuesApi({ labellerYml: EXISTS_YML });

    // Config query, existence query, label listing: three requests, and with
    // four units and one reserved the thread is out of reach. An existence
    // query nobody charges for hides a request that was really made.
    const res = await runIssuesEvent({ SUBREQUEST_BUDGET_LIMIT: '4', SUBREQUEST_RESERVE_HEADROOM: '1' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(requests.filter(r => r.url.includes('/graphql')).length, 3);
    assert.strictEqual(commentListings(requests).length, 0);
    assert.deepStrictEqual(labelPost(requests).body.labels, ['invalid']);
  });

  test('every comment page is charged once, not twice', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    // A full page keeps the pager going, and no page carries the marker.
    const filler = (n) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, body: `chatter ${i}` }));
    const requests = stubIssuesApi({ commentPages: [filler(100), filler(20)] });

    const charges = [];
    const onCall = () => { charges.push(1); return true; };
    await applyIssueLabelling(
      { labelsToAdd: [], labelsToRemove: [], comments: ['Fields are wrong'], resolvedComment: null, legacyHeader: null, labelMeta: {} },
      'token', 'openwrt/openwrt', 7, new Set(), new Set(), onCall
    );

    // Two listings and the comment itself: what the budget is told must be
    // what went out, or the budget declines a write it could have afforded.
    assert.strictEqual(requests.length, 3);
    assert.strictEqual(charges.length, requests.length);
  });

  test('a thread the budget stopped reading is not answered with a second comment', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const filler = (n) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, body: `chatter ${i}` }));
    const requests = stubIssuesApi({ commentPages: [filler(100), filler(20)] });

    // Headroom for the first page only: the comment this run would edit may
    // be on the page it never read, so it posts nothing rather than a
    // duplicate.
    let pagesAffordable = 1;
    await applyIssueLabelling(
      { labelsToAdd: [], labelsToRemove: [], comments: ['Fields are wrong'], resolvedComment: null, legacyHeader: null, labelMeta: {} },
      'token', 'openwrt/openwrt', 7, new Set(), new Set(), () => true, null,
      { hasHeadroom: () => pagesAffordable-- > 0 }
    );

    assert.strictEqual(commentListings(requests).length, 1);
    assert.strictEqual(commentPosts(requests).length, 0);
  });
});
