import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isValidName, validateFormalities, validateMakefileContext, validateEmbeddedPatches, validatePkgReleaseBumps } from '../src/validators.js';

// Mock Config Object
const CONFIG = {
  check_branch: true,
  check_merge_commits: true,
  check_noreply_email: true,
  check_signoff: true,
  check_signature: true,
  allow_autosquash: true,
  enable_comments: true,
  max_subject_len_soft: 60,
  max_subject_len_hard: 80,
  max_body_line_len: 100,
  warn_duplicate_body: true,
  warn_generic_subjects: true,
  require_release_notes: true,
  require_body: true,
  check_pkg_version: true,
  check_crlf: true,
  add_package_label: true,
  drop_package_label: true,
  branch_labeling: true,
  check_openwrt_meta: true,
  check_conffiles: true,
  check_patch_headers: true
};

// ─── Name Validation ─────────────────────────────────────────────

describe('isValidName', () => {
  test('accepts standard two-word names', () => {
    assert.strictEqual(isValidName('John Doe'), true);
  });

  test('accepts hyphenated names (e.g. Asian naming)', () => {
    assert.strictEqual(isValidName('Wei-Ting Yang'), true);
    assert.strictEqual(isValidName('Jean-Luc Picard'), true);
  });

  test('accepts names with apostrophes', () => {
    assert.strictEqual(isValidName("Brian O'Connor"), true);
  });

  test('accepts names with dots', () => {
    assert.strictEqual(isValidName('J. Doe'), true);
  });

  test('accepts Unicode characters (e.g. Nordic)', () => {
    assert.strictEqual(isValidName('Øyvind Sivertsen'), true);
  });

  test('rejects single-word names', () => {
    assert.strictEqual(isValidName('Linus'), false);
  });

  test('rejects names with underscores', () => {
    assert.strictEqual(isValidName('john_doe'), false);
  });

  test('rejects double spaces', () => {
    assert.strictEqual(isValidName('John  Doe'), false);
  });

  test('rejects leading/trailing whitespace', () => {
    assert.strictEqual(isValidName(' John Doe'), false);
    assert.strictEqual(isValidName('John Doe '), false);
  });

  test('rejects invalid characters (slashes, etc.)', () => {
    assert.strictEqual(isValidName('John/Doe'), false);
  });
});

// ─── Commit Formalities ──────────────────────────────────────────

