import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  validateNewPackageOnStable,
  collectPackageMakefiles,
  NEW_PACKAGE_PROBE_CAP,
  NEW_PACKAGE_HEAD_CHARS
} from '../../src/validators.js';
import { isStableBaseBranch } from '../../src/core/policy.ts';
import { DEFAULT_CONFIG } from '../../src/config.js';

const CONFIG = { ...DEFAULT_CONFIG };

const addFile = (path, eol = '\n') => [
  `diff --git a/${path} b/${path}`,
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  `+++ b/${path}`,
  '@@ -0,0 +1,2 @@',
  '+include $(TOPDIR)/rules.mk',
  '+PKG_NAME:=foo',
  ''
].join(eol);

const removeFile = (path) => [
  `diff --git a/${path} b/${path}`,
  'deleted file mode 100644',
  'index 1111111..0000000',
  `--- a/${path}`,
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-include $(TOPDIR)/rules.mk',
  '-PKG_NAME:=foo',
  ''
].join('\n');

// What patches.ts hands the check: the union over every scanned patch.
const fromPatches = (...patches) => {
  const added = new Set();
  const removed = new Set();
  for (const p of patches) {
    collectPackageMakefiles(p, 'added').forEach(x => added.add(x));
    collectPackageMakefiles(p, 'removed').forEach(x => removed.add(x));
  }
  return { added, removed };
};
const adds = (...paths) => ({ added: paths, removed: [] });

// counts: path -> totalCount, or a function of the path. A path it does not
// name has no history.
const lookupWith = (counts = {}, { defaultBranch = 'master', headroom = true, fail = null } = {}) => {
  const calls = [];
  return {
    calls,
    hasHeadroom: () => headroom,
    probe: async (paths) => {
      calls.push(paths);
      if (fail) throw fail;
      const countOf = typeof counts === 'function' ? counts : (p) => counts[p] ?? 0;
      return { defaultBranch, counts: new Map(paths.map(p => [p, countOf(p)])) };
    }
  };
};

const readerWith = (files = {}) => {
  const reads = [];
  const read = async (path) => {
    reads.push(path);
    const v = files[path];
    if (v instanceof Error) throw v;
    return v ?? null;
  };
  return { reads, read };
};

const STABLE = { base: 'openwrt-24.10', default: 'master' };

const run = (makefiles, { branches = STABLE, config = CONFIG, files = {}, lookup = lookupWith() } = {}) => {
  const reader = readerWith(files);
  return validateNewPackageOnStable(makefiles, branches, config, reader.read, lookup)
    .then(res => ({ res, reads: reader.reads, calls: lookup.calls }));
};

describe('isStableBaseBranch', () => {
  test('accepts the three release-branch patterns CONTRIBUTING.md names, and nothing else', () => {
    for (const b of ['openwrt-24.10', 'openwrt-18.06', 'lede-17.01', 'for-14.07']) {
      assert.strictEqual(isStableBaseBranch(b), true, b);
    }
    for (const b of ['master', 'main', 'stable', 'rb-dmx', 'rb-v4l2loopback', 'openwrt-24.10-fix', 'openwrt-24', 'xopenwrt-24.10', 'openwrt-24.10\n']) {
      assert.strictEqual(isStableBaseBranch(b), false, JSON.stringify(b));
    }
  });
});

