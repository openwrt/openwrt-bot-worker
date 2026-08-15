import { describe, test } from 'node:test';
import assert from 'node:assert';
import { SPDX_LICENSE_IDS, SPDX_EXCEPTION_IDS, SPDX_DEPRECATED, SPDX_LICENSE_LIST_VERSION } from '../src/spdx-licenses.js';
import { isValidName, parseRevertSubject, parseRevertCommit, validateFormalities, validateMakefileContext, validateEmbeddedPatches, validatePkgReleaseBumps, checkSpdxIdentifier, findPkgRoot, validateUciConfigs, isPackageMakefilePath, groupReleaseErrors } from '../src/validators.js';

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
  check_pkg_name_reuse: true,
  check_buildbot_default: 'warning',
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

  test('passes GitHub web UI commit with valid author identity', async () => {
    const commit = {
      parents: [{ sha: 'parent-sha' }],
      commit: {
        message: 'mwan3: add configurable nslookup name\n\nAllow the config to specify a name.\n\nSigned-off-by: Alice B. Cooper <alice@example.com>',
        author: { name: 'Alice B. Cooper', email: 'alice@example.com' },
        committer: { name: 'GitHub', email: 'noreply@github.com' },
        verification: { verified: true, key_id: 'GPGKEYID' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(!res.errors.some(e => e.includes('Committer name format is invalid')), `Should not reject GitHub web commit committer name, got: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes('noreply address')), `Should not reject GitHub web commit noreply email, got: ${res.errors.join(', ')}`);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('still catches invalid author name in GitHub web UI commit', async () => {
    const commit = {
      parents: [{ sha: 'parent-sha' }],
      commit: {
        message: 'mwan3: test\n\nSigned-off-by: badname <bad@example.com>',
        author: { name: 'badname', email: 'bad@example.com' },
        committer: { name: 'GitHub', email: 'noreply@github.com' },
        verification: { verified: true, key_id: 'GPGKEYID' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.errors.some(e => e.includes('Author name format is invalid')), `Should still reject invalid author name in web commit`);
    assert.ok(!res.errors.some(e => e.includes('Committer name format is invalid')), `Should not reject GitHub web commit committer name`);
  });

  test('recognizes a web commit by the account GitHub resolved the committer to', async () => {
    const commit = {
      parents: [{ sha: 'parent-sha' }],
      author: { login: 'alice' },
      committer: { login: 'web-flow' },
      commit: {
        message: 'mwan3: add configurable nslookup name\n\nAllow the config to specify a name.\n\nSigned-off-by: Alice B. Cooper <alice@example.com>',
        author: { name: 'Alice B. Cooper', email: 'alice@example.com' },
        committer: { name: 'GitHub', email: 'noreply@github.com' },
        verification: { verified: true, key_id: 'GPGKEYID' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('committed through the GitHub web interface')));
  });

  test('GitHub web commit SOB matches only against author, not committer', async () => {
    const commit = {
      parents: [{ sha: 'parent-sha' }],
      commit: {
        message: 'mwan3: add test feature\n\nSome body text.\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'GitHub', email: 'noreply@github.com' },
        verification: { verified: true, key_id: 'GPGKEYID' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(e => e.includes('Signed-off-by')));
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

  test('measures the subject length without the autosquash marker', async () => {
    // The `fixup! ` marker disappears when the commit is squashed, so the
    // subject it is applied to keeps the full length budget.
    const subject = 'bash: ' + 'a'.repeat(54);
    assert.strictEqual(subject.length, CONFIG.max_subject_len_soft);
    const commit = {
      commit: {
        message: 'fixup! ' + subject + '\n\nCorrects the build flags.\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(!res.warnings.some(w => w.includes('exceeds soft limit')), `Unexpected warnings: ${res.warnings.join(', ')}`);
  });

  test('enforces body line length limit but ignores code blocks and URLs', async () => {
    // 1. Commit body line exceeds limit (CONFIG.max_body_line_len is 100)
    // with ordinary words, so wrapping it under the limit is possible
    const commitLongLine = {
      commit: {
        message: 'bash: fix build issue\n\n' + 'wrappable words '.repeat(8) + '\n\nSigned-off-by: John Doe <john@doe.com>',
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

  test('allows long body lines that cannot be wrapped under the limit', async () => {
    // A verbatim build error quoting a path longer than the limit — no line
    // break can bring it under 100 chars, and breaking inside the path would
    // corrupt the quoted log (openwrt/openwrt#21794).
    const logLine = "ERROR: module '/home/user/Development/OpenWrt/openwrt/build_dir/target-powerpc64_e5500_musl/linux-qoriq_generic/linux-6.12.67/net/ipv6/netfilter/ip6_tables.ko' is missing.";
    const commitLogLine = {
      commit: {
        message: `netfilter: add missing symbol\n\nBuild fails with:\n\n${logLine}\n\nSigned-off-by: John Doe <john@doe.com>`,
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const resLogLine = await validateFormalities(commitLogLine, CONFIG);
    assert.ok(!resLogLine.errors.some(e => e.includes('exceeds max width')), 'Should ignore a line whose overflow comes from an unbreakable token');

    // A single token longer than the limit is unbreakable on its own too.
    const commitLongToken = {
      commit: {
        message: 'bash: fix build issue\n\n' + 'a'.repeat(105) + '\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const resLongToken = await validateFormalities(commitLongToken, CONFIG);
    assert.ok(!resLongToken.errors.some(e => e.includes('exceeds max width')), 'Should ignore a single token longer than the limit');

    // But a long line of ordinary words next to a long token elsewhere in the
    // body is still held to the limit.
    const commitMixed = {
      commit: {
        message: `bash: fix build issue\n\n${logLine}\n${'wrappable words '.repeat(8)}\n\nSigned-off-by: John Doe <john@doe.com>`,
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const resMixed = await validateFormalities(commitMixed, CONFIG);
    assert.strictEqual(resMixed.errors.filter(e => e.includes('exceeds max width')).length, 1, 'Only the wrappable line should be flagged');
  });

  test('allows verbatim terminal-output shapes in the body', async () => {
    // Each shape is >100 chars of short words — only the verbatim-line rules
    // can save them, not the unbreakable-token rule.
    const verbatimLines = [
      '  wireless-regdb: Add regulatory info for CEPT countries FO GI IM SM and VA listed by the WiFi Alliance',
      'scripts/mod/modpost.c:1719:9: error: strchrnul is only available on macOS 15.4 or newer [-Werror,-Wunguarded-availability-new]',
      '[   21.058106] Unable to handle kernel access to user memory outside uaccess routines at virtual address 00000000000000b8',
      'make[2]: *** [modules/video.mk:620: a very long target path that keeps going far past the configured width limit] Error 1',
      '$ ./scripts/kconfig.pl + target/linux/generic/config-6.6 /dev/null > target/linux/generic/config-6.6-new and more output',
      'Fixes: af0546da3440dba24217949527e503820350ff05 ("layerscape: armv8_64b: add Traverse Ten64 NAND variant with a longer tail")'
    ];
    for (const vline of verbatimLines) {
      assert.ok(vline.length > 100, `fixture must exceed the limit: ${vline.slice(0, 40)}`);
      const commit = {
        commit: {
          message: `bash: fix build issue\n\nContext follows:\n\n${vline}\n\nSigned-off-by: John Doe <john@doe.com>`,
          author: { name: 'John Doe', email: 'john@doe.com' },
          committer: { name: 'John Doe', email: 'john@doe.com' }
        }
      };
      const res = await validateFormalities(commit, CONFIG);
      assert.ok(!res.errors.some(e => e.includes('exceeds max width')), `should allow verbatim line: ${vline.slice(0, 40)}...`);
    }

    // One space of indent is how contributors write ordinary prose bullets —
    // those must keep wrapping like any other prose.
    const bullet = ' - This is only working if the first partition is active because recovery images are always flashed to the active partition';
    assert.ok(bullet.length > 100);
    const bulletCommit = {
      commit: {
        message: `bash: fix build issue\n\n${bullet}\n\nSigned-off-by: John Doe <john@doe.com>`,
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const resBullet = await validateFormalities(bulletCommit, CONFIG);
    assert.ok(resBullet.errors.some(e => e.includes('exceeds max width')), 'a single-space prose bullet must still be flagged');
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

  test('warns when subject and body are virtually identical (e.g. my-agent bump version to 2026.27)', async () => {
    const commit = {
      commit: {
        message: 'my-agent: bump version to 2026.27\n\nUpgrade my-agent to the newest version\n\nSigned-off-by: Jane Smith <jane@example.com>',
        author: { name: 'Jane Smith', email: 'jane@example.com' },
        committer: { name: 'Jane Smith', email: 'jane@example.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.warnings.some(w => w.includes('identical or virtually identical')),
      `Expected duplicate warning but got: ${JSON.stringify(res.warnings)}`);
  });

  test('warns when subject and body are virtually identical (e.g. my-cli update to 29.6.1)', async () => {
    const commit = {
      commit: {
        message: 'my-cli: update to 29.6.1\n\nBump my-cli CLI from 29.4.1 to 29.6.1.\n\nSigned-off-by: Jane Smith <jane@example.com>',
        author: { name: 'Jane Smith', email: 'jane@example.com' },
        committer: { name: 'Jane Smith', email: 'jane@example.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.warnings.some(w => w.includes('identical or virtually identical')),
      `Expected duplicate warning but got: ${JSON.stringify(res.warnings)}`);
  });

  test('warns when body only qualifies the kind of release (e.g. bird3: bump to v3.3.2)', async () => {
    const commit = {
      commit: {
        message: 'bird3: bump to v3.3.2\n\nUpdate to latest upstream bugfix release.\n\nSigned-off-by: Jane Smith <jane@example.com>',
        author: { name: 'Jane Smith', email: 'jane@example.com' },
        committer: { name: 'Jane Smith', email: 'jane@example.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.warnings.some(w => w.includes('identical or virtually identical')),
      `Expected duplicate warning but got: ${JSON.stringify(res.warnings)}`);
  });

  test('warns when body only claims bugs were fixed', async () => {
    const commit = {
      commit: {
        message: 'mypkg: update to 2.4.0\n\nStable maintenance release, fixes bugs.\n\nSigned-off-by: Jane Smith <jane@example.com>',
        author: { name: 'Jane Smith', email: 'jane@example.com' },
        committer: { name: 'Jane Smith', email: 'jane@example.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.warnings.some(w => w.includes('identical or virtually identical')),
      `Expected duplicate warning but got: ${JSON.stringify(res.warnings)}`);
  });

  test('does not warn when the body names what was fixed', async () => {
    const commit = {
      commit: {
        message: 'bird3: bump to v3.3.2\n\nUpstream bugfix release, fixes a crash in the BGP reconfiguration path.\n\nSigned-off-by: Jane Smith <jane@example.com>',
        author: { name: 'Jane Smith', email: 'jane@example.com' },
        committer: { name: 'Jane Smith', email: 'jane@example.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(!res.warnings.some(w => w.includes('identical or virtually identical')),
      `Did not expect duplicate warning but got: ${JSON.stringify(res.warnings)}`);
  });

  test('does not warn when body has meaningful context beyond subject', async () => {
    const commit = {
      commit: {
        message: 'my-cli: update to 29.6.1\n\nBump my-cli CLI to 29.6.1.\nThis release fixes a CVE in the CLI implementation.\n\nSigned-off-by: Jane Smith <jane@example.com>',
        author: { name: 'Jane Smith', email: 'jane@example.com' },
        committer: { name: 'Jane Smith', email: 'jane@example.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(!res.warnings.some(w => w.includes('identical or virtually identical')),
      `Did not expect duplicate warning but got: ${JSON.stringify(res.warnings)}`);
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

  test('warns instead of failing when require_linked_github_account is "warning" and author is not linked', async () => {
    const commit = {
      author: null, // not linked to GitHub account
      commit: {
        message: 'mypkg: fix bug\n\nSome description text\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const customConfig = { ...CONFIG, require_linked_github_account: 'warning' };
    const res = await validateFormalities(commit, customConfig);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.warnings.some(w => w.includes('is not linked to any registered GitHub account')));
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

  test('rejects a description that follows the subject without a blank line', async () => {
    const commit = {
      commit: {
        message: 'mypkg: update to 1.2.3\nUpdate to the latest upstream release.\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.errors.some(e => e.includes('followed by a blank line')), `Errors: ${res.errors.join(', ')}`);
  });

  test('accepts a subject separated from the description by a blank line', async () => {
    const commit = {
      commit: {
        message: 'mypkg: update to 1.2.3\n\nUpdate to the latest upstream release.\nhttps://example.com/changelog\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(!res.errors.some(e => e.includes('followed by a blank line')), `Errors: ${res.errors.join(', ')}`);
  });

  test('accepts tools/cmake prefix format for build tool commits', async () => {
    const commit = {
      commit: {
        message: 'tools/cmake: backport bootstrap fix for GCC 16\n\nApply upstream fix for bootstrap with GCC 16.\nhttps://cmake.org/\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('Commit subject layout and length are valid')));
  });

  test('accepts tools/bison prefix format for build tool commits', async () => {
    const commit = {
      commit: {
        message: 'tools/bison: update to 3.8.2\n\nUpdate bison to latest stable release.\nhttps://ftp.gnu.org/gnu/bison/\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('Commit subject layout and length are valid')));
  });

  test('rejects tools/cmake with uppercase after prefix', async () => {
    const commit = {
      commit: {
        message: 'tools/cmake: Backport bootstrap fix for GCC 16\n\nApply upstream fix.\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.errors.some(e => e.includes('lower-case word after the prefix')));
  });

  test('rejects tools/cmake with period at end of subject', async () => {
    const commit = {
      commit: {
        message: 'tools/cmake: backport bootstrap fix for GCC 16.\n\nApply upstream fix.\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.errors.some(e => e.includes('must not end with a period')));
  });

  test('accepts toolchain/musl prefix format', async () => {
    const commit = {
      commit: {
        message: 'toolchain/musl: update to 1.2.5\n\nRelease notes: https://musl.libc.org/releases.html\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('Commit subject layout and length are valid')));
  });

  test('accepts a deeper source tree path as prefix', async () => {
    const commit = {
      commit: {
        message: 'package/network/services/hostapd: fix build\n\nFix build against wolfssl.\nhttps://w1.fi/\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('rejects toolchain/musl with uppercase after prefix', async () => {
    const commit = {
      commit: {
        message: 'toolchain/musl: Update to 1.2.5\n\nRelease notes: https://musl.libc.org/releases.html\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.errors.some(e => e.includes('lower-case word after the prefix')));
  });
});

// ─── Revert Subjects ─────────────────────────────────────────────

const revertBody = (sha) => `\n\nThis reverts commit ${sha}.\nIt broke the build on several targets.\n\nSigned-off-by: John Doe <john@doe.com>`;

const revertCommit = (subject) => ({
  commit: {
    message: subject + revertBody('9fceb02d0ae598e95dc970b74767f19372d61af8'),
    author: { name: 'John Doe', email: 'john@doe.com' },
    committer: { name: 'John Doe', email: 'john@doe.com' }
  }
});

describe('parseRevertSubject', () => {
  test('parses the plain git revert format', () => {
    const res = parseRevertSubject('Revert "generic: permit support of standalone PCS for external kernel module"');
    assert.deepStrictEqual(res, {
      prefix: '',
      original: 'generic: permit support of standalone PCS for external kernel module',
      depth: 1
    });
  });

  test('parses a prefixed revert (e.g. sing-box: Revert "...")', () => {
    const res = parseRevertSubject('sing-box: Revert "sing-box: update to 1.12.3"');
    assert.deepStrictEqual(res, { prefix: 'sing-box: ', original: 'sing-box: update to 1.12.3', depth: 1 });
  });

  test('parses chained and tools/ style prefixes', () => {
    assert.strictEqual(parseRevertSubject('tools/cmake: revert "tools/cmake: update to 4.0"').prefix, 'tools/cmake: ');
    assert.strictEqual(parseRevertSubject('toolchain: binutils: Revert "toolchain: binutils: update to 2.45"').prefix, 'toolchain: binutils: ');
  });

  test('unwraps a revert of a revert', () => {
    const res = parseRevertSubject('Revert "Revert "ramips: mt7620: fix patching mac address in caldata""');
    assert.strictEqual(res.depth, 2);
    assert.strictEqual(res.original, 'ramips: mt7620: fix patching mac address in caldata');
  });

  test('rejects subjects that only mention a revert', () => {
    assert.strictEqual(parseRevertSubject('mypkg: revert the broken change'), null);
    assert.strictEqual(parseRevertSubject('Revert the broken change'), null);
    assert.strictEqual(parseRevertSubject('Reverted "mypkg: update to 1.2.3"'), null);
    assert.strictEqual(parseRevertSubject('toolchain: binutils: partially revert commit 525a1e94b343 "fix update to 2.45.1"'), null);
  });
});

describe('parseRevertCommit', () => {
  const sha = '9fceb02d0ae598e95dc970b74767f19372d61af8';

  test('accepts the reference `git revert` writes into the body', () => {
    const res = parseRevertCommit(`Revert "mypkg: update to 1.2.3"\n\nThis reverts commit ${sha}.`);
    assert.deepStrictEqual(res, { prefix: '', original: 'mypkg: update to 1.2.3', depth: 1 });
  });

  test('accepts the abbreviated sha and the pull request reference GitHub writes', () => {
    assert.ok(parseRevertCommit('Revert "mypkg: update to 1.2.3"\n\nThis reverts commit 9fceb02.'));
    assert.ok(parseRevertCommit('Revert "mypkg: update to 1.2.3"\n\nReverts openwrt/packages#12345'));
  });

  test('rejects a revert subject that does not reference the reverted commit', () => {
    assert.strictEqual(parseRevertCommit('Revert "mypkg: update to 1.2.3"'), null);
    assert.strictEqual(parseRevertCommit('Revert "mypkg: update to 1.2.3"\n\nThis broke the build.'), null);
    // The reference belongs in the body, so a subject claiming it is not enough.
    assert.strictEqual(parseRevertCommit(`Revert "mypkg: update to 1.2.3" This reverts commit ${sha}.`), null);
  });

  test('rejects a body reference under a subject that is not a revert', () => {
    assert.strictEqual(parseRevertCommit(`mypkg: update to 1.2.3\n\nThis reverts commit ${sha}.`), null);
  });

  test('looks past an autosquash marker', () => {
    const res = parseRevertCommit(`fixup! Revert "mypkg: update to 1.2.3"\n\nThis reverts commit ${sha}.`);
    assert.strictEqual(res.original, 'mypkg: update to 1.2.3');
  });
});

describe('validateFormalities revert subjects', () => {
  test('accepts the plain git revert format without a package prefix', async () => {
    const res = await validateFormalities(revertCommit('Revert "generic: permit support of standalone PCS for external kernel module"'), CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('Commit subject layout and length are valid (revert of')));
  });

  test('accepts a revert of a revert', async () => {
    const res = await validateFormalities(revertCommit('Revert "Revert "ramips: mt7620: fix patching mac address in caldata""'), CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('accepts an upper-case Revert after a package prefix', async () => {
    const res = await validateFormalities(revertCommit('irqbalance: Revert "irqbalance: update to 1.9.5"'), CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('excludes the Revert wrapper from the subject length limits', async () => {
    // 86 chars as written, 77 without the wrapper.
    const res = await validateFormalities(revertCommit('Revert "base-files: handle name collision between kernel UBI volume and MTD partition"'), CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('still enforces the hard limit on the reverted subject itself', async () => {
    const original = 'base-files: handle a name collision between the kernel UBI volume and the MTD partition';
    assert.ok(original.length > CONFIG.max_subject_len_hard);
    const res = await validateFormalities(revertCommit(`Revert "${original}"`), CONFIG);
    assert.ok(res.errors.some(e => e.includes('exceeds hard limit') && e.includes('excluding the `Revert "..."` wrapper')));
  });

  test('still rejects a revert-like subject without the quoted original', async () => {
    const res = await validateFormalities(revertCommit('Revert the broken PCS support'), CONFIG);
    assert.ok(res.errors.some(e => e.includes('must start with `<package name or prefix>: `')));
  });

  test('enforces the regular subject rules when allow_revert is disabled', async () => {
    const customConfig = { ...CONFIG, allow_revert: false };
    const res = await validateFormalities(revertCommit('Revert "generic: permit support of standalone PCS for external kernel module"'), customConfig);
    assert.ok(res.errors.some(e => e.includes('must start with `<package name or prefix>: `')));
  });

  test('enforces the regular subject rules when the body does not reference the reverted commit', async () => {
    const commit = {
      commit: {
        message: 'Revert "generic: permit support of standalone PCS for external kernel module"\n\nIt broke the build on several targets.\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.ok(res.errors.some(e => e.includes('must start with `<package name or prefix>: `')));
    assert.ok(res.errors.some(e => e.includes('body does not reference the reverted commit')));
  });

  test('does not hint at a missing reference when the subject passes the regular rules', async () => {
    // `mypkg: revert "..."` already satisfies the prefix and lower-case rules,
    // so an unreferenced revert stays valid rather than becoming an error.
    const commit = {
      commit: {
        message: 'mypkg: revert "the broken PCS support"\n\nIt broke the build on several targets.\n\nSigned-off-by: John Doe <john@doe.com>',
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' }
      }
    };
    const res = await validateFormalities(commit, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
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

  test('accepts version bump with leading zero difference (subject has zero, Makefile does not)', () => {
    const commit = { commit: { message: 'mypkg: update to 2026.07.04' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+PKG_VERSION:=2026.7.4
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('accepts version bump with leading zero difference (Makefile has zero, subject does not)', () => {
    const commit = { commit: { message: 'mypkg: update to 2026.7.4' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+PKG_VERSION:=2026.07.04
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

  test('skips subject validation for a revert restoring the previous PKG_VERSION', () => {
    const commit = { commit: { message: 'sing-box: Revert "sing-box: update to 1.12.3"\n\nThis reverts commit 9fceb02d0ae598e95dc970b74767f19372d61af8.' } };
    const patch = `
--- a/package/net/sing-box/Makefile
+++ b/package/net/sing-box/Makefile
+PKG_VERSION:=1.12.2
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('Commit reverts a previous change')));
  });

  test('catches version mismatch on a revert when allow_revert is disabled', () => {
    const commit = { commit: { message: 'sing-box: Revert "sing-box: update to 1.12.3"' } };
    const patch = `
--- a/package/net/sing-box/Makefile
+++ b/package/net/sing-box/Makefile
+PKG_VERSION:=1.12.2
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, { ...CONFIG, allow_revert: false }, state);
    assert.ok(res.errors.some(e => e.includes('PKG_VERSION')));
  });

  test('catches version mismatch on a revert that does not reference the reverted commit', () => {
    const commit = { commit: { message: 'sing-box: Revert "sing-box: update to 1.12.3"\n\nIt broke the build.' } };
    const patch = `
--- a/package/net/sing-box/Makefile
+++ b/package/net/sing-box/Makefile
+PKG_VERSION:=1.12.2
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes('PKG_VERSION')));
  });

  test('skips subject validation for dynamic/templated PKG_VERSION', () => {
    const commit = { commit: { message: 'apk: update to 2.14.0' } };
    const patch = `
--- a/package/utils/apk/Makefile
+++ b/package/utils/apk/Makefile
+PKG_VERSION:=$(subst -,.,$(PKG_SOURCE_VERSION))
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('validates every Makefile version bump in a commit, not just the first', () => {
    const commit = { commit: { message: 'bash: update to 5.3' } };
    const patch = `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.3
diff --git a/package/utils/sed/Makefile b/package/utils/sed/Makefile
--- a/package/utils/sed/Makefile
+++ b/package/utils/sed/Makefile
+PKG_VERSION:=4.9
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("'4.9'")), `Errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('(5.3)')), `Successes: ${res.successes.join(', ')}`);
  });

  test('still validates a version bump when the same commit adds a new package', () => {
    const commit = { commit: { message: 'newpkg: add package' } };
    const patch = `
diff --git a/package/utils/newpkg/Makefile b/package/utils/newpkg/Makefile
--- /dev/null
+++ b/package/utils/newpkg/Makefile
+PKG_NAME:=newpkg
+PKG_VERSION:=1.0
+PKG_RELEASE:=1
+PKG_MAINTAINER:=Jane Doe <jane@doe.com>
+PKG_LICENSE:=MIT
+PKG_LICENSE_FILES:=LICENSE
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.3
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);
    assert.ok(res.errors.some(e => e.includes("'5.3'")), `Errors: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes("'1.0'")), `Errors: ${res.errors.join(', ')}`);
  });

  test('skips version subject validation for autosquash commits', () => {
    const commit = { commit: { message: 'fixup! bash: fix build on musl' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.3
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('Autosquash commit')), `Successes: ${res.successes.join(', ')}`);
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

  test('does not require package metadata for a new build target Makefile', () => {
    const commit = { commit: { message: 'ti-k3: add new target for BeaglePlay' } };
    const patch = `
diff --git a/target/linux/ti-k3/Makefile b/target/linux/ti-k3/Makefile
new file mode 100644
--- /dev/null
+++ b/target/linux/ti-k3/Makefile
@@ -0,0 +1,12 @@
+#
+# Copyright (C) 2025 OpenWrt.org
+#
+include $(TOPDIR)/rules.mk
+
+ARCH:=aarch64
+BOARD:=ti-k3
+BOARDNAME:=Texas Instruments K3
+FEATURES:=ext4 squashfs fpu usb gpio rtc pci
+KERNEL_PATCHVER:=6.12
+
+include $(TOPDIR)/target/linux/Makefile
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, false, 'a target definition is not a new package');
    assert.ok(!res.errors.some(e => e.includes('PKG_MAINTAINER')));
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE')));
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE_FILES')));
  });

  test('does not require package metadata for a new host tool Makefile', () => {
    const commit = { commit: { message: 'tools/newtool: add host build helper' } };
    const patch = `
--- /dev/null
+++ b/tools/newtool/Makefile
@@ -0,0 +1,5 @@
+PKG_NAME:=newtool
+PKG_VERSION:=1.0
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, false);
    assert.ok(!res.errors.some(e => e.includes('mandatory parameter')));
  });

  test('still requires package metadata when a target commit also adds a package', () => {
    const commit = { commit: { message: 'ti-k3: add new target for BeaglePlay' } };
    const patch = `
diff --git a/target/linux/ti-k3/Makefile b/target/linux/ti-k3/Makefile
--- /dev/null
+++ b/target/linux/ti-k3/Makefile
@@ -0,0 +1,3 @@
+BOARD:=ti-k3
+BOARDNAME:=Texas Instruments K3
diff --git a/package/boot/uboot-ti-k3/Makefile b/package/boot/uboot-ti-k3/Makefile
--- /dev/null
+++ b/package/boot/uboot-ti-k3/Makefile
@@ -0,0 +1,3 @@
+PKG_NAME:=uboot-ti-k3
+PKG_VERSION:=2025.01
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);
    assert.ok(res.errors.some(e => e.includes('PKG_MAINTAINER')));
  });

  test('does not flag a removed target Makefile as a dropped package', () => {
    const commit = { commit: { message: 'ti-k3: drop target' } };
    const patch = `
--- a/target/linux/ti-k3/Makefile
+++ /dev/null
@@ -1,3 +0,0 @@
-BOARD:=ti-k3
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isDroppedPackage, false);
  });

  test('flags a removed package Makefile as a dropped package', () => {
    const commit = { commit: { message: 'oldpkg: drop package' } };
    const patch = `
--- a/package/utils/oldpkg/Makefile
+++ /dev/null
@@ -1,3 +0,0 @@
-PKG_NAME:=oldpkg
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isDroppedPackage, true);
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

  test('skips PKG_LICENSE/PKG_LICENSE_FILES when package includes trusted-firmware-a.mk', () => {
    const commit = { commit: { message: 'packages/boot: add arm-trusted-firmware-airoha' } };
    const patch = `
--- /dev/null
+++ b/package/boot/arm-trusted-firmware-airoha/Makefile
@@ -0,0 +1,15 @@
+#
+# Copyright (C) 2024 OpenWrt.org
+#
+include $(TOPDIR)/rules.mk
+include $(INCLUDE_DIR)/trusted-firmware-a.mk
+
+PKG_NAME:=arm-trusted-firmware-airoha
+PKG_VERSION:=1.0
+PKG_RELEASE:=1
+PKG_MAINTAINER:=John Doe <john@example.com>
+
+define Package/arm-trusted-firmware-airoha
+  TITLE:=Airoha ARM Trusted Firmware
+endef
+    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);
    // Should NOT error for PKG_LICENSE or PKG_LICENSE_FILES since trusted-firmware-a.mk defines them
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE')), 'PKG_LICENSE should not be required when trusted-firmware-a.mk is included');
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE_FILES')), 'PKG_LICENSE_FILES should not be required when trusted-firmware-a.mk is included');
    // But should still require PKG_MAINTAINER
    assert.ok(!res.errors.some(e => e.includes('PKG_MAINTAINER')), 'PKG_MAINTAINER should still be required');
  });

  test('skips PKG_LICENSE/PKG_LICENSE_FILES when package includes u-boot.mk', () => {
    const commit = { commit: { message: 'uboot: add new board support' } };
    const patch = `
--- /dev/null
+++ b/package/boot/uboot-someboard/Makefile
@@ -0,0 +1,15 @@
+#
+# Copyright (C) 2024 OpenWrt.org
+#
+include $(TOPDIR)/rules.mk
+include $(INCLUDE_DIR)/u-boot.mk
+
+PKG_NAME:=uboot-someboard
+PKG_VERSION:=2024.01
+PKG_RELEASE:=1
+PKG_MAINTAINER:=Jane Doe <jane@example.com>
+
+define Package/uboot-someboard
+  TITLE:=U-Boot for SomeBoard
+endef
+    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);
    // Should NOT error for PKG_LICENSE or PKG_LICENSE_FILES since u-boot.mk defines them
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE')), 'PKG_LICENSE should not be required when u-boot.mk is included');
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE_FILES')), 'PKG_LICENSE_FILES should not be required when u-boot.mk is included');
    // But should still require PKG_MAINTAINER
    assert.ok(!res.errors.some(e => e.includes('PKG_MAINTAINER')), 'PKG_MAINTAINER should still be required');
  });

  test('still requires PKG_LICENSE/PKG_LICENSE_FILES when no known license include is present', () => {
    const commit = { commit: { message: 'newpkg: add package' } };
    const patch = `
--- /dev/null
+++ b/package/newpkg/Makefile
@@ -0,0 +1,12 @@
+#
+# Copyright (C) 2024 OpenWrt.org
+#
+include $(TOPDIR)/rules.mk
+include $(INCLUDE_DIR)/package.mk
+
+PKG_NAME:=newpkg
+PKG_VERSION:=1.0
+PKG_RELEASE:=1
+PKG_MAINTAINER:=John Doe <john@example.com>
+
+define Package/newpkg
+  TITLE:=New Package
+endef
+    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);
    // Should still error for PKG_LICENSE and PKG_LICENSE_FILES since no known license .mk is included
    assert.ok(res.errors.some(e => e.includes('PKG_LICENSE')), 'PKG_LICENSE should still be required when no known license include present');
    assert.ok(res.errors.some(e => e.includes('PKG_LICENSE_FILES')), 'PKG_LICENSE_FILES should still be required when no known license include present');
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
    assert.ok(res.errors.some(e => e.includes("must end with a trailing slash '/'")));
  });

  test('rejects conffiles path for .d directory missing trailing slash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/foo.conf
+/etc/foo.d
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("must end with a trailing slash '/'")));
    assert.ok(res.errors.some(e => e.includes("/etc/foo.d")));
  });

  test('accepts conffiles .d directory with trailing slash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/foo.conf
+/etc/foo.d/
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('rejects conffiles path for INSTALL_DIR directory missing trailing slash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/foo.d
+endef
+define Package/foo/install
+	$(INSTALL_DIR) $(1)/etc/foo.d
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("must end with a trailing slash '/'")));
  });

  test('does not leak conffiles block into install block when endef is in diff hunk header', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -50,6 +50,8 @@ endef
 define Package/foo/conffiles
 /etc/foo.conf
+/etc/foo.d/
 endef
 
 define Package/foo/install
+	$(INSTALL_DIR) $(1)/etc/foo.d
+	$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf
 endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    // Should NOT flag INSTALL_DIR or INSTALL_CONF lines as conffiles errors
    assert.ok(!res.errors.some(e => e.includes("INSTALL_DIR")), `Should not flag INSTALL_DIR as conffiles error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes("INSTALL_CONF")), `Should not flag INSTALL_CONF as conffiles error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes("must not contain any spaces or indentation") && e.includes("INSTALL")), `Should not flag install lines as indentation errors: ${res.errors.join(', ')}`);
  });

  test('does not leak conffiles block into a later install hunk when endef is never shown in the diff (odhcp6c PR#22751 regression)', () => {
    const commit = { commit: { message: 'odhcp6c: test' } };
    const patch = `
diff --git a/package/network/ipv6/odhcp6c/Makefile b/package/network/ipv6/odhcp6c/Makefile
--- a/package/network/ipv6/odhcp6c/Makefile
+++ b/package/network/ipv6/odhcp6c/Makefile
@@ -28,7 +28,7 @@ define Package/odhcp6c
   SECTION:=net
   CATEGORY:=Network
   TITLE:=Embedded DHCPv6-client for OpenWrt
-  DEPENDS:=@IPV6 +libubox +libubus
+  DEPENDS:=@IPV6 +libubox +libubus +ucode
 endef

 define Package/odhcp6c/conffiles
@@ -40,7 +40,7 @@ define Package/odhcp6c/install
 	$(INSTALL_DIR) $(1)/usr/sbin/
 	$(INSTALL_BIN) $(PKG_BUILD_DIR)/odhcp6c $(1)/usr/sbin/
 	$(INSTALL_DIR) $(1)/lib/netifd/proto
-	$(INSTALL_BIN) ./files/dhcpv6.sh $(1)/lib/netifd/proto/dhcpv6.sh
+	$(INSTALL_BIN) ./files/dhcpv6.uc $(1)/lib/netifd/proto/dhcpv6.uc
 	$(INSTALL_BIN) ./files/dhcpv6.script $(1)/lib/netifd/
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(!res.errors.some(e => e.includes('INSTALL_BIN')), `Should not flag install line as conffiles error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes('must not contain any spaces or indentation')), `Should not flag spaces error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes("must be an absolute path")), `Should not flag absolute path error: ${res.errors.join(', ')}`);
  });

  test('does not leak conffiles block into a later hunk whose context is not a define', () => {
    const commit = { commit: { message: 'foo: bump to 3.0.722, replace maintainer' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -33,7 +33,7 @@ endef
 define Package/foo/description
 foo is a packet sniffer that runs as a background process on a cable/DSL
 router, gathers all sorts of statistics about network usage, and serves them
-over HTTP.
+over HTTPS.
 endef

 define Package/foo/conffiles
@@ -49,6 +49,11 @@ CONFIGURE_VARS += \\
 	ac_cv_search_strlcpy=no \\
 	ac_cv_search_strlcat=no

+define Build/Configure
+	( cd $(PKG_BUILD_DIR) && autoreconf -fi )
+	$(call Build/Configure/Default)
+endef
+
 define Build/Compile
 	$(HOSTCC) $(PKG_BUILD_DIR)/static/c-ify.c \\
 		-o $(PKG_BUILD_DIR)/c-ify
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(!res.errors.some(e => e.includes('Build/Configure')), `Should not flag Build/Configure block as conffiles error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes('autoreconf')), `Should not flag autoreconf line as conffiles error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes('must not contain any spaces or indentation')), `Should not flag spaces error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes('must be an absolute path')), `Should not flag absolute path error: ${res.errors.join(', ')}`);
  });

  test('closes conffiles block on a define that is not a conffiles block', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -41,0 +42,6 @@ define Package/foo/conffiles
+define Build/Configure
+	( cd $(PKG_BUILD_DIR) && autoreconf -fi )
+	$(call Build/Configure/Default)
+endef
+
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
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

  test('flags spaces immediately after the := operator in Makefiles', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+PKG_LICENSE:= MIT
+PKG_SOURCE_URL:= https://github.com/foo/bar
+PKG_NAME :=  foo
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_space_after_assignment: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 3);
    assert.ok(res.errors[0].includes("Makefile line 'PKG_LICENSE:= MIT' has a space after ':='"));
    assert.ok(res.errors[1].includes("Makefile line 'PKG_SOURCE_URL:= https://github.com/foo/bar' has a space after ':='"));
    assert.ok(res.errors[2].includes("Makefile line 'PKG_NAME :=  foo' has a space after ':='"));
  });

  test('accepts clean assignments without space after :=', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+PKG_LICENSE:=MIT
+PKG_SOURCE_URL:=https://github.com/foo/bar
+PKG_NAME:=foo
+VAR:=
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_space_after_assignment: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes("does not contain spaces after ':='")));
  });

  test('ignores comments and recipe lines containing spaces after :=', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+# TITLE:= Simple WireGuard proxy
+	$(SH) -c "var := value"
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_space_after_assignment: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('respects check_space_after_assignment: false configuration option', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+PKG_LICENSE:= MIT
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_space_after_assignment: false
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('flags `=` instead of `:=` for standard variables (missing colon)', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+PKG_SOURCE_URL= \\
+PKG_LICENSE = MIT
+PKG_VERSION= 1.0.0
+CUSTOM_VAR = helper
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_missing_colon: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 3);
    assert.ok(res.errors[0].includes("uses '=' instead of ':='"));
    assert.ok(res.errors[0].includes("PKG_SOURCE_URL"));
    assert.ok(res.errors[1].includes("uses '=' instead of ':='"));
    assert.ok(res.errors[1].includes("PKG_LICENSE"));
    assert.ok(res.errors[2].includes("uses '=' instead of ':='"));
    assert.ok(res.errors[2].includes("PKG_VERSION"));
  });

  test('respects check_missing_colon: false configuration option', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+PKG_SOURCE_URL= \\
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_missing_colon: false
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('accepts space after := when followed by line continuation backslash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+ DEPENDS:= \\
+	+libpcre2 \\
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_space_after_assignment: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('formats assignment error suggestions as diff block preserving indentation', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+  PKG_SOURCE_URL=https://github.com/foo/bar
+  TITLE:= Simple WireGuard proxy
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_missing_colon: true,
      check_space_after_assignment: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 2);
    
    // Check that missing colon error includes diff block with correct indentation
    assert.ok(res.errors[0].includes("  -   PKG_SOURCE_URL=https://github.com/foo/bar"));
    assert.ok(res.errors[0].includes("  +   PKG_SOURCE_URL:=https://github.com/foo/bar"));
    
    // Check that space after assignment error includes diff block with correct indentation
    assert.ok(res.errors[1].includes("  -   TITLE:= Simple WireGuard proxy"));
    assert.ok(res.errors[1].includes("  +   TITLE:=Simple WireGuard proxy"));
  });

  test('passes valid Makefile block indentation', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo
+  SECTION:=utils
+  CATEGORY:=Utilities
+  TITLE:=Example package
+  DEPENDS:=+libstdcpp \\
+    +libpthread
+endef
+
+define Package/foo/description
+  This is a package description.
+    - bullet 1
+    - bullet 2
+endef
+
+define Package/foo/install
+	$(INSTALL_DIR) $(1)/usr/bin
+	$(INSTALL_BIN) $(PKG_BUILD_DIR)/foo $(1)/usr/bin/
+endef
+
+define Build/Compile
+	$(MAKE) -C $(PKG_BUILD_DIR)
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes("Makefile blocks contain valid indentation")));
  });

  test('flags invalid indentation in Package metadata blocks', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo
+ SECTION:=utils
+	CATEGORY:=Utilities
+   TITLE:=Example package
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 3);
    assert.ok(res.errors[0].includes("line 'SECTION:=utils' inside 'Package/foo' must be indented with exactly 2 spaces"));
    assert.ok(res.errors[1].includes("line 'CATEGORY:=Utilities' inside 'Package/foo' must be indented with exactly 2 spaces"));
    assert.ok(res.errors[2].includes("line 'TITLE:=Example package' inside 'Package/foo' must be indented with exactly 2 spaces"));
  });

  test('flags invalid indentation in description blocks', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/description
+ This description starts with 1 space
+	This line starts with a tab
+No spaces at all
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 3);
    assert.ok(res.errors[0].includes("line 'This description starts with 1 space' inside 'Package/foo/description' must be indented with at least 2 spaces"));
    assert.ok(res.errors[1].includes("line 'This line starts with a tab' inside 'Package/foo/description' must be indented with at least 2 spaces"));
    assert.ok(res.errors[2].includes("line 'No spaces at all' inside 'Package/foo/description' must be indented with at least 2 spaces"));
  });

  test('flags invalid indentation in recipe blocks', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/install
+  $(INSTALL_DIR) $(1)/usr/bin
+	$(INSTALL_BIN) $(PKG_BUILD_DIR)/foo $(1)/usr/bin/
+endef
+
+define Build/Compile
+  $(MAKE) -C $(PKG_BUILD_DIR)
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 2);
    assert.ok(res.errors[0].includes("line '$(INSTALL_DIR) $(1)/usr/bin' inside 'Package/foo/install' must be indented with a tab"));
    assert.ok(res.errors[1].includes("line '$(MAKE) -C $(PKG_BUILD_DIR)' inside 'Build/Compile' must be indented with a tab"));
  });

  test('does not leak block state across diff hunks (issue #44)', () => {
    const commit = { commit: { message: 'prometheus-node-exporter-lua: add dhcp-leases exporter' } };
    const patch = `
diff --git a/utils/prometheus-node-exporter-lua/Makefile b/utils/prometheus-node-exporter-lua/Makefile
--- a/utils/prometheus-node-exporter-lua/Makefile
+++ b/utils/prometheus-node-exporter-lua/Makefile
@@ -81,6 +81,17 @@ define Package/prometheus-node-exporter-lua-dawn/install
 	$(INSTALL_DATA) ./files/dawn.lua $(1)/usr/lib/lua/prometheus-collectors/
 endef

+define Package/prometheus-node-exporter-lua-dhcp-leases
+  $(call Package/prometheus-node-exporter-lua/Default)
+  TITLE+= (dhcp-leases collector)
+  DEPENDS:=prometheus-node-exporter-lua
+endef
+
+define Package/prometheus-node-exporter-lua-dhcp-leases/install
+	$(INSTALL_DIR) $(1)/usr/lib/lua/prometheus-collectors
+	$(INSTALL_DATA) ./files/dhcp-leases.lua $(1)/usr/lib/lua/prometheus-collectors/
+endef
+
 define Package/prometheus-node-exporter-lua-filesystem
   $(call Package/prometheus-node-exporter-lua/Default)
   TITLE+= (filesystem collector)
@@ -320,6 +331,7 @@ endef
 $(eval $(call BuildPackage,prometheus-node-exporter-lua))
 $(eval $(call BuildPackage,prometheus-node-exporter-lua-dawn))
+$(eval $(call BuildPackage,prometheus-node-exporter-lua-dhcp-leases))
 $(eval $(call BuildPackage,prometheus-node-exporter-lua-filesystem))
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0, `Expected no errors, got: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes("Makefile blocks contain valid indentation")));
  });

  test('re-enters block from hunk header context and validates added lines', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -10,3 +10,4 @@ define Package/foo
   SECTION:=utils
+ TITLE:=Badly indented
 endef
@@ -30,3 +31,4 @@ define Package/foo/install
 	$(INSTALL_DIR) $(1)/usr/bin
+  $(INSTALL_BIN) $(PKG_BUILD_DIR)/foo $(1)/usr/bin/
 endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 2, `Expected 2 errors, got: ${res.errors.join(', ')}`);
    assert.ok(res.errors[0].includes("line 'TITLE:=Badly indented' inside 'Package/foo' must be indented with exactly 2 spaces"));
    assert.ok(res.errors[1].includes("line '$(INSTALL_BIN) $(PKG_BUILD_DIR)/foo $(1)/usr/bin/' inside 'Package/foo/install' must be indented with a tab"));
  });

  test('ignores comments, empty lines, and conditionals in blocks', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo
+  SECTION:=utils
+
+  # This is a comment inside metadata
+ifeq ($(CONFIG_FOO),y)
+  TITLE:=Foo Enabled
+else
+  TITLE:=Foo Disabled
+endif
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('respects check_makefile_indentation: false configuration option', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo
+ SECTION:=utils
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: false
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  // Isolate the buildbot-default check so unrelated Makefile rules cannot
  // contribute errors/warnings and skew the assertions below.
  const buildbotConfig = (level) => ({
    ...CONFIG,
    check_openwrt_meta: false,
    check_conffiles: false,
    check_crlf: false,
    check_pkg_version: false,
    check_trailing_newline: false,
    check_makefile_indentation: false,
    check_pkg_name_reuse: false,
    check_missing_colon: false,
    check_space_after_assignment: false,
    check_buildbot_default: level
  });
  const freshState = () => ({ isNewPackage: false, isDroppedPackage: false });

  test('warns on DEFAULT conditioned on BUILDBOT in a feed package (issue #4)', () => {
    const commit = { commit: { message: 'openssh: add sftp-server DEFAULT' } };
    const patch = `
diff --git a/net/openssh/Makefile b/net/openssh/Makefile
--- a/net/openssh/Makefile
+++ b/net/openssh/Makefile
@@ -80,6 +80,13 @@ define Package/openssh-server
 endef
 
+define Package/openssh-sftp-server
+  $(call Package/openssh/Default)
+  TITLE+= SFTP server
+  DEFAULT:=y if (BUILDBOT && !SMALL_FLASH)
+endef
+
 define Package/openssh-client/description
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes("DEFAULT:=y if (BUILDBOT && !SMALL_FLASH)"));
    assert.ok(res.warnings[0].includes("inside 'Package/openssh-sftp-server'"));
  });

  test('labels the package from the hunk header when the define is outside the diff', () => {
    const commit = { commit: { message: 'owut: default on buildbot' } };
    const patch = `
diff --git a/utils/owut/Makefile b/utils/owut/Makefile
--- a/utils/owut/Makefile
+++ b/utils/owut/Makefile
@@ -20,6 +20,7 @@ define Package/owut
   SECTION:=utils
   CATEGORY:=Base system
+  DEFAULT:=y if BUILDBOT
   TITLE:=owut
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes("inside 'Package/owut'"));
  });

  test('does not attribute a DEFAULT line to a package block closed in an earlier hunk', () => {
    const commit = { commit: { message: 'foo: default on buildbot' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -20,3 +20,4 @@ define Package/foo
   TITLE:=Foo
 endef
+DEFAULT:=y if BUILDBOT
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(!res.warnings[0].includes('inside'));
  });

  test('closes the package block on an indented endef', () => {
    const commit = { commit: { message: 'foo: default on buildbot' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -20,3 +20,4 @@ define Package/foo
   TITLE:=Foo
   endef
+DEFAULT:=y if BUILDBOT
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(!res.warnings[0].includes('inside'), 'indented endef must not leave Package/foo attributed');
  });

  test('attributes a DEFAULT line under an indented define', () => {
    const commit = { commit: { message: 'foo: default on buildbot' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -20,3 +20,5 @@ context
+  define Package/foo
+  DEFAULT:=y if BUILDBOT
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes("inside 'Package/foo'"));
  });

  test('detects DEFAULT assignments spread over backslash continuation lines', () => {
    const commit = { commit: { message: 'foo: default on buildbot' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -10,3 +10,5 @@ define Package/foo
   TITLE:=Foo
+  DEFAULT:=y if \\
+    (BUILDBOT && !SMALL_FLASH)
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes('BUILDBOT'));
  });

  test('detects every Makefile assignment flavour for DEFAULT', () => {
    for (const op of [':=', '=', '?=', '+=', '::=']) {
      const commit = { commit: { message: 'foo: default on buildbot' } };
      const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -10,3 +10,4 @@ define Package/foo
   TITLE:=Foo
+  DEFAULT${op}y if BUILDBOT
    `;
      const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
      assert.strictEqual(res.warnings.length, 1, `operator ${op} was not detected`);
    }
  });

  test('treats check_buildbot_default: true and "error" as a hard error', () => {
    for (const level of [true, 'error']) {
      const commit = { commit: { message: 'foo: add DEFAULT' } };
      const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -1,2 +1,3 @@
 define Package/foo
+  DEFAULT:=y if BUILDBOT
 endef
    `;
      const res = validateMakefileContext(commit, patch, buildbotConfig(level), freshState(), 'openwrt/packages');
      assert.strictEqual(res.warnings.length, 0);
      assert.strictEqual(res.errors.length, 1);
      assert.ok(res.errors[0].includes("DEFAULT:=y if BUILDBOT"));
    }
  });

  test('does not flag DEFAULT without a BUILDBOT condition', () => {
    const commit = { commit: { message: 'foo: add DEFAULT' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -1,2 +1,3 @@
 define Package/foo
+  DEFAULT:=y if TARGET_x86
 endef
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0);
    assert.ok(res.successes.some(s => s.includes("No feed package forces its own inclusion")));
  });

  test('ignores DEFAULT+BUILDBOT inside an added comment line', () => {
    const commit = { commit: { message: 'foo: document DEFAULT' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -1,2 +1,3 @@
 define Package/foo
+#  DEFAULT:=y if BUILDBOT
 endef
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 0);
  });

  test('does not flag DEFAULT+BUILDBOT in the main openwrt/openwrt repo, whatever the casing', () => {
    for (const repo of ['openwrt/openwrt', 'OpenWrt/OpenWrt']) {
      const commit = { commit: { message: 'openssh: add sftp-server DEFAULT' } };
      const patch = `
diff --git a/net/openssh/Makefile b/net/openssh/Makefile
--- a/net/openssh/Makefile
+++ b/net/openssh/Makefile
@@ -1,2 +1,3 @@
 define Package/openssh-sftp-server
+  DEFAULT:=y if (BUILDBOT && !SMALL_FLASH)
 endef
    `;
      const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), repo);
      assert.strictEqual(res.errors.length, 0);
      assert.strictEqual(res.warnings.length, 0);
      assert.ok(!res.successes.some(s => s.includes('BUILDBOT')), `Successes: ${res.successes.join(', ')}`);
    }
  });

  test('does not flag pre-existing DEFAULT+BUILDBOT lines left untouched by the diff', () => {
    const commit = { commit: { message: 'foo: unrelated tweak' } };
    const patch = `
diff --git a/utils/owut/Makefile b/utils/owut/Makefile
--- a/utils/owut/Makefile
+++ b/utils/owut/Makefile
@@ -10,7 +10,7 @@ define Package/owut
   DEFAULT:=y if (BUILDBOT && !SMALL_FLASH)
-  TITLE:=owut - an OpenWrt Upgrade Tool
+  TITLE:=owut - an OpenWrt upgrade tool
 endef
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0);
  });

  test('flags a BUILDBOT continuation added under a pre-existing DEFAULT line', () => {
    const commit = { commit: { message: 'foo: enable on buildbot' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -10,3 +10,4 @@ define Package/foo
   TITLE:=Foo
   DEFAULT:=y \\
+\tif BUILDBOT
   DEPENDS:=+libc
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1, 'adding the condition to an existing DEFAULT must be caught');
    assert.ok(res.warnings[0].includes('BUILDBOT'));
    assert.ok(res.warnings[0].includes("inside 'Package/foo'"));
  });

  test('does not flag a pre-existing backslash-continued DEFAULT+BUILDBOT left untouched', () => {
    const commit = { commit: { message: 'foo: unrelated tweak' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -10,4 +10,5 @@ define Package/foo
   TITLE:=Foo
   DEFAULT:=y \\
 \tif BUILDBOT
+  URL:=https://example.org
   DEPENDS:=+libc
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0);
  });

  test('does not re-report an untouched DEFAULT+BUILDBOT when an unrelated clause is appended', () => {
    const commit = { commit: { message: 'foo: extend default condition' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -10,4 +10,5 @@ define Package/foo
   TITLE:=Foo
   DEFAULT:=y if BUILDBOT \\
+\t|| ALL_KMODS
   DEPENDS:=+libc
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0, 'BUILDBOT was already there; the diff did not introduce it');
  });

  test('flags a changed DEFAULT value line above an untouched BUILDBOT continuation', () => {
    const commit = { commit: { message: 'foo: enable by default' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -10,4 +10,4 @@ define Package/foo
   TITLE:=Foo
-  DEFAULT:=n \\
+  DEFAULT:=y \\
 \tif BUILDBOT
   DEPENDS:=+libc
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1, 'flipping the value re-arms the BUILDBOT default');
    assert.ok(res.warnings[0].includes('BUILDBOT'));
  });

  test('attributes the package from an indented define carried as hunk context', () => {
    const commit = { commit: { message: 'foo: default on buildbot' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -10,3 +10,4 @@   define Package/foo
   TITLE:=Foo
+  DEFAULT:=y if BUILDBOT
   DEPENDS:=+libc
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes("inside 'Package/foo'"), 'indented define in the hunk header must still attribute the package');
  });

  test('stays silent when the commit touches no Makefile at all', () => {
    const commit = { commit: { message: 'docs: tweak readme' } };
    const patch = `
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 hello
+world
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 0);
    assert.ok(!res.successes.some(s => s.includes("No feed package forces its own inclusion")));
  });

  test('reports an identical DEFAULT+BUILDBOT line only once per patch', () => {
    const commit = { commit: { message: 'foo: default on buildbot' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -1,2 +1,3 @@
 define Package/foo
+  DEFAULT:=y if BUILDBOT
 endef
diff --git a/utils/bar/Makefile b/utils/bar/Makefile
--- a/utils/bar/Makefile
+++ b/utils/bar/Makefile
@@ -1,2 +1,3 @@
 define Package/foo
+  DEFAULT:=y if BUILDBOT
 endef
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
  });

  test('respects check_buildbot_default: false and "disabled" configuration options', () => {
    for (const level of [false, 'disabled']) {
      const commit = { commit: { message: 'foo: add DEFAULT' } };
      const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -1,2 +1,3 @@
 define Package/foo
+  DEFAULT:=y if BUILDBOT
 endef
    `;
      const res = validateMakefileContext(commit, patch, buildbotConfig(level), freshState(), 'openwrt/packages');
      assert.strictEqual(res.errors.length, 0);
      assert.strictEqual(res.warnings.length, 0);
      assert.ok(!res.successes.some(s => s.includes('BUILDBOT')), `Successes: ${res.successes.join(', ')}`);
    }
  });

  test('rejects reuse of PKG_NAME in call, define, and eval lines', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git b/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/$(PKG_NAME)
+$(eval $(call BuildPackage,$(PKG_NAME)))
+define Package/\${PKG_NAME}/description
+\$(call BuildPackage,\${PKG_NAME})
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 4);
    assert.ok(res.errors[0].includes("reuses PKG_NAME in a call, define, or eval"));
    assert.ok(res.errors[1].includes("reuses PKG_NAME in a call, define, or eval"));
    assert.ok(res.errors[2].includes("reuses PKG_NAME in a call, define, or eval"));
    assert.ok(res.errors[3].includes("reuses PKG_NAME in a call, define, or eval"));
  });

  test('accepts literal package name in call, define, and eval lines', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git b/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo
+\$(eval \$(call BuildPackage,foo))
+define Package/foo/description
+\$(call BuildPackage,foo)
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false
    };
    const resClean = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(resClean.errors.length, 0);
    assert.ok(resClean.successes.some(s => s.includes("does not reuse PKG_NAME in call, define, or eval")));
  });

  test('allows PKG_NAME outside of call, define, and eval lines', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git b/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+PKG_BUILD_DIR:=\$(BUILD_DIR)/\$(PKG_NAME)-\$(PKG_VERSION)
+PKG_SOURCE_URL:=https://github.com/foo/\$(PKG_NAME)
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('ignores comments containing PKG_NAME inside eval/call/define patterns', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git b/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+# \$(eval \$(call BuildPackage,\$(PKG_NAME)))
+# define Package/\$(PKG_NAME)
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

});

