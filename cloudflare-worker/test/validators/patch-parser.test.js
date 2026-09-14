import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { collectFileLineChanges, validatePkgReleaseBumps } from '../../src/validators.js';

// Patches exactly as GitHub serves them for the application/vnd.github.patch
// media type. single-commit.patch is openwrt/openwrt commit 3c1066f4, and
// multi-commit.patch is a three-commit openwrt/packages pull request whose
// second commit has a bulleted message. The expected counts are GitHub's own
// files[].additions and files[].deletions, summed over the commits.
const readFixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const lineCounts = (changes, file) => {
  const change = changes[file];
  return change ? { added: change.added.length, deleted: change.deleted.length } : null;
};

// One commit in GitHub's mail format, ready for a diff to follow.
const mail = (sha, subject, body = 'Change it.') =>
  `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: John Doe <john@doe.com>\nDate: Mon, 1 Sep 2026 10:00:00 +0200\nSubject: [PATCH] ${subject}\n\n${body}\n\nSigned-off-by: John Doe <john@doe.com>\n---\n`;

describe('collectFileLineChanges on patches captured from GitHub', () => {
  test('counts a single commit the way GitHub does', () => {
    const changes = collectFileLineChanges(readFixture('single-commit.patch'));
    assert.deepStrictEqual(Object.keys(changes).sort(), [
      'package/kernel/rtl8812au-ct/Makefile',
      'package/kernel/rtl8812au-ct/patches/120-cfg80211-7.2.patch',
    ]);
    assert.deepStrictEqual(lineCounts(changes, 'package/kernel/rtl8812au-ct/Makefile'), { added: 1, deleted: 1 });
    assert.deepStrictEqual(lineCounts(changes, 'package/kernel/rtl8812au-ct/patches/120-cfg80211-7.2.patch'), { added: 171, deleted: 0 });
  });

  test("counts an embedded patch's own header lines as content", () => {
    const { added } = collectFileLineChanges(readFixture('single-commit.patch'))['package/kernel/rtl8812au-ct/patches/120-cfg80211-7.2.patch'];
    assert.ok(added.includes('--- a/os_dep/linux/ioctl_cfg80211.c'));
    assert.ok(added.includes('+++ b/os_dep/linux/ioctl_cfg80211.c'));
  });

  test('counts a multi-commit pull request the way GitHub does', () => {
    const changes = collectFileLineChanges(readFixture('multi-commit.patch'));
    assert.deepStrictEqual(Object.keys(changes).sort(), [
      'multimedia/tvheadend/Makefile',
      'multimedia/tvheadend/patches/050-iconv-test-continue.patch',
    ]);
    assert.deepStrictEqual(lineCounts(changes, 'multimedia/tvheadend/Makefile'), { added: 13, deleted: 10 });
    assert.deepStrictEqual(lineCounts(changes, 'multimedia/tvheadend/patches/050-iconv-test-continue.patch'), { added: 0, deleted: 13 });
  });

  test("never reads a later commit's mail as lines of the file before it", () => {
    const { deleted } = collectFileLineChanges(readFixture('multi-commit.patch'))['multimedia/tvheadend/patches/050-iconv-test-continue.patch'];
    assert.ok(!deleted.some(line => line.startsWith(' Build/Prepare feeds')), JSON.stringify(deleted));
    assert.ok(!deleted.includes('--'), JSON.stringify(deleted));
  });
});

