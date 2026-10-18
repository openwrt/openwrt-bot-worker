import { describe, test } from 'node:test';
import assert from 'node:assert';
import { runValidations } from '../../src/handlers/pull-request/validation.ts';
import { aggregateReport } from '../../src/handlers/pull-request/report.ts';
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
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
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

  // The caveat the report puts above a backport's findings is keyed off these
  // two flags, so what counts as a finding is pinned here: a patch header
  // reported under `check_patch_headers: warning` is one, and an audit that
  // could not read the file it had to check is not.
  test('records a finding reported as a warning, and a notice as none', async () => {
    const addedWithoutHeaders = `
diff --git a/package/network/services/dropbear/patches/010-fix.patch b/package/network/services/dropbear/patches/010-fix.patch
new file mode 100644
--- /dev/null
+++ b/package/network/services/dropbear/patches/010-fix.patch
@@ -0,0 +1,5 @@
+--- a/src/foo.c
++++ b/src/foo.c
+@@ -1 +1 @@
+-old
++new
`;
    const refreshedPatch = `
diff --git a/package/network/services/dropbear/patches/010-fix.patch b/package/network/services/dropbear/patches/010-fix.patch
--- a/package/network/services/dropbear/patches/010-fix.patch
+++ b/package/network/services/dropbear/patches/010-fix.patch
@@ -10,6 +10,6 @@
-old
+new
`;

    const mockCtx = (fetchFileContentCached) => ({
      prNumber: 42,
      prTitle: 'dropbear: touch a patch',
      baseBranch: 'main',
      headSha: 'head123',
      baseSha: 'base123',
      isBackportPr: false,
      repoFullname: 'openwrt/openwrt',
      config: { ...DEFAULT_CONFIG, check_patch_headers: 'warning' },
      configError: null,
      commitScanCapped: false,
      commitsCount: 1,
      commits: [],
      fileBatchLoader: {
        fetchFileContentCached,
        isFileMissing: () => false,
        getRefSource: () => undefined,
        hasRefSource: () => false,
        setRefSource: () => {},
        getBudgetSkipCount: () => 0,
        getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
      },
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    });

    const patchesResult = (commitPatch) => ({
      usePrWidePatch: false,
      prPatch: null,
      commitDetails: [{
        sha: 'commit1234567890',
        html_url: 'https://github.com/openwrt/openwrt/commit/commit1234567890',
        fullCommit: { commit: { message: 'dropbear: touch a patch\n\nSigned-off-by: Dev <dev@example.com>' } },
        commitPatch,
        isVerbatim: false
      }],
      packageState: { isNewPackage: false, isDroppedPackage: false }
    });

    const found = await runValidations(mockCtx(async () => null), patchesResult(addedWithoutHeaders));
    assert.strictEqual(found.allPatchesErrors.length, 0, 'the check is set to warn, so nothing fails');
    assert.match(found.patchesOutputText, /⚠️ Warning: Embedded patch file .* is missing .*mbox separator line/);
    assert.strictEqual(found.patchesReportedFinding, true, found.patchesOutputText);

    const unread = await runValidations(
      mockCtx(async () => { throw new Error('GitHub API connection timeout'); }),
      patchesResult(refreshedPatch)
    );
    assert.strictEqual(unread.patchChecksIncomplete, true);
    assert.match(unread.patchesOutputText, /could not be read, so its Git headers were not checked/);
    assert.strictEqual(unread.patchesReportedFinding, false,
      'an audit that could not read the file reported no finding, only the reason it could not');
    assert.strictEqual(unread.makefileReportedFinding, false);
  });

  // A gap is this run failing to read this commit's files, not something the
  // backport carried over, so the upstream filter leaves it alone. Dropping it
  // because the upstream read failed the same way left the check neutral with
  // nothing in its body saying why.
  test('keeps the gap that stopped a check when the upstream read hit the same one', async () => {
    const commitPatch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -20,2 +20,4 @@ define Package/foo/install
+\t$(INSTALL_DIR) $(1)/etc
+\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf
+`;

    const mockCtx = {
      prNumber: 42,
      prTitle: 'foo: backport fix',
      baseBranch: 'openwrt-24.10',
      headSha: 'head123',
      baseSha: 'base123',
      isBackportPr: true,
      repoFullname: 'openwrt/openwrt',
      config: { ...DEFAULT_CONFIG, check_conffiles: true, check_pkg_release: false, check_pkg_hash: false },
      configError: null,
      commitScanCapped: false,
      commitsCount: 1,
      commits: [],
      fileBatchLoader: {
        fetchFileContentCached: async () => null,
        isFileMissing: () => false,
        getRefSource: () => undefined,
        hasRefSource: () => false,
        setRefSource: () => {},
        getBudgetSkipCount: () => 0,
        getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
      },
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    };

    const result = await runValidations(mockCtx, {
      usePrWidePatch: false,
      prPatch: null,
      commitDetails: [{
        sha: 'commit1234567890',
        html_url: 'https://github.com/openwrt/openwrt/commit/commit1234567890',
        fullCommit: { commit: { message: 'foo: backport fix\n\n(cherry picked from commit 0987654321098765432109876543210987654321)' } },
        commitPatch,
        isVerbatim: false,
        upstreamPatch: commitPatch,
        upstreamSha: '0987654321098765432109876543210987654321'
      }],
      packageState: { isNewPackage: false, isDroppedPackage: false }
    });

    assert.strictEqual(result.makefileChecksIncomplete, true);
    assert.match(result.makefileOutputText, /⚠️ Warning: Could not fetch .* to verify conffiles section/,
      result.makefileOutputText);
    assert.ok(result.allPrWarnings.some(w => w.includes('to verify conffiles section')),
      result.allPrWarnings.join('\n'));
    assert.strictEqual(result.makefileReportedFinding, false,
      'a gap is not a finding, however it is reported');
  });

  // The wrappers that keep a throwing audit from answering 500 report the
  // failure the same way the audits do, so the sentence has to reach the body
  // and leave the finding flag alone.
  test('reports an audit that threw as a gap, not as a finding', async () => {
    const refreshedPatch = `
diff --git a/package/utils/foo/patches/010-fix.patch b/package/utils/foo/patches/010-fix.patch
--- a/package/utils/foo/patches/010-fix.patch
+++ b/package/utils/foo/patches/010-fix.patch
@@ -10,6 +10,6 @@
-old
+new
`;

    const mockCtx = {
      prNumber: 42,
      prTitle: 'foo: refresh a patch',
      baseBranch: 'main',
      headSha: 'head123',
      baseSha: 'base123',
      isBackportPr: false,
      repoFullname: 'openwrt/openwrt',
      config: { ...DEFAULT_CONFIG },
      configError: null,
      commitScanCapped: false,
      commitsCount: 1,
      commits: [],
      fileBatchLoader: {
        fetchFileContentCached: async () => null,
        // The audit asks whether the file is gone before it reports it
        // unreadable; the loader losing its own bookkeeping is what the
        // wrapper is there for.
        isFileMissing: () => { throw new Error('file state unavailable'); },
        getRefSource: () => undefined,
        hasRefSource: () => false,
        setRefSource: () => {},
        getBudgetSkipCount: () => 0,
        getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
      },
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    };

    const result = await runValidations(mockCtx, {
      usePrWidePatch: true,
      prPatch: refreshedPatch,
      commitDetails: [],
      packageState: { isNewPackage: false, isDroppedPackage: false }
    });

    assert.strictEqual(result.patchChecksIncomplete, true);
    assert.match(result.patchesOutputText, /⚠️ Warning: Could not complete embedded patch validation because of an error fetching file content/,
      result.patchesOutputText);
    assert.ok(result.allPrWarnings.some(w => w.includes('Could not complete embedded patch validation')),
      result.allPrWarnings.join('\n'));
    assert.strictEqual(result.patchesReportedFinding, false);
  });

  // The release and hash audits read the whole series, so one unusable entry
  // takes both of them down at once.
  test('reports the release and hash audits that threw as gaps', async () => {
    const mockCtx = {
      prNumber: 42,
      prTitle: 'foo: bump version',
      baseBranch: 'main',
      headSha: 'head123',
      baseSha: 'base123',
      isBackportPr: false,
      repoFullname: 'openwrt/openwrt',
      config: { ...DEFAULT_CONFIG },
      configError: null,
      commitScanCapped: false,
      commitsCount: 1,
      commits: [],
      fileBatchLoader: {
        fetchFileContentCached: async () => null,
        isFileMissing: () => false,
        getRefSource: () => undefined,
        hasRefSource: () => false,
        setRefSource: () => {},
        getBudgetSkipCount: () => 0,
        getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
      },
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    };

    const result = await runValidations(mockCtx, {
      usePrWidePatch: false,
      prPatch: null,
      commitDetails: [{
        sha: 'commit1234567890',
        html_url: 'https://github.com/openwrt/openwrt/commit/commit1234567890',
        fullCommit: { commit: { message: 'foo: bump version\n\nSigned-off-by: Dev <dev@example.com>' } },
        // Not a diff at all: the per-commit audits skip a verbatim backport,
        // but the release and hash audits still read the entry.
        commitPatch: {},
        isVerbatim: true
      }],
      packageState: { isNewPackage: false, isDroppedPackage: false }
    });

    assert.strictEqual(result.makefileChecksIncomplete, true);
    assert.match(result.makefileOutputText, /⚠️ Warning: Could not complete package release audit because of an error fetching file content/,
      result.makefileOutputText);
    assert.match(result.makefileOutputText, /⚠️ Warning: Could not complete package hash audit because of an error fetching file content/,
      result.makefileOutputText);
    assert.strictEqual(result.makefileReportedFinding, false);
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
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
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
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    };

    // prPatch only has 2 envelopes out of 3 commits (truncated patch series)
    const prPatch = `From ${sha1} Mon Sep 17 00:00:00 2001
From: Author <author@example.com>
Subject: [PATCH 1/3] pkgA: first commit

diff --git a/package/utils/pkgA/Makefile b/package/utils/pkgA/Makefile
--- a/package/utils/pkgA/Makefile
+++ b/package/utils/pkgA/Makefile
@@ -1,3 +1,3 @@
-PKG_RELEASE:=1
+PKG_RELEASE:=2

From ${sha2} Mon Sep 17 00:00:00 2001
From: Author <author@example.com>
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
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    };

    // prPatch has only 1 envelope out of 2 commits
    const prPatch = `From ${sha1} Mon Sep 17 00:00:00 2001
From: Author <author@example.com>
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

  test('marks makefileChecksIncomplete and adds warning when multi-commit PR patch has 0 envelopes', async () => {
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
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    };

    // prPatch has 0 envelopes (raw diff without From <sha> headers)
    const prPatch = `diff --git a/package/utils/pkgA/Makefile b/package/utils/pkgA/Makefile
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
      result.allPrWarnings.some(w => w.includes('PR-wide patch series') && w.includes('0/2 commits mapped')),
      'Should report warning about inability to verify commit boundaries in PR-wide patch series'
    );
  });

  // A feed in openwrt/packages layout keeps its packages at
  // <category>/<name>/..., which none of the Makefile and package prefixes
  // match. An unmappable series there was audited degraded all the same, with
  // no warning and no incomplete flag, so a revert in it reads as a change
  // that forgot its release bump.
  test('marks makefileChecksIncomplete and warns for an unmappable series in a feed layout', async () => {
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
      prTitle: 'foo: two commits in a feed',
      baseBranch: 'main',
      headSha: sha2,
      baseSha: 'base123',
      isBackportPr: false,
      repoFullname: 'openwrt/packages',
      config: { ...DEFAULT_CONFIG },
      configError: null,
      commitScanCapped: false,
      commitsCount: 2,
      commits: [
        { sha: sha1, commit: { message: 'foo: change the init script' } },
        { sha: sha2, commit: { message: 'bar: change the configuration' } }
      ],
      fileBatchLoader: fakeFileBatchLoader,
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    };

    // One envelope for two commits, and not a path any of the prefixes match.
    const prPatch = `From ${sha1} Mon Sep 17 00:00:00 2001
From: Author <author@example.com>
Subject: [PATCH 1/2] foo: change the init script

diff --git a/net/foo/files/foo.init b/net/foo/files/foo.init
--- a/net/foo/files/foo.init
+++ b/net/foo/files/foo.init
@@ -1,2 +1,2 @@
-old
+new
diff --git a/utils/bar/files/bar.conf b/utils/bar/files/bar.conf
--- a/utils/bar/files/bar.conf
+++ b/utils/bar/files/bar.conf
@@ -1,2 +1,2 @@
-old
+new
`;

    const result = await runValidations(mockCtx, { usePrWidePatch: true, prPatch, commitDetails: [] });

    assert.ok(
      result.allPrWarnings.some(w => w.includes('PR-wide patch series') && w.includes('1/2 commits mapped')),
      `a feed layout must report the degraded audit too: ${JSON.stringify(result.allPrWarnings)}`
    );
    assert.strictEqual(result.makefileChecksIncomplete, true);
  });

  // GitHub reports an empty commit as changing no files, and git format-patch
  // writes it into the series patch as headers with no diff. The split leaves
  // it out for exactly that reason, so every commit the audit was looking for
  // is still accounted for and there is nothing left unverified.
  test('maps a series in full when one commit changed no files', async () => {
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
      prTitle: 'multi: three commits, one of them empty',
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
        { sha: sha1, parents: [], changed_files: 1, commit: { message: 'pkgA: first commit' } },
        { sha: sha2, parents: [], changed_files: 1, commit: { message: 'pkgB: second commit' } },
        { sha: sha3, parents: [], changed_files: 0, commit: { message: 'pkgB: empty commit' } }
      ],
      fileBatchLoader: fakeFileBatchLoader,
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    };

    const prPatch = `From ${sha1} Mon Sep 17 00:00:00 2001
From: Author <author@example.com>
Subject: [PATCH 1/3] pkgA: first commit

diff --git a/package/utils/pkgA/Makefile b/package/utils/pkgA/Makefile
--- a/package/utils/pkgA/Makefile
+++ b/package/utils/pkgA/Makefile
@@ -1,3 +1,3 @@
-PKG_RELEASE:=1
+PKG_RELEASE:=2
From ${sha2} Mon Sep 17 00:00:00 2001
From: Author <author@example.com>
Subject: [PATCH 2/3] pkgB: second commit

diff --git a/package/utils/pkgB/Makefile b/package/utils/pkgB/Makefile
--- a/package/utils/pkgB/Makefile
+++ b/package/utils/pkgB/Makefile
@@ -1,3 +1,3 @@
-PKG_RELEASE:=1
+PKG_RELEASE:=2
From ${sha3} Mon Sep 17 00:00:00 2001
From: Author <author@example.com>
Subject: [PATCH 3/3] pkgB: empty commit

-- 
2.45.0
`;

    const result = await runValidations(mockCtx, { usePrWidePatch: true, prPatch, commitDetails: [] });

    assert.ok(
      !result.allPrWarnings.some(w => w.includes('PR-wide patch series')),
      `every commit the audit looked for was mapped: ${JSON.stringify(result.allPrWarnings)}`
    );
    assert.doesNotMatch(result.makefileOutputText, /Could not safely verify commit boundaries/);
    assert.strictEqual(result.makefileChecksIncomplete, false);
  });

  // In PR-wide mode no commit has a patch of its own, so the upstream patch
  // the audit fetched for the release filter was never compared with anything.
  test('does not report a deviation it never compared in PR-wide mode', async () => {
    const fakeFileBatchLoader = {
      fetchFileContentCached: async () => null,
      isFileMissing: () => false,
      getRefSource: () => undefined,
      hasRefSource: () => false,
      setRefSource: () => {},
      getBudgetSkipCount: () => 0,
      getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
    };

    const sha = 'a'.repeat(40);
    const upstreamSha = 'b'.repeat(40);
    const fullCommit = {
      sha,
      parents: [{ sha: 'parent' }],
      commit: { message: `foo: backport the fix\n\n(cherry picked from commit ${upstreamSha})` }
    };

    const mockCtx = {
      prNumber: 42,
      prTitle: '[24.10] foo: backport the fix',
      baseBranch: 'openwrt-24.10',
      headSha: sha,
      baseSha: 'base123',
      isBackportPr: true,
      repoFullname: 'openwrt/openwrt',
      config: { ...DEFAULT_CONFIG },
      configError: null,
      commitScanCapped: false,
      commitsCount: 1,
      commits: [fullCommit],
      fileBatchLoader: fakeFileBatchLoader,
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    };

    const prPatch = `diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -1,3 +1,3 @@
-PKG_RELEASE:=1
+PKG_RELEASE:=2
`;

    const result = await runValidations(mockCtx, {
      usePrWidePatch: true,
      prPatch,
      commitDetails: [{
        sha,
        html_url: `https://github.com/openwrt/openwrt/commit/${sha}`,
        fullCommit,
        commitPatch: null,
        isVerbatim: false,
        upstreamPatch: prPatch,
        upstreamSha,
        upstreamFetchError: null
      }],
      packageState: { isNewPackage: false, isDroppedPackage: false }
    });

    assert.doesNotMatch(result.formalityOutputText, /Backport diff deviates from upstream commit/,
      'no commit patch was fetched, so no diff was compared with the upstream one');
    assert.match(result.formalityOutputText, /audited as one diff/,
      `the commit section has to say what happened instead: ${result.formalityOutputText}`);
  });

  // The commit-message audit reads fields off a payload this code did not
  // build. A throw used to answer the webhook 500, which leaves the pull
  // request with no check-runs at all.
  test('contains a throw from the commit message audit instead of answering 500', async () => {
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
      prTitle: 'foo: a change',
      baseBranch: 'main',
      headSha: 'head123',
      baseSha: 'base123',
      isBackportPr: false,
      repoFullname: 'openwrt/openwrt',
      config: { ...DEFAULT_CONFIG },
      configError: null,
      commitScanCapped: false,
      commitsCount: 1,
      commits: [],
      fileBatchLoader: fakeFileBatchLoader,
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckWarning: null,
      branchCheckOutputText: ''
    };

    const patchesResult = {
      usePrWidePatch: false,
      prPatch: null,
      commitDetails: [{
        sha: 'commit1234567890',
        html_url: 'https://github.com/openwrt/openwrt/commit/commit1234567890',
        fullCommit: {
          commit: {
            message: 'foo: a change\n\nSigned-off-by: Dev <dev@example.com>',
            // A payload field the audit reads and the loop before it does not.
            get author() { throw new Error('malformed commit author'); }
          }
        },
        commitPatch: 'diff --git a/README.md b/README.md\n',
        isVerbatim: false
      }],
      packageState: { isNewPackage: false, isDroppedPackage: false }
    };

    const result = await runValidations(mockCtx, patchesResult);

    assert.strictEqual(result.formalityChecksIncomplete, true);
    assert.deepStrictEqual(result.allFormalityErrors, [], 'a check that could not run is not a check that failed');
    assert.ok(
      result.allPrWarnings.some(w => w.includes('Could not complete the commit message audit')),
      `the gap must be stated: ${JSON.stringify(result.allPrWarnings)}`
    );
  });

  test('reports an unreadable comment thread as an unchecked targeting rule', async () => {
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
      prTitle: 'foo: a change',
      baseBranch: 'main',
      headSha: 'head123',
      baseSha: 'base123',
      isBackportPr: false,
      repoFullname: 'openwrt/openwrt',
      config: { ...DEFAULT_CONFIG },
      configError: null,
      commitScanCapped: false,
      commitsCount: 0,
      commits: [],
      fileBatchLoader: fakeFileBatchLoader,
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: true }),
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckWarning: 'Pull request originates from protected branch `main`, but the comment thread could not be read in full',
      branchCheckOutputText: ''
    };

    const result = await runValidations(mockCtx, { usePrWidePatch: false, prPatch: null, commitDetails: [], packageState: { isNewPackage: false, isDroppedPackage: false } });

    assert.strictEqual(result.formalityChecksIncomplete, true);
    assert.deepStrictEqual(result.allFormalityErrors, []);
    assert.ok(result.allPrWarnings.some(w => w.includes('could not be read in full')));
  });
});