describe('validateMakefileContext dead package variables', () => {
  const DEAD_CONFIG = CONFIG;
  const state = () => ({ isNewPackage: false, isDroppedPackage: false });

  test('flags top-level PROVIDES in a LuCI Makefile and suggests PKG_PROVIDES', () => {
    const commit = { commit: { message: 'luci-app-qosify: provide luci-app-qos' } };
    const patch = `
diff --git a/applications/luci-app-qosify/Makefile b/applications/luci-app-qosify/Makefile
--- a/applications/luci-app-qosify/Makefile
+++ b/applications/luci-app-qosify/Makefile
@@ -7,6 +7,7 @@
 LUCI_TITLE:=LuCI interface for qosify
 LUCI_DEPENDS:=+qosify
 LUCI_PKGARCH:=all
+PROVIDES:=luci-app-qos
    `;
    const res = validateMakefileContext(commit, patch, DEAD_CONFIG, state());
    assert.ok(res.errors.some(e => e.includes("Use 'PKG_PROVIDES:=luci-app-qos'")), `Errors: ${res.errors.join(', ')}`);
  });

  test('flags top-level MAINTAINER in a regular package and suggests PKG_MAINTAINER', () => {
    const commit = { commit: { message: 'mypkg: fix maintainer' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+MAINTAINER:=Jane Doe <jane@doe.com>
    `;
    const res = validateMakefileContext(commit, patch, DEAD_CONFIG, state());
    assert.ok(res.errors.some(e => e.includes("Use 'PKG_MAINTAINER:=Jane Doe <jane@doe.com>'")), `Errors: ${res.errors.join(', ')}`);
  });

  test('flags top-level DEPENDS in a regular package and points to the Package block', () => {
    const commit = { commit: { message: 'mypkg: add dependency' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+DEPENDS:=+libfoo
    `;
    const res = validateMakefileContext(commit, patch, DEAD_CONFIG, state());
    assert.ok(res.errors.some(e => e.includes("Move 'DEPENDS:=+libfoo' into the 'define Package/<name>' block")), `Errors: ${res.errors.join(', ')}`);
  });

  test('does not flag variables inside a define block', () => {
    const commit = { commit: { message: 'mypkg: add package definition' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
@@ -10,0 +11,6 @@
+define Package/mypkg
+  SECTION:=utils
+  CATEGORY:=Utilities
+TITLE:=Unindented but still inside the block
+  DEPENDS:=+libbar
+endef
    `;
    const res = validateMakefileContext(commit, patch, DEAD_CONFIG, state());
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('derives define state from the hunk header context', () => {
    const commit = { commit: { message: 'mypkg: extend package definition' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
@@ -12,3 +12,4 @@ define Package/mypkg
   SECTION:=utils
   CATEGORY:=Utilities
+DEPENDS:=+libbar
    `;
    const res = validateMakefileContext(commit, patch, DEAD_CONFIG, state());
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('suppresses the missing-colon suggestion for a dead assignment', () => {
    const commit = { commit: { message: 'mypkg: provide virtual package' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+PROVIDES=mypkg-virtual
    `;
    const config = { ...DEAD_CONFIG, check_missing_colon: true, check_space_after_assignment: true };
    const res = validateMakefileContext(commit, patch, config, state());
    assert.ok(res.errors.some(e => e.includes('no effect') || e.includes("'define Package/<name>' block")), `Errors: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes("uses '=' instead of ':='")), `Errors: ${res.errors.join(', ')}`);
  });

  test('skips build infrastructure Makefiles', () => {
    const commit = { commit: { message: 'ti-k3: add target' } };
    const patch = `
--- a/target/linux/ti-k3/Makefile
+++ b/target/linux/ti-k3/Makefile
+MAINTAINER:=Jane Doe <jane@doe.com>
    `;
    const res = validateMakefileContext(commit, patch, DEAD_CONFIG, state());
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('reports success when a package Makefile stays clean', () => {
    const commit = { commit: { message: 'mypkg: update to 1.2' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+PKG_VERSION:=1.2
    `;
    const res = validateMakefileContext(commit, patch, { ...DEAD_CONFIG, check_pkg_version: false }, state());
    assert.ok(res.successes.some(s => s.includes('per-package variables')), `Successes: ${res.successes.join(', ')}`);
  });
});

describe('isPackageMakefilePath', () => {
  test('accepts package and feed Makefiles', () => {
    assert.strictEqual(isPackageMakefilePath('package/utils/bash/Makefile'), true);
    assert.strictEqual(isPackageMakefilePath('package/lang/python/python3/Makefile'), true);
    assert.strictEqual(isPackageMakefilePath('net/mosdns/Makefile'), true);
    assert.strictEqual(isPackageMakefilePath('./package/utils/bash/Makefile'), true);
  });

  test('rejects build infrastructure Makefiles', () => {
    assert.strictEqual(isPackageMakefilePath('target/linux/ti-k3/Makefile'), false);
    assert.strictEqual(isPackageMakefilePath('target/linux/ti-k3/image/Makefile'), false);
    assert.strictEqual(isPackageMakefilePath('tools/newtool/Makefile'), false);
    assert.strictEqual(isPackageMakefilePath('toolchain/gcc/Makefile'), false);
    assert.strictEqual(isPackageMakefilePath('Makefile'), false);
  });

  test('rejects non-Makefile paths', () => {
    assert.strictEqual(isPackageMakefilePath('package/utils/bash/Makefile.in'), false);
    assert.strictEqual(isPackageMakefilePath('include/package.mk'), false);
    assert.strictEqual(isPackageMakefilePath(''), false);
    assert.strictEqual(isPackageMakefilePath(null), false);
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
+From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001
+From: John Doe <john@doe.com>
+Date: Tue, 7 Jul 2026 20:09:55 +0300
+Subject: [PATCH] Fix compilation issue
+
+Details of the fix
    `;
    const res = await validateEmbeddedPatches(patch, CONFIG);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.length > 0);
  });

  test('rejects patches missing From hash or Date headers (user example)', async () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
new file mode 100644
--- /dev/null
+++ b/package/utils/bash/patches/001-fix.patch
+From: Name <someone@domain.tld>
+Subject: [PATCH] commit
    `;
    const res = await validateEmbeddedPatches(patch, CONFIG);
    assert.ok(res.errors.some(e => e.includes('Missing required Git header')),
      `Expected error for missing headers, got: ${JSON.stringify(res.errors)}`);
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
      return `From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001\nFrom: John Doe <john@doe.com>\nDate: Tue, 7 Jul 2026 20:09:55 +0300\nSubject: [PATCH] Fix compilation issue\n\nCode content`;
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
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_RELEASE:=1
+PKG_RELEASE:=2
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

  // Regression: GitHub freezes pull_request.base.sha when the PR is opened.
  // A branch created before an in-main source bump then shows a PKG_SOURCE_VERSION
  // difference between base and head even though the PR never touched it, and
  // the audit used to report main's own bump - backwards - as this PR's doing,
  // demanding a PKG_RELEASE reset for a version change that does not exist.
  test('does not report a version change the PR diff never made (stale base.sha)', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/network/services/uhttpd/Makefile b/package/network/services/uhttpd/Makefile
+++ b/package/network/services/uhttpd/Makefile
-PKG_RELEASE:=1
+PKG_RELEASE:=2
+  USERID:=uhttpd=456:uhttpd=456
`
    }];
    // Head carries the older source (branched in June); base.sha resolves to a
    // main that bumped the source in August. The PR itself only bumps RELEASE.
    const headFetch = async () => 'PKG_NAME:=uhttpd\nPKG_SOURCE_DATE:=2026-06-16\nPKG_SOURCE_VERSION:=7b1bec45826bd78c8afc993435bdc0f1df2fe399\nPKG_RELEASE:=2\n';
    const baseFetch = async () => 'PKG_NAME:=uhttpd\nPKG_SOURCE_DATE:=2026-08-03\nPKG_SOURCE_VERSION:=60f64bec40c8113cf09815ec377761b1f4f95f22\nPKG_RELEASE:=1\n';

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(!res.successes.some(s => s.includes('version updated')), `Successes: ${res.successes.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes("PKG_RELEASE bumped from '1' to '2'")), `Successes: ${res.successes.join(', ')}`);
  });

  test('still reports a missing bump when only base.sha drifted and the PR bumped nothing', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+exec bash -l
`
    }];
    // Content changed, nothing bumped by the PR - the phantom version delta
    // from the drifted base must not silently satisfy the bump requirement.
    const headFetch = async (path) => path === 'package/utils/bash/Makefile'
      ? 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n' : null;
    const baseFetch = async (path) => path === 'package/utils/bash/Makefile'
      ? 'PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_RELEASE:=1\n' : null;

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('content changed without a PKG_RELEASE or version bump')), `Errors: ${res.errors.join(', ')}`);
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

  test('states the minor-change advice once per report, not once per package', async () => {
    const pkgs = ['bash', 'dnsmasq', 'busybox'];
    const commitDetails = [{
      commitPatch: pkgs.map(p => `
diff --git a/package/utils/${p}/files/${p}.init b/package/utils/${p}/files/${p}.init
+++ b/package/utils/${p}/files/${p}.init
+exec ${p}
`).join('')
    }];
    const makefileFor = (path) => {
      const pkg = pkgs.find(p => path === `package/utils/${p}/Makefile`);
      return pkg ? `PKG_NAME:=${pkg}\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n` : null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, makefileFor, makefileFor);
    assert.strictEqual(res.errors.length, 3);
    assert.ok(!res.errors.some(e => e.includes('Do not increment release for minor changes')));
    assert.strictEqual(res.notes.length, 1);
    assert.ok(res.notes[0].includes('Do not increment release for minor changes'));
  });

  test('carries no minor-change advice when nothing tripped the bump rule', async () => {
    const res = await validatePkgReleaseBumps([{ commitPatch: '' }], defaultConf, async () => null, async () => null);
    assert.deepStrictEqual(res.notes, []);
  });

  test('groupReleaseErrors folds the missing-bump errors into one list of packages', () => {
    const { packages, others } = groupReleaseErrors([
      'Package `package/utils/bash` content changed without a PKG_RELEASE or version bump.',
      "Package `package/utils/dnsmasq` version updated from '1.0' to '1.1', but PKG_RELEASE was not reset to 1 (currently: '3')",
      'Package `package/utils/busybox` content changed without a PKG_RELEASE or version bump.'
    ]);
    assert.deepStrictEqual(packages, ['package/utils/bash', 'package/utils/busybox']);
    assert.strictEqual(others.length, 1);
    assert.ok(others[0].includes('was not reset to 1'));
  });

  test('always returns a notes array, including on the skipped paths', async () => {
    const off = await validatePkgReleaseBumps([{ commitPatch: '' }], { check_pkg_release: false }, async () => null, async () => null);
    assert.deepStrictEqual(off.notes, []);

    const many = Array.from({ length: 16 }, (_, i) => `
diff --git a/package/utils/p${i}/Makefile b/package/utils/p${i}/Makefile
+++ b/package/utils/p${i}/Makefile
+PKG_NAME:=p${i}
`).join('');
    const tooMany = await validatePkgReleaseBumps([{ commitPatch: many }], defaultConf, async () => null, async () => null);
    assert.ok(tooMany.warnings.some(w => w.includes('audit skipped')));
    assert.deepStrictEqual(tooMany.notes, []);
  });

  test('groupReleaseErrors leaves unrelated errors untouched', () => {
    const { packages, others } = groupReleaseErrors(['Something else entirely']);
    assert.deepStrictEqual(packages, []);
    assert.deepStrictEqual(others, ['Something else entirely']);
  });

  test('passes when u-boot.mk based package Makefile changes non-cosmetically without PKG_RELEASE', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/boot/uboot-testboard/Makefile b/package/boot/uboot-testboard/Makefile
--- a/package/boot/uboot-testboard/Makefile
+++ b/package/boot/uboot-testboard/Makefile
+  HIDDEN:=1
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/boot/uboot-testboard/Makefile') {
        return 'PKG_NAME:=uboot-testboard\nPKG_VERSION:=2026.07\ninclude $(INCLUDE_DIR)/u-boot.mk\n\ndefine U-Boot/Default\n  HIDDEN:=1\nendef\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/boot/uboot-testboard/Makefile') {
        return 'PKG_NAME:=uboot-testboard\nPKG_VERSION:=2026.07\ninclude $(INCLUDE_DIR)/u-boot.mk\n\ndefine U-Boot/Default\nendef\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('shared build helper')));
  });

  test('still fails for non-u-boot package with no PKG_RELEASE and non-cosmetic changes', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+SOME_NEW_BUILD_FLAG:=1
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nSOME_NEW_BUILD_FLAG:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('content changed without a PKG_RELEASE or version bump')));
  });

  test('passes when tools/ package without PKG_RELEASE updates its version', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/tools/meson/Makefile b/tools/meson/Makefile
--- a/tools/meson/Makefile
+++ b/tools/meson/Makefile
-PKG_VERSION:=1.6.1
+PKG_VERSION:=1.11.2
`
    }];
    const headFetch = async (path) => {
      if (path === 'tools/meson/Makefile') {
        return 'PKG_NAME:=meson\nPKG_VERSION:=1.11.2\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'tools/meson/Makefile') {
        return 'PKG_NAME:=meson\nPKG_VERSION:=1.6.1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('host-side build tools without PKG_RELEASE')));
  });

  test('still fails when tools/ package that adopted PKG_RELEASE updates version without resetting it', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/tools/squashfs4/Makefile b/tools/squashfs4/Makefile
--- a/tools/squashfs4/Makefile
+++ b/tools/squashfs4/Makefile
-PKG_VERSION:=4.7.4
+PKG_VERSION:=4.7.5
`
    }];
    const headFetch = async (path) => {
      if (path === 'tools/squashfs4/Makefile') {
        return 'PKG_NAME:=squashfs4\nPKG_VERSION:=4.7.5\nPKG_RELEASE:=2\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'tools/squashfs4/Makefile') {
        return 'PKG_NAME:=squashfs4\nPKG_VERSION:=4.7.4\nPKG_RELEASE:=2\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('was not reset to 1')));
  });

  test('passes when tools/ package drops PKG_RELEASE while updating its version', async () => {
    // Accepted OpenWrt practice, see upstream cbf8c76d0a "tools/meson:
    // update to 1.2.1" - the exemption must not require base to lack
    // PKG_RELEASE too.
    const commitDetails = [{
      commitPatch: `
diff --git a/tools/meson/Makefile b/tools/meson/Makefile
--- a/tools/meson/Makefile
+++ b/tools/meson/Makefile
-PKG_VERSION:=1.1.1
-PKG_RELEASE:=2
+PKG_VERSION:=1.2.1
`
    }];
    const headFetch = async (path) => {
      if (path === 'tools/meson/Makefile') {
        return 'PKG_NAME:=meson\nPKG_VERSION:=1.2.1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'tools/meson/Makefile') {
        return 'PKG_NAME:=meson\nPKG_VERSION:=1.1.1\nPKG_RELEASE:=2\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('host-side build tools without PKG_RELEASE')));
  });

  test('passes when tools/ package without PKG_RELEASE changes patches only', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/toolchain/musl/patches/010-fix.patch b/toolchain/musl/patches/010-fix.patch
--- a/toolchain/musl/patches/010-fix.patch
+++ b/toolchain/musl/patches/010-fix.patch
+-void broken(void);
++void fixed(void);
`
    }];
    const fetchMakefile = async (path) => {
      if (path === 'toolchain/musl/Makefile') {
        return 'PKG_NAME:=musl\nPKG_VERSION:=1.2.5\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, fetchMakefile, fetchMakefile);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('host-side build tool')));
  });

  test('passes for new tools/ package without PKG_RELEASE', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/tools/newtool/Makefile b/tools/newtool/Makefile
new file mode 100644
--- /dev/null
+++ b/tools/newtool/Makefile
`
    }];
    const headFetch = async (path) => {
      if (path === 'tools/newtool/Makefile') {
        return 'PKG_NAME:=newtool\nPKG_VERSION:=1.0\n';
      }
      return null;
    };
    const baseFetch = async () => null;

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('host-side build tool')));
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
diff --git a/package/iozone/Makefile b/package/iozone/Makefile
+++ b/package/iozone/Makefile
-PKG_RELEASE:=1
+PKG_RELEASE:=2
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
diff --git a/luci/libs/luci-lib-uqr/Makefile b/luci/libs/luci-lib-uqr/Makefile
+++ b/luci/libs/luci-lib-uqr/Makefile
-PKG_RELEASE:=1
+PKG_RELEASE:=2
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

  test('handles null content for fetch base / head safely without crash', async () => {
    const commitDetails = [{
      commitPatch: `diff --git a/utils/mypkg/Makefile b/utils/mypkg/Makefile
--- a/utils/mypkg/Makefile
+++ b/utils/mypkg/Makefile
@@ -1,1 +1,2 @@
+PKG_VERSION:=2.0
+PKG_RELEASE:=2
`
    }];
    const headFetch = async () => 'PKG_VERSION:=2.0\nPKG_RELEASE:=2\n';
    const baseFetch = async () => null;

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res);
  });

  test('passes when nested version variable (e.g. GO_VERSION_PATCH) is bumped', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/golang/Makefile b/package/utils/golang/Makefile
+++ b/package/utils/golang/Makefile
-GO_VERSION_PATCH:=3
+GO_VERSION_PATCH:=4
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/golang/Makefile') {
        return 'PKG_NAME:=golang\nGO_VERSION_MAJOR_MINOR:=1.22\nGO_VERSION_PATCH:=4\nPKG_VERSION:=$(GO_VERSION_MAJOR_MINOR)$(if $(GO_VERSION_PATCH),.$(GO_VERSION_PATCH))\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/golang/Makefile') {
        return 'PKG_NAME:=golang\nGO_VERSION_MAJOR_MINOR:=1.22\nGO_VERSION_PATCH:=3\nPKG_VERSION:=$(GO_VERSION_MAJOR_MINOR)$(if $(GO_VERSION_PATCH),.$(GO_VERSION_PATCH))\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('version updated')));
  });

  test('resolves deeply nested variable references in PKG_VERSION', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/nestedpkg/Makefile b/package/utils/nestedpkg/Makefile
+++ b/package/utils/nestedpkg/Makefile
-VAR3:=old
+VAR3:=new
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/nestedpkg/Makefile') {
        return 'PKG_NAME:=nestedpkg\nVAR3:=new\nVAR2:=$(VAR3)\nVAR1:=$(VAR2)\nPKG_VERSION:=$(VAR1)\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/nestedpkg/Makefile') {
        return 'PKG_NAME:=nestedpkg\nVAR3:=old\nVAR2:=$(VAR3)\nVAR1:=$(VAR2)\nPKG_VERSION:=$(VAR1)\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('version updated')));
  });

  test('circular references do not cause infinite recursion', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/circularpkg/Makefile b/package/utils/circularpkg/Makefile
+++ b/package/utils/circularpkg/Makefile
-VAR2:=val
+VAR2:=val2
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/circularpkg/Makefile') {
        return 'PKG_NAME:=circularpkg\nVAR1:=$(VAR2)\nVAR2:=$(VAR1)\nPKG_VERSION:=$(VAR1)\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/circularpkg/Makefile') {
        return 'PKG_NAME:=circularpkg\nVAR1:=$(VAR2)\nVAR2:=$(VAR1)\nPKG_VERSION:=$(VAR1)\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res);
  });

  test('passes when python micro version variable is bumped', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/lang/python/Makefile b/package/lang/python/Makefile
+++ b/package/lang/python/Makefile
-PYTHON3_VERSION_MICRO:=4
+PYTHON3_VERSION_MICRO:=5
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/lang/python/Makefile') {
        return 'PKG_NAME:=python3\nPYTHON3_VERSION_MAJOR:=3\nPYTHON3_VERSION_MINOR:=14\nPYTHON3_VERSION_MICRO:=5\nPKG_VERSION:=$(PYTHON3_VERSION_MAJOR).$(PYTHON3_VERSION_MINOR).$(PYTHON3_VERSION_MICRO)\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/lang/python/Makefile') {
        return 'PKG_NAME:=python3\nPYTHON3_VERSION_MAJOR:=3\nPYTHON3_VERSION_MINOR:=14\nPYTHON3_VERSION_MICRO:=4\nPKG_VERSION:=$(PYTHON3_VERSION_MAJOR).$(PYTHON3_VERSION_MINOR).$(PYTHON3_VERSION_MICRO)\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('version updated')));
  });

  test('passes when a new collector sub-package is registered via an established template macro', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/utils/prometheus-node-exporter-ucode/Makefile b/utils/prometheus-node-exporter-ucode/Makefile
--- a/utils/prometheus-node-exporter-ucode/Makefile
+++ b/utils/prometheus-node-exporter-ucode/Makefile
+$(eval $(call Collector,mdadm,RAID status via /proc/mdstat,))
diff --git a/utils/prometheus-node-exporter-ucode/files/extra/mdadm.uc b/utils/prometheus-node-exporter-ucode/files/extra/mdadm.uc
new file mode 100644
--- /dev/null
+++ b/utils/prometheus-node-exporter-ucode/files/extra/mdadm.uc
+// mdadm collector
`
    }];
    const headFetch = async (path) => {
      if (path === 'utils/prometheus-node-exporter-ucode/Makefile') {
        return 'PKG_NAME:=prometheus-node-exporter-ucode\nPKG_VERSION:=2024.02.07\nPKG_RELEASE:=3\n\n$(eval $(call Collector,dnsmasq,Dnsmasq collector,))\n$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211))\n$(eval $(call Collector,mdadm,RAID status via /proc/mdstat,))\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'utils/prometheus-node-exporter-ucode/Makefile') {
        return 'PKG_NAME:=prometheus-node-exporter-ucode\nPKG_VERSION:=2024.02.07\nPKG_RELEASE:=3\n\n$(eval $(call Collector,dnsmasq,Dnsmasq collector,))\n$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211))\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('new sub-package via an existing template')));
  });

  test('still fails when the only template invocation is the package\'s sole/primary definition', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/utils/singlepkg/Makefile b/utils/singlepkg/Makefile
--- a/utils/singlepkg/Makefile
+++ b/utils/singlepkg/Makefile
+$(eval $(call BuildPackage,singlepkg))
diff --git a/utils/singlepkg/files/extra.uc b/utils/singlepkg/files/extra.uc
new file mode 100644
--- /dev/null
+++ b/utils/singlepkg/files/extra.uc
+// extra file
`
    }];
    const headFetch = async (path) => {
      if (path === 'utils/singlepkg/Makefile') {
        return 'PKG_NAME:=singlepkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n\n$(eval $(call BuildPackage,singlepkg))\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'utils/singlepkg/Makefile') {
        return 'PKG_NAME:=singlepkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('content changed without a PKG_RELEASE or version bump')));
  });

  test('still fails when an existing template invocation is modified rather than a new one added', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/utils/prometheus-node-exporter-ucode/Makefile b/utils/prometheus-node-exporter-ucode/Makefile
--- a/utils/prometheus-node-exporter-ucode/Makefile
+++ b/utils/prometheus-node-exporter-ucode/Makefile
-$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211))
+$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211 +ucode-mod-uci))
`
    }];
    const headFetch = async (path) => {
      if (path === 'utils/prometheus-node-exporter-ucode/Makefile') {
        return 'PKG_NAME:=prometheus-node-exporter-ucode\nPKG_VERSION:=2024.02.07\nPKG_RELEASE:=3\n\n$(eval $(call Collector,dnsmasq,Dnsmasq collector,))\n$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211 +ucode-mod-uci))\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'utils/prometheus-node-exporter-ucode/Makefile') {
        return 'PKG_NAME:=prometheus-node-exporter-ucode\nPKG_VERSION:=2024.02.07\nPKG_RELEASE:=3\n\n$(eval $(call Collector,dnsmasq,Dnsmasq collector,))\n$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211))\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('content changed without a PKG_RELEASE or version bump')));
  });

  // ─── Reverts ───────────────────────────────────────────────────

  const commitWith = (subject) => ({ commit: { message: `${subject}\n\nThis reverts commit 9fceb02d0ae598e95dc970b74767f19372d61af8.` } });

  // Reverting `mypkg: update to 1.2.3` restores both the older version and the
  // PKG_RELEASE that preceded the bump.
  const versionRevertPatch = `
