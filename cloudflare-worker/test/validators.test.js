import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isValidName, validateFormalities, validateMakefileContext, validateEmbeddedPatches } from '../src/validators.js';

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
  test('passes a fully valid commit', () => {
    const commit = {
      parents: [{ sha: 'parent-sha' }],
      commit: {
        message: 'bash: update to 5.3 patch level 15\n\nAdd support for new upstream features.\nhttps://lists.gnu.org/archive/html/bug-bash/\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' },
        verification: { verified: true, key_id: 'GPGKEYID' }
      }
    };
    const res = validateFormalities(commit, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.length > 0);
  });

  test('catches empty commit message', () => {
    const commit = {
      commit: {
        message: '',
        author: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const res = validateFormalities(commit, CONFIG);
    assert.ok(res.errors.some(e => e.includes('empty')));
  });

  test('catches noreply email and missing Signed-off-by', () => {
    const commit = {
      commit: {
        message: 'bash: test subject line',
        author: { name: 'John Doe', email: 'john@noreply.github.com' },
        committer: { name: 'John Doe', email: 'john@noreply.github.com' }
      }
    };
    const res = validateFormalities(commit, CONFIG);
    assert.ok(res.errors.some(e => e.includes('noreply address')));
    assert.ok(res.errors.some(e => e.includes('Signed-off-by')));
  });

  test('rejects merge commits', () => {
    const commit = {
      parents: [{ sha: 'parent-sha-1' }, { sha: 'parent-sha-2' }],
      commit: {
        message: 'bash: test subject line\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const res = validateFormalities(commit, CONFIG);
    assert.ok(res.errors.some(e => e.includes('Merge commits are not allowed')));
  });

  test('enforces soft and hard subject length limits', () => {
    const commitHard = {
      commit: {
        message: 'bash: ' + 'a'.repeat(85),
        author: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const resHard = validateFormalities(commitHard, CONFIG);
    assert.ok(resHard.errors.some(e => e.includes('exceeds hard limit')));

    const commitSoft = {
      commit: {
        message: 'bash: ' + 'a'.repeat(65),
        author: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const resSoft = validateFormalities(commitSoft, CONFIG);
    assert.ok(resSoft.warnings.some(w => w.includes('exceeds soft limit')));
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
});

// ─── Embedded Patches ────────────────────────────────────────────

describe('validateEmbeddedPatches', () => {
  test('catches patches missing From/Subject headers', () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
+++ b/package/utils/bash/patches/001-fix.patch
+Some diff without from and subject headers
    `;
    const res = validateEmbeddedPatches(patch, CONFIG);
    assert.ok(res.errors.some(e => e.includes('Missing required Git header')));
  });

  test('accepts patches with valid From/Subject headers', () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
+++ b/package/utils/bash/patches/001-fix.patch
+From: John Doe <john@doe.com>
+Subject: Fix compilation issue
+
+Details of the fix
    `;
    const res = validateEmbeddedPatches(patch, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.length > 0);
  });
});
