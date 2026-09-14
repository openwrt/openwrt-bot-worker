import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isValidName, parseRevertSubject, parseRevertCommit, validateFormalities } from '../../src/validators.js';
import { CONFIG } from './helpers.js';

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

  test('warns when the subject uses past tense instead of imperative mood', async () => {
    const commit = {
      commit: {
        message: 'mypkg: added support for foo\n\nAdd the foo feature.\nhttps://example.com/\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res = await validateFormalities(commit, { ...CONFIG, warn_imperative_mood: true });
    assert.ok(res.warnings.some(w => w.includes("write 'add ...'")), `Warnings: ${res.warnings.join(', ')}`);
  });

  test('does not warn about imperative subjects', async () => {
    const commit = {
      commit: {
        message: 'mypkg: add support for foo\n\nAdd the foo feature.\nhttps://example.com/\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res = await validateFormalities(commit, { ...CONFIG, warn_imperative_mood: true });
    assert.ok(!res.warnings.some(w => w.includes('imperative mood')), `Warnings: ${res.warnings.join(', ')}`);
  });

  test('does not warn about mood when disabled', async () => {
    const commit = {
      commit: {
        message: 'mypkg: added support for foo\n\nAdd the foo feature.\nhttps://example.com/\n\nSigned-off-by: Jane Smith <jane@smith.com>',
        author: { name: 'Jane Smith', email: 'jane@smith.com' },
        committer: { name: 'Jane Smith', email: 'jane@smith.com' }
      }
    };
    const res = await validateFormalities(commit, { ...CONFIG, warn_imperative_mood: false });
    assert.ok(!res.warnings.some(w => w.includes('imperative mood')), `Warnings: ${res.warnings.join(', ')}`);
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

describe('Signed-off-by parsing', () => {
  const commitWith = (message) => ({
    commit: { message, author: { name: 'Jane Doe', email: 'jane@doe.com' }, committer: { name: 'Jane Doe', email: 'jane@doe.com' } },
    parents: [{}]
  });
  const SIGNOFF_CONFIG = { ...CONFIG, check_signoff: true, require_body: false, check_signature: false, require_linked_github_account: false };

  test('a trailer with an address but no name is not a sign-off', async () => {
    for (const trailer of ['Signed-off-by:<jane@doe.com>', 'Signed-off-by:   <jane@doe.com>']) {
      const res = await validateFormalities(commitWith(`pkg: update\n\n${trailer}`), SIGNOFF_CONFIG);
      assert.ok(res.errors.some(e => e.includes("Missing 'Signed-off-by:' line")),
        `${trailer} -> ${res.errors.join(', ')}`);
    }
  });

  test('does not miss the URL on every second long line', async () => {
    // The pattern that lets a long line off the width limit is shared; a
    // global one would carry its cursor from the previous line and answer
    // the next one wrongly.
    const long = (n) => 'https://example.org/' + 'a'.repeat(140) + `#${n}`;
    const message = ['pkg: update', '', long(1), long(2), long(3), '', 'Signed-off-by: Jane Doe <jane@doe.com>'].join('\n');
    const res = await validateFormalities(commitWith(message), { ...SIGNOFF_CONFIG, max_body_line_len: 100 });
    assert.strictEqual(res.errors.length, 0, `a line that is one URL is never too long: ${res.errors.join(', ')}`);
    assert.ok(!res.warnings.some(w => w.includes('exceeds')), `Unexpected warnings: ${res.warnings.join(', ')}`);
  });

  test('answers promptly on a long line that is not a URL', async () => {
    // 48 000 letters cost the old pattern about 5.5 seconds: it retried the
    // whole run at every starting position looking for a scheme.
    const message = 'pkg: update\n\n' + 'x'.repeat(48000) + '\n\nSigned-off-by: Jane Doe <jane@doe.com>';
    const started = process.hrtime.bigint();
    await validateFormalities(commitWith(message), SIGNOFF_CONFIG);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 2500, `parsing took ${ms.toFixed(0)} ms, which no invocation can afford`);
  });

  test('reads the name and address whatever spacing the trailer uses', async () => {
    const shapes = [
      'Signed-off-by: Jane Doe <jane@doe.com>',
      'Signed-off-by:Jane Doe <jane@doe.com>',
      'signed-off-by:   Jane Doe   <jane@doe.com>'
    ];
    for (const trailer of shapes) {
      const res = await validateFormalities(commitWith(`pkg: update\n\n${trailer}`), SIGNOFF_CONFIG);
      assert.strictEqual(res.errors.length, 0, `${trailer} -> ${res.errors.join(', ')}`);
    }
  });

  test('a trailer with no address is answered promptly, not by burning the invocation', async () => {
    // A commit message anyone can write. The pattern used to let the space
    // matcher and the name matcher compete for every space: 3000 of them cost
    // about six seconds of CPU, past what any Worker invocation gets, so the
    // run was killed and the pull request got no checks at all.
    const message = 'pkg: update\n\nSigned-off-by:' + ' '.repeat(3000);
    const started = process.hrtime.bigint();
    const res = await validateFormalities(commitWith(message), SIGNOFF_CONFIG);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // The bound is far above what the fixed pattern needs (hundredths of a
    // millisecond) and far below what the old one did (about 6 500 ms), so a
    // slow or loaded machine cannot turn this into a false alarm.
    assert.ok(ms < 2500, `parsing took ${ms.toFixed(0)} ms, which no invocation can afford`);
    assert.ok(res.errors.some(e => e.includes('Signed-off-by')), `an unsigned commit is still reported: ${res.errors.join(', ')}`);
  });
});
