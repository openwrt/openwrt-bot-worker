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
  });
});
