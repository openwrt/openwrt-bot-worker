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
    // Nearly every thread fits on page 1, and the override commands this scan
    // looks for are on it. Skipping it to protect the reserve costs one
    // request's worth of headroom and the whole answer.
    test('reads page 1 even with no headroom, so an override on it is still found', async () => {
      let pageRequests = 0;
      globalThis.fetch = async () => {
        pageRequests++;
        const comments = [
          { id: 5, body: 'Looks intentional, [allow branch]', user: { login: 'maintainer' }, author_association: 'MEMBER' }
        ];
        return new Response(JSON.stringify(comments), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      let onCallCount = 0;
      const onCall = () => { onCallCount++; return true; };

      const result = await scanPrComments(
        'openwrt/openwrt',
        123,
        'fake-token',
        onCall,
        async () => true,
        null,
        () => false // no headroom
      );

      assert.strictEqual(pageRequests, 1, 'page 1 is always read');
      assert.strictEqual(onCallCount, 1, 'and the request it costs is counted');
      assert.strictEqual(result.hasBranchBypassComment, true);
      assert.strictEqual(result.incomplete, false, 'a thread of one page was read in full');
    });

    test('stops after a full page 1 when the headroom is gone, and says the scan is incomplete', async () => {
      let pageRequests = 0;
      globalThis.fetch = async () => {
        pageRequests++;
        // A full page means GitHub has more to serve, so a second one is due.
        const comments = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'hello' }));
        return new Response(JSON.stringify(comments), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const result = await scanPrComments(
        'openwrt/openwrt',
        123,
        'fake-token',
        () => true,
        async () => false,
        null,
        () => false
      );

      assert.strictEqual(pageRequests, 1, 'page 2 is the one the reserve refuses');
      assert.strictEqual(result.incomplete, true, 'an unread page is not a thread without overrides');
      assert.strictEqual(result.hasBranchBypassComment, false);
    });

    test('keeps an override it had already found when the scan stops short', async () => {
      globalThis.fetch = async () => {
        const comments = Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          body: i === 0 ? 'Fine by me, [allow cherry-pick]' : 'hello',
          user: { login: 'maintainer' },
          author_association: 'MEMBER'
        }));
        return new Response(JSON.stringify(comments), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const result = await scanPrComments(
        'openwrt/openwrt', 123, 'fake-token', () => true, async () => true, null, () => false
      );

      assert.strictEqual(result.hasCherryPickBypassComment, true, 'what was read still counts');
      assert.strictEqual(result.incomplete, true);
    });

    test('marks the scan incomplete when GitHub does not serve a page', async () => {
      globalThis.fetch = async () =>
        new Response('upstream hiccup', { status: 503 });

      const result = await scanPrComments(
        'openwrt/openwrt', 123, 'fake-token', () => true, async () => false, null, () => true
      );

      assert.strictEqual(result.incomplete, true, 'a page GitHub refused is not an answer about overrides');
      assert.strictEqual(result.existingCommentId, null);
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
      assert.strictEqual(result?.incomplete, false);
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
    // The three answers the resolver can give about an override's author, for
    // each override. "No write access" withholds the override; "could not ask"
    // withholds it too - access is never assumed - but it must not read as a
    // thread without an override, because that is what fails the rule.
    for (const [override, found, unverified] of [
      ['[allow branch]', 'hasBranchBypassComment', 'branchOverrideUnverified'],
      ['[allow cherry-pick]', 'hasCherryPickBypassComment', 'cherryPickOverrideUnverified']
    ]) {
      const comments = () => [
        { id: 10, body: `Fine by me, ${override}`, user: { login: 'privatemaintainer' }, author_association: 'CONTRIBUTOR' }
      ];

      test(`honours ${override} from an author GitHub confirms has write access`, async () => {
        let lookups = 0;
        const result = await scanCommentList(comments(), async () => { lookups++; return true; }, null);
        assert.strictEqual(result[found], true);
        assert.strictEqual(result[unverified], false);
        assert.strictEqual(result.incomplete, false);
        assert.strictEqual(lookups, 1, 'one override comment is worth one question');
      });

      test(`withholds ${override} from an author GitHub says has no write access`, async () => {
        const result = await scanCommentList(comments(), async () => false, null);
        assert.strictEqual(result[found], false);
        assert.strictEqual(result[unverified], false, 'GitHub answered, so the rule can be reported on');
        assert.strictEqual(result.incomplete, false);
      });

      test(`reports ${override} as unverified when the permission lookup failed`, async () => {
        const result = await scanCommentList(comments(), async () => null, null);
        assert.strictEqual(result[found], false, 'write access is never assumed');
        assert.strictEqual(result[unverified], true, 'but this is not a thread without an override');
        // `incomplete` is what triggers a re-scan of the whole thread, and the
        // thread was read in full: re-reading it would spend the reserve to
        // arrive at the same unanswered question.
        assert.strictEqual(result.incomplete, false, 'the thread itself was read to the end');
      });
    }

    test('marks only the rule the unverifiable override actually names', async () => {
      const comments = [
        { id: 11, body: 'go ahead, [allow branch]', user: { login: 'privatemaintainer' }, author_association: 'CONTRIBUTOR' }
      ];

      const result = await scanCommentList(comments, async () => null, null);
      assert.strictEqual(result.branchOverrideUnverified, true);
      assert.strictEqual(result.cherryPickOverrideUnverified, false, 'the cherry-pick rule was never in question');
    });

    test('asks nothing about a comment that carries no override at all', async () => {
      let lookups = 0;
      const result = await scanCommentList(
        [{ id: 12, body: 'please rebase', user: { login: 'reviewer' }, author_association: 'CONTRIBUTOR' }],
        async () => { lookups++; return null; },
        null
      );
      assert.strictEqual(lookups, 0, 'a plain comment is not worth a subrequest');
      assert.strictEqual(result.branchOverrideUnverified, false);
      assert.strictEqual(result.cherryPickOverrideUnverified, false);
    });
  });
});