diff --git a/package/utils/mypkg/Makefile b/package/utils/mypkg/Makefile
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
-PKG_VERSION:=1.2.3
+PKG_VERSION:=1.2.2
-PKG_RELEASE:=1
+PKG_RELEASE:=3
`;
  const versionRevertHead = async (path) =>
    path === 'package/utils/mypkg/Makefile' ? 'PKG_NAME:=mypkg\nPKG_VERSION:=1.2.2\nPKG_RELEASE:=3\n' : null;
  const versionRevertBase = async (path) =>
    path === 'package/utils/mypkg/Makefile' ? 'PKG_NAME:=mypkg\nPKG_VERSION:=1.2.3\nPKG_RELEASE:=1\n' : null;

  test('accepts a revert restoring an older version and its previous PKG_RELEASE', async () => {
    const commitDetails = [{ fullCommit: commitWith('mypkg: Revert "mypkg: update to 1.2.3"'), commitPatch: versionRevertPatch }];
    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, versionRevertHead, versionRevertBase);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('matching its state before the reverted commit')));
  });

  test('still demands a PKG_RELEASE reset for the same downgrade in a regular commit', async () => {
    const commitDetails = [{ fullCommit: commitWith('mypkg: downgrade to 1.2.2'), commitPatch: versionRevertPatch }];
    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, versionRevertHead, versionRevertBase);
    assert.ok(res.errors.some(e => e.includes('PKG_RELEASE was not reset to 1')));
  });

  test('keeps the audit strict when no commit message is available (PR-wide patch fallback)', async () => {
    const commitDetails = [{ commitPatch: versionRevertPatch }];
    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, versionRevertHead, versionRevertBase);
    assert.ok(res.errors.some(e => e.includes('PKG_RELEASE was not reset to 1')));
  });

  test('keeps the audit strict when allow_revert is disabled', async () => {
    const commitDetails = [{ fullCommit: commitWith('mypkg: Revert "mypkg: update to 1.2.3"'), commitPatch: versionRevertPatch }];
    const res = await validatePkgReleaseBumps(commitDetails, { ...defaultConf, allow_revert: false }, versionRevertHead, versionRevertBase);
    assert.ok(res.errors.some(e => e.includes('PKG_RELEASE was not reset to 1')));
  });

  test('keeps the audit strict when the body does not reference the reverted commit', async () => {
    const commitDetails = [{
      fullCommit: { commit: { message: 'mypkg: Revert "mypkg: update to 1.2.3"\n\nIt broke the build.' } },
      commitPatch: versionRevertPatch
    }];
    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, versionRevertHead, versionRevertBase);
    assert.ok(res.errors.some(e => e.includes('PKG_RELEASE was not reset to 1')));
  });

  test('keeps the audit strict when a regular commit touches the same package', async () => {
    const commitDetails = [
      { fullCommit: commitWith('mypkg: Revert "mypkg: update to 1.2.3"'), commitPatch: versionRevertPatch },
      {
        fullCommit: { commit: { message: 'mypkg: refresh patches' } },
        commitPatch: `
