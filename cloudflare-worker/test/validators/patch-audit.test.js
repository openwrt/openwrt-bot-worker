import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateEmbeddedPatches } from '../../src/validators.js';
import { CONFIG } from './helpers.js';

describe('validateEmbeddedPatches', () => {
  describe('in a whole pull request', () => {
    const envelope = (sha) => `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: John Doe <john@doe.com>\nDate: Mon, 1 Sep 2026 10:00:00 +0200\nSubject: [PATCH] mypkg: refresh patch\n\nSigned-off-by: John Doe <john@doe.com>\n---\n`;
    const modify = (p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -10,6 +10,6 @@\n-old\n+new\n\n`;
    const remove = (p) => `diff --git a/${p} b/${p}\ndeleted file mode 100644\n--- a/${p}\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-old\n-new\n\n`;
    const add = (p) => `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,1 @@\n+x\n\n`;
    const rename = (from, to) => `diff --git a/${from} b/${to}\nsimilarity index 100%\nrename from ${from}\nrename to ${to}\n\n`;
    const P = 'utils/mypkg/patches/001-fix.patch';
    const goodHeaders = 'From 0123456789012345678901234567890123456789 Mon Sep 17 00:00:00 2001\nFrom: A <a@b.c>\nDate: Mon, 1 Sep 2026 10:00:00 +0200\nSubject: [PATCH] fix\n';
    const recording = (answer) => {
      const lookups = [];
      return { lookups, fetch: async (p) => { lookups.push(p); return answer; } };
    };

    test('does not look for a patch file a later commit deletes', async () => {
      const { lookups, fetch } = recording(null);
      const res = await validateEmbeddedPatches(envelope('a'.repeat(40)) + modify(P) + envelope('b'.repeat(40)) + remove(P), { check_patch_headers: true }, fetch);
      assert.deepStrictEqual(lookups, []);
      assert.strictEqual(res.incomplete, false);
      assert.deepStrictEqual(res.skipped, []);
    });

    test('does not look for a patch file a later commit renames away', async () => {
      const { lookups, fetch } = recording(null);
      const res = await validateEmbeddedPatches(envelope('a'.repeat(40)) + modify(P) + envelope('b'.repeat(40)) + rename(P, 'utils/mypkg/patches/002-fix.patch'), { check_patch_headers: true }, fetch);
      assert.deepStrictEqual(lookups, []);
      assert.strictEqual(res.incomplete, false);
    });

    test('still checks a patch file that is deleted and then added back', async () => {
      const { lookups, fetch } = recording(goodHeaders);
      const res = await validateEmbeddedPatches(envelope('a'.repeat(40)) + modify(P) + envelope('b'.repeat(40)) + remove(P) + envelope('c'.repeat(40)) + add(P), { check_patch_headers: true }, fetch);
      assert.ok(lookups.includes(P), JSON.stringify(lookups));
      assert.ok(res.successes.some(s => s.includes('contains valid Git compliance headers')), res.successes.join(', '));
      assert.strictEqual(res.incomplete, false);
    });
  });

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
    const fetched = [];
    const fetchFileContent = async (file) => {
      fetched.push(file);
      // Neither file carries the mbox envelope, so each one is one finding.
      return 'From: John Doe <john@doe.com>\nSubject: [PATCH] Fix\n';
    };
    const res = await validateEmbeddedPatches(patch, CONFIG, fetchFileContent);

    assert.deepStrictEqual(fetched.sort(), [
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
    const fetched = [];
    const res = await validateEmbeddedPatches(patch, CONFIG, async (file) => { fetched.push(file); return null; });
    assert.deepStrictEqual(fetched, [], 'nothing to look up');
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(m => m.includes('No downstream raw embedded patch files')),
      `Unexpected successes: ${res.successes.join(', ')}`);
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
    const fetched = [];
    const fetchFileContent = async (file) => {
      fetched.push(file);
      return 'From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001\nFrom: John Doe <john@doe.com>\nDate: Tue, 7 Jul 2026 20:09:55 +0300\nSubject: [PATCH] Fix\n';
    };
    const res = await validateEmbeddedPatches(patch, CONFIG, fetchFileContent);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.strictEqual(new Set(fetched).size, fetched.length, 'no patch file looked up twice');
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

  test('reports a modified patch it could not read instead of passing it', async () => {
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
    // Not looking is not the same as looking and finding it correct: the
    // caller turns this count into the neutral conclusion.
    assert.strictEqual(res.incomplete, true);
    assert.ok(res.skipped.some(s => s.includes('could not be read')), `Skipped: ${res.skipped.join(', ')}`);
  });

  test('counts a patch file whose fetch throws, and still judges the rest', async () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
--- a/package/utils/bash/patches/001-fix.patch
+++ b/package/utils/bash/patches/001-fix.patch
@@ -10,6 +10,6 @@
-old_code
+new_code
diff --git a/package/utils/bash/patches/002-new.patch b/package/utils/bash/patches/002-new.patch
new file mode 100644
--- /dev/null
+++ b/package/utils/bash/patches/002-new.patch
@@ -0,0 +1,2 @@
+a patch with no headers at all
+that nobody can apply
    `;
    const fetchFileContent = async (file) => {
      if (file.endsWith('001-fix.patch')) throw new Error('GraphQL batch file fetch failed');
      return null;
    };
    const res = await validateEmbeddedPatches(patch, CONFIG, fetchFileContent);
    assert.strictEqual(res.skipped.length, 1, 'the one that could not be read is skipped');
    assert.ok(res.errors.some(e => e.includes('002-new.patch')), `the readable one is still judged: ${res.errors.join(', ')}`);
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
