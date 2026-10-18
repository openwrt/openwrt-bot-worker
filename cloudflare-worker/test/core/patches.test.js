import { describe, test } from 'node:test';
import assert from 'node:assert';
import { resolvePatchesAndCommits } from '../../src/handlers/pull-request/patches.ts';

describe('resolvePatchesAndCommits lifecycle phase', () => {
  const createMockContext = ({
    commitsCount = 20,
    availableBudget = 30,
    prPatchResponse = null,
    commitPatchResponse = { code: 200, raw: 'diff --git a/foo b/foo\n' }
  } = {}) => {
    const commits = [];
    for (let i = 0; i < commitsCount; i++) {
      commits.push({
        sha: `sha_${i}`,
        html_url: `https://github.com/test/repo/commit/sha_${i}`,
        commit: { message: `commit ${i}` }
      });
    }

    return {
      commits,
      client: {
        budget: { limit: 50, used: 50 - availableBudget, reserve: 0 },
        hasHeadroom: () => true,
        trackedApiCall: async (url) => {
          if (url.includes('/commits/')) {
            return commitPatchResponse;
          }
          return { code: 200, data: null };
        },
        optionalApiCall: async (url) => {
          if (url.includes('/commits/')) {
            return commitPatchResponse;
          }
          return { code: 200, data: null };
        }
      },
      fileBatchLoader: {
        getRefSource: () => undefined,
        hasRefSource: () => false,
        setRefSource: () => {}
      },
      isBackportPr: false,
      repoFullname: 'openwrt/openwrt',
      prData: { url: 'https://api.github.com/repos/openwrt/openwrt/pulls/100' },
      startPrPatchFetch: async () => prPatchResponse
    };
  };

  test('uses PR-wide patch when commits > 15 and PR patch fetch succeeds', async () => {
    const prPatchText = 'diff --git a/pkg/Makefile b/pkg/Makefile\n--- a/pkg/Makefile\n+++ b/pkg/Makefile\n';
    const ctx = createMockContext({
      commitsCount: 18,
      prPatchResponse: { code: 200, raw: prPatchText, data: null, headers: { get: () => null } }
    });

    const result = await resolvePatchesAndCommits(ctx);

    assert.strictEqual(result.usePrWidePatch, true);
    assert.strictEqual(result.prPatch, prPatchText);
    assert.strictEqual(result.patchUnavailable, false);
  });

  test('falls back to commit-by-commit fetching when PR-wide patch is unavailable and budget allows', async () => {
    const ctx = createMockContext({
      commitsCount: 16,
      availableBudget: 20, // 20 available >= 16 commits
      prPatchResponse: { code: 404, raw: 'Not Found', data: null, headers: { get: () => null } }
    });

    const result = await resolvePatchesAndCommits(ctx);

    assert.strictEqual(result.usePrWidePatch, false);
    assert.strictEqual(result.patchUnavailable, false);
    assert.strictEqual(result.commitDetails.length, 16);
  });

  test('marks patchUnavailable when PR-wide patch is unavailable and budget is insufficient for individual commits', async () => {
    const ctx = createMockContext({
      commitsCount: 25,
      availableBudget: 10, // 10 available < 25 commits
      prPatchResponse: { code: 404, raw: 'Not Found', data: null, headers: { get: () => null } }
    });

    const result = await resolvePatchesAndCommits(ctx);

    assert.strictEqual(result.usePrWidePatch, true);
    assert.strictEqual(result.patchUnavailable, true);
    assert.strictEqual(result.prPatch, null);
  });

  test('increments upstreamComparisonSkips when fetching upstream backport commit fails', async () => {
    const ctx = createMockContext({ commitsCount: 1 });
    ctx.isBackportPr = true;
    ctx.commits = [{
      sha: '1234567890123456789012345678901234567890',
      html_url: 'https://github.com/test/repo/commit/1234567890123456789012345678901234567890',
      commit: { message: 'foo: backport fix\n\n(cherry picked from commit 0987654321098765432109876543210987654321)' }
    }];
    ctx.client.optionalApiCall = async (url) => {
      if (url.includes('/commits/0987654321098765432109876543210987654321')) {
        return { code: 500, raw: 'Internal Server Error' };
      }
      return { code: 200, raw: 'diff --git a/foo b/foo\n' };
    };

    const result = await resolvePatchesAndCommits(ctx);
    assert.strictEqual(result.upstreamComparisonSkips, 1);
    assert.ok(result.commitDetails[0].upstreamFetchError.includes('Could not fetch upstream commit'));
  });
});
