import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateEmbeddedPatches } from '../../src/validators.js';
import { CONFIG, assertSomeIncludes, assertNoErrors, assertErrorIncludes } from './helpers.js';

describe('validateEmbeddedPatches', () => {
  // A lookup that answers every path the same way and remembers what it was
  // asked for.
  const recording = (answer) => {
    const lookups = [];
    return { lookups, fetch: async (p) => { lookups.push(p); return answer; } };
  };

  // A new patch file shows its whole content in the diff, so it can be judged
  // without a lookup.
  const newPatchWithoutHeaders = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
new file mode 100644
--- /dev/null
+++ b/package/utils/bash/patches/001-fix.patch
+Some diff without from and subject headers
    `;

  // An edited patch file shows only a few changed lines; its headers are out
  // of view unless the file is looked up.
  const modifiedPatch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
--- a/package/utils/bash/patches/001-fix.patch
+++ b/package/utils/bash/patches/001-fix.patch
@@ -10,6 +10,6 @@
-old_code
+new_code
    `;

  test('catches patches missing From/Subject headers', async () => {
    const res = await validateEmbeddedPatches(newPatchWithoutHeaders, CONFIG);
    assertErrorIncludes(res, 'Missing required Git header');
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
    assertNoErrors(res);
    assert.ok(res.successes.length > 0);
  });

  test('pairs each diff chunk with the patch file its own header names', async () => {
    // The first patch file patches the second one, so its diff body contains
    // the second file's path. Pairing chunks with files by "does this chunk
    // mention that path" therefore checks the second file twice - once
    // against its own chunk and once against the first file's - which both
    // wastes a lookup and reports the finding twice.
    const patch = `diff --git a/utils/mypkg/patches/001-a.patch b/utils/mypkg/patches/001-a.patch
--- a/utils/mypkg/patches/001-a.patch
+++ b/utils/mypkg/patches/001-a.patch
@@ -1,4 +1,5 @@
 some context
++--- a/utils/mypkg/patches/002-b.patch
+++++ b/utils/mypkg/patches/002-b.patch
 more context
diff --git a/utils/mypkg/patches/002-b.patch b/utils/mypkg/patches/002-b.patch
--- a/utils/mypkg/patches/002-b.patch
+++ b/utils/mypkg/patches/002-b.patch
@@ -10,6 +10,6 @@
-old_code
+new_code
`;
    // Neither file carries the mbox envelope, so each one is one finding.
    const { lookups, fetch } = recording('From: John Doe <john@doe.com>\nSubject: [PATCH] Fix\n');
    const res = await validateEmbeddedPatches(patch, CONFIG, fetch);

    assert.deepStrictEqual(lookups.sort(), [
      'utils/mypkg/patches/001-a.patch',
      'utils/mypkg/patches/002-b.patch'
    ], 'one lookup per changed patch file');
    assert.strictEqual(res.errors.length, 2, `one finding per file: ${JSON.stringify(res.errors)}`);
  });

  test('does not read a leftover like 001-fix.patch.bak as a patch file', async () => {
    const patch = `diff --git a/utils/mypkg/patches/001-fix.patch.bak b/utils/mypkg/patches/001-fix.patch.bak
new file mode 100644
--- /dev/null
+++ b/utils/mypkg/patches/001-fix.patch.bak
@@ -0,0 +1,2 @@
+a backup file with no Git headers
+that nobody applies
`;
    const { lookups, fetch } = recording(null);
    const res = await validateEmbeddedPatches(patch, CONFIG, fetch);
    assert.deepStrictEqual(lookups, [], 'nothing to look up');
    assertNoErrors(res);
    assertSomeIncludes(res.successes, 'No downstream raw embedded patch files', 'successes');
  });

  test('checks every patch file of a large refresh exactly once', async () => {
    const count = 300;
    const patch = Array.from({ length: count }, (_, i) => {
      const file = `target/linux/generic/pending-6.12/${String(i).padStart(3, '0')}-fix.patch`;
      return `diff --git a/${file} b/${file}
new file mode 100644
--- /dev/null
+++ b/${file}
+From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001
+From: John Doe <john@doe.com>
+Date: Tue, 7 Jul 2026 20:09:55 +0300
+Subject: [PATCH] Fix ${i}
`;
    }).join('');
    const { lookups, fetch } = recording('From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001\nFrom: John Doe <john@doe.com>\nDate: Tue, 7 Jul 2026 20:09:55 +0300\nSubject: [PATCH] Fix\n');
    const res = await validateEmbeddedPatches(patch, CONFIG, fetch);
    assertNoErrors(res);
    assert.strictEqual(new Set(lookups).size, lookups.length, 'no patch file looked up twice');
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
    assertErrorIncludes(res, 'Missing required Git header');
  });

  test('skips validation for modified patches when fetch fails/not provided', async () => {
    const res = await validateEmbeddedPatches(modifiedPatch, CONFIG);
    assertNoErrors(res);
    assertSomeIncludes(res.successes, 'unable to fetch full file', 'successes');
  });

  test('accepts modified patches when fetched content has valid headers', async () => {
    const fetch = async () => 'From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001\nFrom: John Doe <john@doe.com>\nDate: Tue, 7 Jul 2026 20:09:55 +0300\nSubject: [PATCH] Fix compilation issue\n\nCode content';
    const res = await validateEmbeddedPatches(modifiedPatch, CONFIG, fetch);
    assertNoErrors(res);
    assertSomeIncludes(res.successes, 'contains valid Git compliance headers', 'successes');
  });

  test('catches missing headers in modified patches when fetched content lacks them', async () => {
    const res = await validateEmbeddedPatches(modifiedPatch, CONFIG, async () => 'Some content without headers');
    assertErrorIncludes(res, 'Missing required Git header');
  });

  // Only the two off switches change what comes back; how loudly a finding is
  // reported is left to the caller.
  for (const [title, level, reported] of [
    ['skips validation entirely when check_patch_headers is false', false, false],
    ['skips validation entirely when check_patch_headers is disabled string', 'disabled', false],
    ['returns errors normally when check_patch_headers is warning (caller handles severity)', 'warning', true],
    ['returns errors normally when check_patch_headers is true', true, true]
  ]) {
    test(title, async () => {
      const res = await validateEmbeddedPatches(newPatchWithoutHeaders, { ...CONFIG, check_patch_headers: level });
      if (reported) {
        assertErrorIncludes(res, 'Missing required Git header');
      } else {
        assertNoErrors(res);
        assert.deepStrictEqual(res.successes, []);
      }
    });
  }
});