diff --git a/package/utils/mypkg/patches/001-fix.patch b/package/utils/mypkg/patches/001-fix.patch
--- a/package/utils/mypkg/patches/001-fix.patch
+++ b/package/utils/mypkg/patches/001-fix.patch
+context
`
      }
    ];
    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, versionRevertHead, versionRevertBase);
    assert.ok(res.errors.some(e => e.includes('PKG_RELEASE was not reset to 1')));
  });

  test('accepts a revert restoring a dropped package with its previous PKG_RELEASE', async () => {
    const commitDetails = [{
      fullCommit: commitWith('Revert "oldpkg: remove abandoned package"'),
      commitPatch: `
diff --git a/package/utils/oldpkg/Makefile b/package/utils/oldpkg/Makefile
new file mode 100644
--- /dev/null
+++ b/package/utils/oldpkg/Makefile
`
    }];
    const headFetch = async (path) =>
      path === 'package/utils/oldpkg/Makefile' ? 'PKG_NAME:=oldpkg\nPKG_VERSION:=2.0\nPKG_RELEASE:=5\n' : null;

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, async () => null);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('restored by a revert with its previous PKG_RELEASE')));
  });

  test('still requires a bump when a revert changes content without touching version or release', async () => {
    const commitDetails = [{
      fullCommit: commitWith('Revert "mypkg: tweak init script"'),
      commitPatch: `
