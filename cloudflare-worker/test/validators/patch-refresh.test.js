import { describe, test } from 'node:test';
import assert from 'node:assert';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { validateEmbeddedPatches } from '../../src/validators.js';
import { readFixture, assertSomeIncludes, assertNoneIncludes, assertNoErrors } from './helpers.js';

// The header rule is off in most of these, so only the refresh rule speaks.
const REFRESH = { check_patch_headers: false, check_patch_refresh: true };
const NOT_WRITTEN_BY_REFRESH = "carries a diff the buildroot's refresh target did not write";
const ALL_REFRESHED = "✅ Embedded patch diffs match what the buildroot's refresh target writes";

// Diffs of a patch file. The lines of the patch file itself are given bare,
// or with the outer diff's +, - or space already in front for an edit.
const added = (path, lines) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n` +
  `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n`;
const edited = (path, hunk) =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n` +
  `@@ -10,8 +10,8 @@ Signed-off-by: A <a@b.c>\n${hunk.join('\n')}\n`;
const removed = (path, lines) =>
  `diff --git a/${path} b/${path}\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/${path}\n+++ /dev/null\n` +
  `@@ -1,${lines.length} +0,0 @@\n${lines.map(line => `-${line}`).join('\n')}\n`;

// A patch in the form the refresh target writes, and the same patch as
// `git format-patch` writes it.
const DESCRIPTION = [
  'From 0123456789012345678901234567890123456789 Mon Sep 17 00:00:00 2001',
  'From: A <a@b.c>',
  'Date: Mon, 1 Sep 2026 10:00:00 +0200',
  'Subject: [PATCH] fix the frobnicator',
  '',
  'It frobnicated twice.',
  '',
  'Signed-off-by: A <a@b.c>',
  '---'
];
const QUILT_BODY = [
  '--- a/src/foo.c',
  '+++ b/src/foo.c',
  '@@ -1,3 +1,3 @@ int main(void)',
  ' a',
  '-b',
  '+c',
  ' d'
];
const GIT_BODY = ['diff --git a/src/foo.c b/src/foo.c', 'index 1234567..89abcde 100644', ...QUILT_BODY];
const P = 'package/utils/foo/patches/010-fix.patch';

