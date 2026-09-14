import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isValidName, parseRevertSubject, parseRevertCommit, validateFormalities } from '../../src/validators.js';
import {
  CONFIG, JOHN, makeCommit, commitBy,
  assertSomeIncludes, assertNoneIncludes, assertNoErrors, assertErrorIncludes, assertNoErrorIncludes
} from './helpers.js';

const JANE = Object.freeze({ name: 'Jane Smith', email: 'jane@smith.com' });
const JANE_AT_EXAMPLE = Object.freeze({ name: 'Jane Smith', email: 'jane@example.com' });
const ALICE = Object.freeze({ name: 'Alice B. Cooper', email: 'alice@example.com' });
// The committer GitHub records for a commit made in its web interface.
const GITHUB = Object.freeze({ name: 'GitHub', email: 'noreply@github.com' });
const VERIFIED = Object.freeze({ verified: true, key_id: 'GPGKEYID' });

// A commit whose message ends with the author's own sign-off. The author also
// commits it unless fields name someone else.
const signedOff = (text, author = JOHN, fields = {}) =>
  makeCommit(`${text}\n\nSigned-off-by: ${author.name} <${author.email}>`, { author, committer: author, ...fields });

// A signed commit made in the GitHub web interface on the author's behalf.
const webCommit = (text, author) => ({
  parents: [{ sha: 'parent-sha' }],
  ...signedOff(text, author, { committer: GITHUB, verification: VERIFIED })
});

const assertWarningIncludes = (res, text) => assertSomeIncludes(res.warnings, text, 'warnings');
const assertNoWarningIncludes = (res, text) => assertNoneIncludes(res.warnings, text, 'warnings');
const assertSuccessIncludes = (res, text) => assertSomeIncludes(res.successes, text, 'successes');

describe('isValidName', () => {
  const cases = [
    ['accepts standard two-word names', true, ['John Doe']],
    ['accepts hyphenated names (e.g. Asian naming)', true, ['Wei-Ting Yang', 'Jean-Luc Picard']],
    ['accepts names with apostrophes', true, ["Brian O'Connor"]],
    ['accepts names with dots', true, ['J. Doe']],
    ['accepts Unicode characters (e.g. Nordic)', true, ['Øyvind Sivertsen']],
    ['rejects single-word names', false, ['Linus']],
    ['rejects names with underscores', false, ['john_doe']],
    ['rejects double spaces', false, ['John  Doe']],
    ['rejects leading/trailing whitespace', false, [' John Doe', 'John Doe ']],
    ['rejects invalid characters (slashes, etc.)', false, ['John/Doe']]
  ];

  for (const [title, valid, names] of cases) {
    test(title, () => {
      for (const name of names) {
        assert.strictEqual(isValidName(name), valid, `isValidName(${JSON.stringify(name)})`);
      }
    });
  }
});

