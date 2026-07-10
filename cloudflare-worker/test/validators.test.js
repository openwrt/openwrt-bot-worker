import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isValidName, validateFormalities, validateMakefileContext, validateEmbeddedPatches, validatePkgReleaseBumps, findPkgRoot, validateUciConfigs } from '../src/validators.js';

// Mock Config Object
const CONFIG = {
  check_branch: true,
  check_merge_commits: true,
  check_noreply_email: true,
  check_signoff: true,
  check_signature: true,
  allow_autosquash: true,
  enable_comments: true,
  show_force_push_tip: true,
  max_subject_len_soft: 60,
  max_subject_len_hard: 80,
  max_body_line_len: 100,
  warn_duplicate_body: true,
  warn_generic_subjects: true,
  require_release_notes: true,
  require_body: true,
  check_pkg_version: true,
  check_crlf: true,
  check_trailing_newline: true,
  add_package_label: true,
  drop_package_label: true,
  branch_labeling: true,
  check_openwrt_meta: true,
  check_conffiles: true,
  check_patch_headers: true,
  require_linked_github_account: false,
  check_openwrt_spelling: true
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

  test('enforces body line length limit but ignores code blocks and URLs', async () => {
    // 1. Commit body line exceeds limit (CONFIG.max_body_line_len is 100)
    const commitLongLine = {
      commit: {
        message: 'bash: fix build issue\n\n' + 'a'.repeat(105) + '\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const resLongLine = await validateFormalities(commitLongLine, CONFIG);
    assert.ok(resLongLine.errors.some(e => e.includes('exceeds max width')), 'Should reject too long line in body');

    // 2. Commit body line exceeds limit but is inside a code block
    const commitCodeBlock = {
      commit: {
        message: 'bash: fix build issue\n\nOtherwise we get\n```\n' + 'a'.repeat(105) + '\n```\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const resCodeBlock = await validateFormalities(commitCodeBlock, CONFIG);
    assert.ok(!resCodeBlock.errors.some(e => e.includes('exceeds max width')), 'Should ignore long line in code block');

    // 3. Commit body line exceeds limit but contains a URL (checking uppercase HTTPS and git protocols)
    const commitWithUrl = {
      commit: {
        message: 'bash: fix build issue\n\nThis is a long line containing a URL: HTTPS://github.com/openwrt/openwrt-bot-worker/blob/4c90a2854344d1174d3c28a7b94c4ca324f13ce1/cloudflare-worker/src/validators.js#L1 which should be ignored\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const resWithUrl = await validateFormalities(commitWithUrl, CONFIG);
    assert.ok(!resWithUrl.errors.some(e => e.includes('exceeds max width')), 'Should ignore long line containing an uppercase HTTPS URL');

    const commitWithGitUrl = {
      commit: {
        message: 'bash: fix build issue\n\nThis is a long line containing a git URL: git://git.openwrt.org/feed/packages.git/some/path/which/is/very/long/and/exceeds/the/limit/completely\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const resWithGitUrl = await validateFormalities(commitWithGitUrl, CONFIG);
    assert.ok(!resWithGitUrl.errors.some(e => e.includes('exceeds max width')), 'Should ignore long line containing a git:// URL');
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

  test('passes when require_linked_github_account is true and author is linked to GitHub user', async () => {
    const commit = {
      author: { login: 'johndoe' }, // linked GitHub account
      commit: {
        message: 'mypkg: fix bug\n\nSome description text\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const customConfig = { ...CONFIG, require_linked_github_account: true };
    const res = await validateFormalities(commit, customConfig);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('fails when require_linked_github_account is true and author is not linked to GitHub user', async () => {
    const commit = {
      author: null, // not linked to GitHub account
      commit: {
        message: 'mypkg: fix bug\n\nSome description text\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const customConfig = { ...CONFIG, require_linked_github_account: true };
    const res = await validateFormalities(commit, customConfig);
    assert.ok(res.errors.some(e => e.includes('is not linked to any registered GitHub account')));
  });

  test('passes spelling check when OpenWrt or openwrt is used correctly', async () => {
    const commit = {
      commit: {
        message: 'mypkg: support OpenWrt properly\n\nWe love OpenWrt. Make sure it runs well under openwrt.\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(!res.warnings.some(w => w.includes('Incorrect capitalization of \'OpenWrt\'')));
  });

  test('warns on incorrect casing of OpenWrt (e.g. OpenWRT, Openwrt, OPENWRT)', async () => {
    const commit1 = {
      commit: {
        message: 'mypkg: support OpenWRT\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res1 = await validateFormalities(commit1, CONFIG);
    assert.ok(res1.warnings.some(w => w.includes('Incorrect capitalization of \'OpenWrt\' detected: \'OpenWRT\'')));

    const commit2 = {
      commit: {
        message: 'mypkg: fix compatibility\n\nThis is an Openwrt package.\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res2 = await validateFormalities(commit2, CONFIG);
    assert.ok(res2.warnings.some(w => w.includes('Incorrect capitalization of \'OpenWrt\' detected: \'Openwrt\'')));

    const commit3 = {
      commit: {
        message: 'mypkg: fix compatibility\n\nThis is for OPENWRT.\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res3 = await validateFormalities(commit3, CONFIG);
    assert.ok(res3.warnings.some(w => w.includes('Incorrect capitalization of \'OpenWrt\' detected: \'OPENWRT\'')));
  });

  test('ignores spelling check inside code blocks and URLs', async () => {
    const commit = {
      commit: {
        message: 'mypkg: fix spelling in code blocks\n\nLook at this error:\n```\nOpenWRT compiler error: Openwrt is missing\n```\nAlso check out https://github.com/OpenWRT/packages\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(!res.warnings.some(w => w.includes('Incorrect capitalization of \'OpenWrt\'')));
  });

  test('does not perform spelling check when disabled in config', async () => {
    const commit = {
      commit: {
        message: 'mypkg: support OpenWRT\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const customConfig = { ...CONFIG, check_openwrt_spelling: false };
    const res = await validateFormalities(commit, customConfig);
    assert.ok(!res.warnings.some(w => w.includes('Incorrect capitalization of \'OpenWrt\'')));
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

  test('supports custom metadata fields in check_openwrt_meta', () => {
    const commit = { commit: { message: 'newpkg: add package' } };
    const patch = `
--- /dev/null
+++ b/package/newpkg/Makefile
@@ -0,0 +1,10 @@
+PKG_NAME:=newpkg
+PKG_VERSION:=1.0
+PKG_RELEASE:=1
+PKG_MAINTAINER:=John Doe <john@doe.com>
     `;
    const customConfig = { ...CONFIG, check_openwrt_meta: ['PKG_MAINTAINER', 'PKG_LICENSE'] };
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, customConfig, state);
    assert.strictEqual(state.isNewPackage, true);
    // Should error for PKG_LICENSE (which is in the custom list but missing)
    assert.ok(res.errors.some(e => e.includes('PKG_LICENSE')));
    // Should NOT error for PKG_LICENSE_FILES (which is not in the custom list)
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE_FILES')));
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

  test('accepts PKG_MAINTAINER with valid email format', () => {
    const commit = { commit: { message: 'bash: test' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_MAINTAINER:=Jane Doe <jane.doe@example.com>
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('accepts multiple PKG_MAINTAINER names and emails', () => {
    const commit = { commit: { message: 'bash: test' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_MAINTAINER:=Jane Doe <jane.doe@example.com>, John Doe <john.doe@example.com>
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('rejects PKG_MAINTAINER with URL/website inside angle brackets', () => {
    const commit = { commit: { message: 'bash: test' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_MAINTAINER:=Jane Doe <https://example.com/janedoe>
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes('must be a valid email address and not a website/URL')));
  });

  test('rejects PKG_MAINTAINER without angle brackets / email', () => {
    const commit = { commit: { message: 'bash: test' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_MAINTAINER:=Jane Doe
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("should contain an email address inside angle brackets '<>'")));
  });

  test('accepts valid conffiles block with no indentation or space', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/foo.json
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('conffiles block contains no spaces or indentation')));
  });

  test('rejects conffiles block with space indentation', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+    /etc/foo.json
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("must not contain any spaces or indentation")));
  });

  test('rejects conffiles block with tab indentation', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+\t/etc/foo.json
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("must not contain any spaces or indentation")));
  });

  test('rejects conffiles block with spaces inside a line', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/foo.json 
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("must not contain any spaces or indentation")));
  });

  test('ignores files that are not Makefiles even if they contain conffiles block definitions', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/README.md b/package/utils/foo/README.md
--- a/package/utils/foo/README.md
+++ b/package/utils/foo/README.md
+define Package/foo/conffiles
+    /etc/foo.json
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('ignores deleted conffiles definitions when tracking state', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
-define Package/foo/conffiles
-/etc/foo.json
-endef
+define Package/foo/install
+	$(INSTALL_DIR) $(1)/usr/bin
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('rejects conffiles path that is not an absolute path', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+etc/foo.json
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("must be an absolute path starting with '/'")));
  });

  test('rejects conffiles path for known directory missing trailing slash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/config
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("is a directory and must end with a trailing slash '/'")));
  });

  test('rejects conffiles path for individual file ending with trailing slash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/config/foo/
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("is an individual file and must not end with a trailing slash")));
  });

  test('rejects conffiles path for individual file with extension ending with trailing slash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/foo.conf/
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("is an individual file and must not end with a trailing slash")));
  });

  test('rejects package that installs config files but is missing conffiles section', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/install
+	$(INSTALL_DIR) $(1)/etc/config
+	$(INSTALL_DATA) ./files/foo.config $(1)/etc/config/foo
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("Makefile installs configuration files under /etc/, but is missing the required 'conffiles' section")));
  });

  test('accepts package that installs config files and has conffiles section', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/config/foo
+endef
+define Package/foo/install
+	$(INSTALL_DIR) $(1)/etc/config
+	$(INSTALL_CONF) ./files/foo.config $(1)/etc/config/foo
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('accepts conffiles directory with trailing slash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/config/
+/etc/ssl/certs/
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('catches missing trailing newline on new/modified file additions as error by default', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- /dev/null
+++ b/package/utils/foo/Makefile
@@ -0,0 +1,1 @@
+PKG_NAME:=foo
\\ No newline at end of file
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const newlineTestConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: true
    };
    const res = validateMakefileContext(commit, patch, newlineTestConfig, state);
    assert.ok(res.errors.some(e => e.includes("missing a trailing newline")));
    assert.strictEqual(res.warnings.length, 0);
  });

  test('catches missing trailing newline as warning when check_trailing_newline is set to warning', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- /dev/null
+++ b/package/utils/foo/Makefile
@@ -0,0 +1,1 @@
+PKG_NAME:=foo
\\ No newline at end of file
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const newlineTestConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: 'warning'
    };
    const res = validateMakefileContext(commit, patch, newlineTestConfig, state);
    assert.ok(res.warnings.some(w => w.includes("missing a trailing newline")));
    assert.strictEqual(res.errors.length, 0);
  });

  test('does not report missing trailing newline when check_trailing_newline is disabled', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- /dev/null
+++ b/package/utils/foo/Makefile
@@ -0,0 +1,1 @@
+PKG_NAME:=foo
\\ No newline at end of file
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const newlineTestConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false
    };
    const res = validateMakefileContext(commit, patch, newlineTestConfig, state);
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0);
  });

  test('accepts files with trailing newline', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- /dev/null
+++ b/package/utils/foo/Makefile
@@ -0,0 +1,1 @@
+PKG_NAME:=foo
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const newlineTestConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: true
    };
    const res = validateMakefileContext(commit, patch, newlineTestConfig, state);
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0);
    assert.ok(res.successes.some(s => s.includes("All modified files contain a trailing newline")));
  });

  test('ignores missing trailing newline in pre-image (old version) when not present in post-image', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -1,1 +1,2 @@
-PKG_NAME:=foo
\\ No newline at end of file
+PKG_NAME:=foo
+PKG_VERSION:=1.0
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const newlineTestConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: true
    };
    const res = validateMakefileContext(commit, patch, newlineTestConfig, state);
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0);
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

  test('skips validation entirely when check_patch_headers is false', async () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
new file mode 100644
--- /dev/null
+++ b/package/utils/bash/patches/001-fix.patch
+Some diff without from and subject headers
    `;
    const disabledConf = { ...CONFIG, check_patch_headers: false };
    const res = await validateEmbeddedPatches(patch, disabledConf);
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.successes.length, 0);
  });

  test('skips validation entirely when check_patch_headers is disabled string', async () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
new file mode 100644
--- /dev/null
+++ b/package/utils/bash/patches/001-fix.patch
+Some diff without from and subject headers
    `;
    const disabledConf = { ...CONFIG, check_patch_headers: 'disabled' };
    const res = await validateEmbeddedPatches(patch, disabledConf);
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.successes.length, 0);
  });

  test('returns errors normally when check_patch_headers is warning (caller handles severity)', async () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
new file mode 100644
--- /dev/null
+++ b/package/utils/bash/patches/001-fix.patch
+Some diff without from and subject headers
    `;
    const warningConf = { ...CONFIG, check_patch_headers: 'warning' };
    const res = await validateEmbeddedPatches(patch, warningConf);
    assert.ok(res.errors.some(e => e.includes('Missing required Git header')));
  });

  test('returns errors normally when check_patch_headers is true', async () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
new file mode 100644
--- /dev/null
+++ b/package/utils/bash/patches/001-fix.patch
+Some diff without from and subject headers
    `;
    const errorConf = { ...CONFIG, check_patch_headers: true };
    const res = await validateEmbeddedPatches(patch, errorConf);
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
+exec bash
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

  test('passes when existing package files modified with only cosmetic changes', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+# just a comment edit
+
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
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('only minor/cosmetic updates')));
  });

  test('passes when Makefile modified with only minor metadata and download updates', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_MAINTAINER:=Old Maintainer
+PKG_MAINTAINER:=New Maintainer
-PKG_SOURCE_URL:=http://oldurl
+PKG_SOURCE_URL:=https://newurl
-PKG_HASH:=1234
+PKG_HASH:=5678
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
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('only minor/cosmetic updates')));
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

  test('skips checks when only test.sh or test-version.sh are modified', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/test.sh b/package/utils/bash/test.sh
+++ b/package/utils/bash/test.sh
+# add new tests
diff --git a/package/utils/bash/test-version.sh b/package/utils/bash/test-version.sh
+++ b/package/utils/bash/test-version.sh
+# test script updates
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
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('supports package/<pkg>/... layout directly without category prefix', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/iozone/files/iozone.init b/package/iozone/files/iozone.init
+++ b/package/iozone/files/iozone.init
+# modified config
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/iozone/Makefile') {
        return 'PKG_NAME:=iozone\nPKG_VERSION:=4.0\nPKG_RELEASE:=2\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/iozone/Makefile') {
        return 'PKG_NAME:=iozone\nPKG_VERSION:=4.0\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('version unchanged, but PKG_RELEASE bumped')));
  });

  test('supports deeply nested layouts like luci/libs/<pkg>/...', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/luci/libs/luci-lib-uqr/patches/001-fix.patch b/luci/libs/luci-lib-uqr/patches/001-fix.patch
+++ b/luci/libs/luci-lib-uqr/patches/001-fix.patch
+# patch file contents
`
    }];
    const headFetch = async (path) => {
      if (path === 'luci/libs/luci-lib-uqr/Makefile') {
        return 'PKG_NAME:=luci-lib-uqr\nPKG_VERSION:=1.0\nPKG_RELEASE:=2\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'luci/libs/luci-lib-uqr/Makefile') {
        return 'PKG_NAME:=luci-lib-uqr\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('version unchanged, but PKG_RELEASE bumped')));
  });

  test('skips checks when more than 15 package roots are modified', async () => {
    let patch = '';
    for (let i = 1; i <= 16; i++) {
      patch += `
diff --git a/package/utils/pkg${i}/Makefile b/package/utils/pkg${i}/Makefile
index 123456..789012 100644
--- a/package/utils/pkg${i}/Makefile
+++ b/package/utils/pkg${i}/Makefile
`;
    }
    const commitDetails = [{ commitPatch: patch }];

    let fetchCalled = false;
    const fetchFn = async () => {
      fetchCalled = true;
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, fetchFn, fetchFn);
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.successes.length, 0);
    assert.ok(res.warnings.some(w => w.includes('Package release bump audit skipped') && w.includes('16 packages')));
    assert.strictEqual(fetchCalled, false);
  });

  test('skips baseFetch call completely for new packages (avoiding unnecessary subrequests/404s)', async () => {
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
    const baseFetch = async () => {
      throw new Error('baseFetch should not be called for new packages!');
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('correctly initializes PKG_RELEASE to 1')));
  });

  test('skips headFetch call completely for deleted packages', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/oldpkg/Makefile b/package/utils/oldpkg/Makefile
deleted file mode 100644
--- a/package/utils/oldpkg/Makefile
+++ /dev/null
`
    }];
    const headFetch = async () => {
      throw new Error('headFetch should not be called for deleted packages!');
    };
    const baseFetch = async () => {
      return 'PKG_NAME:=oldpkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n';
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    // Since it's deleted, it skips check, so no errors and no successes
    assert.strictEqual(res.errors.length, 0);
  });
});