describe('validateEmbeddedPatches: diffs the refresh target did not write', () => {
  test('reports git\'s file header on a patch from openwrt PR 25595, with the command that rewrites it', async () => {
    const res = await validateEmbeddedPatches(readFixture('git-format-patch-file.patch'), REFRESH);
    assert.deepStrictEqual(res.errors, [
      "- Embedded patch file 'package/kernel/mac80211/patches/ath11k/953-wifi-ath11k-support-ipq9574.patch' carries a diff the buildroot's refresh target did not write: it still has git's `diff --git` file header, which quilt never emits. Regenerate it with `make package/mac80211/{clean,prepare} QUILT=1` followed by `make package/mac80211/refresh`, which rewrites the diff the way quilt writes it (`quilt refresh -p ab --no-index --no-timestamps`). The mail header and the description above the diff are preserved, so this does not undo the patch-header check."
    ]);
    assertNoneIncludes(res.successes, 'refresh target', 'successes');
    assert.strictEqual(res.incomplete, false);
  });

  test('passes a patch in the form quilt writes it', async () => {
    const res = await validateEmbeddedPatches(added(P, [...DESCRIPTION, ...QUILT_BODY]), REFRESH);
    assertNoErrors(res);
    assert.deepStrictEqual(res.successes, [ALL_REFRESHED]);
  });

  // The two patch rules ask for different parts of the file, so a patch can
  // satisfy both: the refresh target keeps the header above the diff.
  test('passes a git-am header over a quilt diff under both patch rules', async () => {
    const res = await validateEmbeddedPatches(added(P, [...DESCRIPTION, ...QUILT_BODY]),
      { check_patch_headers: true, check_patch_refresh: true });
    assertNoErrors(res);
    assertSomeIncludes(res.successes, 'contains valid Git compliance headers', 'successes');
    assertSomeIncludes(res.successes, ALL_REFRESHED, 'successes');
  });

  // A file can break both rules: each reports it once, the header rule first,
  // and each at its own level.
  test('reports a patch with neither the headers nor a refreshed diff under both rules', async () => {
    const bare = added(P, ['Fix the frobnicator.', '', ...GIT_BODY]);
    const warned = await validateEmbeddedPatches(bare, { check_patch_headers: true, check_patch_refresh: 'warning' });
    assert.strictEqual(warned.errors.length, 1);
    assert.match(warned.errors[0], /^- Embedded patch file '.*010-fix\.patch' is missing the 'From <commit hash>/);
    assert.strictEqual(warned.warnings.length, 1);
    assert.ok(warned.warnings[0].includes(NOT_WRITTEN_BY_REFRESH), warned.warnings[0]);

    const failed = await validateEmbeddedPatches(bare, { check_patch_headers: true, check_patch_refresh: 'error' });
    assert.deepStrictEqual(failed.errors, [warned.errors[0], warned.warnings[0]]);
    assert.deepStrictEqual(failed.warnings, []);
  });

  describe('names the first signal, in a fixed order', () => {
    for (const [title, body, clause] of [
      ['an Index: line', ['Index: foo/bar.c', '===================================================================', ...QUILT_BODY],
        'it has an `Index:` line, which `--no-index` removes'],
      ['git\'s index line on its own', ['index 1234567..89abcde 100644', ...QUILT_BODY],
        "it still has git's `index <hash>..<hash>` line, which quilt never emits"],
      ['timestamps before the prefixes that come with them', [
        '--- foo-1.2/src/x.c\t2024-01-01 10:00:00.000000000 +0000',
        '+++ foo-1.2.new/src/x.c\t2024-01-01 10:05:00.000000000 +0000',
        ...QUILT_BODY.slice(2)
      ], 'its `---`/`+++` lines still carry working-copy timestamps, which `--no-timestamps` removes'],
      ['paths without the a/ and b/ prefixes', ['--- foo-1.2/src/x.c', '+++ foo-1.2.new/src/x.c', ...QUILT_BODY.slice(2)],
        'its `---`/`+++` lines do not use the `a/` and `b/` prefixes that `-p ab` gives'],
      ['diff --git ahead of everything else', ['diff --git a/x b/x', 'index 1234567..89abcde', 'Index: x', '--- x\t1', '+++ y\t1', '@@ -1 +1 @@'],
        "it still has git's `diff --git` file header"]
    ]) {
      test(title, async () => {
        const res = await validateEmbeddedPatches(added(P, [...DESCRIPTION, ...body]), REFRESH);
        assert.strictEqual(res.errors.length, 1, JSON.stringify(res.errors));
        assert.ok(res.errors[0].includes(`${NOT_WRITTEN_BY_REFRESH}: ${clause}`), res.errors[0]);
      });
    }
  });

  test('does not read a patch that creates a file as a missing prefix', async () => {
    const res = await validateEmbeddedPatches(added(P, [
      ...DESCRIPTION, '--- /dev/null', '+++ b/src/new.c', '@@ -0,0 +1 @@', '+int x;',
      '--- a/src/gone.c', '+++ /dev/null', '@@ -1 +0,0 @@', '-int y;'
    ]), REFRESH);
    assertNoErrors(res);
    assert.deepStrictEqual(res.successes, [ALL_REFRESHED]);
  });

  describe('judges only what the pull request wrote', () => {
    // The file at the head commit is git-formatted, and the edit does not touch
    // that part of it. The rule never asks for the file.
    test('leaves an edit alone whose own lines are clean, without reading the file', async () => {
      const lookups = [];
      const fetch = async (path) => { lookups.push(path); return [...DESCRIPTION, ...GIT_BODY].join('\n'); };
      const res = await validateEmbeddedPatches(edited(P, [' a', '-b', '+c', ' d']), REFRESH, fetch);
      assert.deepStrictEqual(lookups, []);
      assertNoErrors(res);
      assert.deepStrictEqual(res.successes, [ALL_REFRESHED]);
    });

    test('leaves a git header rewritten in place alone', async () => {
      const res = await validateEmbeddedPatches(edited(P, [
        '-diff --git a/src/foo.c b/src/foo.c',
        '+diff --git a/src/bar.c b/src/bar.c',
        ' index 1234567..89abcde 100644',
        '----- a/src/foo.c',
        '-+++ b/src/foo.c',
        '+--- a/src/bar.c',
        '++++ b/src/bar.c'
      ]), REFRESH);
      assertNoErrors(res);
      assert.deepStrictEqual(res.successes, [ALL_REFRESHED]);
    });

    test('reports a git header an edit adds to a patch that had none', async () => {
      const res = await validateEmbeddedPatches(edited(P, [
        '+diff --git a/src/foo.c b/src/foo.c',
        '+index 1234567..89abcde 100644',
        ' --- a/src/foo.c',
        ' +++ b/src/foo.c'
      ]), REFRESH);
      assert.strictEqual(res.errors.length, 1, JSON.stringify(res.errors));
      assert.ok(res.errors[0].includes("git's `diff --git` file header"), res.errors[0]);
    });

    // A kernel bump GitHub shows as a delete and an add: the header travelled
    // with the patch, nobody wrote it.
    test('leaves a patch alone that a bump moved as a delete and an add', async () => {
      const content = [...DESCRIPTION, ...GIT_BODY];
      const res = await validateEmbeddedPatches(
        removed('target/linux/generic/pending-6.12/700-x.patch', content) +
        added('target/linux/generic/pending-6.18/700-x.patch', content), REFRESH);
      assertNoErrors(res);
      assert.deepStrictEqual(res.successes, [ALL_REFRESHED]);
    });

    test('leaves a patch alone that a bump renamed and edited', async () => {
      const from = 'package/boot/uboot-airoha/patches/307-net.patch';
      const to = 'package/boot/uboot-airoha/patches/308-net.patch';
      const rename = `diff --git a/${from} b/${to}\nsimilarity index 95%\nrename from ${from}\nrename to ${to}\nindex 1111111..2222222 100644\n` +
        `--- a/${from}\n+++ b/${to}\n@@ -14,7 +14,7 @@ Signed-off-by: A <a@b.c>\n diff --git a/net/x.c b/net/x.c\n` +
        `-index 1234567..89abcde 100644\n+index 7654321..edcba98 100644\n --- a/net/x.c\n +++ b/net/x.c\n`;
      const res = await validateEmbeddedPatches(rename, REFRESH);
      assertNoErrors(res);
      assert.deepStrictEqual(res.successes, [ALL_REFRESHED]);
    });

    // A u-boot bump that rewrites a git-format patch in place and adds a file
    // section: the new section's header is the form the file already has.
    test('leaves a bump alone that adds a section to a patch already in git format', async () => {
      const bump = edited('package/boot/uboot-airoha/patches/307-net.patch', [
        ' diff --git a/net/x.c b/net/x.c',
        '-index 1234567..89abcde 100644',
        '+index 7654321..edcba98 100644',
        ' --- a/net/x.c',
        ' +++ b/net/x.c',
        ' @@ -1 +1 @@',
        '-a',
        '+b',
        '+diff --git a/net/y.c b/net/y.c',
        '+index 1111111..2222222 100644',
        '+--- a/net/y.c',
        '++++ b/net/y.c',
        '+@@ -1 +1 @@',
        '+-c',
        '++d'
      ]);
      const res = await validateEmbeddedPatches(bump, REFRESH);
      assertNoErrors(res);
      assert.deepStrictEqual(res.successes, [ALL_REFRESHED]);
      // Control: the same added section in a patch whose context is quilt's
      // form is still reported, and so is a new git-format patch file.
      const intoQuilt = await validateEmbeddedPatches(edited(P, [
        ' --- a/net/x.c',
        ' +++ b/net/x.c',
        '+diff --git a/net/y.c b/net/y.c',
        '+index 1111111..2222222 100644',
        '+--- a/net/y.c',
        '++++ b/net/y.c'
      ]), REFRESH);
      assert.strictEqual(intoQuilt.errors.length, 1, JSON.stringify(intoQuilt.errors));
      assert.ok(intoQuilt.errors[0].includes("git's `diff --git` file header"), intoQuilt.errors[0]);
      const fresh = await validateEmbeddedPatches(added(P, [...DESCRIPTION, ...GIT_BODY]) + bump, REFRESH);
      assert.strictEqual(fresh.errors.length, 1, JSON.stringify(fresh.errors));
      assert.ok(fresh.errors[0].includes(`'${P}'`), fresh.errors[0]);
    });

    // Nothing was written, so there is nothing to pass either.
    test('judges nothing in a rename that keeps the content, or a file header with no hunks', async () => {
      const headerOnly = `diff --git a/${P} b/${P}\nold mode 100644\nnew mode 100755\n--- a/${P}\n+++ b/${P}\n`;
      for (const patch of [readFixture('rename-only.patch'), headerOnly]) {
        const res = await validateEmbeddedPatches(patch, REFRESH);
        assertNoErrors(res);
        assertNoneIncludes(res.successes, 'refresh target', 'successes');
      }
      const beside = await validateEmbeddedPatches(headerOnly + added('package/utils/foo/patches/020-other.patch', QUILT_BODY), REFRESH);
      assert.deepStrictEqual(beside.successes, [ALL_REFRESHED]);
    });

    test('says so when an edit takes git\'s header out of a patch', async () => {
      const res = await validateEmbeddedPatches(edited(P, [
        ' Signed-off-by: A <a@b.c>',
        ' ---',
        '-diff --git a/src/foo.c b/src/foo.c',
        '-index 1234567..89abcde 100644',
        ' --- a/src/foo.c',
        ' +++ b/src/foo.c'
      ]), REFRESH);
      assertNoErrors(res);
      assert.deepStrictEqual(res.successes, [
        `✅ Embedded patch '${P}' was regenerated with the buildroot's refresh target`,
        ALL_REFRESHED
      ]);
    });

    // A refresh takes every marker out, so one left in the context means this
    // edit was not one.
    test('does not call an edit a refresh when git\'s header stays in the context', async () => {
      const res = await validateEmbeddedPatches(edited(P, [
        ' diff --git a/src/foo.c b/src/foo.c',
        '-index 1234567..89abcde 100644',
        ' --- a/src/foo.c',
        ' +++ b/src/foo.c'
      ]), REFRESH);
      assertNoErrors(res);
      assert.deepStrictEqual(res.successes, [ALL_REFRESHED]);
    });
  });

  describe('lines that only look like diff headers', () => {
    test('a hunk removing a `-- comment` line, and one adding `++ x`', async () => {
      const res = await validateEmbeddedPatches(added(P, [
        ...DESCRIPTION, ...QUILT_BODY.slice(0, 3), ' select 1;', '--- comment text', ' select 2;', '+++ x', ' select 3;'
      ]), REFRESH);
      assertNoErrors(res);
      assert.deepStrictEqual(res.successes, [ALL_REFRESHED]);
    });

    test('a description quoting `diff --git` with nothing of git\'s under it', async () => {
      const res = await validateEmbeddedPatches(added(P, [
        ...DESCRIPTION.slice(0, 5), 'Upstream started from', 'diff --git a/x b/y', 'and went on from there.', '', ...QUILT_BODY
      ]), REFRESH);
      assertNoErrors(res);
      assert.deepStrictEqual(res.successes, [ALL_REFRESHED]);
    });

    // As net/nginx/patches/nginx-mod-lua/001-feature_support_pcre2.patch does:
    // the patched file is itself a patch, so its context is diff headers.
    test('diff headers in the context of the patched file', async () => {
      const res = await validateEmbeddedPatches(added(P, [
        ...DESCRIPTION, '--- a/t/patch.diff', '+++ b/t/patch.diff', '@@ -1,6 +1,6 @@',
        ' diff --git a/src/x.c b/src/x.c', ' index 1234567..89abcde 100644', ' --- x.c\t2020-01-01', ' +++ x.c\t2020-01-01',
        '-old', '+new'
      ]), REFRESH);
      assertNoErrors(res);
      assert.deepStrictEqual(res.successes, [ALL_REFRESHED]);
    });
  });

  // Each beside a git-formatted quilt patch, which is the one reported.
  describe('files the rule leaves alone', () => {
    const Q = 'package/utils/foo/patches/020-other.patch';
    const reportsOnlyTheQuiltPatch = (res) => {
      assert.strictEqual(res.errors.length, 1, JSON.stringify(res.errors));
      assert.ok(res.errors[0].startsWith(`- Embedded patch file '${Q}' ${NOT_WRITTEN_BY_REFRESH}`), res.errors[0]);
    };

    // admin/backuppc in openwrt/packages: installed and applied at run time.
    test('a patch outside a quilt patch directory', async () => {
      const res = await validateEmbeddedPatches(added('admin/backuppc/files/fixup-config-pl.patch', [
        '--- configure.pl.orig\t2020-06-20 18:46:27.000000000 +0200',
        '+++ configure.pl\t2020-06-21 11:12:36.373146571 +0200',
        '@@ -1 +1 @@', '-a', '+b'
      ]) + added(Q, GIT_BODY), REFRESH);
      reportsOnlyTheQuiltPatch(res);
    });

    test('a patch git carries as binary, and a deleted one', async () => {
      const binary = `diff --git a/${P} b/${P}\nnew file mode 100644\nindex 0000000..1111111\nGIT binary patch\nliteral 12\nzcmZ?wbhEHbWMg1qU}0ckU;qNNY5)Z~\n\n`;
      for (const patch of [binary, removed(P, [...DESCRIPTION, ...GIT_BODY])]) {
        reportsOnlyTheQuiltPatch(await validateEmbeddedPatches(patch + added(Q, GIT_BODY), REFRESH));
      }
    });

    test('a patch in a hidden directory', async () => {
      const res = await validateEmbeddedPatches(added('.github/patches/001-x.patch', GIT_BODY) + added(Q, GIT_BODY), REFRESH);
      reportsOnlyTheQuiltPatch(res);
    });
  });

  describe('in a series', () => {
    const envelope = (sha, subject) => `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: A <a@b.c>\nDate: Mon, 1 Sep 2026 10:00:00 +0200\nSubject: [PATCH] ${subject}\n\n`;

    test('reads no further than the next commit\'s envelope', async () => {
      // The second commit's message has lines a diff would read as a header
      // pair with timestamps; they are not part of the patch file above them.
      const series =
        envelope('a'.repeat(40), 'foo: add a fix') + 'Signed-off-by: A <a@b.c>\n---\n' + added(P, [...DESCRIPTION, ...QUILT_BODY]) +
        '-- \n2.43.0\n\n' +
        envelope('b'.repeat(40), 'foo: explain') + 'Quoting the old notes:\n+--- old\t1\n++++ new\t2\n---\n' +
        added('package/utils/foo/files/notes.txt', ['notes']);
      const res = await validateEmbeddedPatches(series, REFRESH);
      assertNoErrors(res);
      assert.deepStrictEqual(res.successes, [ALL_REFRESHED]);
    });

    test('leaves a git-formatted patch alone that a later commit refreshes', async () => {
      const series =
        envelope('a'.repeat(40), 'foo: add a fix') + '---\n' + added(P, [...DESCRIPTION, ...GIT_BODY]) +
        envelope('b'.repeat(40), 'foo: refresh patches') + '---\n' +
        edited(P, [' ---', '-diff --git a/src/foo.c b/src/foo.c', '-index 1234567..89abcde 100644', ' --- a/src/foo.c']);
      const res = await validateEmbeddedPatches(series, REFRESH);
      assertNoErrors(res);
      assertSomeIncludes(res.successes, ALL_REFRESHED, 'successes');
    });
  });

  describe('switches and levels', () => {
    const gitFormatted = added(P, [...DESCRIPTION, ...GIT_BODY]);

    test('runs with the header rule switched off, and asks for no file', async () => {
      const lookups = [];
      const res = await validateEmbeddedPatches(edited(P, ['+diff --git a/x b/x', '+index 1234567..89abcde']),
        REFRESH, async (path) => { lookups.push(path); return null; });
      assert.deepStrictEqual(lookups, []);
      assert.strictEqual(res.errors.length, 1, JSON.stringify(res.errors));
      assert.deepStrictEqual(res.skipped, []);
      assert.strictEqual(res.incomplete, false);
    });

    test('returns nothing when both patch rules are off', async () => {
      for (const off of [false, 'disabled']) {
        const res = await validateEmbeddedPatches(gitFormatted, { check_patch_headers: off, check_patch_refresh: off });
        assert.deepStrictEqual(res, { errors: [], successes: [], skipped: [], warnings: [], incomplete: false });
      }
    });

    test('reports a warning at the default level, and an error when asked', async () => {
      const warned = await validateEmbeddedPatches(gitFormatted, { check_patch_headers: false, check_patch_refresh: 'warning' });
      assert.deepStrictEqual(warned.errors, []);
      assert.strictEqual(warned.warnings.length, 1);
      assert.ok(warned.warnings[0].includes(NOT_WRITTEN_BY_REFRESH), warned.warnings[0]);
      for (const level of [true, 'error']) {
        const failed = await validateEmbeddedPatches(gitFormatted, { check_patch_headers: false, check_patch_refresh: level });
        assert.deepStrictEqual(failed.warnings, []);
        assert.strictEqual(failed.errors.length, 1);
      }
    });

    test('says nothing about refreshing when the refresh rule is off', async () => {
      for (const off of [false, 'disabled']) {
        const res = await validateEmbeddedPatches(gitFormatted, { check_patch_headers: true, check_patch_refresh: off });
        assertNoErrors(res);
        assertNoneIncludes(res.successes, 'refresh target', 'successes');
      }
      const on = await validateEmbeddedPatches(gitFormatted, { check_patch_headers: true, check_patch_refresh: true });
      assert.strictEqual(on.errors.length, 1, JSON.stringify(on.errors));
    });
  });

  // One u-boot bump can carry dozens of upstream-format patches.
  test('lists ten patch files and counts the rest', async () => {
    let patch = '';
    for (let i = 0; i < 12; i++) patch += added(`package/boot/uboot-foo/patches/${100 + i}-x.patch`, GIT_BODY);
    const res = await validateEmbeddedPatches(patch, REFRESH);
    assert.strictEqual(res.errors.length, 11);
    assert.ok(res.errors.slice(0, 10).every(e => e.includes(NOT_WRITTEN_BY_REFRESH)));
    assert.strictEqual(res.errors[10], '- … and 2 more embedded patch file(s) with a diff the refresh target did not write.');
  });

  describe('the command it names', () => {
    for (const [path, remedy] of [
      ['package/kernel/mac80211/patches/ath11k/x.patch', 'Regenerate it with `make package/mac80211/{clean,prepare} QUILT=1` followed by `make package/mac80211/refresh`, which'],
      ['target/linux/bcm27xx/patches-6.18/x.patch', 'Regenerate it with `make target/linux/refresh` (with the matching target selected in `.config`), which'],
      ['target/linux/generic/backport-6.12/x.patch', 'Regenerate it with `make target/linux/refresh` (with the matching target selected in `.config`), which'],
      ['net/frr/patches/996-x.patch', '`make package/frr/refresh`, which'],
      ['babeld/patches/001-x.patch', '`make package/babeld/refresh`, which'],
      ['package/devel/gdb/patches-host/001-x.patch', '`make package/gdb/refresh`, which'],
      ['lang/python/python3/patches/001-x.patch', '`make package/python3/refresh`, which'],
      ['tools/libtool/patches/001-x.patch', "Regenerate it with the buildroot's refresh target for `tools/libtool`, which"],
      ['toolchain/gcc/patches-14.x/001-x.patch', "Regenerate it with the buildroot's refresh target for `toolchain/gcc`, which"]
    ]) {
      test(path, async () => {
        const res = await validateEmbeddedPatches(added(path, GIT_BODY), REFRESH);
        assert.strictEqual(res.errors.length, 1, JSON.stringify(res.errors));
        assert.ok(res.errors[0].includes(remedy), res.errors[0]);
      });
    }
  });
});

// The whole invocation has 10 ms of CPU on the Workers Free plan. The rule
// reads every patch file a pull request adds, so it is pinned on the largest
// pull request diff in a sample of 400 merged ones (openwrt PR 25945: 39 patch
// files, 26 129 lines, about a megabyte), rebuilt here in its shape, and on a
// file whose every line is a header pair - the most work a contributor can
// hand it per byte. Run in a worker thread, so a regression that blocks the
// thread fails here instead of hanging the suite, and pinned as a ratio of
// that thread's CPU time against the header rule on the same input, measured
// alternately, so a loaded machine inflates both arms at once.
describe('refresh rule cost', () => {
  const WORKER = `
    import { validateEmbeddedPatches } from VALIDATORS;
    import { parentPort, workerData } from 'node:worker_threads';
    const lookup = async () => 'From 0123456789012345678901234567890123456789 Mon Sep 17 00:00:00 2001\\nFrom: a\\nDate: b\\nSubject: c\\n';
    const both = { check_patch_headers: true, check_patch_refresh: 'warning' };
    const headersOnly = { check_patch_headers: true, check_patch_refresh: false };
    // This thread's CPU time where Node has it, so time the thread spent
    // descheduled on a loaded machine counts in neither arm.
    const now = process.threadCpuUsage
      ? () => { const { user, system } = process.threadCpuUsage(); return (user + system) / 1000; }
      : () => performance.now();
    const cost = async (patch, config, reps) => {
      const started = now();
      let last = null;
      for (let i = 0; i < reps; i++) last = await validateEmbeddedPatches(patch, config, lookup);
      return { elapsed: now() - started, last };
    };
    const out = {};
    for (const [name, patch] of Object.entries(workerData)) {
      await cost(patch, both, 2);
      await cost(patch, headersOnly, 2);
      const ratios = [];
      let last = null;
      for (let round = 0; round < 5; round++) {
        const base = await cost(patch, headersOnly, 5);
        const measured = await cost(patch, both, 5);
        last = measured.last;
        ratios.push(measured.elapsed / Math.max(base.elapsed, 0.001));
      }
      out[name] = { ratio: ratios.sort((a, b) => a - b)[2], warnings: last.warnings, successes: last.successes };
    }
    parentPort.postMessage(out);
  `;

  // 39 added patch files of 660 lines each, in the form the refresh target
  // writes: a header, then hunks over many source files.
  const largestPullRequest = () => {
    let patch = '';
    for (let i = 0; i < 39; i++) {
      const lines = [...DESCRIPTION];
      for (let file = 0; lines.length < 660; file++) {
        lines.push(`--- a/drivers/net/f${file}.c`, `+++ b/drivers/net/f${file}.c`, `@@ -${file * 40},7 +${file * 40},8 @@ static int probe(struct device *dev)`);
        for (let k = 0; k < 7; k++) lines.push(` \tret = do_thing_${k}(dev, ${k}); /* ${'x'.repeat(10)} */`);
        lines.push('+\tret = do_more(dev);');
      }
      patch += added(`target/linux/generic/backport-6.18/${100 + i}-x.patch`, lines);
    }
    return patch;
  };
  // Every line a pair that gives a prefix and never a timestamp, so no pair
  // can be skipped as already known.
  const headerPairs = () => {
    const lines = [];
    for (let i = 0; i < 12000; i++) lines.push(`--- x/f${i}.c`, `+++ y/f${i}.c`);
    return added(P, lines);
  };

  const measureOutOfThread = async () => {
    const validators = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../src/validators.js')).href);
    const worker = new Worker(WORKER.replace('VALIDATORS', validators), {
      eval: true,
      workerData: { largestPullRequest: largestPullRequest(), headerPairs: headerPairs() }
    });
    try {
      return await new Promise((settle, fail) => {
        const cutOff = setTimeout(() => fail(new Error('the refresh rule did not settle within 20 s')), 20000);
        worker.on('message', (value) => { clearTimeout(cutOff); settle(value); });
        worker.on('error', (err) => { clearTimeout(cutOff); fail(err); });
      });
    } finally {
      await worker.terminate();
    }
  };

  test('costs a small multiple of the header rule on the largest diffs it is handed', async () => {
    const measured = await measureOutOfThread();

    assert.deepStrictEqual(measured.largestPullRequest.warnings, []);
    assert.ok(measured.largestPullRequest.successes.includes(ALL_REFRESHED), JSON.stringify(measured.largestPullRequest.successes));
    assert.strictEqual(measured.headerPairs.warnings.length, 1);
    assert.ok(measured.headerPairs.warnings[0].includes('do not use the `a/` and `b/` prefixes'), measured.headerPairs.warnings[0]);

    // About 3x and 10x today; each bound is four times that. Searching past
    // a line's end for its tab, once per pair, costs seconds.
    assert.ok(measured.largestPullRequest.ratio < 12,
      `the largest pull request cost ${measured.largestPullRequest.ratio.toFixed(1)}x the header rule alone`);
    assert.ok(measured.headerPairs.ratio < 40,
      `a file of header pairs cost ${measured.headerPairs.ratio.toFixed(1)}x the header rule alone`);
  });
});
