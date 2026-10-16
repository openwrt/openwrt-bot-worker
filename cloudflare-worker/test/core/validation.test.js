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

  test('marks makefileChecksIncomplete when upstream Makefile check is incomplete', async () => {
    const fakeFileBatchLoader = {
      fetchFileContentCached: async () => null,
      isFileMissing: () => false,
      getRefSource: () => undefined,
      hasRefSource: () => false,
      setRefSource: () => {},
      getBudgetSkipCount: () => 0,
      getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
    };

    const mockCtx = {
      prNumber: 42,
      prTitle: 'foo: backport fix',
      baseBranch: 'main',
      headSha: 'head123',
      baseSha: 'base123',
      isBackportPr: true,
      repoFullname: 'openwrt/openwrt',
      config: { ...DEFAULT_CONFIG, check_conffiles: true },
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
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -20,2 +20,4 @@ define Package/foo/install
+\t$(INSTALL_DIR) $(1)/etc
+\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf
+`;
    const upstreamPatch = commitPatch;

    const patchesResult = {
      usePrWidePatch: false,
      prPatch: null,
      commitDetails: [{
        sha: 'commit1234567890',
        html_url: 'https://github.com/openwrt/openwrt/commit/commit1234567890',
        fullCommit: {
          commit: {
            message: 'foo: backport fix\n\n(cherry picked from commit 0987654321098765432109876543210987654321)'
          }
        },
        commitPatch,
        isVerbatim: false,
        upstreamPatch,
        upstreamSha: '0987654321098765432109876543210987654321'
      }],
      packageState: { isNewPackage: false, isDroppedPackage: false }
    };

    const result = await runValidations(mockCtx, patchesResult);
    assert.strictEqual(result.makefileChecksIncomplete, true);
  });

  test('marks makefileChecksIncomplete and adds warning when PR-wide patch series is truncated', async () => {
    const fakeFileBatchLoader = {
      fetchFileContentCached: async () => null,
      isFileMissing: () => false,
      getRefSource: () => undefined,
      hasRefSource: () => false,
      setRefSource: () => {},
      getBudgetSkipCount: () => 0,
      getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
    };

    const sha1 = '1111111111111111111111111111111111111111';
    const sha2 = '2222222222222222222222222222222222222222';
    const sha3 = '3333333333333333333333333333333333333333';

    const mockCtx = {
      prNumber: 42,
      prTitle: 'multi: three commits PR',
      baseBranch: 'main',
      headSha: sha3,
      baseSha: 'base123',
      isBackportPr: false,
      repoFullname: 'openwrt/openwrt',
      config: { ...DEFAULT_CONFIG },
      configError: null,
      commitScanCapped: false,
      commitsCount: 3,
      commits: [
        { sha: sha1, commit: { message: 'pkgA: first commit' } },
        { sha: sha2, commit: { message: 'pkgB: second commit' } },
        { sha: sha3, commit: { message: 'pkgC: third commit' } }
      ],
      fileBatchLoader: fakeFileBatchLoader,
      getCommentsScanWithRetry: async () => null,
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    };

    // prPatch only has 2 envelopes out of 3 commits (truncated patch series)
    const prPatch = `From ${sha1} Mon Sep 17 00:00:00 2001
Subject: [PATCH 1/3] pkgA: first commit

diff --git a/package/utils/pkgA/Makefile b/package/utils/pkgA/Makefile
--- a/package/utils/pkgA/Makefile
+++ b/package/utils/pkgA/Makefile
@@ -1,3 +1,3 @@
-PKG_RELEASE:=1
+PKG_RELEASE:=2

From ${sha2} Mon Sep 17 00:00:00 2001
Subject: [PATCH 2/3] pkgB: second commit

diff --git a/package/utils/pkgB/Makefile b/package/utils/pkgB/Makefile
--- a/package/utils/pkgB/Makefile
+++ b/package/utils/pkgB/Makefile
@@ -1,3 +1,3 @@
-PKG_RELEASE:=1
+PKG_RELEASE:=2
`;

    const patchesResult = {
      usePrWidePatch: true,
      prPatch,
      commitDetails: []
    };

    const result = await runValidations(mockCtx, patchesResult);
    assert.strictEqual(result.makefileChecksIncomplete, true);
    assert.ok(
      result.allPrWarnings.some(w => w.includes('PR-wide patch series') && w.includes('2/3 commits mapped')),
      'Should report warning about truncated PR-wide patch series'
    );
  });

  test('marks makefileChecksIncomplete and adds warning when multi-commit PR patch has <= 1 envelope', async () => {
    const fakeFileBatchLoader = {
      fetchFileContentCached: async () => null,
      isFileMissing: () => false,
      getRefSource: () => undefined,
      hasRefSource: () => false,
      setRefSource: () => {},
      getBudgetSkipCount: () => 0,
      getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
    };

    const sha1 = '1111111111111111111111111111111111111111';
    const sha2 = '2222222222222222222222222222222222222222';

    const mockCtx = {
      prNumber: 42,
      prTitle: 'multi: two commits PR',
      baseBranch: 'main',
      headSha: sha2,
      baseSha: 'base123',
      isBackportPr: false,
      repoFullname: 'openwrt/openwrt',
      config: { ...DEFAULT_CONFIG },
      configError: null,
      commitScanCapped: false,
      commitsCount: 2,
      commits: [
        { sha: sha1, commit: { message: 'pkgA: first commit' } },
        { sha: sha2, commit: { message: 'pkgB: second commit' } }
      ],
      fileBatchLoader: fakeFileBatchLoader,
      getCommentsScanWithRetry: async () => null,
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    };

    // prPatch has only 1 envelope out of 2 commits
    const prPatch = `From ${sha1} Mon Sep 17 00:00:00 2001
Subject: [PATCH 1/2] pkgA: first commit

diff --git a/package/utils/pkgA/Makefile b/package/utils/pkgA/Makefile
--- a/package/utils/pkgA/Makefile
+++ b/package/utils/pkgA/Makefile
@@ -1,3 +1,3 @@
-PKG_RELEASE:=1
+PKG_RELEASE:=2
`;

    const patchesResult = {
      usePrWidePatch: true,
      prPatch,
      commitDetails: []
    };

    const result = await runValidations(mockCtx, patchesResult);
    assert.strictEqual(result.makefileChecksIncomplete, true);
    assert.ok(
      result.allPrWarnings.some(w => w.includes('PR-wide patch series')),
      'Should report warning about inability to verify commit boundaries in PR-wide patch series'
    );
  });
});
