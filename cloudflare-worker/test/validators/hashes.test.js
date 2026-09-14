import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validatePkgHashes } from '../../src/validators.js';
import { CONFIG } from './helpers.js';

describe('validatePkgHashes', () => {
  const HASH_CONFIG = { ...CONFIG, check_pkg_hash: true };
  const bumpPatch = `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.3
`;
  const sha256a = 'a'.repeat(64);
  const sha256b = 'b'.repeat(64);

  test('fails when the version changes but PKG_HASH stays', async () => {
    const headFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_HASH:=${sha256a}\n`;
    const baseFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_HASH:=${sha256a}\n`;
    const res = await validatePkgHashes([{ commitPatch: bumpPatch }], HASH_CONFIG, headFetch, baseFetch);
    assert.ok(res.findings.some(f => f.includes('keeps the old PKG_HASH')), `Findings: ${res.findings.join(', ')}`);
    assert.strictEqual(res.errors.length, 0, 'an inferred source change must not be a hard error');
  });

  test('treats SKIP in any other spelling as unusable, like the build does', async () => {
    const headFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_SOURCE_URL:=https://example.com/\nPKG_HASH:=SKIP\n`;
    const baseFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_SOURCE_URL:=https://example.com/\nPKG_HASH:=${sha256a}\n`;
    const res = await validatePkgHashes([{ commitPatch: bumpPatch }], HASH_CONFIG, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('not a usable checksum')), `Errors: ${res.errors.join(', ')}`);
    assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
  });

  test('reports a checksum that a version bump removes instead of praising the change', async () => {
    const headFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_SOURCE_URL:=https://example.com/\n`;
    const baseFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_SOURCE_URL:=https://example.com/\nPKG_HASH:=${sha256a}\n`;
    const res = await validatePkgHashes([{ commitPatch: bumpPatch }], HASH_CONFIG, headFetch, baseFetch);
    assert.ok(res.findings.some(f => f.includes('drops its PKG_HASH')), `Findings: ${res.findings.join(', ')}`);
    assert.strictEqual(res.successes.length, 0, `Unexpected successes: ${res.successes.join(', ')}`);
  });

  test('passes when the version and PKG_HASH change together', async () => {
    const headFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_HASH:=${sha256b}\n`;
    const baseFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_HASH:=${sha256a}\n`;
    const res = await validatePkgHashes([{ commitPatch: bumpPatch }], HASH_CONFIG, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('updates the source checksum together with the version')));
  });

  test('fails when PKG_SOURCE_VERSION changes but PKG_MIRROR_HASH stays', async () => {
    const sourceBumpPatch = `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_SOURCE_VERSION:=cafebabe
+PKG_SOURCE_VERSION:=deadbeef
`;
    const headFetch = async () => `PKG_NAME:=fw\nPKG_SOURCE_VERSION:=deadbeef\nPKG_MIRROR_HASH:=${sha256a}\n`;
    const baseFetch = async () => `PKG_NAME:=fw\nPKG_SOURCE_VERSION:=cafebabe\nPKG_MIRROR_HASH:=${sha256a}\n`;
    const res = await validatePkgHashes([{ commitPatch: sourceBumpPatch }], HASH_CONFIG, headFetch, baseFetch);
    assert.ok(res.findings.some(f => f.includes('keeps the old PKG_MIRROR_HASH')), `Findings: ${res.findings.join(', ')}`);
  });

  test('ignores a version difference caused only by a stale base.sha', async () => {
    // The diff bumps nothing version-related; base.sha drifted while the
    // branch sat, so base and head contents disagree on PKG_SOURCE_VERSION.
    const releaseOnlyPatch = `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_RELEASE:=1
+PKG_RELEASE:=2
`;
    const headFetch = async () => `PKG_NAME:=fw\nPKG_SOURCE_VERSION:=deadbeef\nPKG_RELEASE:=2\nPKG_MIRROR_HASH:=${sha256a}\n`;
    const baseFetch = async () => `PKG_NAME:=fw\nPKG_SOURCE_VERSION:=cafebabe\nPKG_RELEASE:=1\nPKG_MIRROR_HASH:=${sha256a}\n`;
    const res = await validatePkgHashes([{ commitPatch: releaseOnlyPatch }], HASH_CONFIG, headFetch, baseFetch);
    assert.strictEqual(res.findings.length, 0, `Unexpected findings: ${res.findings.join(', ')}`);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('rejects PKG_HASH set to skip', async () => {
    const headFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_HASH:=skip\n`;
    const baseFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_HASH:=${sha256a}\n`;
    const res = await validatePkgHashes([{ commitPatch: bumpPatch }], HASH_CONFIG, headFetch, baseFetch);
    assert.ok(res.warnings.some(w => w.includes("set to 'skip'")), `Warnings: ${res.warnings.join(', ')}`);
    assert.strictEqual(res.errors.length, 0, 'skip is supported by the build system, so it must not be an error');
  });

  test('rejects an MD5-length PKG_HASH', async () => {
    const headFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_HASH:=${'c'.repeat(32)}\n`;
    const baseFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_HASH:=${sha256a}\n`;
    const res = await validatePkgHashes([{ commitPatch: bumpPatch }], HASH_CONFIG, headFetch, baseFetch);
    assert.ok(res.warnings.some(w => w.includes('MD5')), `Warnings: ${res.warnings.join(', ')}`);
    assert.strictEqual(res.errors.length, 0, 'MD5 is only deprecated, so it must not be an error');
  });

  test('rejects a checksum the download step cannot use at all', async () => {
    const headFetch = async () => 'PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_HASH:=not-a-checksum\n';
    const baseFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_HASH:=${sha256a}\n`;
    const res = await validatePkgHashes([{ commitPatch: bumpPatch }], HASH_CONFIG, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('not a usable checksum')), `Errors: ${res.errors.join(', ')}`);
  });

  test('requires a hash on new packages that download sources', async () => {
    const newPatch = `
diff --git a/package/utils/newpkg/Makefile b/package/utils/newpkg/Makefile
--- /dev/null
+++ b/package/utils/newpkg/Makefile
+PKG_NAME:=newpkg
`;
    const headFetch = async () => 'PKG_NAME:=newpkg\nPKG_VERSION:=1.0\nPKG_SOURCE_URL:=https://example.com/\n';
    const res = await validatePkgHashes([{ commitPatch: newPatch }], HASH_CONFIG, headFetch, async () => null);
    assert.ok(res.findings.some(f => f.includes('no PKG_HASH')), `Findings: ${res.findings.join(', ')}`);
  });

  test('does not demand a hash from a new VCS-sourced package', async () => {
    const newPatch = `
diff --git a/package/utils/newpkg/Makefile b/package/utils/newpkg/Makefile
--- /dev/null
+++ b/package/utils/newpkg/Makefile
+PKG_NAME:=newpkg
`;
    const headFetch = async () => 'PKG_NAME:=newpkg\nPKG_SOURCE_PROTO:=git\nPKG_SOURCE_URL:=https://example.com/repo.git\nPKG_SOURCE_VERSION:=deadbeef\n';
    const res = await validatePkgHashes([{ commitPatch: newPatch }], HASH_CONFIG, headFetch, async () => null);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.strictEqual(res.findings.length, 0, `Unexpected findings: ${res.findings.join(', ')}`);
  });

  test('accepts a new package with a valid SHA256 hash', async () => {
    const newPatch = `
diff --git a/package/utils/newpkg/Makefile b/package/utils/newpkg/Makefile
--- /dev/null
+++ b/package/utils/newpkg/Makefile
+PKG_NAME:=newpkg
`;
    const headFetch = async () => `PKG_NAME:=newpkg\nPKG_VERSION:=1.0\nPKG_SOURCE_URL:=https://example.com/\nPKG_HASH:=${sha256a}\n`;
    const res = await validatePkgHashes([{ commitPatch: newPatch }], HASH_CONFIG, headFetch, async () => null);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('valid SHA256 checksum')));
  });

  test('leaves packages without any checksum alone', async () => {
    const headFetch = async () => 'PKG_NAME:=base-files\nPKG_RELEASE:=2\n';
    const baseFetch = async () => 'PKG_NAME:=base-files\nPKG_RELEASE:=1\n';
    const res = await validatePkgHashes([{ commitPatch: bumpPatch }], HASH_CONFIG, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('leaves dynamic hash values alone', async () => {
    const headFetch = async () => 'PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_HASH:=$(DYNAMIC_HASH)\n';
    const baseFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_HASH:=${sha256a}\n`;
    const res = await validatePkgHashes([{ commitPatch: bumpPatch }], HASH_CONFIG, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('does nothing when disabled', async () => {
    const headFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_HASH:=${sha256a}\n`;
    const baseFetch = async () => `PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_HASH:=${sha256a}\n`;
    const res = await validatePkgHashes([{ commitPatch: bumpPatch }], { ...CONFIG, check_pkg_hash: false }, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.successes.length, 0);
  });
});