describe('findPkgRoot', () => {
  test('ignores category-level Makefiles and non-package paths but parses package paths correctly', async () => {
    // Category level Makefiles should be ignored (return null)
    assert.strictEqual(await findPkgRoot('package/utils/Makefile', null), null);
    assert.strictEqual(await findPkgRoot('utils/Makefile', null), null);
    assert.strictEqual(await findPkgRoot('package/Makefile', null), null);
    assert.strictEqual(await findPkgRoot('Makefile', null), null);

    // Standard package directories
    assert.strictEqual(await findPkgRoot('package/utils/bash/Makefile', null), 'package/utils/bash');
    assert.strictEqual(await findPkgRoot('package/utils/bash/src/main.c', null), 'package/utils/bash');
    assert.strictEqual(await findPkgRoot('package/utils/bash/patches/001-fix.patch', null), 'package/utils/bash');

    // Category-less package layout
    assert.strictEqual(await findPkgRoot('package/iozone/Makefile', null), 'package/iozone');
    assert.strictEqual(await findPkgRoot('package/iozone/files/iozone.init', null), 'package/iozone');

    // Normal feed layout
    assert.strictEqual(await findPkgRoot('utils/bash/Makefile', null), 'utils/bash');

    // Deeply nested feed layouts (luci/libs/<pkg>)
    assert.strictEqual(await findPkgRoot('luci/libs/luci-lib-uqr/Makefile', null), 'luci/libs/luci-lib-uqr');
    assert.strictEqual(await findPkgRoot('luci/libs/luci-lib-uqr/patches/001-fix.patch', null), 'luci/libs/luci-lib-uqr');

    // Hidden directories and special folders
    assert.strictEqual(await findPkgRoot('.github/workflows/check.yml', null), null);
  });

  test('resolves uncommon package category layout via Makefile fallback', async () => {
    const fetchFn = async (path) => {
      if (path === 'package/security/openssl/Makefile') {
        return 'PKG_NAME:=openssl\n';
      }
      return null;
    };

    assert.strictEqual(
      await findPkgRoot('package/security/openssl/files/openssl.conf', fetchFn, {}),
      'package/security/openssl'
    );
  });
});

