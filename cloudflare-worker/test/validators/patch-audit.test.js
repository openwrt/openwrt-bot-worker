import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateEmbeddedPatches } from '../../src/validators.js';
import { CONFIG, readFixture, assertSomeIncludes, assertNoErrors, assertErrorIncludes } from './helpers.js';

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

  describe('in a whole pull request', () => {
    const envelope = (sha) => `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: John Doe <john@doe.com>\nDate: Mon, 1 Sep 2026 10:00:00 +0200\nSubject: [PATCH] mypkg: refresh patch\n\nSigned-off-by: John Doe <john@doe.com>\n---\n`;
    const modify = (p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -10,6 +10,6 @@\n-old\n+new\n\n`;
    const remove = (p) => `diff --git a/${p} b/${p}\ndeleted file mode 100644\n--- a/${p}\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-old\n-new\n\n`;
    const add = (p) => `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,1 @@\n+x\n\n`;
    const rename = (from, to) => `diff --git a/${from} b/${to}\nsimilarity index 100%\nrename from ${from}\nrename to ${to}\n\n`;
    // One commit per change, in order, each in its own mbox envelope.
    const pullRequest = (...changes) => changes.map((change, i) => envelope('abc'[i].repeat(40)) + change).join('');
    const P = 'utils/mypkg/patches/001-fix.patch';
    const goodHeaders = 'From 0123456789012345678901234567890123456789 Mon Sep 17 00:00:00 2001\nFrom: A <a@b.c>\nDate: Mon, 1 Sep 2026 10:00:00 +0200\nSubject: [PATCH] fix\n';

    test('does not look for a patch file a later commit deletes', async () => {
      const { lookups, fetch } = recording(null);
      const res = await validateEmbeddedPatches(pullRequest(modify(P), remove(P)), { check_patch_headers: true }, fetch);
      assert.deepStrictEqual(lookups, []);
      assert.strictEqual(res.incomplete, false);
      assert.deepStrictEqual(res.skipped, []);
    });

    const Q = 'utils/mypkg/patches/002-fix.patch';

    test('looks a patch file up under the name a later commit renames it to', async () => {
      const { lookups, fetch } = recording(goodHeaders);
      const res = await validateEmbeddedPatches(pullRequest(modify(P), rename(P, Q)), { check_patch_headers: true }, fetch);
      assert.deepStrictEqual(lookups, [Q]);
      assertSomeIncludes(res.successes, `'${Q}' contains valid Git compliance headers`, 'successes');
      assert.strictEqual(res.incomplete, false);
    });

    test('judges a new patch file under its new name after a rename that keeps the content', async () => {
      // The rename has no +++ line, and the file cannot be read, so the added
      // content is all there is to judge.
      const { lookups, fetch } = recording(null);
      const res = await validateEmbeddedPatches(pullRequest(add(P), rename(P, Q)), { check_patch_headers: true }, fetch);
      assert.deepStrictEqual(lookups, [Q]);
      assertErrorIncludes(res, Q);
    });

    test('judges a renamed patch file as it is at the end, not as it was first added', async () => {
      const { lookups, fetch } = recording(goodHeaders);
      const res = await validateEmbeddedPatches(pullRequest(add(P), modify(P), rename(P, Q)), { check_patch_headers: true }, fetch);
      assert.ok(lookups.length > 0 && lookups.every(p => p === Q), JSON.stringify(lookups));
      assertNoErrors(res);
    });

    test('still judges the diff that added a patch file after a later commit edits it', async () => {
      // Neither lookup succeeds, so the added content is all there is to judge.
      const res = await validateEmbeddedPatches(pullRequest(add(P), modify(P)), { check_patch_headers: true }, async () => null);
      assertErrorIncludes(res, P);
    });

    test('follows a patch file through more than one rename', async () => {
      const R = 'utils/mypkg/patches/003-fix.patch';
      const { lookups, fetch } = recording(goodHeaders);
      await validateEmbeddedPatches(pullRequest(add(P), rename(P, Q), rename(Q, R)), { check_patch_headers: true }, fetch);
      assert.deepStrictEqual(lookups, [R]);
    });

    test('does not look for a patch file that is renamed and then deleted', async () => {
      const { lookups, fetch } = recording(null);
      const res = await validateEmbeddedPatches(pullRequest(modify(P), rename(P, Q), remove(Q)), { check_patch_headers: true }, fetch);
      assert.deepStrictEqual(lookups, []);
      assert.strictEqual(res.incomplete, false);
    });

    // rename-only.patch is openwrt/openwrt commit 3458b4c as GitHub serves it:
    // nine renames that keep the content, none of them with a +++ line.
    test('follows a rename written the way GitHub writes it', async () => {
      const renames = readFixture('rename-only.patch');
      const [, from, to] = renames.match(/^rename from (.*)\nrename to (.*)$/m);
      const { lookups, fetch } = recording(null);
      const res = await validateEmbeddedPatches(pullRequest(add(from)) + renames, { check_patch_headers: true }, fetch);
      assert.deepStrictEqual(lookups, [to]);
      assertErrorIncludes(res, to);
    });

    test('still checks a patch file that is deleted and then added back', async () => {
      const { lookups, fetch } = recording(goodHeaders);
      const res = await validateEmbeddedPatches(pullRequest(modify(P), remove(P), add(P)), { check_patch_headers: true }, fetch);
      assert.ok(lookups.includes(P), JSON.stringify(lookups));
      assertSomeIncludes(res.successes, 'contains valid Git compliance headers', 'successes');
      assert.strictEqual(res.incomplete, false);
    });

    const noHeaders = 'a patch with no headers\n';

    test('warns about an older patch file under the name a later commit renames it to', async () => {
      const res = await validateEmbeddedPatches(pullRequest(modify(P), rename(P, Q)), { check_patch_headers: true }, async () => noHeaders);
      assertNoErrors(res);
      assert.strictEqual(res.warnings.length, 1, JSON.stringify(res.warnings));
      assert.match(res.warnings[0], new RegExp(`'${Q}' is missing .* It predates this pull request`));
    });

    // The edit's chunk alone looks like an older file; the series added it.
    test('holds a patch file added by one commit and edited by the next to the rule', async () => {
      const res = await validateEmbeddedPatches(pullRequest(add(P), modify(P)), { check_patch_headers: true }, async () => noHeaders);
      assert.deepStrictEqual(res.warnings, [], 'the file does not predate the pull request');
      assert.strictEqual(res.errors.length, 1, `one finding for one file: ${JSON.stringify(res.errors)}`);
      assert.match(res.errors[0], new RegExp(`'${P}' is missing`));
    });

    test('holds a patch file added and then renamed to the rule under its new name', async () => {
      const res = await validateEmbeddedPatches(pullRequest(add(P), rename(P, Q), modify(Q)), { check_patch_headers: true }, async () => noHeaders);
      assert.deepStrictEqual(res.warnings, []);
      assertErrorIncludes(res, `'${Q}' is missing`);
    });

    // One commit takes the envelope out, a later one edits something else:
    // the series removed it, whichever chunk is looked at.
    test('fails an older patch file one commit of the series took a header out of', async () => {
      const dropEnvelope = `diff --git a/${P} b/${P}\n--- a/${P}\n+++ b/${P}\n@@ -1,3 +1,2 @@\n-From 0123456789012345678901234567890123456789 Mon Sep 17 00:00:00 2001\n From: A <a@b.c>\n Subject: [PATCH] fix\n\n`;
      const res = await validateEmbeddedPatches(pullRequest(dropEnvelope, modify(P)), { check_patch_headers: true },
        async () => 'From: A <a@b.c>\nSubject: [PATCH] fix\n');
      assert.deepStrictEqual(res.warnings, []);
      assert.strictEqual(res.errors.length, 1, JSON.stringify(res.errors));
      assert.match(res.errors[0], /loses the 'From <commit hash> Mon Sep 17 00:00:00 2001' mbox separator line in this change/);
    });

    // An added blank line at the end of a new patch file is followed by the
    // next commit's own mail header, which is not part of the file.
    test('does not read the next commit\'s mail header as the headers of a new patch file', async () => {
      const addEndingBlank = `diff --git a/${P} b/${P}\nnew file mode 100644\n--- /dev/null\n+++ b/${P}\n@@ -0,0 +1,2 @@\n+no headers\n+\n`;
      const res = await validateEmbeddedPatches(pullRequest(addEndingBlank, modify('utils/mypkg/Makefile')), { check_patch_headers: true }, async () => null);
      assert.strictEqual(res.errors.length, 1, JSON.stringify(res.errors));
      assert.match(res.errors[0], /mbox separator line/);
      assert.match(res.errors[0], /'From:' author line/);
    });
  });

  test('catches patches missing From/Subject headers', async () => {
    const res = await validateEmbeddedPatches(newPatchWithoutHeaders, CONFIG);
    assertErrorIncludes(res, 'Regenerate the patch');
  });

  test('names only the mbox separator when everything else is present (issue #76)', async () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
new file mode 100644
--- /dev/null
+++ b/package/utils/bash/patches/001-fix.patch
+From: Name <someone@domain.tld>
+Subject: [PATCH] netfilter: flow: Add bridge_vid member
+
+Details of the fix
    `;
    const res = await validateEmbeddedPatches(patch, CONFIG);
    assert.strictEqual(res.errors.length, 1, `Errors: ${res.errors.join(', ')}`);
    assert.ok(res.errors[0].includes('mbox separator line'), `Errors: ${res.errors.join(', ')}`);
    assert.ok(!res.errors[0].includes("the 'From:' author line"), `Errors: ${res.errors.join(', ')}`);
    assert.ok(!res.errors[0].includes("a 'Subject:' line"), `Errors: ${res.errors.join(', ')}`);
    assert.ok(res.errors[0].includes('git format-patch'), `Errors: ${res.errors.join(', ')}`);
  });

  // The three shapes that occur in the OpenWrt trees: the full format-patch
  // header, a bare quilt diff with no header at all, and From:/Subject:
  // without the envelope.
  describe('shapes found in the OpenWrt trees', () => {
    const asNewPatch = (body) => `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
new file mode 100644
--- /dev/null
+++ b/package/utils/bash/patches/001-fix.patch
${body.split('\n').map(l => '+' + l).join('\n')}
    `;
    const asModifiedPatch = () => `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
--- a/package/utils/bash/patches/001-fix.patch
+++ b/package/utils/bash/patches/001-fix.patch
@@ -10,6 +10,6 @@
-old_code
+new_code
    `;

    // Shape of e.g. target/linux/generic/pending-6.12/704-01-*.patch
    const fullHeader = 'From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001\nFrom: Eric Woudstra <ericwouds@gmail.com>\nDate: Fri, 24 Jan 2025 16:09:03 +0100\nSubject: [PATCH] netfilter: flow: Add bridge_vid member\n\n---\n--- a/x\n+++ b/x';
    // Shape of the patches reported in issue #76
    const noEnvelope = 'From: Felix Fietkau <nbd@nbd.name>\nSubject: [PATCH] netfilter: add xt_FLOWOFFLOAD target\n\n---\n--- a/x\n+++ b/x';
    // Shape of e.g. packages/devel/scons/patches/001-platform_env.patch
    const bareDiff = '--- a/scons-local-4.10.1/SCons/Platform/__init__.py\n+++ b/scons-local-4.10.1/SCons/Platform/__init__.py\n@@ -69,6 +69,8 @@\n+code';

    test('accepts a new patch carrying the full format-patch header', async () => {
      const res = await validateEmbeddedPatches(asNewPatch(fullHeader), CONFIG);
      assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
      assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
    });

    test('rejects a new patch that has no headers at all', async () => {
      const res = await validateEmbeddedPatches(asNewPatch(bareDiff), CONFIG);
      assert.strictEqual(res.errors.length, 1, `Errors: ${res.errors.join(', ')}`);
      assert.match(res.errors[0], /mbox separator line/);
      assert.match(res.errors[0], /'From:' author line/);
      assert.match(res.errors[0], /'Subject:' line/);
    });

    test('warns instead of failing when an existing header-less patch is edited', async () => {
      const res = await validateEmbeddedPatches(asModifiedPatch(), CONFIG, async () => bareDiff);
      assert.strictEqual(res.errors.length, 0, `A pre-existing patch must not block the PR: ${res.errors.join(', ')}`);
      assert.strictEqual(res.warnings.length, 1, `Warnings: ${res.warnings.join(', ')}`);
      assert.match(res.warnings[0], /predates this pull request/);
    });

    test('fails when this change itself removes a header from an existing patch', async () => {
      // The file is read after the change, so the missing envelope could be
      // old news - but the diff shows this pull request deleting it.
      const chunk = `diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
--- a/package/utils/bash/patches/001-fix.patch
+++ b/package/utils/bash/patches/001-fix.patch
@@ -1,4 +1,3 @@
-From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001
 From: John Doe <john@doe.com>
 Subject: [PATCH] Fix

`;
      const res = await validateEmbeddedPatches(chunk, CONFIG, async () => noEnvelope);
      assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
      assert.strictEqual(res.errors.length, 1, `Errors: ${res.errors.join(', ')}`);
      assert.match(res.errors[0], /loses the 'From <commit hash> Mon Sep 17 00:00:00 2001' mbox separator line/);
    });

    // An added line that still looks like the header is no repair when the
    // file read afterwards lacks it: indented, 'git am' does not see it.
    test('fails a change that replaces a header line with one git am does not read', async () => {
      const chunk = `diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
--- a/package/utils/bash/patches/001-fix.patch
+++ b/package/utils/bash/patches/001-fix.patch
@@ -1,4 +1,4 @@
-From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001
+ From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001
 From: John Doe <john@doe.com>
 Subject: [PATCH] Fix
`;
      const res = await validateEmbeddedPatches(chunk, CONFIG,
        async () => ' From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001\n' + noEnvelope);
      assert.deepStrictEqual(res.warnings, []);
      assert.strictEqual(res.errors.length, 1, JSON.stringify(res.errors));
      assert.match(res.errors[0], /loses the 'From <commit hash> Mon Sep 17 00:00:00 2001' mbox separator line/);
    });

    test('warns instead of failing when an existing patch only lacks the envelope', async () => {
      const res = await validateEmbeddedPatches(asModifiedPatch(), CONFIG, async () => noEnvelope);
      assert.strictEqual(res.errors.length, 0, `Errors: ${res.errors.join(', ')}`);
      assert.match(res.warnings[0], /mbox separator line/);
      assert.doesNotMatch(res.warnings[0], /'Subject:' line/);
    });

    test('accepts an edit to an existing patch that already has the full header', async () => {
      const res = await validateEmbeddedPatches(asModifiedPatch(), CONFIG, async () => fullHeader);
      assert.strictEqual(res.errors.length, 0);
      assert.strictEqual(res.warnings.length, 0);
      assert.ok(res.successes.some(s => s.includes('valid Git compliance headers')));
    });

    // Why the separator is named is said only when it is the one missing.
    test('explains the separator only when it is what is missing', async () => {
      const withEnvelope = 'From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] fix\n';
      const res = await validateEmbeddedPatches(asModifiedPatch(), CONFIG, async () => withEnvelope);
      assert.strictEqual(res.warnings.length, 1, JSON.stringify(res.warnings));
      assert.match(res.warnings[0], /is missing the 'From:' author line\./);
      assert.doesNotMatch(res.warnings[0], /mbox/);
    });

    // A per-commit audit is told which files an earlier commit added.
    test('holds an edited patch file to the rule when the caller says the pull request added it', async () => {
      const res = await validateEmbeddedPatches(asModifiedPatch(), CONFIG, async () => bareDiff, undefined,
        (path) => path === 'package/utils/bash/patches/001-fix.patch');
      assert.deepStrictEqual(res.warnings, []);
      assert.strictEqual(res.errors.length, 1, JSON.stringify(res.errors));
    });
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
    // Both files existed before this change, so each one is a warning.
    assert.strictEqual(res.warnings.length, 2, `one finding per file: ${JSON.stringify(res.warnings)}`);
    assertNoErrors(res);
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

  test('accepts a format-patch style patch without a Date line', async () => {
    const patch = `
diff --git a/package/utils/bash/patches/001-fix.patch b/package/utils/bash/patches/001-fix.patch
new file mode 100644
--- /dev/null
+++ b/package/utils/bash/patches/001-fix.patch
+From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001
+From: Name <someone@domain.tld>
+Subject: [PATCH] commit
+
+Details of the fix
    `;
    const res = await validateEmbeddedPatches(patch, CONFIG);
    assertNoErrors(res);
    assertSomeIncludes(res.successes, 'contains valid Git compliance headers', 'successes');
  });

  test('reports a modified patch it could not read instead of passing it', async () => {
    const res = await validateEmbeddedPatches(modifiedPatch, CONFIG);
    assertNoErrors(res);
    // A file that was not read is a gap, never a finding.
    assert.deepStrictEqual(res.warnings, []);
    // Not looking is not the same as looking and finding it correct: the
    // caller turns this count into the neutral conclusion.
    assert.strictEqual(res.incomplete, true);
    assertSomeIncludes(res.skipped, 'could not be read', 'skipped');
  });

  // The caller says a file is missing only when the repository answered so,
  // e.g. after a merge commit deleted it.
  test('has nothing to check in a modified patch file that is not there at all', async () => {
    const res = await validateEmbeddedPatches(modifiedPatch, CONFIG, async () => null, () => true);
    assertNoErrors(res);
    assert.strictEqual(res.incomplete, false);
    assertSomeIncludes(res.successes, 'no longer in the pull request', 'successes');
  });

  test('still judges a new patch file from the diff when it is not there', async () => {
    const res = await validateEmbeddedPatches(newPatchWithoutHeaders, CONFIG, async () => null, () => true);
    assertErrorIncludes(res, 'Regenerate the patch');
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
    // The readable one is still judged.
    assertErrorIncludes(res, '002-new.patch');
  });

  test('accepts modified patches when fetched content has valid headers', async () => {
    const fetch = async () => 'From 939fb2bc7c770984925de3ad2d94829377488df2 Mon Sep 17 00:00:00 2001\nFrom: John Doe <john@doe.com>\nDate: Tue, 7 Jul 2026 20:09:55 +0300\nSubject: [PATCH] Fix compilation issue\n\nCode content';
    const res = await validateEmbeddedPatches(modifiedPatch, CONFIG, fetch);
    assertNoErrors(res);
    assertSomeIncludes(res.successes, 'contains valid Git compliance headers', 'successes');
  });

  test('reports missing headers in modified patches as a warning, not a failure', async () => {
    const res = await validateEmbeddedPatches(modifiedPatch, CONFIG, async () => 'Some content without headers');
    assertNoErrors(res);
    assertSomeIncludes(res.warnings, 'Regenerate the patch', 'warnings');
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
        assertErrorIncludes(res, 'Regenerate the patch');
      } else {
        assertNoErrors(res);
        assert.deepStrictEqual(res.successes, []);
      }
    });
  }
});