describe('validateNewPackageOnStable', () => {
  test('reports a package the default branch has never carried', async () => {
    const { res, calls, reads } = await run(fromPatches(addFile('net/51ddns-agent/Makefile')));
    assert.deepStrictEqual(calls, [['net/51ddns-agent/Makefile']]);
    assert.deepStrictEqual(reads, [], 'the category layout needs no read');
    assert.strictEqual(res.errors.length, 1);
    assert.ok(res.errors[0].startsWith('This pull request adds a package that has never existed on `master`: `net/51ddns-agent`. Release branches carry backports only'), res.errors[0]);
    assert.ok(res.errors[0].includes('link it here and treat this as a note rather than a finding'), res.errors[0]);
    assert.strictEqual(res.summary, "Adds 1 package not present in 'master' history: net/51ddns-agent");
    assert.deepStrictEqual(res.notices, []);
    assert.deepStrictEqual(res.successes, []);
    assert.strictEqual(res.incomplete, false);
  });

  test('is switched off by false and "disabled", without a read or a query', async () => {
    for (const level of [false, 'disabled']) {
      const lookup = lookupWith();
      const { res, reads } = await run(adds('net/foo/Makefile', 'applications/luci-app-foo/Makefile'), { config: { ...CONFIG, check_new_package_on_stable: level }, lookup });
      assert.strictEqual(lookup.calls.length, 0, String(level));
      assert.deepStrictEqual(reads, [], String(level));
      assert.deepStrictEqual(res, { successes: [], errors: [], notices: [], summary: null, incomplete: false });
    }
    // Control: the same input at the default level is asked about.
    const { calls } = await run(adds('net/foo/Makefile'));
    assert.strictEqual(calls.length, 1);
  });

  test('runs at "error" and true the same as at "warning"; the caller grades', async () => {
    for (const level of ['error', true, 'warning']) {
      const { res } = await run(adds('net/foo/Makefile'), { config: { ...CONFIG, check_new_package_on_stable: level } });
      assert.strictEqual(res.errors.length, 1, String(level));
    }
  });

  describe('the base branch gate', () => {
    test('leaves a pull request to the default branch alone, whatever its title says', async () => {
      // isBackportPr is true for a master pull request titled `[24.10] ...`;
      // the gate reads the base branch only.
      for (const base of ['master', 'main', 'rb-dmx', 'stable']) {
        const lookup = lookupWith();
        const { res } = await run(adds('net/foo/Makefile'), { branches: { base, default: 'master' }, lookup });
        assert.strictEqual(lookup.calls.length, 0, base);
        assert.deepStrictEqual(res.errors, [], base);
      }
      // Control: the same input on a release branch is asked about.
      const { calls } = await run(adds('net/foo/Makefile'));
      assert.strictEqual(calls.length, 1);
    });

    test('checks lede-17.01 and for-XX.YY like openwrt-XX.YY', async () => {
      for (const base of ['lede-17.01', 'for-14.07', 'openwrt-25.12']) {
        const { res, calls } = await run(adds('net/foo/Makefile'), { branches: { base, default: 'master' } });
        assert.strictEqual(calls.length, 1, base);
        assert.strictEqual(res.errors.length, 1, base);
      }
    });

    test('leaves a repository whose default branch is the release branch alone', async () => {
      const lookup = lookupWith();
      const { res } = await run(adds('net/foo/Makefile'), { branches: { base: 'openwrt-24.10', default: 'openwrt-24.10' }, lookup });
      assert.strictEqual(lookup.calls.length, 0);
      assert.deepStrictEqual(res.errors, []);
      // Control: a payload that does not name the default branch is asked.
      const unknown = await run(adds('net/foo/Makefile'), { branches: { base: 'openwrt-24.10', default: null } });
      assert.strictEqual(unknown.calls.length, 1);
    });

    test('says nothing when the default branch GitHub names turns out to be the base', async () => {
      const many = adds('net/foo/Makefile', ...Array.from({ length: 13 }, (_, i) => `net/p${i}/Makefile`));
      const lookup = lookupWith({}, { defaultBranch: 'openwrt-24.10' });
      const { res } = await run(many, { branches: { base: 'openwrt-24.10', default: null }, lookup });
      assert.strictEqual(lookup.calls.length, 1);
      assert.deepStrictEqual(res, { successes: [], errors: [], notices: [], summary: null, incomplete: false });
      // Control: GitHub naming master reports them, and the cap.
      const control = await run(many, { branches: { base: 'openwrt-24.10', default: null } });
      assert.strictEqual(control.res.errors.length, 1);
      assert.strictEqual(control.res.notices.length, 1);
    });
  });

  test('asks about history, not presence: a package master moved away is no finding', async () => {
    // lang/perl-future/Makefile: backported in 2026, gone from master's tree
    // since the perl packages moved to lang/perl/ in 2025, still in its log.
    const { res, calls } = await run(adds('lang/perl-future/Makefile'), { lookup: lookupWith({ 'lang/perl-future/Makefile': 3 }) });
    assert.deepStrictEqual(calls, [['lang/perl-future/Makefile']]);
    assert.deepStrictEqual(res.errors, []);
    assert.deepStrictEqual(res.successes, ["✅ Packages added by this pull request already exist on 'master'"]);
    assert.strictEqual(res.incomplete, false);
  });

  test('passes a mis-based pull request whose packages all have default-branch history', async () => {
    const paths = ['admin/earlyoom/Makefile', 'admin/freeipmi/Makefile', 'admin/iotop/Makefile'];
    const { res, calls } = await run(adds(...paths), {
      files: Object.fromEntries(paths.map(p => [p, 'PKG_NAME:=x\n'])),
      lookup: lookupWith(() => 8)
    });
    assert.deepStrictEqual(calls, [paths]);
    assert.deepStrictEqual(res.errors, []);
    assert.strictEqual(res.successes.length, 1);
  });

  test('does not count a Makefile below a package root as a package', async () => {
    const lookup = lookupWith();
    const { res, reads } = await run(fromPatches(
      addFile('net/foo/src/Makefile'),
      addFile('net/foo/files/Makefile'),
      addFile('package/utils/foo/src/Makefile')
    ), { lookup });
    assert.strictEqual(lookup.calls.length, 0);
    assert.deepStrictEqual(reads, []);
    assert.deepStrictEqual(res, { successes: [], errors: [], notices: [], summary: null, incomplete: false });
    // Control: the package's own Makefile beside them is the one asked about.
    const { calls } = await run(fromPatches(addFile('net/foo/src/Makefile'), addFile('net/foo/Makefile')));
    assert.deepStrictEqual(calls, [['net/foo/Makefile']]);
  });

  test('does not count build infrastructure as a package', async () => {
    const lookup = lookupWith();
    const makefiles = fromPatches(
      addFile('target/linux/ramips/image/Makefile'),
      addFile('tools/firmware-utils/Makefile'),
      addFile('toolchain/gcc/Makefile'),
      addFile('Makefile'),
      addFile('.github/foo/Makefile')
    );
    const { res } = await run(makefiles, { lookup });
    assert.strictEqual(lookup.calls.length, 0);
    assert.deepStrictEqual(res.errors, []);
    assert.deepStrictEqual(res.notices, []);
    // Control: a package beside them is the only path asked about.
    const { calls } = await run(fromPatches(addFile('toolchain/gcc/Makefile'), addFile('Makefile'), addFile('package/utils/foo/Makefile')));
    assert.deepStrictEqual(calls, [['package/utils/foo/Makefile']]);
  });

  test('resolves a luci application by reading its Makefile', async () => {
    const { res, reads, calls } = await run(adds('applications/luci-app-foo/Makefile'), {
      files: { 'applications/luci-app-foo/Makefile': 'LUCI_TITLE:=Foo\n\ninclude ../../luci.mk\n' }
    });
    assert.deepStrictEqual(reads, ['applications/luci-app-foo/Makefile'], 'only the added Makefile itself is read');
    assert.deepStrictEqual(calls, [['applications/luci-app-foo/Makefile']]);
    assert.match(res.errors[0], /`applications\/luci-app-foo`/);
  });

  // The batching loader folds every read asked for in one tick into one
  // request; a read asked a microtask later goes out on its own.
  test('asks for the Makefile in the tick it is called in', async () => {
    const reads = [];
    const pending = validateNewPackageOnStable(adds('applications/luci-app-foo/Makefile'), STABLE, CONFIG,
      async (path) => { reads.push(path); return 'include ../../luci.mk\n'; }, lookupWith());
    assert.deepStrictEqual(reads, ['applications/luci-app-foo/Makefile']);
    assert.strictEqual((await pending).errors.length, 1);
  });

  test('resolves a package at the root of the routing feed by reading its Makefile', async () => {
    const { res, calls } = await run(adds('bird3/Makefile'), { files: { 'bird3/Makefile': 'PKG_NAME:=bird3\nPKG_VERSION:=3.0\n' } });
    assert.deepStrictEqual(calls, [['bird3/Makefile']]);
    assert.match(res.errors[0], /`bird3`/);
  });

  test('drops a Makefile its own text says is no package', async () => {
    const lookup = lookupWith();
    const { res } = await run(adds('scripts/helper/Makefile'), { files: { 'scripts/helper/Makefile': 'all:\n\techo hi\n' }, lookup });
    assert.strictEqual(lookup.calls.length, 0);
    assert.deepStrictEqual(res, { successes: [], errors: [], notices: [], summary: null, incomplete: false });
    // Control: the same path with a package in it is asked about.
    const { calls } = await run(adds('scripts/helper/Makefile'), { files: { 'scripts/helper/Makefile': 'PKG_NAME:=helper\n' } });
    assert.deepStrictEqual(calls, [['scripts/helper/Makefile']]);
  });

  test('reports a Makefile that could not be read as unchecked, never as a finding', async () => {
    for (const content of [null, new Error('GraphQL batch file fetch failed (HTTP 502)')]) {
      const lookup = lookupWith();
      const { res } = await run(adds('applications/luci-app-foo/Makefile'), { files: { 'applications/luci-app-foo/Makefile': content }, lookup });
      assert.strictEqual(lookup.calls.length, 0);
      assert.deepStrictEqual(res.errors, []);
      assert.deepStrictEqual(res.notices, ["Could not check whether 'applications/luci-app-foo' exists on 'master': its package Makefile could not be read, so the release-branch rule was left unchecked rather than reported as a failure."]);
      assert.strictEqual(res.incomplete, true);
    }
  });

  // A package Makefile is tens of kilobytes. One far larger than that is not
  // scanned at all - the scan is linear but twelve such files could still
  // outrun the CPU budget - so the rule is reported as unchecked for it.
  test('leaves a Makefile too large to be read unchecked, never a finding', async () => {
    const huge = 'LUCI_TITLE:=Foo\n' + '\n'.repeat(NEW_PACKAGE_HEAD_CHARS) + 'include ../../luci.mk\n';
    const lookup = lookupWith();
    const { res } = await run(adds('applications/luci-app-foo/Makefile'), { files: { 'applications/luci-app-foo/Makefile': huge }, lookup });

    assert.strictEqual(lookup.calls.length, 0, 'nothing is asked about a package it did not read');
    assert.deepStrictEqual(res.errors, []);
    assert.deepStrictEqual(res.notices, [`Could not check whether 'applications/luci-app-foo' exists on 'master': its package Makefile is larger than this check reads (${NEW_PACKAGE_HEAD_CHARS / 1024} KiB), so the release-branch rule was left unchecked rather than reported as a failure.`]);
    assert.strictEqual(res.incomplete, true);
  });

  test('still reads a Makefile right at the size it reads', async () => {
    const atCap = 'LUCI_TITLE:=Foo\n\ninclude ../../luci.mk\n';
    const padded = atCap + '#'.repeat(NEW_PACKAGE_HEAD_CHARS - atCap.length);
    const { res } = await run(adds('applications/luci-app-foo/Makefile'), { files: { 'applications/luci-app-foo/Makefile': padded } });

    assert.strictEqual(padded.length, NEW_PACKAGE_HEAD_CHARS);
    assert.match(res.errors[0] || '', /`applications\/luci-app-foo`/, 'judged as usual');
  });

  test('still reports the packages it could resolve beside one it could not', async () => {
    const { res, calls } = await run(adds('applications/luci-app-foo/Makefile', 'net/bar/Makefile'));
    assert.deepStrictEqual(calls, [['net/bar/Makefile']]);
    assert.strictEqual(res.errors.length, 1);
    assert.strictEqual(res.notices.length, 1);
    assert.strictEqual(res.incomplete, true);
  });

  test('does not send the query once only the reserve is left', async () => {
    const lookup = lookupWith({}, { headroom: false });
    const { res } = await run(adds('net/foo/Makefile'), { lookup });
    assert.strictEqual(lookup.calls.length, 0);
    assert.deepStrictEqual(res.errors, []);
    assert.deepStrictEqual(res.notices, ["Could not ask GitHub which packages 'master' carries (no request budget left outside the reserve kept for the closing writes), so the release-branch rule was left unchecked rather than reported as a failure."]);
    assert.strictEqual(res.incomplete, true);
  });

  test('reports a query that failed as unchecked, not as packages master lacks', async () => {
    const lookup = lookupWith({}, { fail: new Error('GraphQL path history query for openwrt/packages was not answered (HTTP 502: bad gateway)') });
    const { res } = await run(adds('net/foo/Makefile'), { lookup });
    assert.deepStrictEqual(res.errors, []);
    assert.strictEqual(res.summary, null);
    assert.strictEqual(res.notices.length, 1);
    assert.match(res.notices[0], /^Could not ask GitHub which packages 'master' carries \(GraphQL path history query .*\(HTTP 502: bad gateway\)\), so the release-branch rule was left unchecked/);
    assert.ok(!res.notices[0].includes('never existed'));
    assert.strictEqual(res.incomplete, true);
  });

  test('reports a path the answer left out as unchecked', async () => {
    const lookup = {
      calls: [],
      hasHeadroom: () => true,
      probe: async (paths) => { lookup.calls.push(paths); return { defaultBranch: 'master', counts: new Map([['net/a/Makefile', 0]]) }; }
    };
    const { res } = await run(adds('net/a/Makefile', 'net/b/Makefile'), { lookup });
    assert.match(res.errors[0], /`net\/a`/);
    assert.ok(!res.errors[0].includes('net/b'));
    assert.deepStrictEqual(res.notices, ["Could not check whether 'net/b' exists on 'master': GitHub returned no history for it, so the release-branch rule was left unchecked rather than reported as a failure."]);
    assert.strictEqual(res.incomplete, true);
  });

  describe('the probe cap', () => {
    const roots = Array.from({ length: 31 }, (_, i) => `net/pkg${String(i).padStart(2, '0')}`);

    test('asks about the first 12 roots in path order and names the rest', async () => {
      const shuffled = [...roots].reverse().map(r => `${r}/Makefile`);
      const { res, calls } = await run(adds(...shuffled), { lookup: lookupWith(() => 1) });
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0], roots.slice(0, NEW_PACKAGE_PROBE_CAP).map(r => `${r}/Makefile`));
      assert.deepStrictEqual(res.notices, ["This pull request adds 31 package Makefiles; only the first 12 were checked against 'master', so the rest were left unchecked."]);
      assert.strictEqual(res.incomplete, true);
      assert.deepStrictEqual(res.successes, [], 'what was left unprobed is no pass');
    });

    test('reports a finding among the probed and the unprobed remainder together', async () => {
      const { res } = await run(adds(...roots.map(r => `${r}/Makefile`)), { lookup: lookupWith(p => (p === 'net/pkg03/Makefile' ? 0 : 2)) });
      assert.strictEqual(res.summary, "Adds 1 package not present in 'master' history: net/pkg03");
      assert.strictEqual(res.notices.length, 1);
      assert.strictEqual(res.incomplete, true);
    });

    test('counts only package roots against the cap', async () => {
      const subs = Array.from({ length: 20 }, (_, i) => `net/aaa${String(i).padStart(2, '0')}/src/Makefile`);
      const real = ['net/v/Makefile', 'net/w/Makefile', 'net/x/Makefile', 'net/y/Makefile', 'net/z/Makefile'];
      const { res, calls } = await run(adds(...subs, ...real), { lookup: lookupWith(() => 1) });
      assert.deepStrictEqual(calls, [real]);
      assert.deepStrictEqual(res.notices, []);
      assert.strictEqual(res.successes.length, 1);
    });
  });

  test('lists several packages one per line, in path order', async () => {
    const { res } = await run(adds('package/iwrt/b/Makefile', 'package/iwrt/a/Makefile'), {
      files: { 'package/iwrt/a/Makefile': 'PKG_NAME:=a\n', 'package/iwrt/b/Makefile': 'PKG_NAME:=b\n' }
    });
    assert.ok(res.errors[0].startsWith('This pull request adds packages that have never existed on `master`:\n  - `package/iwrt/a`\n  - `package/iwrt/b`\n\n  Release branches carry backports only'), res.errors[0]);
    assert.ok(res.errors[0].includes('pull request for these packages is already open'));
    assert.strictEqual(res.summary, "Adds 2 packages not present in 'master' history: package/iwrt/a, package/iwrt/b");
  });

  test("names the default branch GitHub reports, in every sentence", async () => {
    const found = await run(adds('package/utils/mavlink-router/Makefile'), { branches: { base: 'openwrt-24.10', default: 'main' }, lookup: lookupWith({}, { defaultBranch: 'main' }) });
    assert.ok(!found.res.errors[0].includes('master'), found.res.errors[0]);
    assert.strictEqual((found.res.errors[0].match(/`main`/g) || []).length, 4, found.res.errors[0]);
    assert.ok(found.res.errors[0].includes("`main`'s history"));
    assert.strictEqual(found.res.summary, "Adds 1 package not present in 'main' history: package/utils/mavlink-router");
    const passed = await run(adds('package/utils/mavlink-router/Makefile'), { branches: { base: 'openwrt-24.10', default: 'main' }, lookup: lookupWith(() => 5, { defaultBranch: 'main' }) });
    assert.deepStrictEqual(passed.res.successes, ["✅ Packages added by this pull request already exist on 'main'"]);
  });

  describe('across commits', () => {
    test('a move done on master is no finding; one done only on the stable branch is', async () => {
      // python-libpass replaced python-passlib in two commits; per commit the
      // addition is a plain new file.
      const makefiles = fromPatches(
        addFile('lang/python/python-libpass/Makefile'),
        removeFile('lang/python/python-passlib/Makefile')
      );
      const onMaster = await run(makefiles, { lookup: lookupWith({ 'lang/python/python-libpass/Makefile': 1 }) });
      assert.deepStrictEqual(onMaster.calls, [['lang/python/python-libpass/Makefile']]);
      assert.deepStrictEqual(onMaster.res.errors, []);
      const stableOnly = await run(makefiles, { lookup: lookupWith({}) });
      assert.match(stableOnly.res.errors[0], /`lang\/python\/python-libpass`/);
    });

    test('a package added and removed again within the pull request is none', async () => {
      for (const order of [[addFile('net/foo/Makefile'), removeFile('net/foo/Makefile')], [removeFile('net/foo/Makefile'), addFile('net/foo/Makefile')]]) {
        const lookup = lookupWith();
        const { res } = await run(fromPatches(...order), { lookup });
        assert.strictEqual(lookup.calls.length, 0);
        assert.deepStrictEqual(res.errors, []);
      }
      // Control: the addition alone is reported.
      const { res } = await run(fromPatches(addFile('net/foo/Makefile')));
      assert.strictEqual(res.errors.length, 1);
    });

    test('two commits adding the same Makefile ask about it once', async () => {
      const { res, calls } = await run(adds('net/foo/Makefile', 'net/foo/Makefile'));
      assert.deepStrictEqual(calls, [['net/foo/Makefile']]);
      assert.strictEqual(res.summary, "Adds 1 package not present in 'master' history: net/foo");
    });
  });

  test('asks about the clean path of a patch with CRLF line ends', async () => {
    const makefiles = fromPatches(addFile('net/foo/Makefile', '\r\n'));
    assert.deepStrictEqual([...makefiles.added], ['net/foo/Makefile']);
    const { calls } = await run(makefiles);
    assert.deepStrictEqual(calls, [['net/foo/Makefile']]);
  });

  // Pinned as counters: whatever the pull request adds, one query of at most
  // NEW_PACKAGE_PROBE_CAP paths, and at most that many reads.
  describe('cost on the largest input a pull request can write', () => {
    test('5000 added package roots cost one query of 12 paths and no read', async () => {
      const makefiles = adds(...Array.from({ length: 5000 }, (_, i) => `net/pkg${i}/Makefile`));
      const { calls, reads, res } = await run(makefiles);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].length, NEW_PACKAGE_PROBE_CAP);
      assert.strictEqual(reads.length, 0);
      assert.match(res.notices[0], /adds 5000 package Makefiles; only the first 12/);
    });

    test('5000 added Makefiles of a layout that needs reading cost at most 12 reads', async () => {
      const paths = Array.from({ length: 5000 }, (_, i) => `applications/luci-app-${i}/Makefile`);
      const files = Object.fromEntries(paths.map(p => [p, 'include ../../luci.mk\n']));
      const { calls, reads } = await run(adds(...paths), { files });
      assert.strictEqual(reads.length, NEW_PACKAGE_PROBE_CAP);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].length, NEW_PACKAGE_PROBE_CAP);
    });

    // The root helpers walk a path once per segment; a path no package root
    // sits that deep in never reaches them.
    test('a Makefile deeper than any package root costs nothing', async () => {
      const six = 'a/b/c/d/e/f/Makefile';
      const seven = 'a/b/c/d/e/f/g/Makefile';
      const deep = `${'d/'.repeat(2000)}Makefile`;
      const files = { [six]: 'PKG_NAME:=six\n', [seven]: 'PKG_NAME:=seven\n', [deep]: 'PKG_NAME:=deep\n' };
      const { reads, calls } = await run(adds(six, seven, deep), { files });
      assert.deepStrictEqual(reads, [six]);
      assert.deepStrictEqual(calls, [[six]]);
    });
  });
});
