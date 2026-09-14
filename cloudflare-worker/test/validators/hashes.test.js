import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validatePkgHashes } from '../../src/validators.js';
import { CONFIG, assertSomeIncludes } from './helpers.js';

// A Makefile as the fetchers serve it: one assignment per line.
const makefile = (lines) => `${lines.join('\n')}\n`;

// Checks what the audit reported, list by list: a string must appear in one
// of that list's entries, and [] means the list must stay empty.
const assertReported = (res, expected) => {
  for (const [list, want] of Object.entries(expected)) {
    if (Array.isArray(want)) assert.deepStrictEqual(res[list], want, `${list} should be empty: ${JSON.stringify(res[list])}`);
    else assertSomeIncludes(res[list], want, list);
  }
};

describe('validatePkgHashes', () => {
  const HASH_CONFIG = { ...CONFIG, check_pkg_hash: true };
  const bumpPatch = `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.3
`;
  const newPatch = `
diff --git a/package/utils/newpkg/Makefile b/package/utils/newpkg/Makefile
--- /dev/null
+++ b/package/utils/newpkg/Makefile
+PKG_NAME:=newpkg
`;
  const sha256a = 'a'.repeat(64);
  const sha256b = 'b'.repeat(64);
  const pinned = `PKG_HASH:=${sha256a}`;
  const sourceUrl = 'PKG_SOURCE_URL:=https://example.com/';

  // A bash Makefile at a version, followed by the given lines.
  const bash = (version, ...rest) => ['PKG_NAME:=bash', `PKG_VERSION:=${version}`, ...rest];

  // Audits one commit, serving the same head and base Makefile for every
  // path; a null base is a file the base branch does not have.
  const audit = (patch, head, base, config = HASH_CONFIG) =>
    validatePkgHashes([{ commitPatch: patch }], config,
      async () => makefile(head), async () => (base === null ? null : makefile(base)));

  const bumpCases = [
    {
      name: 'fails when the version changes but PKG_HASH stays',
      head: bash('5.3', pinned),
      base: bash('5.2', pinned),
      // An inferred source change must not be a hard error.
      expect: { findings: 'keeps the old PKG_HASH', errors: [] }
    },
    {
      name: 'treats SKIP in any other spelling as unusable, like the build does',
      head: bash('5.3', sourceUrl, 'PKG_HASH:=SKIP'),
      base: bash('5.2', sourceUrl, pinned),
      expect: { errors: 'not a usable checksum', warnings: [] }
    },
    {
      name: 'reports a checksum that a version bump removes instead of praising the change',
      head: bash('5.3', sourceUrl),
      base: bash('5.2', sourceUrl, pinned),
      expect: { findings: 'drops its PKG_HASH', successes: [] }
    },
    {
      name: 'passes when the version and PKG_HASH change together',
      head: bash('5.3', `PKG_HASH:=${sha256b}`),
      base: bash('5.2', pinned),
      expect: { errors: [], successes: 'updates the source checksum together with the version' }
    },
    {
      name: 'rejects PKG_HASH set to skip',
      head: bash('5.3', 'PKG_HASH:=skip'),
      base: bash('5.2', pinned),
      // skip is supported by the build system, so it must not be an error.
      expect: { warnings: "set to 'skip'", errors: [] }
    },
    {
      name: 'rejects an MD5-length PKG_HASH',
      head: bash('5.3', `PKG_HASH:=${'c'.repeat(32)}`),
      base: bash('5.2', pinned),
      // MD5 is only deprecated, so it must not be an error.
      expect: { warnings: 'MD5', errors: [] }
    },
    {
      name: 'rejects a checksum the download step cannot use at all',
      head: bash('5.3', 'PKG_HASH:=not-a-checksum'),
      base: bash('5.2', pinned),
      expect: { errors: 'not a usable checksum' }
    },
    {
      name: 'leaves packages without any checksum alone',
      head: ['PKG_NAME:=base-files', 'PKG_RELEASE:=2'],
      base: ['PKG_NAME:=base-files', 'PKG_RELEASE:=1'],
      expect: { errors: [] }
    },
    {
      name: 'leaves dynamic hash values alone',
      head: bash('5.3', 'PKG_HASH:=$(DYNAMIC_HASH)'),
      base: bash('5.2', pinned),
      expect: { errors: [] }
    }
  ];

  for (const { name, head, base, expect } of bumpCases) {
    test(name, async () => {
      assertReported(await audit(bumpPatch, head, base), expect);
    });
  }

  test('fails when PKG_SOURCE_VERSION changes but PKG_MIRROR_HASH stays', async () => {
    const sourceBumpPatch = `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_SOURCE_VERSION:=cafebabe
+PKG_SOURCE_VERSION:=deadbeef
`;
    const res = await audit(sourceBumpPatch,
      ['PKG_NAME:=fw', 'PKG_SOURCE_VERSION:=deadbeef', `PKG_MIRROR_HASH:=${sha256a}`],
      ['PKG_NAME:=fw', 'PKG_SOURCE_VERSION:=cafebabe', `PKG_MIRROR_HASH:=${sha256a}`]);
    assertReported(res, { findings: 'keeps the old PKG_MIRROR_HASH' });
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
    const res = await audit(releaseOnlyPatch,
      ['PKG_NAME:=fw', 'PKG_SOURCE_VERSION:=deadbeef', 'PKG_RELEASE:=2', `PKG_MIRROR_HASH:=${sha256a}`],
      ['PKG_NAME:=fw', 'PKG_SOURCE_VERSION:=cafebabe', 'PKG_RELEASE:=1', `PKG_MIRROR_HASH:=${sha256a}`]);
    assertReported(res, { findings: [], errors: [] });
  });

  const newPackageCases = [
    {
      name: 'requires a hash on new packages that download sources',
      head: ['PKG_NAME:=newpkg', 'PKG_VERSION:=1.0', sourceUrl],
      expect: { findings: 'no PKG_HASH' }
    },
    {
      name: 'does not demand a hash from a new VCS-sourced package',
      head: ['PKG_NAME:=newpkg', 'PKG_SOURCE_PROTO:=git', 'PKG_SOURCE_URL:=https://example.com/repo.git', 'PKG_SOURCE_VERSION:=deadbeef'],
      expect: { errors: [], findings: [] }
    },
    {
      name: 'accepts a new package with a valid SHA256 hash',
      head: ['PKG_NAME:=newpkg', 'PKG_VERSION:=1.0', sourceUrl, pinned],
      expect: { errors: [], successes: 'valid SHA256 checksum' }
    }
  ];

  for (const { name, head, expect } of newPackageCases) {
    test(name, async () => {
      assertReported(await audit(newPatch, head, null), expect);
    });
  }

  test('does nothing when disabled', async () => {
    const res = await audit(bumpPatch, bash('5.3', pinned), bash('5.2', pinned), { ...CONFIG, check_pkg_hash: false });
    assertReported(res, { errors: [], successes: [] });
  });
});