diff --git a/package/utils/mypkg/files/mypkg.init b/package/utils/mypkg/files/mypkg.init
--- a/package/utils/mypkg/files/mypkg.init
+++ b/package/utils/mypkg/files/mypkg.init
+start_service() {
`
    }];
    const headFetch = async (path) =>
      path === 'package/utils/mypkg/Makefile' ? 'PKG_NAME:=mypkg\nPKG_VERSION:=1.2.2\nPKG_RELEASE:=3\n' : null;

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, headFetch);
    assert.ok(res.errors.some(e => e.includes('content changed without a PKG_RELEASE or version bump')));
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

    // Nested python, perl, php, ruby packages under lang/
    assert.strictEqual(await findPkgRoot('lang/python/python-selinux/Makefile', null), 'lang/python/python-selinux');
    assert.strictEqual(await findPkgRoot('lang/python/python-selinux/patches/001-fix.patch', null), 'lang/python/python-selinux');
    assert.strictEqual(await findPkgRoot('lang/python/python-selinux/src/subfolder/file.c', null), 'lang/python/python-selinux');
    assert.strictEqual(await findPkgRoot('package/lang/python/python-selinux/Makefile', null), 'package/lang/python/python-selinux');
    assert.strictEqual(await findPkgRoot('lang/python/Makefile', null), 'lang/python');

    assert.strictEqual(await findPkgRoot('lang/perl/perl-libxml/Makefile', null), 'lang/perl/perl-libxml');
    assert.strictEqual(await findPkgRoot('lang/php/php8-pecl-redis/Makefile', null), 'lang/php/php8-pecl-redis');
    assert.strictEqual(await findPkgRoot('lang/ruby/ruby-sass-listen/Makefile', null), 'lang/ruby/ruby-sass-listen');
    assert.strictEqual(await findPkgRoot('lang/lua/lua-foo/Makefile', null), 'lang/lua/lua-foo');
    assert.strictEqual(await findPkgRoot('lang/lua/lua-foo/patches/001-fix.patch', null), 'lang/lua/lua-foo');
    assert.strictEqual(await findPkgRoot('package/lang/lua/lua-foo/Makefile', null), 'package/lang/lua/lua-foo');

    // Non-nested languages (e.g. golang)
    assert.strictEqual(await findPkgRoot('lang/golang/Makefile', null), 'lang/golang');
    assert.strictEqual(await findPkgRoot('lang/golang/src/subfolder/file.c', null), 'lang/golang');

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

// ─── Root-level Feed Packages ────────────────────────────────────

describe('findPkgRoot for feeds without category directories', () => {
  const routingFetch = async (path) => {
    if (path === 'babeld/Makefile' || path === 'batman-adv/Makefile') {
      return 'PKG_NAME:=' + path.split('/')[0] + '\n';
    }
    return null;
  };

  test('resolves a routing feed package from its Makefile', async () => {
    assert.strictEqual(await findPkgRoot('babeld/Makefile', routingFetch, {}), 'babeld');
  });

  test('resolves a routing feed package from a nested file', async () => {
    assert.strictEqual(await findPkgRoot('batman-adv/files/etc/config/batman-adv', routingFetch, {}), 'batman-adv');
    assert.strictEqual(await findPkgRoot('babeld/patches/001-fix.patch', routingFetch, {}), 'babeld');
  });

  test('returns null for root directories that are not packages', async () => {
    assert.strictEqual(await findPkgRoot('scripts/dl_cleanup.py', async () => null, {}), null);
  });

  test('never guesses single-segment roots in dry mode (no fetch available)', async () => {
    assert.strictEqual(await findPkgRoot('scripts/dl_cleanup.py', null), null);
    assert.strictEqual(await findPkgRoot('babeld/Makefile', null), null);
    assert.strictEqual(await findPkgRoot('package/utils/bash/Makefile', null), 'package/utils/bash');
  });

  test('resolves video feed categories without probing', async () => {
    const noFetch = async () => { throw new Error('should not probe fast-path categories'); };
    assert.strictEqual(await findPkgRoot('frameworks/gstreamer1/Makefile', noFetch, {}), 'frameworks/gstreamer1');
    assert.strictEqual(await findPkgRoot('games/prboom/Makefile', noFetch, {}), 'games/prboom');
  });
});

// ─── SPDX License Check ──────────────────────────────────────────

describe('generated SPDX data', () => {
  test('records the SPDX release it was generated from', () => {
    assert.ok(SPDX_LICENSE_LIST_VERSION && SPDX_LICENSE_LIST_VERSION.length > 0);
  });

  test('carries a plausible identifier list', () => {
    assert.ok(SPDX_LICENSE_IDS.size > 500, `only ${SPDX_LICENSE_IDS.size} identifiers`);
    assert.ok(SPDX_EXCEPTION_IDS.size > 50, `only ${SPDX_EXCEPTION_IDS.size} exceptions`);
    assert.ok(SPDX_DEPRECATED.size > 20, `only ${SPDX_DEPRECATED.size} deprecated ids`);
    for (const id of ['MIT', 'GPL-2.0-only', 'Apache-2.0']) {
      assert.ok(SPDX_LICENSE_IDS.has(id), `${id} missing from the generated list`);
    }
  });

  test('never suggests a replacement that is not itself a valid identifier', () => {
    for (const [deprecatedId, replacement] of SPDX_DEPRECATED) {
      assert.ok(!SPDX_LICENSE_IDS.has(deprecatedId), `${deprecatedId} is listed as both valid and deprecated`);
      if (!replacement) continue;
      for (const option of replacement.split(' or ')) {
        const [licenseId, , exceptionId] = option.split(' ');
        assert.ok(SPDX_LICENSE_IDS.has(licenseId), `${deprecatedId} points at unknown identifier '${licenseId}'`);
        if (exceptionId) {
          assert.ok(SPDX_EXCEPTION_IDS.has(exceptionId), `${deprecatedId} points at unknown exception '${exceptionId}'`);
        }
      }
    }
  });
});

describe('checkSpdxIdentifier', () => {
  test('accepts identifiers from the SPDX list', () => {
    for (const id of ['MIT', 'GPL-2.0-only', 'GPL-2.0-or-later', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'Artistic-1.0-Perl', 'PHP-3.01', 'OLDAP-2.8', 'blessing']) {
      assert.strictEqual(checkSpdxIdentifier(id), null, `${id} should be valid`);
    }
  });

  test('accepts LicenseRef- identifiers for licenses SPDX does not list', () => {
    assert.strictEqual(checkSpdxIdentifier('LicenseRef-MaxLinear-Software-License-Agreement'), null);
  });

  test('reports deprecated identifiers with the SPDX replacement', () => {
    assert.deepStrictEqual(checkSpdxIdentifier('GPL-2.0'), {
      reason: 'is deprecated by SPDX',
      suggestion: "'GPL-2.0-only' or 'GPL-2.0-or-later'"
    });
    assert.deepStrictEqual(checkSpdxIdentifier('LGPL-2.1+'), {
      reason: 'is deprecated by SPDX',
      suggestion: "'LGPL-2.1-or-later'"
    });
  });

  test('offers no replacement when SPDX retired an id without a successor', () => {
    const res = checkSpdxIdentifier('GPL-3.0-with-GCC-exception');
    assert.strictEqual(res.reason, 'is deprecated by SPDX');
    assert.strictEqual(res.suggestion, null);
  });

  test('reports wrong capitalization with the exact identifier', () => {
    assert.deepStrictEqual(checkSpdxIdentifier('BSD-2-clause'), {
      reason: 'is written with the wrong capitalization',
      suggestion: "'BSD-2-Clause'"
    });
  });

  test('maps informal GPL spellings onto real identifiers', () => {
    assert.strictEqual(checkSpdxIdentifier('GPLv2').suggestion, "'GPL-2.0-only' or 'GPL-2.0-or-later'");
    assert.strictEqual(checkSpdxIdentifier('GPLv3').suggestion, "'GPL-3.0-only' or 'GPL-3.0-or-later'");
    assert.strictEqual(checkSpdxIdentifier('LGPLv2.1+').suggestion, "'LGPL-2.1-or-later'");
  });

  test('rewrites a hyphenated exception into the WITH operator', () => {
    assert.strictEqual(
      checkSpdxIdentifier('GPL-2.0-or-later-with-Autoconf-exception-2.0').suggestion,
      "'GPL-2.0-or-later WITH Autoconf-exception-2.0'"
    );
  });

  test('fixes the -later slip', () => {
    assert.strictEqual(checkSpdxIdentifier('GPL-3.0-later').suggestion, "'GPL-3.0-or-later'");
  });

  test('splits slash-joined pairs like MIT/X11', () => {
    assert.match(checkSpdxIdentifier('MIT/X11').suggestion, /'MIT' or 'X11'/);
  });

  test('names concrete identifiers for a bare license family', () => {
    assert.strictEqual(checkSpdxIdentifier('BSD').reason, 'names a license family rather than an SPDX identifier');
    assert.strictEqual(checkSpdxIdentifier('Apache').suggestion, "'Apache-2.0'");
    assert.strictEqual(checkSpdxIdentifier('Public-Domain').suggestion, "'CC0-1.0' or 'Unlicense'");
  });

  test('reports placeholders with no invented replacement', () => {
    for (const junk of ['VARIOUS', 'Custom', 'COPYING', 'EULA', 'FREE']) {
      const res = checkSpdxIdentifier(junk);
      assert.strictEqual(res.reason, 'is not a known SPDX identifier');
      assert.strictEqual(res.suggestion, null);
    }
  });
});

describe('validateMakefileContext SPDX licenses', () => {
  const SPDX_CONFIG = { ...CONFIG, check_spdx_license: true };
  const state = () => ({ isNewPackage: false, isDroppedPackage: false });
  const patchWith = (license) => `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+PKG_LICENSE:=${license}
    `;
  const commit = { commit: { message: 'mypkg: set license' } };

  test('warns about the deprecated GPL-2.0 identifier', () => {
    const res = validateMakefileContext(commit, patchWith('GPL-2.0'), SPDX_CONFIG, state());
    assert.ok(res.warnings.some(w => w.includes("'GPL-2.0-only' or 'GPL-2.0-or-later'")), `Warnings: ${res.warnings.join(', ')}`);
  });

  test('warns about informal spellings like GPLv2+', () => {
    const res = validateMakefileContext(commit, patchWith('GPLv2+'), SPDX_CONFIG, state());
    assert.ok(res.warnings.some(w => w.includes("'GPL-2.0-or-later'")), `Warnings: ${res.warnings.join(', ')}`);
  });

  test('warns about a bare BSD license', () => {
    const res = validateMakefileContext(commit, patchWith('BSD'), SPDX_CONFIG, state());
    assert.ok(res.warnings.some(w => w.includes('BSD-3-Clause')), `Warnings: ${res.warnings.join(', ')}`);
  });

  test('accepts valid SPDX expressions', () => {
    const res = validateMakefileContext(commit, patchWith('GPL-2.0-only OR MIT'), SPDX_CONFIG, state());
    assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('SPDX')), `Successes: ${res.successes.join(', ')}`);
  });

  test('leaves dynamic license values alone', () => {
    const res = validateMakefileContext(commit, patchWith('$(BASE_LICENSE)'), SPDX_CONFIG, state());
    assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
  });

  test('checks licenses appended with +=', () => {
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+PKG_LICENSE += GPLv2
    `;
    const res = validateMakefileContext(commit, patch, SPDX_CONFIG, state());
    assert.ok(res.warnings.some(w => w.includes("'GPL-2.0-only' or 'GPL-2.0-or-later'")), `Warnings: ${res.warnings.join(', ')}`);
  });

  test('ignores trailing comments after the license expression', () => {
    const res = validateMakefileContext(commit, patchWith('MIT # formerly GPLv2'), SPDX_CONFIG, state());
    assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
  });

  test('does nothing when disabled', () => {
    const res = validateMakefileContext(commit, patchWith('GPLv2'), { ...CONFIG, check_spdx_license: false }, state());
    assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
  });
});

