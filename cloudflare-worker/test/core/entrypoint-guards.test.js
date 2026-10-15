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
import { calculateHmac } from '../github-mocks.js';

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