describe('validateFormalities', () => {
  // Every body-width case shares the subject and varies only the body.
  const fixBuild = (body) => signedOff(`bash: fix build issue\n\n${body}`);

  // `author` is the GitHub account the author email resolved to, or null.
  const accountCommit = (author) => ({ author, ...signedOff('mypkg: fix bug\n\nSome description text', JANE) });

  test('passes a fully valid commit', async () => {
    const commit = {
      parents: [{ sha: 'parent-sha' }],
      ...signedOff('bash: update to 5.3 patch level 15\n\nAdd support for new upstream features.\nhttps://lists.gnu.org/archive/html/bug-bash/', JOHN, { verification: VERIFIED })
    };
    const res = await validateFormalities(commit, CONFIG);
    assertNoErrors(res);
    assert.ok(res.successes.length > 0);
  });

  test('catches empty commit message', async () => {
    const res = await validateFormalities(makeCommit('', { author: JOHN }), CONFIG);
    assertErrorIncludes(res, 'empty');
  });

  test('catches noreply email and missing Signed-off-by', async () => {
    const res = await validateFormalities(commitBy('bash: test subject line', { name: 'John Doe', email: 'john@noreply.github.com' }), CONFIG);
    assertErrorIncludes(res, 'noreply address');
    assertErrorIncludes(res, 'Signed-off-by');
  });

  test('passes GitHub web UI commit with valid author identity', async () => {
    const res = await validateFormalities(webCommit('mwan3: add configurable nslookup name\n\nAllow the config to specify a name.', ALICE), CONFIG);
    assertNoErrorIncludes(res, 'Committer name format is invalid');
    assertNoErrorIncludes(res, 'noreply address');
    assertNoErrors(res);
  });

  test('still catches invalid author name in GitHub web UI commit', async () => {
    const res = await validateFormalities(webCommit('mwan3: test', { name: 'badname', email: 'bad@example.com' }), CONFIG);
    assertErrorIncludes(res, 'Author name format is invalid');
    assertNoErrorIncludes(res, 'Committer name format is invalid');
  });

  test('recognizes a web commit by the account GitHub resolved the committer to', async () => {
    const commit = {
      author: { login: 'alice' },
      committer: { login: 'web-flow' },
      ...webCommit('mwan3: add configurable nslookup name\n\nAllow the config to specify a name.', ALICE)
    };
    const res = await validateFormalities(commit, CONFIG);
    assertNoErrors(res);
    assertSuccessIncludes(res, 'committed through the GitHub web interface');
  });

  test('GitHub web commit SOB matches only against author, not committer', async () => {
    const res = await validateFormalities(webCommit('mwan3: add test feature\n\nSome body text.', JOHN), CONFIG);
    assertNoErrors(res);
    assertSuccessIncludes(res, 'Signed-off-by');
  });

  test('rejects merge commits', async () => {
    const commit = {
      parents: [{ sha: 'parent-sha-1' }, { sha: 'parent-sha-2' }],
      ...signedOff('bash: test subject line')
    };
    const res = await validateFormalities(commit, CONFIG);
    assertErrorIncludes(res, 'Merge commits are not allowed');
  });

  test('enforces soft and hard subject length limits', async () => {
    const resHard = await validateFormalities(makeCommit('bash: ' + 'a'.repeat(85), { author: JOHN }), CONFIG);
    assertErrorIncludes(resHard, 'exceeds hard limit');

    const resSoft = await validateFormalities(makeCommit('bash: ' + 'a'.repeat(65), { author: JOHN }), CONFIG);
    assertWarningIncludes(resSoft, 'exceeds soft limit');
  });

  test('measures the subject length without the autosquash marker', async () => {
    // The `fixup! ` marker disappears when the commit is squashed, so the
    // subject it is applied to keeps the full length budget.
    const subject = 'bash: ' + 'a'.repeat(54);
    assert.strictEqual(subject.length, CONFIG.max_subject_len_soft);
    const res = await validateFormalities(signedOff(`fixup! ${subject}\n\nCorrects the build flags.`), CONFIG);
    assertNoErrors(res);
    assertNoWarningIncludes(res, 'exceeds soft limit');
  });

  test('enforces body line length limit but ignores code blocks and URLs', async () => {
    // CONFIG.max_body_line_len is 100. A line of ordinary words can be wrapped
    // under it, so it is rejected.
    assertErrorIncludes(await validateFormalities(fixBuild('wrappable words '.repeat(8)), CONFIG), 'exceeds max width');

    // A long line inside a code block is not.
    assertNoErrorIncludes(await validateFormalities(fixBuild('Otherwise we get\n```\n' + 'a'.repeat(105) + '\n```'), CONFIG), 'exceeds max width');

    // Nor is one containing a URL, with an upper-case HTTPS or a git scheme.
    const httpsLine = 'This is a long line containing a URL: HTTPS://github.com/openwrt/openwrt-bot-worker/blob/4c90a2854344d1174d3c28a7b94c4ca324f13ce1/cloudflare-worker/src/validators.js#L1 which should be ignored';
    assertNoErrorIncludes(await validateFormalities(fixBuild(httpsLine), CONFIG), 'exceeds max width');
    const gitLine = 'This is a long line containing a git URL: git://git.openwrt.org/feed/packages.git/some/path/which/is/very/long/and/exceeds/the/limit/completely';
    assertNoErrorIncludes(await validateFormalities(fixBuild(gitLine), CONFIG), 'exceeds max width');
  });

  test('allows long body lines that cannot be wrapped under the limit', async () => {
    // A verbatim build error quoting a path longer than the limit — no line
    // break can bring it under 100 chars, and breaking inside the path would
    // corrupt the quoted log (openwrt/openwrt#21794).
    const logLine = "ERROR: module '/home/user/Development/OpenWrt/openwrt/build_dir/target-powerpc64_e5500_musl/linux-qoriq_generic/linux-6.12.67/net/ipv6/netfilter/ip6_tables.ko' is missing.";
    const resLogLine = await validateFormalities(signedOff(`netfilter: add missing symbol\n\nBuild fails with:\n\n${logLine}`), CONFIG);
    assertNoErrorIncludes(resLogLine, 'exceeds max width');

    // A single token longer than the limit is unbreakable on its own too.
    assertNoErrorIncludes(await validateFormalities(fixBuild('a'.repeat(105)), CONFIG), 'exceeds max width');

    // But a long line of ordinary words next to a long token elsewhere in the
    // body is still held to the limit.
    const resMixed = await validateFormalities(fixBuild(`${logLine}\n${'wrappable words '.repeat(8)}`), CONFIG);
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
      const res = await validateFormalities(fixBuild(`Context follows:\n\n${vline}`), CONFIG);
      assert.ok(!res.errors.some(e => e.includes('exceeds max width')), `should allow verbatim line: ${vline.slice(0, 40)}...`);
    }

    // One space of indent is how contributors write ordinary prose bullets —
    // those must keep wrapping like any other prose.
    const bullet = ' - This is only working if the first partition is active because recovery images are always flashed to the active partition';
    assert.ok(bullet.length > 100);
    assertErrorIncludes(await validateFormalities(fixBuild(bullet), CONFIG), 'exceeds max width');
  });

  test('rejects commit with only Signed-off-by and no description', async () => {
    const res = await validateFormalities(signedOff('mypkg: fix build issue', JANE_AT_EXAMPLE), CONFIG);
    assertErrorIncludes(res, 'description body is empty');
  });

  // Whether the body only restates the subject.
  const duplicateBodies = [
    ['warns when subject and body are semantically identical (e.g. mypkg: update to 1.2.3)', true, 'mypkg: update to 1.2.3\n\n- Update MyPkg to v1.2.3'],
    ['warns when subject and body are virtually identical (e.g. my-agent bump version to 2026.27)', true, 'my-agent: bump version to 2026.27\n\nUpgrade my-agent to the newest version'],
    ['warns when subject and body are virtually identical (e.g. my-cli update to 29.6.1)', true, 'my-cli: update to 29.6.1\n\nBump my-cli CLI from 29.4.1 to 29.6.1.'],
    ['warns when body only qualifies the kind of release (e.g. bird3: bump to v3.3.2)', true, 'bird3: bump to v3.3.2\n\nUpdate to latest upstream bugfix release.'],
    ['warns when body only claims bugs were fixed', true, 'mypkg: update to 2.4.0\n\nStable maintenance release, fixes bugs.'],
    ['does not warn when the body names what was fixed', false, 'bird3: bump to v3.3.2\n\nUpstream bugfix release, fixes a crash in the BGP reconfiguration path.'],
    ['does not warn when body has meaningful context beyond subject', false, 'my-cli: update to 29.6.1\n\nBump my-cli CLI to 29.6.1.\nThis release fixes a CVE in the CLI implementation.']
  ];

  for (const [title, duplicate, text] of duplicateBodies) {
    test(title, async () => {
      const res = await validateFormalities(signedOff(text, JANE_AT_EXAMPLE), CONFIG);
      if (duplicate) {
        assertWarningIncludes(res, 'identical or virtually identical');
      } else {
        assertNoWarningIncludes(res, 'identical or virtually identical');
      }
    });
  }

  test('correctly extracts SSH key signature fingerprint without the footer tag', async () => {
    const commit = signedOff('mypkg: fix build issue\n\nSome description body text', JANE_AT_EXAMPLE, {
      verification: {
        verified: true,
        reason: 'valid',
        signature: '-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAAAtteSBwdWJsaWNrZXk=\n-----END SSH SIGNATURE-----'
      }
    });
    const res = await validateFormalities(commit, CONFIG);
    const successStr = res.successes.find(s => s.includes('cryptographic signature'));
    assert.ok(successStr, 'Expected cryptographic signature success message');
    assert.ok(successStr.includes('SSH Key Fingerprint: SHA256:+TBIvMqpQRHPC3Z8XrLcBD54NjV/OozKzSaDG13PLm0'),
      `Expected key details containing fingerprint but got: ${successStr}`);
  });

  test('passes when require_linked_github_account is true and author is linked to GitHub user', async () => {
    const res = await validateFormalities(accountCommit({ login: 'johndoe' }), { ...CONFIG, require_linked_github_account: true });
    assertNoErrors(res);
  });

  test('fails when require_linked_github_account is true and author is not linked to GitHub user', async () => {
    const res = await validateFormalities(accountCommit(null), { ...CONFIG, require_linked_github_account: true });
    assertErrorIncludes(res, 'is not linked to any registered GitHub account');
  });

  test('warns instead of failing when require_linked_github_account is "warning" and author is not linked', async () => {
    const res = await validateFormalities(accountCommit(null), { ...CONFIG, require_linked_github_account: 'warning' });
    assertNoErrors(res);
    assertWarningIncludes(res, 'is not linked to any registered GitHub account');
  });

  test('passes spelling check when OpenWrt or openwrt is used correctly', async () => {
    const res = await validateFormalities(signedOff('mypkg: support OpenWrt properly\n\nWe love OpenWrt. Make sure it runs well under openwrt.', JANE), CONFIG);
    assertNoWarningIncludes(res, "Incorrect capitalization of 'OpenWrt'");
  });

  test('warns on incorrect casing of OpenWrt (e.g. OpenWRT, Openwrt, OPENWRT)', async () => {
    const misspellings = [
      ['mypkg: support OpenWRT', 'OpenWRT'],
      ['mypkg: fix compatibility\n\nThis is an Openwrt package.', 'Openwrt'],
      ['mypkg: fix compatibility\n\nThis is for OPENWRT.', 'OPENWRT']
    ];
    for (const [text, detected] of misspellings) {
      const res = await validateFormalities(signedOff(text, JANE), CONFIG);
      assertWarningIncludes(res, `Incorrect capitalization of 'OpenWrt' detected: '${detected}'`);
    }
  });

  test('ignores spelling check inside code blocks and URLs', async () => {
    const res = await validateFormalities(signedOff('mypkg: fix spelling in code blocks\n\nLook at this error:\n```\nOpenWRT compiler error: Openwrt is missing\n```\nAlso check out https://github.com/OpenWRT/packages', JANE), CONFIG);
    assertNoWarningIncludes(res, "Incorrect capitalization of 'OpenWrt'");
  });

  test('does not perform spelling check when disabled in config', async () => {
    const res = await validateFormalities(signedOff('mypkg: support OpenWRT', JANE), { ...CONFIG, check_openwrt_spelling: false });
    assertNoWarningIncludes(res, "Incorrect capitalization of 'OpenWrt'");
  });

  test('rejects a description that follows the subject without a blank line', async () => {
    const res = await validateFormalities(signedOff('mypkg: update to 1.2.3\nUpdate to the latest upstream release.', JANE), CONFIG);
    assertErrorIncludes(res, 'followed by a blank line');
  });

  test('accepts a subject separated from the description by a blank line', async () => {
    const res = await validateFormalities(signedOff('mypkg: update to 1.2.3\n\nUpdate to the latest upstream release.\nhttps://example.com/changelog', JANE), CONFIG);
    assertNoErrorIncludes(res, 'followed by a blank line');
  });

  test('warns when the subject uses past tense instead of imperative mood', async () => {
    const res = await validateFormalities(signedOff('mypkg: added support for foo\n\nAdd the foo feature.\nhttps://example.com/', JANE), { ...CONFIG, warn_imperative_mood: true });
    assertWarningIncludes(res, "write 'add ...'");
  });

  test('does not warn about imperative subjects', async () => {
    const res = await validateFormalities(signedOff('mypkg: add support for foo\n\nAdd the foo feature.\nhttps://example.com/', JANE), { ...CONFIG, warn_imperative_mood: true });
    assertNoWarningIncludes(res, 'imperative mood');
  });

  test('does not warn about mood when disabled', async () => {
    const res = await validateFormalities(signedOff('mypkg: added support for foo\n\nAdd the foo feature.\nhttps://example.com/', JANE), { ...CONFIG, warn_imperative_mood: false });
    assertNoWarningIncludes(res, 'imperative mood');
  });

  // Source tree paths as the subject prefix. A row with an `error` is rejected
  // with it; every other row is accepted.
  const prefixedSubjects = [
    {
      title: 'accepts tools/cmake prefix format for build tool commits',
      commit: signedOff('tools/cmake: backport bootstrap fix for GCC 16\n\nApply upstream fix for bootstrap with GCC 16.\nhttps://cmake.org/', JANE)
    },
    {
      title: 'accepts tools/bison prefix format for build tool commits',
      commit: signedOff('tools/bison: update to 3.8.2\n\nUpdate bison to latest stable release.\nhttps://ftp.gnu.org/gnu/bison/')
    },
    {
      title: 'rejects tools/cmake with uppercase after prefix',
      commit: signedOff('tools/cmake: Backport bootstrap fix for GCC 16\n\nApply upstream fix.', JANE),
      error: 'lower-case word after the prefix'
    },
    {
      title: 'rejects tools/cmake with period at end of subject',
      commit: signedOff('tools/cmake: backport bootstrap fix for GCC 16.\n\nApply upstream fix.', JANE),
      error: 'must not end with a period'
    },
    {
      title: 'accepts toolchain/musl prefix format',
      commit: signedOff('toolchain/musl: update to 1.2.5\n\nRelease notes: https://musl.libc.org/releases.html', JANE)
    },
    {
      title: 'accepts a deeper source tree path as prefix',
      commit: signedOff('package/network/services/hostapd: fix build\n\nFix build against wolfssl.\nhttps://w1.fi/', JANE)
    },
    {
      title: 'rejects toolchain/musl with uppercase after prefix',
      commit: signedOff('toolchain/musl: Update to 1.2.5\n\nRelease notes: https://musl.libc.org/releases.html', JANE),
      error: 'lower-case word after the prefix'
    }
  ];

  for (const { title, commit, error } of prefixedSubjects) {
    test(title, async () => {
      const res = await validateFormalities(commit, CONFIG);
      if (error) {
        assertErrorIncludes(res, error);
      } else {
        assertNoErrors(res);
        assertSuccessIncludes(res, 'Commit subject layout and length are valid');
      }
    });
  }
});

