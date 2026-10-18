import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  isPullRequestPayload,
  isIssueCommentPayload,
  isIssuesPayload
} from '../../src/types/github.ts';
import { handlePullRequestEvent } from '../../src/handlers/pull-request/index.ts';
import { handleIssuesEvent } from '../../src/handlers/issues.ts';
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
