import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { scanPrComments, scanCommentList } from '../../src/core/comment-scanner.ts';

describe('comment-scanner', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('scanPrComments headroom checks', () => {
    test('skips comment scan before page 1 and makes no API calls when hasHeadroom is false', async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      let onCallCount = 0;
      const onCall = () => { onCallCount++; return true; };
      const isMaintainerUser = async () => false;

      const result = await scanPrComments(
        'openwrt/openwrt',
        123,
        'fake-token',
        onCall,
        isMaintainerUser,
        null,
        () => false // no headroom
      );

      assert.strictEqual(result, null);
      assert.strictEqual(fetchCalled, false, 'fetch should not be called when headroom is exhausted before page 1');
      assert.strictEqual(onCallCount, 0, 'onCall should not be invoked');
    });

    test('stops comment scan after page 1 when headroom is exhausted before page 2', async () => {
      let pageRequests = 0;
      globalThis.fetch = async (url) => {
        pageRequests++;
        // Return 100 empty comments to trigger pagination to page 2
        const comments = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'hello' }));
        return new Response(JSON.stringify(comments), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      let calls = 0;
      // Headroom available for page 1, but exhausted for page 2
      const hasHeadroom = () => calls++ === 0;
      const isMaintainerUser = async () => false;

      const result = await scanPrComments(
        'openwrt/openwrt',
        123,
        'fake-token',
        () => true,
        isMaintainerUser,
        null,
        hasHeadroom
      );

      assert.strictEqual(result, null);
      assert.strictEqual(pageRequests, 1, 'only page 1 should be fetched before headroom check halts scanning');
    });

    test('successfully scans comments when headroom is available', async () => {
      globalThis.fetch = async () => {
        const comments = [
          { id: 42, body: '## Formality Check: Failed\nDetails...', viewer_did_author: true }
        ];
        return new Response(JSON.stringify(comments), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const result = await scanPrComments(
        'openwrt/openwrt',
        123,
        'fake-token',
        () => true,
        async () => false,
        null,
        () => true
      );

      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.existingCommentId, 42);
      assert.strictEqual(result?.hasBranchBypassComment, false);
      assert.strictEqual(result?.hasCherryPickBypassComment, false);
    });
  });

  describe('scanCommentList', () => {
    test('detects maintainer bypass commands', async () => {
      const comments = [
        { id: 10, body: 'Please merge this. [allow-branch]', user: { login: 'alice' }, author_association: 'MEMBER' },
        { id: 20, body: 'Confirmed: [allow-cherry-pick]', user: { login: 'bob' }, author_association: 'COLLABORATOR' }
      ];

      const result = await scanCommentList(
        comments,
        async () => true, // maintainer
        null
      );

      assert.strictEqual(result.hasBranchBypassComment, true);
      assert.strictEqual(result.hasCherryPickBypassComment, true);
    });
  });
});