const REVERTED_SHA = '9fceb02d0ae598e95dc970b74767f19372d61af8';

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
    const subjects = [
      'mypkg: revert the broken change',
      'Revert the broken change',
      'Reverted "mypkg: update to 1.2.3"',
      'toolchain: binutils: partially revert commit 525a1e94b343 "fix update to 2.45.1"'
    ];
    for (const subject of subjects) {
      assert.strictEqual(parseRevertSubject(subject), null, subject);
    }
  });
});

describe('parseRevertCommit', () => {
  test('accepts the reference `git revert` writes into the body', () => {
    const res = parseRevertCommit(`Revert "mypkg: update to 1.2.3"\n\nThis reverts commit ${REVERTED_SHA}.`);
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
    assert.strictEqual(parseRevertCommit(`Revert "mypkg: update to 1.2.3" This reverts commit ${REVERTED_SHA}.`), null);
  });

  test('rejects a body reference under a subject that is not a revert', () => {
    assert.strictEqual(parseRevertCommit(`mypkg: update to 1.2.3\n\nThis reverts commit ${REVERTED_SHA}.`), null);
  });

  test('looks past an autosquash marker', () => {
    const res = parseRevertCommit(`fixup! Revert "mypkg: update to 1.2.3"\n\nThis reverts commit ${REVERTED_SHA}.`);
    assert.strictEqual(res.original, 'mypkg: update to 1.2.3');
  });
});