// The release audit reads the commit series. When the PR-wide patch cannot be
// split onto the listed commits, every per-commit entry would carry a null
// patch and the audit would read an empty diff, so the whole patch goes in as
// one entry and the validators split the mbox themselves.
describe('runValidations release audit in PR-wide mode', () => {
  test('audits the whole patch when the commit split did not cover the series', async () => {
    const makefile = 'include $(TOPDIR)/rules.mk\nPKG_NAME:=foo\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\ninclude $(INCLUDE_DIR)/package.mk\n';
    const files = { 'net/foo/Makefile': makefile };
    const fakeFileBatchLoader = {
      fetchFileContentCached: async (path) => (Object.hasOwn(files, path) ? files[path] : null),
      isFileMissing: () => false,
      getRefSource: () => undefined,
      hasRefSource: () => false,
      setRefSource: () => {},
      getBudgetSkipCount: () => 0,
      getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
    };

    const envelope = (sha, subject) => `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: John Doe <john@doe.com>\nDate: Mon, 1 Sep 2026 10:00:00 +0200\nSubject: [PATCH] ${subject}\n\nChange it.\n\nSigned-off-by: John Doe <john@doe.com>\n---\n`;
    const changeTo = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
    const prPatch = envelope('a'.repeat(40), 'foo: change the configuration') + changeTo('net/foo/files/etc/config/foo') +
      envelope('b'.repeat(40), 'foo: refresh the patch') + changeTo('net/foo/patches/010-fix.patch');

    // The listed commits are not the ones the patch carries, which is what a
    // force-push between the two requests looks like: nothing maps.
    const commits = [
      { sha: 'c'.repeat(40), parents: [{ sha: 'p1' }], changed_files: 1, commit: { message: 'foo: change the configuration' } },
      { sha: 'd'.repeat(40), parents: [{ sha: 'p2' }], changed_files: 1, commit: { message: 'foo: refresh the patch' } }
    ];

    const mockCtx = {
      prNumber: 7,
      prTitle: 'foo: update the configuration',
      baseBranch: 'main',
      headSha: 'head123',
      baseSha: 'base123',
      isBackportPr: false,
      repoFullname: 'openwrt/packages',
      config: { ...DEFAULT_CONFIG, check_pkg_release: 'error' },
      configError: null,
      commitScanCapped: false,
      commitsCount: commits.length,
      commits,
      fileBatchLoader: fakeFileBatchLoader,
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    };

    const result = await runValidations(mockCtx, {
      usePrWidePatch: true, prPatch, commitDetails: [], packageState: { isNewPackage: false, isDroppedPackage: false }
    });

    const reported = [...result.allMakefileErrors, ...result.allPrWarnings].join('\n');
    assert.match(reported, /without a .PKG_RELEASE. or version bump|commit boundaries/);
  });
});