describe('validateFormalities', () => {
  test('passes a fully valid commit', async () => {
    const commit = {
      parents: [{ sha: 'parent-sha' }],
      commit: {
        message: 'bash: update to 5.3 patch level 15\n\nAdd support for new upstream features.\nhttps://lists.gnu.org/archive/html/bug-bash/\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' },
        verification: { verified: true, key_id: 'GPGKEYID' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.length > 0);
  });

  test('catches empty commit message', async () => {
    const commit = {
      commit: {
        message: '',
        author: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.errors.some(e => e.includes('empty')));
  });

  test('catches noreply email and missing Signed-off-by', async () => {
    const commit = {
      commit: {
        message: 'bash: test subject line',
        author: { name: 'John Doe', email: 'john@noreply.github.com' },
        committer: { name: 'John Doe', email: 'john@noreply.github.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.errors.some(e => e.includes('noreply address')));
    assert.ok(res.errors.some(e => e.includes('Signed-off-by')));
  });

  test('rejects merge commits', async () => {
    const commit = {
      parents: [{ sha: 'parent-sha-1' }, { sha: 'parent-sha-2' }],
      commit: {
        message: 'bash: test subject line\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.errors.some(e => e.includes('Merge commits are not allowed')));
  });

  test('enforces soft and hard subject length limits', async () => {
    const commitHard = {
      commit: {
        message: 'bash: ' + 'a'.repeat(85),
        author: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const resHard = await validateFormalities(commitHard, CONFIG);
    assert.ok(resHard.errors.some(e => e.includes('exceeds hard limit')));

    const commitSoft = {
      commit: {
        message: 'bash: ' + 'a'.repeat(65),
        author: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const resSoft = await validateFormalities(commitSoft, CONFIG);
    assert.ok(resSoft.warnings.some(w => w.includes('exceeds soft limit')));
  });

  test('rejects commit with only Signed-off-by and no description', async () => {
    const commit = {
      commit: {
        message: 'mypkg: fix build issue\n\nSigned-off-by: Jane Smith <jane@example.com>',
        author: { name: 'Jane Smith', email: 'jane@example.com' },
        committer: { name: 'Jane Smith', email: 'jane@example.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.errors.some(e => e.includes('description body is empty')),
      `Expected empty body error but got: ${JSON.stringify(res.errors)}`);
  });

  test('warns when subject and body are semantically identical (e.g. mypkg: update to 1.2.3)', async () => {
    const commit = {
      commit: {
        message: 'mypkg: update to 1.2.3\n\n- Update MyPkg to v1.2.3\n\nSigned-off-by: Jane Smith <jane@example.com>',
        author: { name: 'Jane Smith', email: 'jane@example.com' },
        committer: { name: 'Jane Smith', email: 'jane@example.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.warnings.some(w => w.includes('identical or virtually identical')),
      `Expected duplicate warning but got: ${JSON.stringify(res.warnings)}`);
  });

  test('correctly extracts SSH key signature fingerprint without the footer tag', async () => {
    const commit = {
      commit: {
        message: 'mypkg: fix build issue\n\nSome description body text\n\nSigned-off-by: Jane Smith <jane@example.com>',
        author: { name: 'Jane Smith', email: 'jane@example.com' },
        committer: { name: 'Jane Smith', email: 'jane@example.com' },
        verification: {
          verified: true,
          reason: 'valid',
          signature: '-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAAAtteSBwdWJsaWNrZXk=\n-----END SSH SIGNATURE-----'
        }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    const successStr = res.successes.find(s => s.includes('cryptographic signature'));
    assert.ok(successStr, 'Expected cryptographic signature success message');
    assert.ok(successStr.includes('SSH Key Fingerprint: SHA256:+TBIvMqpQRHPC3Z8XrLcBD54NjV/OozKzSaDG13PLm0'),
      `Expected key details containing fingerprint but got: ${successStr}`);
  });
});

// ─── Makefile Context ────────────────────────────────────────────

describe('validateMakefileContext', () => {
  test('accepts version bump matching commit subject', () => {
    const commit = { commit: { message: 'bash: update to 5.3' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.3
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('catches version mismatch with commit subject', () => {
    const commit = { commit: { message: 'bash: update to 5.3' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.4
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes('PKG_VERSION')));
  });

  test('requires metadata fields for new packages', () => {
    const commit = { commit: { message: 'newpkg: add package' } };
    const patch = `
--- /dev/null
+++ b/package/newpkg/Makefile
@@ -0,0 +1,10 @@
+PKG_NAME:=newpkg
+PKG_VERSION:=1.0
+PKG_RELEASE:=1
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);
    assert.ok(res.errors.some(e => e.includes('PKG_MAINTAINER')));
    assert.ok(res.errors.some(e => e.includes('PKG_LICENSE')));
    assert.ok(res.errors.some(e => e.includes('PKG_LICENSE_FILES')));
    assert.ok(!res.errors.some(e => e.includes('PKG_VERSION')), 'PKG_VERSION should not be checked for new packages');
  });

  test('detects CRLF line endings', () => {
    const commit = { commit: { message: 'bash: test' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.3\r
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes('CRLF')));
  });

  test('does not enforce openwrt metadata on subsequent commits even if state.isNewPackage is true', () => {
    const commit1 = { commit: { message: 'newpkg: add package' } };
    const patch1 = `
--- /dev/null
+++ b/package/newpkg/Makefile
+PKG_NAME:=newpkg
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    // This call sets state.isNewPackage = true
    validateMakefileContext(commit1, patch1, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);

    const commit2 = { commit: { message: 'newpkg: update version to 1.0.0' } };
    const patch2 = `
--- a/package/newpkg/Makefile
+++ b/package/newpkg/Makefile
+PKG_VERSION:=1.0.0
    `;
    // This call should not complain about missing PKG_MAINTAINER, etc.
    const res = validateMakefileContext(commit2, patch2, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });
});

// ─── Embedded Patches ────────────────────────────────────────────

describe('validateEmbeddedPatches', () => {
  test('catches patches missing From/Subject headers', async () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
new file mode 100644
--- /dev/null
+++ b/package/utils/bash/patches/001-fix.patch
+Some diff without from and subject headers
    `;
    const res = await validateEmbeddedPatches(patch, CONFIG);
    assert.ok(res.errors.some(e => e.includes('Missing required Git header')));
  });

  test('accepts patches with valid From/Subject headers', async () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
new file mode 100644
--- /dev/null
+++ b/package/utils/bash/patches/001-fix.patch
+From: John Doe <john@doe.com>
+Subject: Fix compilation issue
+
+Details of the fix
    `;
    const res = await validateEmbeddedPatches(patch, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.length > 0);
  });

  test('skips validation for modified patches when fetch fails/not provided', async () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
--- a/package/utils/bash/patches/001-fix.patch
+++ b/package/utils/bash/patches/001-fix.patch
@@ -10,6 +10,6 @@
-old_code
+new_code
    `;
    const res = await validateEmbeddedPatches(patch, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('unable to fetch full file')));
  });

  test('accepts modified patches when fetched content has valid headers', async () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
--- a/package/utils/bash/patches/001-fix.patch
+++ b/package/utils/bash/patches/001-fix.patch
@@ -10,6 +10,6 @@
-old_code
+new_code
    `;
    const mockFetch = async (path) => {
      return `From: John Doe <john@doe.com>\nSubject: Fix compilation issue\n\nCode content`;
    };
    const res = await validateEmbeddedPatches(patch, CONFIG, mockFetch);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('contains valid Git compliance headers')));
  });

  test('catches missing headers in modified patches when fetched content lacks them', async () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
--- a/package/utils/bash/patches/001-fix.patch
+++ b/package/utils/bash/patches/001-fix.patch
@@ -10,6 +10,6 @@
-old_code
+new_code
    `;
    const mockFetch = async (path) => {
      return `Some content without headers`;
    };
    const res = await validateEmbeddedPatches(patch, CONFIG, mockFetch);
    assert.ok(res.errors.some(e => e.includes('Missing required Git header')));
  });
});

// ─── Package Release Bump Validation ─────────────────────────────

describe('validatePkgReleaseBumps', () => {
  const defaultConf = { ...CONFIG, check_pkg_release: 'warning' };

  test('skips checks when disabled', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+# modified init script
`
    }];
    const disabledConf = { ...defaultConf, check_pkg_release: false };
    const res = await validatePkgReleaseBumps(commitDetails, disabledConf, () => null, () => null);
    assert.strictEqual(res.errors.length, 0);
  });

  test('passes for new package with release 1', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/newpkg/Makefile b/package/utils/newpkg/Makefile
new file mode 100644
--- /dev/null
+++ b/package/utils/newpkg/Makefile
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/newpkg/Makefile') {
        return 'PKG_NAME:=newpkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async () => null; // didn't exist

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('correctly initializes PKG_RELEASE to 1')));
  });

  test('fails for new package with release not 1', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/newpkg/Makefile b/package/utils/newpkg/Makefile
new file mode 100644
--- /dev/null
+++ b/package/utils/newpkg/Makefile
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/newpkg/Makefile') {
        return 'PKG_NAME:=newpkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=2\n';
      }
      return null;
    };
    const baseFetch = async () => null;

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('must start with PKG_RELEASE set to 1')));
  });

  test('passes when existing package modified and PKG_RELEASE bumped', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+# tweak init
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=2\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('PKG_RELEASE bumped')));
  });

  test('fails when existing package files modified but PKG_RELEASE or version is not bumped', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+# tweak init
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('content changed without a PKG_RELEASE or version bump')));
  });

  test('passes when version updated and PKG_RELEASE reset to 1', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_VERSION:=5.2
+PKG_VERSION:=5.3
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=3\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('version updated to \'5.3\' and PKG_RELEASE correctly reset to 1')));
  });

  test('fails when version updated but PKG_RELEASE is not reset to 1', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_VERSION:=5.2
+PKG_VERSION:=5.3
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_RELEASE:=2\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=3\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('but PKG_RELEASE was not reset to 1')));
  });
});