describe('collectFileLineChanges on crafted input', () => {
  test('takes the same lines whether a header pair or a hunk opens the body', () => {
    // A mode change or a pure rename carries no --- / +++ pair; the first
    // hunk then ends the preamble instead.
    const patch = 'diff --git a/package/foo/Makefile b/package/foo/Makefile\nold mode 100644\nnew mode 100755\n@@ -1,2 +1,2 @@\n-PKG_RELEASE:=1\n+PKG_RELEASE:=2\n';
    assert.deepStrictEqual(collectFileLineChanges(patch)['package/foo/Makefile'], { added: ['PKG_RELEASE:=2'], deleted: ['PKG_RELEASE:=1'] });
  });

  test('keeps content lines that open like a file header', () => {
    // Refreshing an embedded patch rewrites its own `---`/`+++` lines.
    const patch = 'diff --git a/package/foo/patches/010-x.patch b/package/foo/patches/010-x.patch\nindex 1111111..2222222 100644\n--- a/package/foo/patches/010-x.patch\n+++ b/package/foo/patches/010-x.patch\n@@ -1,4 +1,4 @@\n---- a/src/old.c\n-+++ b/src/old.c\n+--- a/src/new.c\n++++ b/src/new.c\n @@ -1,3 +1,4 @@\n';
    const file = collectFileLineChanges(patch)['package/foo/patches/010-x.patch'];
    assert.deepStrictEqual(file.deleted, ['--- a/src/old.c', '+++ b/src/old.c']);
    assert.deepStrictEqual(file.added, ['--- a/src/new.c', '+++ b/src/new.c']);
  });

  test('counts a content line that looks like a mail envelope', () => {
    const envelope = 'From 0123456789012345678901234567890123456789 Mon Sep 17 00:00:00 2001';
    const patch = `diff --git a/p/patches/001-x.patch b/p/patches/001-x.patch\nnew file mode 100644\n--- /dev/null\n+++ b/p/patches/001-x.patch\n@@ -0,0 +1,2 @@\n+${envelope}\n+Subject: [PATCH] x\n`;
    assert.deepStrictEqual(collectFileLineChanges(patch)['p/patches/001-x.patch'].added, [envelope, 'Subject: [PATCH] x']);
  });

  test('returns nothing for an empty patch or a commit mail without a diff', () => {
    assert.deepStrictEqual(collectFileLineChanges(''), {});
    assert.deepStrictEqual(collectFileLineChanges(mail('a'.repeat(40), 'docs: no diff')), {});
  });

  test('records no lines for a binary file, a pure rename or a mode change', () => {
    const patch = [
      'diff --git a/img.png b/img.png', 'index 1111111..2222222 100644', 'Binary files a/img.png and b/img.png differ',
      'diff --git a/a.patch b/b.patch', 'similarity index 100%', 'rename from a.patch', 'rename to b.patch',
      'diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', '',
    ].join('\n');
    assert.deepStrictEqual(collectFileLineChanges(patch), {});
  });

  test('keeps a carriage return that belongs to the content and skips the no-newline marker', () => {
    const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\r\n\\ No newline at end of file\n+new\r\n\\ No newline at end of file\n';
    assert.deepStrictEqual(collectFileLineChanges(patch).x, { added: ['new\r'], deleted: ['old\r'] });
  });

  test('ignores lines outside any file and a file header with no hunk', () => {
    assert.deepStrictEqual(collectFileLineChanges('+stray line\n-another\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n'), {});
  });
});

describe('release audit on a multi-commit patch', () => {
  test('needs no PKG_RELEASE bump for a comment-only edit followed by a commit with a bulleted message', async () => {
    const patch =
      mail('a'.repeat(40), 'foo: fix a typo in a comment', 'Spelling only.') +
      'diff --git a/package/utils/foo/files/foo.init b/package/utils/foo/files/foo.init\nindex 1111111..2222222 100644\n--- a/package/utils/foo/files/foo.init\n+++ b/package/utils/foo/files/foo.init\n@@ -1,3 +1,3 @@\n #!/bin/sh /etc/rc.common\n-# start the foo daemn\n+# start the foo daemon\n START=90\n\n' +
      mail('b'.repeat(40), 'README: describe the reload', '- restart the service on reload\n- drop the legacy option') +
      'diff --git a/README.md b/README.md\nindex 3333333..4444444 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n';
    const content = 'PKG_NAME:=foo\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n';
    const fetchFile = async () => content;
    const res = await validatePkgReleaseBumps([{ commitPatch: patch }], { check_pkg_release: true }, fetchFile, fetchFile);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });
});
