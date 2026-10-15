import { describe, test } from 'node:test';
import assert from 'node:assert';
import { runValidations } from '../../src/handlers/pull-request/validation.ts';
import { DEFAULT_CONFIG } from '../../src/config.js';

describe('runValidations error containment', () => {
  test('gracefully handles file fetching failures in UCI or patch validation without crashing with HTTP 500', async () => {
    const fakeFileBatchLoader = {
      fetchFileContentCached: async () => {
        throw new Error('GitHub API connection timeout');
      },
      isFileMissing: () => false,
      getRefSource: () => undefined,
      hasRefSource: () => false,
      setRefSource: () => {},
      getBudgetSkipCount: () => 0,
      getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
    };

    const mockCtx = {
      prNumber: 42,
      prTitle: 'test: update config',
      baseBranch: 'main',
      headSha: 'head123',
      baseSha: 'base123',
      isBackportPr: false,
      repoFullname: 'openwrt/openwrt',
      config: { ...DEFAULT_CONFIG, check_uci_config: true, check_patch_headers: 'warning' },
      configError: null,
      commitScanCapped: false,
      commitsCount: 1,
      commits: [],
      fileBatchLoader: fakeFileBatchLoader,
      getCommentsScanWithRetry: async () => null,
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    };

    const commitPatch = `
diff --git a/package/network/services/dropbear/files/dropbear.config b/package/network/services/dropbear/files/dropbear.config
--- a/package/network/services/dropbear/files/dropbear.config
+++ b/package/network/services/dropbear/files/dropbear.config
@@ -1,2 +1,3 @@
 config dropbear
+	option Port '2222'
`;

    const patchesResult = {
      usePrWidePatch: false,
      prPatch: null,
      commitDetails: [{
        sha: 'commit1234567890',
        html_url: 'https://github.com/openwrt/openwrt/commit/commit1234567890',
        fullCommit: {
          commit: {
            message: 'dropbear: update config\n\nSigned-off-by: Dev <dev@example.com>'
          }
        },
        commitPatch,
        isVerbatim: false
      }],
      packageState: { isNewPackage: false, isDroppedPackage: false }
    };

    // Before the fix, this threw an unhandled rejection because settled() returned the original rejecting promise
    const result = await runValidations(mockCtx, patchesResult);

    assert.ok(result);
    assert.strictEqual(Array.isArray(result.allPrWarnings), true);
    assert.ok(
      result.allPrWarnings.some(w => w.includes('Could not complete UCI config validation because of an error fetching file content')),
      'Warning should explain that UCI validation could not complete due to file fetch failure'
    );
  });
});
