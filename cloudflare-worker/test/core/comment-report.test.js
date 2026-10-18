import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildCommentBody, syncPrComment } from '../../src/handlers/pull-request/comment-report.ts';
import { GitHubWriteQueue } from '../../src/core/github-write-queue.ts';

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
          trackedApiCall: async (url, method, body) => {
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
          trackedApiCall: async (url, method) => {
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
          trackedApiCall: async () => ({ code: 404, data: null, raw: 'Not Found' })
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