describe('validateFormalities revert subjects', () => {
  const revertCommit = (subject) => signedOff(`${subject}\n\nThis reverts commit ${REVERTED_SHA}.\nIt broke the build on several targets.`);
  const unreferencedRevert = (subject) => signedOff(`${subject}\n\nIt broke the build on several targets.`);

  const acceptedReverts = [
    ['accepts the plain git revert format without a package prefix', 'Revert "generic: permit support of standalone PCS for external kernel module"'],
    ['accepts a revert of a revert', 'Revert "Revert "ramips: mt7620: fix patching mac address in caldata""'],
    ['accepts an upper-case Revert after a package prefix', 'irqbalance: Revert "irqbalance: update to 1.9.5"'],
    // 86 chars as written, 77 without the wrapper.
    ['excludes the Revert wrapper from the subject length limits', 'Revert "base-files: handle name collision between kernel UBI volume and MTD partition"']
  ];

  for (const [title, subject] of acceptedReverts) {
    test(title, async () => {
      const res = await validateFormalities(revertCommit(subject), CONFIG);
      assertNoErrors(res);
      assertSuccessIncludes(res, 'Commit subject layout and length are valid (revert of');
    });
  }

  test('still enforces the hard limit on the reverted subject itself', async () => {
    const original = 'base-files: handle a name collision between the kernel UBI volume and the MTD partition';
    assert.ok(original.length > CONFIG.max_subject_len_hard);
    const res = await validateFormalities(revertCommit(`Revert "${original}"`), CONFIG);
    assert.ok(res.errors.some(e => e.includes('exceeds hard limit') && e.includes('excluding the `Revert "..."` wrapper')), `Errors: ${JSON.stringify(res.errors)}`);
  });

  test('still rejects a revert-like subject without the quoted original', async () => {
    const res = await validateFormalities(revertCommit('Revert the broken PCS support'), CONFIG);
    assertErrorIncludes(res, 'must start with `<package name or prefix>: `');
  });

  test('enforces the regular subject rules when allow_revert is disabled', async () => {
    const res = await validateFormalities(revertCommit('Revert "generic: permit support of standalone PCS for external kernel module"'), { ...CONFIG, allow_revert: false });
    assertErrorIncludes(res, 'must start with `<package name or prefix>: `');
  });

  test('enforces the regular subject rules when the body does not reference the reverted commit', async () => {
    const res = await validateFormalities(unreferencedRevert('Revert "generic: permit support of standalone PCS for external kernel module"'), CONFIG);
    assertErrorIncludes(res, 'must start with `<package name or prefix>: `');
    assertErrorIncludes(res, 'body does not reference the reverted commit');
  });

  test('does not hint at a missing reference when the subject passes the regular rules', async () => {
    // `mypkg: revert "..."` already satisfies the prefix and lower-case rules,
    // so an unreferenced revert stays valid rather than becoming an error.
    const res = await validateFormalities(unreferencedRevert('mypkg: revert "the broken PCS support"'), CONFIG);
    assertNoErrors(res);
  });
});

describe('Signed-off-by parsing', () => {
  const commitWith = (message) => ({ ...commitBy(message, { name: 'Jane Doe', email: 'jane@doe.com' }), parents: [{}] });
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
    // the next one wrongly. A line that is one URL is never too long.
    const long = (n) => 'https://example.org/' + 'a'.repeat(140) + `#${n}`;
    const message = ['pkg: update', '', long(1), long(2), long(3), '', 'Signed-off-by: Jane Doe <jane@doe.com>'].join('\n');
    const res = await validateFormalities(commitWith(message), { ...SIGNOFF_CONFIG, max_body_line_len: 100 });
    assertNoErrors(res);
    assertNoWarningIncludes(res, 'exceeds');
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
      assert.deepStrictEqual(res.errors, [], `${trailer} -> ${res.errors.join(', ')}`);
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
    assertErrorIncludes(res, 'Signed-off-by');
  });
});