// ─── UCI Config Validation ────────────────────────────────────────

describe('validateUciConfigs', () => {
  test('accepts valid UCI configurations (sections, options, lists, comments, empty lines)', async () => {
    const patch = `
diff --git a/package/utils/foo/files/foo.config b/package/utils/foo/files/foo.config
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.config
@@ -0,0 +1,10 @@
+# This is a comment
+package 'foo'
+
+config system 'main'
+\toption hostname 'OpenWrt'
+
+config timeserver 'ntp'
+\tlist server '0.openwrt.pool.ntp.org'
+\tlist server '1.openwrt.pool.ntp.org'
+    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return `
define Package/foo/install
\t$(INSTALL_CONF) ./files/foo.config $(1)/etc/config/foo
endef
        `;
      }
      if (path === 'package/utils/foo/files/foo.config') {
        return `
# This is a comment
package 'foo'

config system 'main'
\toption hostname 'OpenWrt'

config timeserver 'ntp'
\tlist server '0.openwrt.pool.ntp.org'
\tlist server '1.openwrt.pool.ntp.org'
        `;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('is a valid UCI configuration file')));
  });

  test('rejects raw TOML at etc/config path', async () => {
    const patch = `
diff --git a/package/utils/foo/files/foo.toml b/package/utils/foo/files/foo.toml
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.toml
@@ -0,0 +1,5 @@
+[foo]
+enabled = true
+hostname = "OpenWrt"
+    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return `
define Package/foo/install
\t$(INSTALL_CONF) ./files/foo.toml $(1)/etc/config/foo
endef
        `;
      }
      if (path === 'package/utils/foo/files/foo.toml') {
        return `
[foo]
enabled = true
hostname = "OpenWrt"
        `;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.ok(res.errors.some(e => e.includes('not a valid UCI configuration file')), `Expected error, got: ${JSON.stringify(res.errors)}`);
  });

  test('identifies etc/config file via conffiles block', async () => {
    const patch = `
diff --git a/package/utils/foo/files/foo.conf b/package/utils/foo/files/foo.conf
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.conf
    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return `
define Package/foo/conffiles
/etc/config/foo
endef
        `;
      }
      if (path === 'package/utils/foo/files/foo.conf') {
        // Not valid UCI
        return `invalid_key = "value"`;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.ok(res.errors.some(e => e.includes("destined for '/etc/config/' but is not a valid UCI")), `Expected error, got: ${JSON.stringify(res.errors)}`);
  });

  test('ignores shell scripts and init scripts', async () => {
    const patch = `
diff --git a/package/utils/foo/files/foo.init b/package/utils/foo/files/foo.init
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.init
    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return `
define Package/foo/install
\t$(INSTALL_BIN) ./files/foo.init $(1)/etc/init.d/foo
endef
        `;
      }
      if (path === 'package/utils/foo/files/foo.init') {
        return `#!/bin/sh\n/etc/rc.common\n`;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.strictEqual(res.errors.length, 0);
  });

  test('ignores configuration files installed to other locations (e.g. /etc/foo/)', async () => {
    const patch = `
diff --git a/package/utils/foo/files/foo.conf b/package/utils/foo/files/foo.conf
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.conf
    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return `
define Package/foo/install
\t$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo/foo.conf
endef
        `;
      }
      if (path === 'package/utils/foo/files/foo.conf') {
        return `raw_config_key: raw_value\n`;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.strictEqual(res.errors.length, 0);
  });

  test('directly recognizes files with /etc/config/ in path', async () => {
    const patch = `
diff --git a/package/utils/foo/files/etc/config/foo b/package/utils/foo/files/etc/config/foo
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/etc/config/foo
    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return 'PKG_NAME:=foo\n';
      }
      if (path === 'package/utils/foo/files/etc/config/foo') {
        return 'invalid_line';
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.ok(res.errors.some(e => e.includes("destined for '/etc/config/' but is not a valid UCI")));
  });

  test('skips checks when check_uci_config is false', async () => {
    const patch = `
diff --git a/package/utils/foo/files/etc/config/foo b/package/utils/foo/files/etc/config/foo
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/etc/config/foo
    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/files/etc/config/foo') {
        return 'invalid_line';
      }
      return null;
    };

    const disabledConfig = { ...CONFIG, check_uci_config: false };
    const res = await validateUciConfigs(patch, disabledConfig, fetchFn);
    assert.strictEqual(res.errors.length, 0);
  });
});