// ─── Init Script Check ───────────────────────────────────────────

describe('validateMakefileContext init scripts', () => {
  const INIT_CONFIG = { ...CONFIG, check_init_scripts: true };
  const state = () => ({ isNewPackage: false, isDroppedPackage: false });
  const commit = { commit: { message: 'mypkg: add init script' } };
  const newInitPatch = (lines) => `
diff --git a/package/utils/mypkg/files/mypkg.init b/package/utils/mypkg/files/mypkg.init
--- /dev/null
+++ b/package/utils/mypkg/files/mypkg.init
@@ -0,0 +1,${lines.length} @@
${lines.map(l => '+' + l).join('\n')}
    `;

  test('warns when a new init script lacks the rc.common interpreter', () => {
    const patch = newInitPatch(['#!/bin/sh', 'START=95', 'start() { true; }']);
    const res = validateMakefileContext(commit, patch, INIT_CONFIG, state());
    assert.ok(res.warnings.some(w => w.includes("does not start with '#!/bin/sh /etc/rc.common'")), `Warnings: ${res.warnings.join(', ')}`);
  });

  test('warns when a new init script has no START= priority', () => {
    const patch = newInitPatch(['#!/bin/sh /etc/rc.common', 'start() { true; }']);
    const res = validateMakefileContext(commit, patch, INIT_CONFIG, state());
    assert.ok(res.warnings.some(w => w.includes("defines no 'START=' priority")), `Warnings: ${res.warnings.join(', ')}`);
  });

  test('accepts a proper rc.common init script', () => {
    const patch = newInitPatch(['#!/bin/sh /etc/rc.common', '', 'START=95', 'STOP=10', 'USE_PROCD=1', 'start_service() { true; }']);
    const res = validateMakefileContext(commit, patch, INIT_CONFIG, state());
    assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('rc.common interpreter')), `Successes: ${res.successes.join(', ')}`);
  });

  test('ignores patches, templates and docs under init.d paths', () => {
    const patch = `
diff --git a/package/utils/mypkg/files/etc/init.d/README.txt b/package/utils/mypkg/files/etc/init.d/README.txt
--- /dev/null
+++ b/package/utils/mypkg/files/etc/init.d/README.txt
+How the init scripts here are organized.
diff --git a/package/utils/mypkg/patches/001-etc-init.d-fix.patch b/package/utils/mypkg/patches/001-etc-init.d-fix.patch
--- /dev/null
+++ b/package/utils/mypkg/patches/001-etc-init.d-fix.patch
+--- a/etc/init.d/foo
++++ b/etc/init.d/foo
+@@ -1 +1 @@
+-old
++new
    `;
    const res = validateMakefileContext(commit, patch, INIT_CONFIG, state());
    assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
  });

  test('ignores edits to existing init scripts', () => {
    const patch = `
diff --git a/package/utils/mypkg/files/mypkg.init b/package/utils/mypkg/files/mypkg.init
--- a/package/utils/mypkg/files/mypkg.init
+++ b/package/utils/mypkg/files/mypkg.init
+reload_service() { true; }
    `;
    const res = validateMakefileContext(commit, patch, INIT_CONFIG, state());
    assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
  });

  test('does nothing when disabled', () => {
    const patch = newInitPatch(['#!/bin/sh', 'start() { true; }']);
    const res = validateMakefileContext(commit, patch, { ...CONFIG, check_init_scripts: false }, state());
    assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
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

  test('ignores init scripts under files/etc/init.d/ even when conffiles has a matching /etc/config/ entry', async () => {
    // Simulates a package where an init script at files/etc/init.d/foo
    // should NOT be flagged as a UCI config file even though the
    // Makefile conffiles block has /etc/config/foo.
    const patch = `
diff --git a/net/foo/files/etc/init.d/foo b/net/foo/files/etc/init.d/foo
new file mode 100644
--- /dev/null
+++ b/net/foo/files/etc/init.d/foo
    `;

    const fetchFn = async (path) => {
      if (path === 'net/foo/Makefile') {
        return `
define Package/foo/conffiles
/etc/config/foo
endef

define Package/foo/install
\t$(INSTALL_BIN) ./files/etc/init.d/foo $(1)/etc/init.d/foo
\t$(INSTALL_CONF) ./files/etc/config/foo $(1)/etc/config/foo
endef
        `;
      }
      if (path === 'net/foo/files/etc/init.d/foo') {
        return `#!/bin/sh /etc/rc.common\n\nSTART=20\n`;
      }
      if (path === 'net/foo/files/etc/config/foo') {
        return `config foo 'global'\n\toption enabled '1'\n`;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.strictEqual(res.errors.length, 0);
  });

  test('ignores ucode scripts under files/ that are not under files/etc/config/', async () => {
    // Simulates a package where a ucode library script at files/lib/foo/foo.uc
    // should NOT be flagged as a UCI config file even though the
    // Makefile conffiles block has /etc/config/foo.
    const patch = `
diff --git a/net/foo/files/lib/foo/foo.uc b/net/foo/files/lib/foo/foo.uc
new file mode 100644
--- /dev/null
+++ b/net/foo/files/lib/foo/foo.uc
    `;

    const fetchFn = async (path) => {
      if (path === 'net/foo/Makefile') {
        return `
define Package/foo/conffiles
/etc/config/foo
endef

define Package/foo/install
\t$(INSTALL_DIR) $(1)/usr/lib/foo
\t$(INSTALL_DATA) ./files/lib/foo/foo.uc $(1)/usr/lib/foo/foo.uc
\t$(INSTALL_CONF) ./files/etc/config/foo $(1)/etc/config/foo
endef
        `;
      }
      if (path === 'net/foo/files/lib/foo/foo.uc') {
        return `'use strict';\n\n// helper functions\n`;
      }
      if (path === 'net/foo/files/etc/config/foo') {
        return `config foo 'global'\n\toption enabled '1'\n`;
      }
      return null;
    };

    const res = await validateUciConfigs(patch, CONFIG, fetchFn);
    assert.strictEqual(res.errors.length, 0);
  });

  test('ignores sed scripts and defaults files', async () => {
    const patch = `
diff --git a/package/utils/foo/files/foo.conf.sed b/package/utils/foo/files/foo.conf.sed
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.conf.sed
diff --git a/package/utils/foo/files/foo.defaults b/package/utils/foo/files/foo.defaults
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/files/foo.defaults
    `;

    const fetchFn = async (path) => {
      if (path === 'package/utils/foo/Makefile') {
        return `
define Package/foo/install
\t$(INSTALL_DATA) ./files/foo.conf.sed $(1)/usr/share/foo/foo.conf.sed
\t$(INSTALL_DATA) ./files/foo.defaults $(1)/etc/uci-defaults/foo
\t$(INSTALL_DATA) ./files/foo.conf $(1)/etc/config/foo
endef
        `;
      }
      if (path === 'package/utils/foo/files/foo.conf.sed') {
        return `s/a/b/\n`;
      }
      if (path === 'package/utils/foo/files/foo.defaults') {
        return `chown foo:foo /etc/foo.conf\n`;
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