// `commitScanCapped` says the commit listing is shorter than the count GitHub
// reported, which happens both when this run stopped paging and when GitHub
// counted commit records it then would not serve.
describe('runValidations on a commit listing shorter than the count', () => {
  const loader = {
    fetchFileContentCached: async () => null,
    isFileMissing: () => false,
    getRefSource: () => undefined,
    hasRefSource: () => false,
    setRefSource: () => {},
    getBudgetSkipCount: () => 0,
    getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
  };
  const ctxFor = (commitsCount, commitsPagingCapped, commits) => ({
    prNumber: 7,
    prTitle: 'mypkg: update',
    baseBranch: 'main',
    headSha: 'head',
    baseSha: 'base',
    isBackportPr: false,
    repoFullname: 'openwrt/packages',
    config: { ...DEFAULT_CONFIG, check_uci_config: false, check_pkg_release: false },
    configError: null,
    commitScanCapped: true,
    commitsPagingCapped,
    commitsCount,
    commits,
    fileBatchLoader: loader,
    getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
    isMaintainerUser: async () => false,
    isAuthorMaintainer: async () => false,
    branchCheckError: null,
    branchCheckOutputText: ''
  });
  const commit = (sha) => ({
    sha,
    html_url: `https://github.com/openwrt/packages/commit/${sha}`,
    parents: [{ sha: 'p' }],
    commit: { message: 'mypkg: update\n\nSigned-off-by: Dev <dev@example.com>' }
  });
  const patchesResult = {
    usePrWidePatch: false,
    prPatch: null,
    commitDetails: [],
    packageState: { isNewPackage: false, isDroppedPackage: false }
  };

  test('names the paging cap when pages were left unfetched', async () => {
    const res = await runValidations(ctxFor(412, true, [commit('a1')]), patchesResult);
    assert.match(res.formalityOutputText, /capped at 300 commits for API safety/);
    assert.ok(res.allPrWarnings.some(w => w.includes('capped at 300 commits')), res.allPrWarnings.join('\n'));
  });

  test('reports withheld records instead of the cap when every page was read', async () => {
    const res = await runValidations(ctxFor(2, false, [commit('a1')]), patchesResult);
    assert.doesNotMatch(res.formalityOutputText, /capped at 300 commits/);
    assert.match(res.formalityOutputText, /counted 2 commits for this pull request but served the records of 1, so 1 commit message\(s\) were not audited/);
  });
});

  // The caveat also belongs over a Makefile finding the repository chose to
  // have reported as a warning: it is still a finding, and still one the
  // upstream patch would have been compared against. An audit keeps the gaps
  // it hit out of `warnings` and in `notices`, which is what tells the two
  // apart here.
  describe('Makefile findings the configuration reports as warnings', () => {
    const noTrailingNewline = `
diff --git a/package/utils/foo/files/foo.sh b/package/utils/foo/files/foo.sh
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.sh
@@ -0,0 +1,2 @@
+#!/bin/sh
+echo hi
\\ No newline at end of file
`;

    const loader = (fetchFileContentCached) => ({
      fetchFileContentCached,
      isFileMissing: () => false,
      getRefSource: () => undefined,
      hasRefSource: () => false,
      setRefSource: () => {},
      getBudgetSkipCount: () => 0,
      getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
    });

    const ctxFor = (config, fetchFileContentCached = async () => null) => ({
      prNumber: 42,
      prTitle: 'foo: add a helper script',
      baseBranch: 'main',
      headSha: 'head123',
      baseSha: 'base123',
      isBackportPr: false,
      repoFullname: 'openwrt/openwrt',
      config: { ...DEFAULT_CONFIG, ...config },
      configError: null,
      commitScanCapped: false,
      commitsCount: 1,
      commits: [],
      fileBatchLoader: loader(fetchFileContentCached),
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      branchCheckError: null,
      branchCheckOutputText: ''
    });

    const perCommit = (commitPatch) => ({
      usePrWidePatch: false,
      prPatch: null,
      commitDetails: [{
        sha: 'commit1234567890',
        html_url: 'https://github.com/openwrt/openwrt/commit/commit1234567890',
        fullCommit: { commit: { message: 'foo: add a helper script\n\nSigned-off-by: Dev <dev@example.com>' } },
        commitPatch,
        isVerbatim: false
      }],
      packageState: { isNewPackage: false, isDroppedPackage: false }
    });

    test('records a per-commit finding the configuration downgraded to a warning', async () => {
      const res = await runValidations(ctxFor({ check_trailing_newline: 'warning' }), perCommit(noTrailingNewline));

      assert.strictEqual(res.allMakefileErrors.length, 0, 'the check is set to warn, so nothing fails');
      assert.match(res.makefileOutputText, /⚠️ Warning: File 'package\/utils\/foo\/files\/foo\.sh' is missing a trailing newline/);
      assert.strictEqual(res.makefileReportedFinding, true, res.makefileOutputText);
    });

    // GUARD, passes either way: the same finding at its default severity. The
    // flag must not depend on which of the two the configuration picked.
    test('records the same finding when it is reported as an error', async () => {
      const res = await runValidations(ctxFor({ check_trailing_newline: true }), perCommit(noTrailingNewline));

      assert.match(res.makefileOutputText, /❌ File 'package\/utils\/foo\/files\/foo\.sh' is missing a trailing newline/);
      assert.strictEqual(res.makefileReportedFinding, true);
    });

    // GUARD on the discriminator: a gap the audit reports instead of a finding
    // travels in `notices`, and must leave the flag alone.
    test('records no finding for an audit that only reports a gap', async () => {
      const unreadableConffiles = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -20,2 +20,4 @@ define Package/foo/install
+\t$(INSTALL_DIR) $(1)/etc/config
+\t$(INSTALL_CONF) ./files/foo.config $(1)/etc/config/foo
`;
      const res = await runValidations(
        ctxFor({ check_conffiles: true }, async () => null),
        perCommit(unreadableConffiles)
      );

      assert.strictEqual(res.makefileChecksIncomplete, true);
      assert.match(res.makefileOutputText, /⚠️ Warning: Could not /);
      assert.strictEqual(res.makefileReportedFinding, false, res.makefileOutputText);
    });

    test('records a PR-wide finding the configuration downgraded to a warning', async () => {
      const ctx = ctxFor({ check_trailing_newline: 'warning' });
      const res = await runValidations(ctx, {
        usePrWidePatch: true,
        prPatch: noTrailingNewline,
        commitDetails: [],
        packageState: { isNewPackage: false, isDroppedPackage: false }
      });

      assert.strictEqual(res.allMakefileErrors.length, 0);
      assert.match(res.makefileOutputText, /#### Pull Request Overall Diff:/);
      assert.match(res.makefileOutputText, /⚠️ Warning: File 'package\/utils\/foo\/files\/foo\.sh' is missing a trailing newline/);
      assert.strictEqual(res.makefileReportedFinding, true, res.makefileOutputText);
    });

    // One audit result can carry both at once: a finding the repository asked
    // to be reported as a warning, and a gap that stopped another of its
    // checks. Telling the two apart by `incomplete` read the gap as the whole
    // result and withheld the caveat over a finding that is what it is for.
    test('caveats a downgraded finding that shares its audit with a gap', async () => {
      const commitPatch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -20,2 +20,4 @@ define Package/foo/install
+\t$(INSTALL_DIR) $(1)/etc
+\t$(INSTALL_CONF) ./files/my.cnf $(1)/$(DYNAMIC_DEST)/my.cnf
diff --git a/package/utils/foo/files/my.cnf b/package/utils/foo/files/my.cnf
--- /dev/null
+++ b/package/utils/foo/files/my.cnf
@@ -0,0 +1 @@
+key = value
\\ No newline at end of file
`;
      // The head Makefile resolves the install path no better than the hunk,
      // so the conffiles check reports itself unable to judge coverage.
      const headMakefile = `
define Package/foo
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Foo
endef

define Package/foo/conffiles
/etc/my.cnf
endef
`;
      const ctx = {
        ...ctxFor({
          check_trailing_newline: 'warning',
          check_pkg_release: false,
          check_pkg_hash: false
        }, async () => headMakefile),
        prTitle: 'foo: backport a fix',
        baseBranch: 'openwrt-24.10',
        isBackportPr: true,
        repoFullname: 'openwrt/packages',
        client: { budget: { limit: 50, used: 10, reserve: 15 } }
      };

      const patchesResult = {
        usePrWidePatch: false,
        prPatch: null,
        patchUnavailable: false,
        upstreamComparisonSkips: 0,
        upstreamFetchFailures: 1,
        commitDetailsIncomplete: false,
        commitDetails: [{
          sha: 'commit1234567890',
          html_url: 'https://github.com/openwrt/packages/commit/commit1234567890',
          fullCommit: { commit: { message: 'foo: backport a fix\n\n(cherry picked from commit 0987654321098765432109876543210987654321)' } },
          commitPatch,
          isVerbatim: false,
          upstreamFetchError: 'Could not fetch upstream commit 0987654 from GitHub API (HTTP 404)'
        }],
        packageState: { isNewPackage: false, isDroppedPackage: false }
      };

      const outcome = await runValidations(ctx, patchesResult);

      assert.deepStrictEqual(outcome.allMakefileErrors, [],
        'the caveat below has to come from the finding, not from an error');
      assert.match(outcome.makefileOutputText, /⚠️ Warning: File .* is missing a trailing newline/);
      assert.match(outcome.makefileOutputText, /⚠️ Warning: Could not safely determine installed configuration path/);
      assert.strictEqual(outcome.makefileChecksIncomplete, true);
      assert.strictEqual(outcome.makefileReportedFinding, true, outcome.makefileOutputText);

      const report = aggregateReport(ctx, patchesResult, outcome);
      assert.match(report.makefileOutputText, /were not filtered out of the findings below/,
        report.makefileOutputText);
    });

    // The hash audit keeps its heuristic findings in `findings` and reports a
    // checksum turned off or left an MD5 through `warnings`; the notice that
    // it skipped the pull request altogether travels apart from both.
    test('records a hash finding reported as a warning', async () => {
      const hashTurnedOff = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -8,2 +8,2 @@
-PKG_HASH:=1111111111111111111111111111111111111111111111111111111111111111
+PKG_HASH:=skip
`;
      const head = `PKG_NAME:=foo\nPKG_VERSION:=1.0\nPKG_SOURCE_URL:=https://example.invalid/foo\nPKG_HASH:=skip\n`;
      const base = `PKG_NAME:=foo\nPKG_VERSION:=1.0\nPKG_SOURCE_URL:=https://example.invalid/foo\nPKG_HASH:=1111111111111111111111111111111111111111111111111111111111111111\n`;
      const res = await runValidations(
        ctxFor({}, async (_path, sha) => (sha === 'head123' ? head : base)),
        perCommit(hashTurnedOff)
      );

      assert.match(res.makefileOutputText, /#### Package Hash Audit:/);
      assert.match(res.makefileOutputText, /⚠️ Warning: PKG_HASH in 'package\/utils\/foo\/Makefile' is set to 'skip'/);
      assert.strictEqual(res.makefileReportedFinding, true, res.makefileOutputText);
    });
  });

// A patch file the pull request only edits, and that lacked its headers
// before it, is reported without failing the check.
describe('patch files older than the pull request', () => {
  const P = 'package/network/services/dropbear/patches/010-fix.patch';
  const UPSTREAM = '0987654321098765432109876543210987654321';
  const edit = `
diff --git a/${P} b/${P}
--- a/${P}
+++ b/${P}
@@ -10,6 +10,6 @@
-old
+new
`;
  const add = `
diff --git a/${P} b/${P}
new file mode 100644
--- /dev/null
+++ b/${P}
@@ -0,0 +1,1 @@
+no headers
`;

  const ctxFor = ({ fetch = async () => 'no headers', isBackportPr = false, config = {} } = {}) => ({
    prNumber: 42,
    prTitle: 'dropbear: touch a patch',
    baseBranch: isBackportPr ? 'openwrt-24.10' : 'main',
    headSha: 'head123',
    baseSha: 'base123',
    isBackportPr,
    repoFullname: 'openwrt/openwrt',
    config: { ...DEFAULT_CONFIG, check_pkg_release: false, check_pkg_hash: false, ...config },
    configError: null,
    commitScanCapped: false,
    commitsCount: 1,
    commits: [],
    fileBatchLoader: {
      fetchFileContentCached: fetch,
      isFileMissing: () => false,
      getRefSource: () => undefined,
      hasRefSource: () => false,
      setRefSource: () => {},
      getBudgetSkipCount: () => 0,
      getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
    },
    getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false }),
    isMaintainerUser: async () => false,
    isAuthorMaintainer: async () => false,
    branchCheckError: null,
    branchCheckOutputText: ''
  });

  const commit = (sha, commitPatch, extra = {}) => ({
    sha,
    html_url: `https://github.com/openwrt/openwrt/commit/${sha}`,
    fullCommit: { commit: { message: `dropbear: touch a patch\n\n(cherry picked from commit ${UPSTREAM})\nSigned-off-by: Dev <dev@example.com>` } },
    commitPatch,
    isVerbatim: false,
    upstreamPatch: null,
    upstreamSha: null,
    upstreamFetchError: null,
    ...extra
  });
  const perCommit = (...commitDetails) => ({
    usePrWidePatch: false,
    prPatch: null,
    commitDetails,
    packageState: { isNewPackage: false, isDroppedPackage: false }
  });

  test('reports one in the details and the comment, as a finding that does not fail', async () => {
    const res = await runValidations(ctxFor(), perCommit(commit('commit1234567890', edit)));

    assert.deepStrictEqual(res.allPatchesErrors, []);
    assert.match(res.patchesOutputText, /⚠️ Warning: Embedded patch file '.*010-fix\.patch' is missing .* It predates this pull request/);
    assert.ok(res.allPrWarnings.some(w => w.startsWith('**Commit [commit1]') && w.includes('predates this pull request')),
      res.allPrWarnings.join('\n'));
    assert.strictEqual(res.patchesReportedFinding, true, 'a contributor has to read it');
  });

  // The first half is what the second filters: without it the second passes
  // whether or not the warning is reported at all.
  test('drops a warning the upstream commit carries too, as it does an error', async () => {
    const own = await runValidations(ctxFor({ isBackportPr: true }), perCommit(commit('commit1234567890', edit)));
    assert.match(own.patchesOutputText, /predates this pull request/);

    const filtered = await runValidations(ctxFor({ isBackportPr: true }),
      perCommit(commit('commit1234567890', edit, { upstreamPatch: edit, upstreamSha: UPSTREAM })));
    assert.doesNotMatch(filtered.patchesOutputText, /predates this pull request/);
    assert.match(filtered.patchesOutputText, /Filtered out embedded patch issues already present in upstream commit/);
    assert.ok(!filtered.allPrWarnings.some(w => w.includes('predates this pull request')), filtered.allPrWarnings.join('\n'));
    assert.strictEqual(filtered.patchesReportedFinding, false);
  });

  // Per commit, the second commit's diff does not show that the first one
  // added the file; calling it older than the pull request would be untrue.
  test('holds a later commit editing a patch file an earlier one added to the rule', async () => {
    const res = await runValidations(ctxFor(), perCommit(commit('commit1111111111', add), commit('commit2222222222', edit)));

    assert.doesNotMatch(res.patchesOutputText, /predates this pull request/, res.patchesOutputText);
    const second = res.patchesOutputText.split('#### Commit [').find(s => s.startsWith('commit2'));
    assert.match(second, /❌ Embedded patch file '.*010-fix\.patch' is missing/, res.patchesOutputText);
  });

  test('reports one in a whole pull request under the overall diff', async () => {
    const res = await runValidations(ctxFor(), {
      usePrWidePatch: true,
      prPatch: edit,
      commitDetails: [],
      packageState: { isNewPackage: false, isDroppedPackage: false }
    });

    assert.deepStrictEqual(res.allPatchesErrors, []);
    assert.match(res.patchesOutputText, /#### Pull Request Overall Diff:\n[^#]*⚠️ Warning: Embedded patch file .* It predates this pull request/);
    assert.ok(res.allPrWarnings.some(w => w.startsWith('**Pull Request Overall Diff**') && w.includes('predates this pull request')),
      res.allPrWarnings.join('\n'));
    assert.strictEqual(res.patchesReportedFinding, true);
  });
  // With the check set to warn, an added patch's failure is reported the same
  // way as an older patch's warning: one block under the commit, not two, and
  // each line once with a single leading dash.
  test('reports every non-blocking finding of a commit in one block', async () => {
    const P2 = 'package/network/services/dropbear/patches/020-new.patch';
    const res = await runValidations(ctxFor({ config: { check_patch_headers: 'warning' } }),
      perCommit(commit('commit1234567890', edit + add.replaceAll(P, P2))));

    const blocks = res.allPrWarnings.filter(w => w.startsWith('**Commit [commit1]'));
    assert.strictEqual(blocks.length, 1, res.allPrWarnings.join('\n'));
    assert.match(blocks[0], /010-fix\.patch' is missing .* It predates this pull request/);
    assert.match(blocks[0], /020-new\.patch' is missing/);
    assert.doesNotMatch(blocks[0], /- ⚠️ - /, 'one dash per line');
    assert.deepStrictEqual(res.allPatchesErrors, [], 'nothing fails while the check is set to warn');
  });
});

describe('an input the run could not read', () => {
  const silentLoader = {
    fetchFileContentCached: async () => null,
    isFileMissing: () => false,
    getRefSource: () => undefined,
    hasRefSource: () => false,
    setRefSource: () => {},
    getBudgetSkipCount: () => 0,
    getFetchFailureCount: () => 0,
    getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
  };

  const COMMIT_MESSAGE = [
    'dropbear: tidy up the default config',
    '',
    'Make the shipped configuration readable before the port option is added.',
    '',
    'Signed-off-by: Jane Doe <jane@example.com>'
  ].join('\n');

  const cleanScan = (over = {}) => ({
    hasBranchBypassComment: false,
    hasCherryPickBypassComment: false,
    existingCommentId: null,
    incomplete: false,
    branchOverrideUnverified: false,
    cherryPickOverrideUnverified: false,
    ...over
  });

  const patchesResult = {
    usePrWidePatch: false,
    prPatch: null,
    patchUnavailable: false,
    upstreamComparisonSkips: 0,
    upstreamFetchFailures: 0,
    commitDetailsIncomplete: false,
    packageStateKnown: true,
    packageState: { isNewPackage: false, isDroppedPackage: false },
    commitDetails: [{
      sha: 'a'.repeat(40),
      html_url: 'https://github.com/openwrt/openwrt/commit/' + 'a'.repeat(40),
      fullCommit: {
        sha: 'a'.repeat(40),
        author: { login: 'janedoe' },
        committer: { login: 'janedoe' },
        parents: [{ sha: 'b'.repeat(40) }],
        commit: {
          message: COMMIT_MESSAGE,
          author: { name: 'Jane Doe', email: 'jane@example.com' },
          committer: { name: 'Jane Doe', email: 'jane@example.com' },
          verification: { verified: true, key_id: 'GPGKEYID' }
        }
      },
      commitPatch: [
        'diff --git a/docs/dropbear.md b/docs/dropbear.md',
        '--- a/docs/dropbear.md',
        '+++ b/docs/dropbear.md',
        '@@ -1,2 +1,3 @@',
        ' dropbear',
        '+a line',
        ''
      ].join('\n'),
      isVerbatim: false
    }]
  };

  const ctxFor = (over = {}) => ({
    prNumber: 42,
    prTitle: 'dropbear: tidy up the default config',
    baseBranch: 'main',
    headSha: 'head123',
    baseSha: 'base123',
    isBackportPr: false,
    repoFullname: 'openwrt/openwrt',
    config: { ...DEFAULT_CONFIG },
    configError: null,
    configPartial: false,
    configUnread: false,
    labelerUnread: false,
    commitScanCapped: false,
    commitsPagingCapped: false,
    commitsCount: 1,
    commits: [],
    fileBatchLoader: silentLoader,
    getCommentsScanWithRetry: async () => cleanScan(),
    isMaintainerUser: async () => false,
    isAuthorMaintainer: async () => false,
    bodyRequestsCherryPickBypass: false,
    branchCheckError: null,
    branchCheckWarning: null,
    branchCheckOutputText: '',
    client: { budget: { limit: 45, reserve: 15, used: 3 } },
    ...over
  });

  // The repository may have set a check to a warning, or switched it off. The
  // defaults that stood in for its config cannot carry a verdict, so all three
  // check-runs report what could be verified instead of a pass.
  test('a config the setup query could not read leaves all three audits incomplete', async () => {
    const ctx = ctxFor({ configUnread: true });
    const outcome = await runValidations(ctx, patchesResult);

    assert.strictEqual(outcome.allFormalityErrors.length, 0, 'nothing is actually wrong with this pull request');
    assert.strictEqual(outcome.formalityChecksIncomplete, true);
    assert.strictEqual(outcome.makefileChecksIncomplete, true);
    assert.strictEqual(outcome.patchChecksIncomplete, true);
    assert.ok(
      outcome.allPrWarnings.some(w => w.includes('.github/formalities.json') && w.includes('could not be read')),
      'and the pull request comment says which input was missing'
    );

    const report = aggregateReport(ctx, patchesResult, outcome);
    assert.strictEqual(report.formalityConclusion, 'neutral');
    assert.strictEqual(report.makefileConclusion, 'neutral');
    assert.strictEqual(report.patchesConclusion, 'neutral');
    // A check reporting neutral with nothing in its details saying why sends
    // the reader looking for a reason that is not there, so each of the three
    // bodies names the input that was missing.
    assert.match(report.formalityOutputText, /`\.github\/formalities\.json` in this repository could not be read/);
    assert.match(report.makefileOutputText, /`\.github\/formalities\.json` in this repository could not be read/);
    assert.match(report.patchesOutputText, /`\.github\/formalities\.json` in this repository could not be read/);
  });

  test('a config that is simply absent still concludes success', async () => {
    const ctx = ctxFor();
    const outcome = await runValidations(ctx, patchesResult);
    const report = aggregateReport(ctx, patchesResult, outcome);

    assert.strictEqual(report.formalityConclusion, 'success');
    assert.strictEqual(report.makefileConclusion, 'success');
    assert.strictEqual(report.patchesConclusion, 'success');
  });

  test('unreadable labeler rules are reported without moving any conclusion', async () => {
    const ctx = ctxFor({ labelerUnread: true, config: { ...DEFAULT_CONFIG, enable_labeler_yml: true } });
    const outcome = await runValidations(ctx, patchesResult);

    assert.ok(outcome.allPrWarnings.some(w => w.includes('.github/labeler.yml')));
    assert.strictEqual(aggregateReport(ctx, patchesResult, outcome).formalityConclusion, 'success');
  });

  // enable_labeler_yml defaults to false, so the noisy case is a repository
  // that switched the labeler off: no label was derived from the file either
  // way, and the file being unreadable changed nothing for it.
  test('a repository with the labeler switched off is not told its labeler file was unreadable', async () => {
    const ctx = ctxFor({ labelerUnread: true });
    const outcome = await runValidations(ctx, patchesResult);

    assert.strictEqual(ctx.config.enable_labeler_yml, false, 'the default this case is about');
    assert.ok(!outcome.allPrWarnings.some(w => w.includes('.github/labeler.yml')));
  });

  test('it is reported when whether the labeler is on is itself unreadable', async () => {
    const ctx = ctxFor({ labelerUnread: true, configUnread: true });
    const outcome = await runValidations(ctx, patchesResult);

    assert.ok(outcome.allPrWarnings.some(w => w.includes('.github/labeler.yml')));
  });

  // The cherry-pick rule, waived by `[allow cherry-pick]`, needs the same
  // answer the targeting rule gets in context.ts.
  test('an [allow cherry-pick] override from an unverifiable author leaves the marker unchecked', async () => {
    const ctx = ctxFor({
      isBackportPr: true,
      baseBranch: 'openwrt-24.10',
      getCommentsScanWithRetry: async () => cleanScan({ cherryPickOverrideUnverified: true })
    });
    const outcome = await runValidations(ctx, patchesResult);

    assert.strictEqual(outcome.allFormalityErrors.length, 0, 'the missing marker must not be reported as a failure');
    assert.strictEqual(outcome.formalityChecksIncomplete, true);
    assert.ok(outcome.allPrWarnings.some(w => w.includes('write access could not be verified')));
    assert.strictEqual(aggregateReport(ctx, patchesResult, outcome).formalityConclusion, 'neutral');
  });

  // The same question asked of the pull request description rather than a
  // comment: the resolver answers null, and null is not "no".
  test('an [allow cherry-pick] in the description from an unresolvable author leaves the marker unchecked', async () => {
    const ctx = ctxFor({
      isBackportPr: true,
      baseBranch: 'openwrt-24.10',
      bodyRequestsCherryPickBypass: true,
      isAuthorMaintainer: async () => null
    });
    const outcome = await runValidations(ctx, patchesResult);

    assert.strictEqual(outcome.allFormalityErrors.length, 0);
    assert.strictEqual(outcome.formalityChecksIncomplete, true);
    assert.ok(outcome.allPrWarnings.some(w => w.includes('write access could not be verified')));
    assert.strictEqual(aggregateReport(ctx, patchesResult, outcome).formalityConclusion, 'neutral');
  });

  test('a backport with no override at all still fails the cherry-pick rule', async () => {
    const ctx = ctxFor({ isBackportPr: true, baseBranch: 'openwrt-24.10' });
    const outcome = await runValidations(ctx, patchesResult);

    assert.ok(outcome.allFormalityErrors.some(e => e.includes('cherry picked from commit')));
    assert.strictEqual(aggregateReport(ctx, patchesResult, outcome).formalityConclusion, 'failure');
  });

  test('an [allow cherry-pick] override whose author is confirmed is honoured', async () => {
    const ctx = ctxFor({
      isBackportPr: true,
      baseBranch: 'openwrt-24.10',
      getCommentsScanWithRetry: async () => cleanScan({ hasCherryPickBypassComment: true })
    });
    const outcome = await runValidations(ctx, patchesResult);

    assert.strictEqual(outcome.allFormalityErrors.length, 0);
    assert.strictEqual(outcome.formalityChecksIncomplete, false);
    assert.strictEqual(aggregateReport(ctx, patchesResult, outcome).formalityConclusion, 'success');
  });
});
