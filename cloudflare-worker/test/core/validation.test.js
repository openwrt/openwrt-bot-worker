import { describe, test } from 'node:test';
import assert from 'node:assert';
import { runValidations } from '../../src/handlers/pull-request/validation.ts';
import { aggregateReport } from '../../src/handlers/pull-request/report.ts';
import { buildCheckRunPayloads } from '../../src/handlers/pull-request/check-run-report.ts';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { collectPackageMakefiles } from '../../src/validators.js';
import { resolvePatchesAndCommits } from '../../src/handlers/pull-request/patches.ts';

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
    assert.match(result.makefileOutputText, /⚠️ Warning: Could not complete package source pin audit because of an error fetching file content/,
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

    // The source pin audit has no errors of its own: every finding is graded
    // by check_pkg_source_pin, the way the hash audit grades its findings.
    describe('the package source pin audit', () => {
      const dottedDate = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -8,1 +8,1 @@
-PKG_SOURCE_DATE:=2025-10-06
+PKG_SOURCE_DATE:=2025.10.06
`;
      const abbreviated = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -8,1 +8,1 @@
+PKG_SOURCE_VERSION:=a1b2c3d
`;
      const quiet = { check_pkg_release: false, check_pkg_hash: false };

      test('reports a finding as a warning by default', async () => {
        const res = await runValidations(ctxFor(quiet), perCommit(dottedDate));
        assert.match(res.makefileOutputText, /#### Package Source Pin Audit:\n  ⚠️ Warning: PKG_SOURCE_DATE in 'package\/utils\/foo\/Makefile' is '2025\.10\.06'/, res.makefileOutputText);
        assert.ok(res.allPrWarnings.some(w => w.startsWith('**Package Source Pin Audit**:\n- ⚠️ PKG_SOURCE_DATE')), res.allPrWarnings.join('\n'));
        assert.deepStrictEqual(res.allMakefileErrors, []);
        assert.strictEqual(res.makefileReportedFinding, true);
        // The date stands on the patch alone; the unread head only drops the
        // version example from the wording.
        assert.ok(!res.makefileOutputText.includes('were not fully checked'), res.makefileOutputText);
      });

      test('reports a finding as an error when the repository asks for it', async () => {
        const res = await runValidations(ctxFor({ ...quiet, check_pkg_source_pin: 'error' }), perCommit(dottedDate));
        assert.ok(res.allMakefileErrors.some(e => e.startsWith('**Package Source Pin Audit**:\n- PKG_SOURCE_DATE')), res.allMakefileErrors.join('\n'));
        assert.match(res.makefileOutputText, /  ❌ PKG_SOURCE_DATE in 'package\/utils\/foo\/Makefile'/);
        assert.ok(!res.allPrWarnings.some(w => w.includes('Package Source Pin Audit')), res.allPrWarnings.join('\n'));
        assert.strictEqual(res.makefileReportedFinding, true);
      });

      test('reports an unread head as a gap, not as a finding', async () => {
        const res = await runValidations(ctxFor(quiet), perCommit(abbreviated));
        assert.match(res.makefileOutputText, /⚠️ Warning: Could not read 'package\/utils\/foo\/Makefile' at the head commit/, res.makefileOutputText);
        assert.strictEqual(res.makefileChecksIncomplete, true);
        assert.strictEqual(res.makefileReportedFinding, false);
      });

      test('reports a head read that throws as a gap', async () => {
        const res = await runValidations(ctxFor(quiet, async () => { throw new Error('loader exploded'); }), perCommit(abbreviated));
        assert.match(res.makefileOutputText, /⚠️ Warning: Could not complete package source pin audit because of an error fetching file content: loader exploded/, res.makefileOutputText);
        assert.strictEqual(res.makefileChecksIncomplete, true);
        assert.ok(!/Package Source Pin Audit:\n(  .*\n)*  ⚠️ Warning: PKG_SOURCE/.test(res.makefileOutputText), res.makefileOutputText);
      });
    });

    // Graded inside the audit by check_dts_checklist, 'warning' by default.
    describe('the device tree checklist', () => {
      const dts = 'target/linux/ramips/dts/mt7621_vendor_board.dts';
      const noHeader = `
diff --git a/${dts} b/${dts}
new file mode 100644
--- /dev/null
+++ b/${dts}
@@ -0,0 +1,4 @@
+#include "mt7621.dtsi"
+/ {
+	model = "Vendor Board";
+};
`;
      const modifiedDtsi = `
diff --git a/target/linux/ramips/dts/mt7621.dtsi b/target/linux/ramips/dts/mt7621.dtsi
--- a/target/linux/ramips/dts/mt7621.dtsi
+++ b/target/linux/ramips/dts/mt7621.dtsi
@@ -1,1 +1,1 @@
+	label = "green:lan";
`;

      test('reports a finding as a warning by default', async () => {
        const res = await runValidations(ctxFor({}), perCommit(noHeader));
        assert.match(res.makefileOutputText, /#### Device Tree Checklist:\n  ⚠️ Warning: New device tree 'target\/linux\/ramips\/dts\/mt7621_vendor_board\.dts' has no 'SPDX-License-Identifier' comment/, res.makefileOutputText);
        assert.ok(res.allPrWarnings.some(w => w.startsWith('**Device Tree Checklist**:\n- ⚠️ New device tree')), res.allPrWarnings.join('\n'));
        assert.deepStrictEqual(res.allMakefileErrors, []);
        assert.strictEqual(res.makefileReportedFinding, true);
        assert.strictEqual(res.makefileChecksIncomplete, false);
      });

      test('reports a finding as an error when the repository asks for it', async () => {
        const res = await runValidations(ctxFor({ check_dts_checklist: 'error' }), perCommit(noHeader));
        assert.ok(res.allMakefileErrors.some(e => e.startsWith('**Device Tree Checklist**:\n- New device tree')), res.allMakefileErrors.join('\n'));
        assert.match(res.makefileOutputText, /  ❌ New device tree 'target\/linux\/ramips\/dts\/mt7621_vendor_board\.dts'/);
        assert.ok(!res.allPrWarnings.some(w => w.includes('Device Tree Checklist')), res.allPrWarnings.join('\n'));
      });

      test('names a modified device tree in the check-run body only', async () => {
        const res = await runValidations(ctxFor({}), perCommit(modifiedDtsi));
        assert.match(res.makefileOutputText, /#### Device Tree Checklist:\n  ℹ️ The DTS checklist runs only on device trees a pull request adds, so the changes to 'target\/linux\/ramips\/dts\/mt7621\.dtsi' were not checked against it\./, res.makefileOutputText);
        assert.ok(!res.allPrWarnings.some(w => w.includes('Device Tree Checklist')), res.allPrWarnings.join('\n'));
        assert.strictEqual(res.makefileChecksIncomplete, false);
        assert.strictEqual(res.makefileReportedFinding, false);
      });

      test('says nothing on a pull request with no device tree', async () => {
        const res = await runValidations(ctxFor({}), perCommit(noTrailingNewline));
        assert.ok(!res.makefileOutputText.includes('Device Tree Checklist'), res.makefileOutputText);
        // GUARD: the same pull request adding a device tree gets the section.
        const withDts = await runValidations(ctxFor({}), perCommit(noTrailingNewline + noHeader));
        assert.ok(withDts.makefileOutputText.includes('#### Device Tree Checklist:'), withDts.makefileOutputText);
      });

      test('reports an audit that throws as a gap', async () => {
        const ctx = ctxFor({});
        Object.defineProperty(ctx.config, 'check_dts_checklist', { get() { throw new Error('config exploded'); } });
        const res = await runValidations(ctx, perCommit(noHeader));
        assert.match(res.makefileOutputText, /⚠️ Warning: Could not complete the device tree checklist because of an error fetching file content: config exploded/, res.makefileOutputText);
        assert.strictEqual(res.makefileChecksIncomplete, true);
      });
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

// The refresh rule grades its findings by check_patch_refresh, apart from the
// header rule, which check_patch_headers grades in the renderer.
describe('embedded patches the refresh target did not write', () => {
  const P = 'package/utils/foo/patches/010-fix.patch';
  // Headers git am reads, over a diff still in git's form.
  const gitFormatted = `
diff --git a/${P} b/${P}
new file mode 100644
--- /dev/null
+++ b/${P}
@@ -0,0 +1,10 @@
+From 0123456789012345678901234567890123456789 Mon Sep 17 00:00:00 2001
+From: A <a@b.c>
+Date: Mon, 1 Sep 2026 10:00:00 +0200
+Subject: [PATCH] fix
+---
+diff --git a/src/foo.c b/src/foo.c
+index 1234567..89abcde 100644
+--- a/src/foo.c
++++ b/src/foo.c
+@@ -1 +1 @@
`;
  // The same file without the git-am headers either.
  const bare = gitFormatted.replace(/^\+(?:From|Date|Subject).*\n/mg, '');
  const finding = /Embedded patch file 'package\/utils\/foo\/patches\/010-fix\.patch' carries a diff the buildroot's refresh target did not write/;

  const ctxFor = (config, over = {}) => ({
    prNumber: 42,
    prTitle: 'foo: add a fix',
    baseBranch: 'main',
    headSha: 'head123',
    baseSha: 'base123',
    isBackportPr: false,
    repoFullname: 'openwrt/openwrt',
    config: { ...DEFAULT_CONFIG, check_pkg_release: false, check_pkg_hash: false, ...config },
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
    isMaintainerUser: async () => false,
    isAuthorMaintainer: async () => false,
    branchCheckError: null,
    branchCheckOutputText: '',
    ...over
  });
  const perCommit = (commitPatch, extra = {}) => ({
    usePrWidePatch: false,
    prPatch: null,
    commitDetails: [{
      sha: 'commit1234567890',
      html_url: 'https://github.com/openwrt/openwrt/commit/commit1234567890',
      fullCommit: { commit: { message: 'foo: add a fix\n\nSigned-off-by: Dev <dev@example.com>' } },
      commitPatch,
      isVerbatim: false,
      ...extra
    }],
    packageState: { isNewPackage: false, isDroppedPackage: false }
  });

  test('reports a warning by default, and the patch check still passes', async () => {
    const ctx = ctxFor({});
    const patchesResult = perCommit(gitFormatted);
    const outcome = await runValidations(ctx, patchesResult);
    assert.deepStrictEqual(outcome.allPatchesErrors, []);
    assert.match(outcome.patchesOutputText, /  ⚠️ Warning: Embedded patch file .* carries a diff the buildroot's refresh target did not write/);
    assert.ok(outcome.allPrWarnings.some(w => /^- ⚠️ Embedded patch file .* refresh target did not write/m.test(w)), outcome.allPrWarnings.join('\n'));
    assert.strictEqual(outcome.patchesReportedFinding, true);
    assert.strictEqual(aggregateReport(ctx, patchesResult, outcome).patchesConclusion, 'success');
  });

  test('fails the patch check when the repository asks for an error', async () => {
    const ctx = ctxFor({ check_patch_refresh: true });
    const patchesResult = perCommit(gitFormatted);
    const outcome = await runValidations(ctx, patchesResult);
    assert.strictEqual(outcome.allPatchesErrors.length, 1);
    assert.match(outcome.allPatchesErrors[0], finding);
    assert.match(outcome.patchesOutputText, /  ❌ Embedded patch file .* refresh target did not write/);
    assert.strictEqual(aggregateReport(ctx, patchesResult, outcome).patchesConclusion, 'failure');
  });

  // check_patch_headers: warning turns the header rule's errors into
  // warnings; it has no say over the refresh rule's.
  test('keeps a refresh error an error when the header rule only warns', async () => {
    const outcome = await runValidations(ctxFor({ check_patch_headers: 'warning', check_patch_refresh: 'error' }), perCommit(bare));
    assert.strictEqual(outcome.allPatchesErrors.length, 1);
    assert.match(outcome.allPatchesErrors[0], finding);
    assert.doesNotMatch(outcome.allPatchesErrors[0], /is missing the 'From <commit hash>/);
    assert.match(outcome.patchesOutputText, /  ⚠️ Warning: Embedded patch file .* is missing the 'From <commit hash>/);
  });

  test('drops a warning the upstream commit of a backport carries too', async () => {
    const ctx = ctxFor({}, { isBackportPr: true, baseBranch: 'openwrt-24.10' });
    const backport = (upstreamPatch) => runValidations(ctx, perCommit(gitFormatted, {
      upstreamPatch,
      upstreamSha: '0987654321098765432109876543210987654321'
    }));

    const inherited = await backport(gitFormatted);
    assert.doesNotMatch(inherited.patchesOutputText, finding);
    assert.ok(!inherited.allPrWarnings.some(w => finding.test(w)), inherited.allPrWarnings.join('\n'));
    assert.strictEqual(inherited.patchesReportedFinding, false);

    // Upstream wrote the patch the way the refresh target does, so the
    // cherry-pick introduced the git header itself.
    const introduced = await backport(gitFormatted.replace(/^\+diff --git .*\n\+index .*\n/m, ''));
    assert.match(introduced.patchesOutputText, finding);
    assert.strictEqual(introduced.patchesReportedFinding, true);
  });

  test('reports a warning in a pull request audited as one diff', async () => {
    const commits = [{ sha: 'a'.repeat(40), parents: [{ sha: 'p' }], changed_files: 1, commit: { message: 'foo: add a fix' } }];
    const prPatch = `From ${'a'.repeat(40)} Mon Sep 17 00:00:00 2001\nFrom: A <a@b.c>\nDate: Mon, 1 Sep 2026 10:00:00 +0200\nSubject: [PATCH] foo: add a fix\n\n---\n${gitFormatted.slice(1)}`;
    const ctx = ctxFor({}, { commits, commitsCount: 1 });
    const patchesResult = { usePrWidePatch: true, prPatch, commitDetails: [], packageState: { isNewPackage: false, isDroppedPackage: false } };
    const outcome = await runValidations(ctx, patchesResult);
    assert.deepStrictEqual(outcome.allPatchesErrors, []);
    assert.match(outcome.patchesOutputText, /#### Pull Request Overall Diff:\n(?:  .*\n)*  ⚠️ Warning: Embedded patch file .* refresh target did not write/);
    assert.ok(outcome.allPrWarnings.some(w => w.startsWith('**Pull Request Overall Diff**:\n- ⚠️ Embedded patch file')), outcome.allPrWarnings.join('\n'));
    assert.strictEqual(outcome.patchesReportedFinding, true);
  });

  const checkRunOf = (ctx, patchesResult, outcome) =>
    buildCheckRunPayloads(aggregateReport(ctx, patchesResult, outcome), ctx.headSha)[2].payload;

  // A refresh warning is the patch check's finding like an older patch's
  // missing header: the check passes, and says it has something to read.
  test('titles a check whose only finding is a refresh warning as passed with warnings', async () => {
    const ctx = ctxFor({});
    const patchesResult = perCommit(gitFormatted);
    const check = checkRunOf(ctx, patchesResult, await runValidations(ctx, patchesResult));
    assert.strictEqual(check.conclusion, 'success');
    assert.strictEqual(check.output.title, 'Code Patches: Passed with warnings');
    assert.doesNotMatch(check.output.summary, /correct Git tracking headers/);
    assert.match(check.output.summary, /some carry warnings/);

    // The same patch with the rule off has nothing to warn about.
    const offCtx = ctxFor({ check_patch_refresh: false });
    const off = checkRunOf(offCtx, patchesResult, await runValidations(offCtx, patchesResult));
    assert.strictEqual(off.output.title, 'Code Patches: Passed');
  });

  test('does not call a check failed by a refresh error a header problem', async () => {
    const ctx = ctxFor({ check_patch_refresh: 'error' });
    const patchesResult = perCommit(gitFormatted);
    const check = checkRunOf(ctx, patchesResult, await runValidations(ctx, patchesResult));
    assert.strictEqual(check.conclusion, 'failure');
    assert.strictEqual(check.output.title, 'Code Patches: Failed');
    assert.doesNotMatch(check.output.summary, /Git headers/);
  });

  test('leaves a backport whose upstream commit has the same unrefreshed patch passing', async () => {
    const ctx = ctxFor({}, { isBackportPr: true, baseBranch: 'openwrt-24.10' });
    const patchesResult = perCommit(gitFormatted, {
      upstreamPatch: gitFormatted,
      upstreamSha: '0987654321098765432109876543210987654321'
    });
    const outcome = await runValidations(ctx, patchesResult);
    assert.deepStrictEqual(outcome.allPrWarnings.filter(w => w.includes('Embedded patch file')), []);
    assert.strictEqual(checkRunOf(ctx, patchesResult, outcome).output.title, 'Code Patches: Passed');
  });

  // One file breaking both rules: a line per rule, header rule first, each
  // at its own rule's level, and the non-blocking ones in one block.
  describe('a patch file that breaks both rules', () => {
    const headerLine = /Embedded patch file 'package\/utils\/foo\/patches\/010-fix\.patch' is missing the 'From <commit hash>/;
    const lines = (block) => block.split('\n').filter(l => l.startsWith('- '));

    test('fails on the headers of an added patch and warns about its diff', async () => {
      const ctx = ctxFor({});
      const patchesResult = perCommit(bare);
      const outcome = await runValidations(ctx, patchesResult);
      assert.strictEqual(outcome.allPatchesErrors.length, 1);
      assert.match(outcome.allPatchesErrors[0], headerLine);
      assert.doesNotMatch(outcome.allPatchesErrors[0], finding);
      const blocks = outcome.allPrWarnings.filter(w => w.startsWith('**Commit [commit1]'));
      assert.strictEqual(blocks.length, 1, outcome.allPrWarnings.join('\n'));
      assert.strictEqual(lines(blocks[0]).length, 1);
      assert.match(blocks[0], finding);
      assert.strictEqual(checkRunOf(ctx, patchesResult, outcome).output.title, 'Code Patches: Failed');
    });

    test('puts both lines in one block when the header rule only warns', async () => {
      const ctx = ctxFor({ check_patch_headers: 'warning' });
      const patchesResult = perCommit(bare);
      const outcome = await runValidations(ctx, patchesResult);
      assert.deepStrictEqual(outcome.allPatchesErrors, []);
      const blocks = outcome.allPrWarnings.filter(w => w.startsWith('**Commit [commit1]'));
      assert.strictEqual(blocks.length, 1, outcome.allPrWarnings.join('\n'));
      const [header, refresh, ...rest] = lines(blocks[0]);
      assert.deepStrictEqual(rest, []);
      assert.match(header, headerLine);
      assert.match(refresh, finding);
      assert.doesNotMatch(blocks[0], /- ⚠️ - /, 'one dash per line');
      assert.strictEqual(checkRunOf(ctx, patchesResult, outcome).output.title, 'Code Patches: Passed with warnings');
    });

    // An older patch file without headers that this change puts git's diff
    // header into: two warnings, in the same order as above.
    test('warns twice, in one block, about an older patch an edit puts a git diff into', async () => {
      const edit = `
diff --git a/${P} b/${P}
index 1111111..2222222 100644
--- a/${P}
+++ b/${P}
@@ -1,2 +1,7 @@
 fix foo

+diff --git a/src/foo.c b/src/foo.c
+index 1234567..89abcde 100644
+--- a/src/foo.c
++++ b/src/foo.c
+@@ -1 +1 @@
`;
      const file = 'fix foo\n\ndiff --git a/src/foo.c b/src/foo.c\nindex 1234567..89abcde 100644\n--- a/src/foo.c\n+++ b/src/foo.c\n@@ -1 +1 @@\n';
      const ctx = ctxFor({}, {
        fileBatchLoader: { ...ctxFor({}).fileBatchLoader, fetchFileContentCached: async (path) => (path === P ? file : null) }
      });
      const patchesResult = perCommit(edit);
      const outcome = await runValidations(ctx, patchesResult);
      assert.deepStrictEqual(outcome.allPatchesErrors, []);
      const blocks = outcome.allPrWarnings.filter(w => w.startsWith('**Commit [commit1]'));
      assert.strictEqual(blocks.length, 1, outcome.allPrWarnings.join('\n'));
      const [header, refresh, ...rest] = lines(blocks[0]);
      assert.deepStrictEqual(rest, []);
      assert.match(header, /010-fix\.patch' is missing .* It predates this pull request/);
      assert.match(refresh, finding);
      assert.doesNotMatch(blocks[0], /- ⚠️ - /, 'one dash per line');
      assert.strictEqual(checkRunOf(ctx, patchesResult, outcome).output.title, 'Code Patches: Passed with warnings');
    });
  });
});

// The release-branch rule asks the default branch's history about every
// package root the pull request adds. GitHub is reached through fetch here so
// the helper's own contract is what the tests run against: one POST whose
// query carries `history(`, answered or failed as each test needs.
describe('a new package on a release branch', { concurrency: 1 }, () => {
  const SHA = 'c'.repeat(40);
  const TRAILER = `(cherry picked from commit ${'d'.repeat(40)})`;
  const addMakefile = (path) => [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1,3 @@',
    '+include $(TOPDIR)/rules.mk',
    '+PKG_NAME:=foo',
    '+PKG_RELEASE:=1',
    ''
  ].join('\n');

  const loader = {
    fetchFileContentCached: async () => null,
    isFileMissing: () => false,
    getRefSource: () => undefined,
    hasRefSource: () => false,
    setRefSource: () => {},
    getBudgetSkipCount: () => 0,
    getFetchFailureCount: () => 0,
    getStats: () => ({ budgetSkipCount: 0, missingFilesCount: 0 })
  };

  const ctxFor = (config = {}, over = {}) => {
    const budget = { limit: 45, reserve: 15, used: over.used ?? 5 };
    const baseBranch = over.baseBranch ?? 'openwrt-24.10';
    return {
      prNumber: 30345,
      prTitle: over.prTitle ?? '51ddns-agent: add package',
      prBody: '',
      baseBranch,
      headSha: 'head123',
      baseSha: 'base123',
      isBackportPr: over.isBackportPr ?? true,
      repoFullname: 'openwrt/packages',
      token: 'token',
      config: { ...DEFAULT_CONFIG, ...config },
      configError: null,
      configPartial: false,
      configUnread: false,
      labelerUnread: false,
      commitScanCapped: false,
      commitsPagingCapped: false,
      commitsCount: 1,
      commits: over.commits ?? [],
      fileBatchLoader: loader,
      getCommentsScanWithRetry: async () => ({ hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null, incomplete: false, branchOverrideUnverified: false, cherryPickOverrideUnverified: false }),
      isMaintainerUser: async () => false,
      isAuthorMaintainer: async () => false,
      bodyRequestsCherryPickBypass: false,
      branchCheckError: null,
      branchCheckWarning: null,
      branchCheckOutputText: '',
      client: {
        budget,
        hasHeadroom: () => budget.limit - budget.reserve - budget.used > 0,
        countOptionalAttempt: () => { if (budget.limit - budget.reserve - budget.used <= 0) return false; budget.used++; return true; }
      },
      prData: { base: { ref: baseBranch, sha: 'base123', repo: { default_branch: over.defaultBranch ?? 'master' } } }
    };
  };

  const perCommit = (patch, message = `51ddns-agent: add package\n\nAdd the 51ddns agent.\n\nSigned-off-by: Jane Doe <jane@example.com>\n${TRAILER}`) => ({
    usePrWidePatch: false,
    prPatch: null,
    commitDetails: [{
      sha: SHA,
      html_url: `https://github.com/openwrt/packages/commit/${SHA}`,
      fullCommit: {
        sha: SHA,
        author: { login: 'janedoe' },
        committer: { login: 'janedoe' },
        parents: [{ sha: 'p' }],
        commit: {
          message,
          author: { name: 'Jane Doe', email: 'jane@example.com' },
          committer: { name: 'Jane Doe', email: 'jane@example.com' },
          verification: { verified: true, key_id: 'GPGKEYID' }
        }
      },
      commitPatch: patch,
      isVerbatim: false,
      upstreamPatch: null,
      upstreamSha: null,
      upstreamFetchError: null
    }],
    packageState: { isNewPackage: true, isDroppedPackage: false },
    addedPackageMakefiles: new Set(collectPackageMakefiles(patch, 'added')),
    removedPackageMakefiles: new Set(collectPackageMakefiles(patch, 'removed'))
  });

  // respond(body) -> { status, json | raw } for the history query; any other
  // request fetch is asked for fails the test.
  const withGitHub = async (respond, fn) => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const originalError = console.error;
    const queries = [];
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options?.body || '{}');
      if (!String(url).endsWith('/graphql') || !String(body.query || '').includes('history(')) {
        throw new Error(`unexpected request ${url}`);
      }
      queries.push(body);
      const { status, json, raw } = respond(body);
      return new Response(raw ?? JSON.stringify(json), { status });
    };
    console.warn = () => {};
    console.error = () => {};
    try {
      return { result: await fn(), queries };
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      console.error = originalError;
    }
  };
  // Every path asked about answered with `count(path)`.
  const history = (count, branch = 'master') => (body) => {
    const commit = {};
    for (const [k, v] of Object.entries(body.variables)) {
      if (/^p\d+$/.test(k)) commit[`c${k.slice(1)}`] = { totalCount: count(v) };
    }
    return { status: 200, json: { data: { repository: { defaultBranchRef: { name: branch }, object: commit } } } };
  };
  const SECTION = /#### New Package on a Release Branch:\n((?:  .*\n)*)/;
  const ownWarnings = (outcome) => outcome.allPrWarnings.filter(w => w.startsWith('**New Package on a Release Branch**'));

  test('warns, by default, about a package master has never carried', async () => {
    const { result: outcome, queries } = await withGitHub(history(() => 0),
      () => runValidations(ctxFor(), perCommit(addMakefile('net/51ddns-agent/Makefile'))));
    assert.strictEqual(queries.length, 1);
    assert.deepStrictEqual(queries[0].variables, { o: 'openwrt', n: 'packages', p0: 'net/51ddns-agent/Makefile' });
    const warnings = ownWarnings(outcome);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].startsWith('**New Package on a Release Branch**:\n- ⚠️ This pull request adds a package that has never existed on `master`: `net/51ddns-agent`.'), warnings[0]);
    assert.match(outcome.formalityOutputText, /#### New Package on a Release Branch:\n  ⚠️ Warning: Adds 1 package not present in 'master' history: net\/51ddns-agent\n/);
    assert.ok(!outcome.allFormalityErrors.some(e => e.includes('New Package')), outcome.allFormalityErrors.join('\n'));
    assert.strictEqual(outcome.formalityChecksIncomplete, false);
    // Above the commit blocks, with the pull request's other targeting rule.
    assert.ok(outcome.formalityOutputText.indexOf('#### New Package') < outcome.formalityOutputText.indexOf('#### Commit ['), outcome.formalityOutputText);
  });

  test('fails the pull request at "error" and at true', async () => {
    for (const level of ['error', true]) {
      const { result: outcome } = await withGitHub(history(() => 0),
        () => runValidations(ctxFor({ check_new_package_on_stable: level }), perCommit(addMakefile('net/51ddns-agent/Makefile'))));
      const errors = outcome.allFormalityErrors.filter(e => e.startsWith('**New Package on a Release Branch**'));
      assert.strictEqual(errors.length, 1, String(level));
      assert.ok(errors[0].startsWith('**New Package on a Release Branch**:\n- This pull request adds a package'), errors[0]);
      assert.match(outcome.formalityOutputText, /  ❌ Adds 1 package not present in 'master' history: net\/51ddns-agent\n/);
      assert.deepStrictEqual(ownWarnings(outcome), [], String(level));
    }
  });

  test('sends no query and says nothing when switched off', async () => {
    for (const level of [false, 'disabled']) {
      const { result: outcome, queries } = await withGitHub(history(() => 0),
        () => runValidations(ctxFor({ check_new_package_on_stable: level }), perCommit(addMakefile('net/51ddns-agent/Makefile'))));
      assert.strictEqual(queries.length, 0, String(level));
      assert.ok(!outcome.formalityOutputText.includes('New Package'), String(level));
      assert.deepStrictEqual(ownWarnings(outcome), []);
    }
    // Control: the default level asks.
    const { queries } = await withGitHub(history(() => 0), () => runValidations(ctxFor(), perCommit(addMakefile('net/51ddns-agent/Makefile'))));
    assert.strictEqual(queries.length, 1);
  });

  test('leaves a pull request to master titled as a backport alone', async () => {
    const { result: outcome, queries } = await withGitHub(history(() => 0),
      () => runValidations(ctxFor({}, { baseBranch: 'master', prTitle: '[24.10] foo: add new package', isBackportPr: true }), perCommit(addMakefile('net/foo/Makefile'))));
    assert.strictEqual(queries.length, 0);
    assert.ok(!outcome.formalityOutputText.includes('New Package'));
    assert.deepStrictEqual(ownWarnings(outcome), []);
    // Control: the same pull request based on the release branch is asked about.
    const control = await withGitHub(history(() => 0),
      () => runValidations(ctxFor({}, { prTitle: '[24.10] foo: add new package' }), perCommit(addMakefile('net/foo/Makefile'))));
    assert.strictEqual(control.queries.length, 1);
  });

  test('passes a backport of a package master already carries', async () => {
    const { result: outcome } = await withGitHub(history(() => 3, 'main'),
      () => runValidations(ctxFor({}, { defaultBranch: 'main' }), perCommit(addMakefile('lang/perl-future/Makefile'))));
    assert.match(outcome.formalityOutputText, /#### New Package on a Release Branch:\n  ✅ Packages added by this pull request already exist on 'main'\n/);
    assert.deepStrictEqual(ownWarnings(outcome), []);
    assert.strictEqual(outcome.formalityChecksIncomplete, false);
  });

  describe('a history query that came back without an answer', () => {
    const cases = [
      ['HTTP 502', () => ({ status: 502, raw: 'bad gateway' })],
      ['a missing alias', () => ({ status: 200, json: { data: { repository: { defaultBranchRef: { name: 'master' }, object: {} } } } })]
    ];
    for (const [name, respond] of cases) {
      test(`${name} leaves the rule unchecked and the check neutral, never "not on master"`, async () => {
        const ctx = ctxFor();
        const patches = perCommit(addMakefile('net/51ddns-agent/Makefile'));
        const { result: outcome } = await withGitHub(respond, () => runValidations(ctx, patches));
        const warnings = ownWarnings(outcome);
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /^\*\*New Package on a Release Branch\*\*:\n- ⚠️ Could not ask GitHub which packages 'master' carries \(GraphQL path history query/);
        assert.ok(!warnings[0].includes('never existed'), warnings[0]);
        assert.ok(!outcome.formalityOutputText.includes('not present in'), outcome.formalityOutputText);
        assert.ok(!outcome.allFormalityErrors.some(e => e.includes('New Package')));
        assert.strictEqual(outcome.formalityChecksIncomplete, true);
        assert.strictEqual(aggregateReport(ctx, patches, outcome).formalityConclusion, 'neutral');
      });
    }
  });

  test('sends no query once only the reserve is left', async () => {
    const { result: outcome, queries } = await withGitHub(history(() => 0),
      () => runValidations(ctxFor({}, { used: 30 }), perCommit(addMakefile('net/51ddns-agent/Makefile'))));
    assert.strictEqual(queries.length, 0);
    assert.match(outcome.formalityOutputText, /  ⚠️ Could not ask GitHub which packages 'master' carries \(no request budget left outside the reserve kept for the closing writes\)/);
    assert.strictEqual(outcome.formalityChecksIncomplete, true);
  });

  test('stands beside the cherry-pick rule without restating it', async () => {
    const ctx = ctxFor();
    const patches = perCommit(addMakefile('net/51ddns-agent/Makefile'), '51ddns-agent: add package\n\nAdd the 51ddns agent.\n\nSigned-off-by: Jane Doe <jane@example.com>');
    const { result: outcome } = await withGitHub(history(() => 0), () => runValidations(ctx, patches));
    assert.ok(outcome.allFormalityErrors.some(e => e.includes("must contain the context line: '(cherry picked from commit ...)'")), outcome.allFormalityErrors.join('\n'));
    const warnings = ownWarnings(outcome);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes('never existed on `master`'));
    assert.ok(!warnings[0].includes('cherry picked from commit'), warnings[0]);
    assert.strictEqual(aggregateReport(ctx, patches, outcome).formalityConclusion, 'failure');
  });

  // The same pull request, audited as one diff (more than 15 commits, and a
  // split that matched no commit, so none has a patch of its own) and commit
  // by commit, reports the same thing after asking once.
  test('reports the same in PR-wide and in per-commit mode', async () => {
    const shaOf = (i) => String(i + 1).padStart(40, 'a');
    const commitPart = (i, diff) => `From ${shaOf(i)} Mon Sep 17 00:00:00 2001\nFrom: Dev <dev@example.com>\nDate: Mon, 1 Sep 2026 10:00:00 +0200\nSubject: [PATCH] change ${i}\n\nSigned-off-by: Dev <dev@example.com>\n---\n${diff}`;
    const touch = (i) => `diff --git a/net/other/files/f${i} b/net/other/files/f${i}\n--- a/net/other/files/f${i}\n+++ b/net/other/files/f${i}\n@@ -1 +1 @@\n-a\n+b\n`;
    const series = (n, changedFiles) => {
      const commits = Array.from({ length: n }, (_, i) => ({
        sha: shaOf(i),
        html_url: `https://github.com/openwrt/packages/commit/${shaOf(i)}`,
        parents: [{ sha: 'p' }],
        changed_files: changedFiles,
        commit: { message: `change ${i}\n\nSigned-off-by: Dev <dev@example.com>` }
      }));
      const raw = commits.map((c, i) => commitPart(i, i === 1 ? addMakefile('net/51ddns-agent/Makefile') : touch(i))).join('');
      return { commits, raw };
    };
    const runSeries = async (n, changedFiles) => {
      const { commits, raw } = series(n, changedFiles);
      const ctx = ctxFor({}, { commits, isBackportPr: false });
      ctx.commitsCount = n;
      ctx.client.trackedApiCall = async () => ({ code: 404, raw: '' });
      ctx.client.optionalApiCall = async () => ({ code: 404, raw: '' });
      ctx.startPrPatchFetch = async () => ({ code: 200, raw, data: null, headers: { get: () => null } });
      ctx.prData.url = 'https://api.github.com/repos/openwrt/packages/pulls/30345';
      const patches = await resolvePatchesAndCommits(ctx);
      const { result, queries } = await withGitHub(history(() => 0), () => runValidations(ctx, patches));
      return { patches, outcome: result, queries };
    };

    const prWide = await runSeries(20, 2);
    assert.strictEqual(prWide.patches.usePrWidePatch, true);
    assert.ok(prWide.patches.commitDetails.every(c => c.commitPatch === null));
    const split = await runSeries(3, 1);
    assert.strictEqual(split.patches.usePrWidePatch, false);
    assert.ok(split.patches.commitDetails.every(c => typeof c.commitPatch === 'string'));

    for (const run of [prWide, split]) {
      assert.strictEqual(run.queries.length, 1);
      assert.deepStrictEqual(run.queries[0].variables, { o: 'openwrt', n: 'packages', p0: 'net/51ddns-agent/Makefile' });
      assert.strictEqual(ownWarnings(run.outcome).length, 1);
    }
    assert.deepStrictEqual(ownWarnings(prWide.outcome), ownWarnings(split.outcome));
    assert.strictEqual(prWide.outcome.formalityOutputText.match(SECTION)[0], split.outcome.formalityOutputText.match(SECTION)[0]);
  });
});
