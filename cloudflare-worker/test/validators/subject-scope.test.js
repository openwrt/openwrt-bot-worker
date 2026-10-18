import { describe, test } from 'node:test';
import assert from 'node:assert';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { validateSubjectScope, createSubjectScopeBudget, findPkgRoot } from '../../src/validators.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { CONFIG } from './helpers.js';

const SCOPE = {
  ...CONFIG,
  allow_revert: true,
  check_subject_scope: 'warning',
  subject_scope_prefixes: [...DEFAULT_CONFIG.subject_scope_prefixes]
};

const change = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
const deletion = (path) => `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n`;
const patchOf = (...paths) => paths.map(change).join('');
const commitOf = (subject, body = 'Explain the change.') =>
  ({ commit: { message: `${subject}\n\n${body}\n\nSigned-off-by: Jane Doe <jane@example.com>` } });

// A head tree of the given files. A path listed in `failing` is one the loader
// could not read; any other path it does not hold is genuinely absent.
const treeOf = (files = {}, failing = []) => {
  const reads = [];
  return {
    reads,
    fetch: async (path) => {
      reads.push(path);
      if (failing.includes(path)) return null;
      return Object.hasOwn(files, path) ? files[path] : null;
    },
    isMissing: (path) => !failing.includes(path) && !Object.hasOwn(files, path)
  };
};

const check = async (subject, paths, { repo = 'openwrt/packages', config = {}, files = {}, failing = [], budget, patch, body, fetch } = {}) => {
  const tree = treeOf(files, failing);
  const res = await validateSubjectScope(commitOf(subject, body), patch ?? patchOf(...paths), { ...SCOPE, ...config }, repo,
    fetch || tree.fetch, { isMissing: tree.isMissing, budget });
  return { ...res, reads: tree.reads };
};

const silent = (res) => {
  assert.deepStrictEqual(res.warnings, [], 'warnings');
  assert.deepStrictEqual(res.errors, [], 'errors');
  assert.deepStrictEqual(res.notices, [], 'notices');
  assert.strictEqual(res.incomplete, false);
};
const passes = (res, token) => {
  silent(res);
  assert.strictEqual(res.successes.length, 1, JSON.stringify(res.successes));
  assert.match(res.successes[0], new RegExp(`^✅ Subject prefix \`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\` names a `));
};
const exempt = (res) => {
  silent(res);
  assert.deepStrictEqual(res.successes, []);
};
const warns = (res) => {
  assert.strictEqual(res.warnings.length, 1, JSON.stringify(res));
  assert.deepStrictEqual(res.errors, []);
  assert.deepStrictEqual(res.successes, []);
  assert.strictEqual(res.incomplete, false);
  return res.warnings[0];
};
const leftUnchecked = (res, { gap = true } = {}) => {
  assert.deepStrictEqual(res.warnings, []);
  assert.deepStrictEqual(res.errors, []);
  assert.deepStrictEqual(res.successes, []);
  assert.strictEqual(res.notices.length, 1, JSON.stringify(res.notices));
  assert.match(res.notices[0], /^Could not check the subject prefix against the files this commit changes \(.+\), so the prefix was left unchecked rather than reported as wrong\.$/);
  assert.strictEqual(res.incomplete, gap);
  return res.notices[0];
};

const DROPBEAR = 'package/network/services/dropbear/Makefile';
const DROPBEAR_TREE = { [DROPBEAR]: 'include $(TOPDIR)/rules.mk\n\nPKG_NAME:=dropbear\nPKG_VERSION:=2025.88\n' };
const LUCI_APP = (app) => `applications/${app}/htdocs/luci-static/resources/view/${app}.js`;
const LUCI_TREE = (app) => ({ [`applications/${app}/Makefile`]: 'LUCI_TITLE:=Foo\n\ninclude ../../luci.mk\n' });

describe('validateSubjectScope', () => {
  test('passes a prefix that names the package, and warns about one that names nothing changed', async () => {
    passes(await check('curl: update to 8.23.0', ['net/curl/Makefile']), 'curl');

    const finding = warns(await check('hostapd: fix WPS', [DROPBEAR], { repo: 'openwrt/openwrt', files: DROPBEAR_TREE }));
    assert.strictEqual(finding,
      'Subject prefix `hostapd` does not name anything this commit changes: it changes `package/network/services/dropbear/` (package `dropbear`). ' +
      'Name the package or subsystem the commit changes (`dropbear: …`), or `treewide: ` for a change that spans the tree. ' +
      'If the prefix is deliberate — the fix belongs to a different package than the file it edits, or it names a device, ' +
      'a subtarget or an upstream kernel subsystem — nothing needs changing here.');
  });

  test('reports at the configured level, and nothing at all when switched off', async () => {
    const miss = (level) => check('hostapd: fix WPS', [DROPBEAR], { repo: 'openwrt/openwrt', files: DROPBEAR_TREE, config: { check_subject_scope: level } });
    warns(await miss('warning'));
    for (const level of ['error', true]) {
      const res = await miss(level);
      assert.deepStrictEqual(res.warnings, [], String(level));
      assert.strictEqual(res.errors.length, 1, String(level));
      assert.match(res.errors[0], /^Subject prefix `hostapd` does not name anything this commit changes/);
    }
    for (const level of [false, 'disabled', undefined]) {
      const res = await miss(level);
      exempt(res);
      assert.deepStrictEqual(res.reads, [], String(level));
    }
    // A matching prefix is no success line either while the check is off.
    exempt(await check('curl: update to 8.23.0', ['net/curl/Makefile'], { config: { check_subject_scope: false } }));
  });

  test('passes a commit as soon as the prefix explains one of its files', async () => {
    passes(await check('curl: update to 8.23.0', ['net/curl/Makefile', 'utils/collectd/Makefile']), 'curl');
    passes(await check('input-support: add a package for input device handling', [
      'package/system/hardware-support/Makefile',
      'package/kernel/linux/modules/input.mk',
      'target/linux/ramips/image/mt76x8.mk'
    ], {
      repo: 'openwrt/openwrt',
      files: { 'package/system/hardware-support/Makefile': 'PKG_NAME:=hardware-support\n\ndefine Package/input-support\n  TITLE:=Input\nendef\n' }
    }), 'input-support');
    passes(await check('libiwinfo: update to Git HEAD', ['package/network/utils/iwinfo/Makefile', 'scripts/feeds'], { repo: 'openwrt/openwrt' }), 'libiwinfo');
  });

  test('accepts any part of a chained prefix, not only the last', async () => {
    exempt(await check('ci: labeler: tighten the globs', ['.github/labeler.yml']));
    // `extractSubjectEntity` would read only `filogic`, which no path carries.
    passes(await check('mediatek: filogic: add the BPi-R4 2.5G PHY', ['package/boot/uboot-mediatek/Makefile'], { repo: 'openwrt/openwrt' }), 'mediatek');
    passes(await check('wifi: mt76: update to Git HEAD', ['package/kernel/mt76/Makefile'], { repo: 'openwrt/openwrt' }), 'mt76');
  });

  test('reads a path-shaped prefix piece by piece', async () => {
    exempt(await check('tools/cmake: update to 3.31.2', ['tools/cmake/Makefile'], { repo: 'openwrt/openwrt' }));
    exempt(await check('toolchain: musl: bump to 1.2.6', ['toolchain/musl/Makefile'], { repo: 'openwrt/openwrt' }));
    // In a feed `lang` names no subsystem: the path itself explains it.
    passes(await check('lang/python: add a helper', ['lang/python/python3-package.mk']), 'lang');
  });

  test('accepts the subsystem words the guidelines name, where they cover a changed file', async () => {
    const noAllowlist = { subject_scope_prefixes: [] };
    exempt(await check('kernel: add KERNEL_TIME_NS Kconfig knob', ['config/Config-kernel.in'], { repo: 'openwrt/openwrt' }));
    exempt(await check('build: derive the version strings eagerly', ['include/image.mk'], { repo: 'openwrt/openwrt' }));
    exempt(await check('ci: remove keys last used by travis CI', ['.keys/626471F1.asc']));
    exempt(await check('i18n: sync translations', ['applications/luci-app-acl/po/en/acl.po'], { repo: 'openwrt/luci', config: noAllowlist }));
    exempt(await check('targets: derive ARM ISA features from CPU_TYPE', ['include/target.mk', 'target/Config.in'], { repo: 'openwrt/openwrt' }));
    // The word alone is not enough: it has to cover something the commit changes.
    const app = 'luci-app-foo';
    const finding = warns(await check('kernel: fix the web UI', [LUCI_APP(app)], { repo: 'openwrt/luci', files: LUCI_TREE(app) }));
    // A LuCI Makefile defines no package name of its own: the directory alone is named.
    assert.match(finding, /^Subject prefix `kernel` does not name anything this commit changes: it changes `applications\/luci-app-foo\/`\. Name the package or subsystem the commit changes \(`luci-app-foo: …`\)/);
    // A feed has no kernel tree for the word to cover.
    warns(await check('kernel: fix the build', ['net/foo/Makefile'], { files: { 'net/foo/Makefile': 'PKG_NAME:=foo\n' } }));
  });

  test('accepts treewide in both spellings, and not a typo of it', async () => {
    const noAllowlist = { subject_scope_prefixes: [] };
    exempt(await check('treewide: drop the md5 checksums', ['net/curl/Makefile', 'utils/collectd/Makefile'], { config: noAllowlist }));
    exempt(await check('tree-wide: remove redundant test.sh files', ['net/curl/test.sh', 'utils/collectd/test.sh'], { config: noAllowlist }));
    const app = 'luci-app-foo';
    warns(await check('treewise: resync translations', [`applications/${app}/po/de/foo.po`], { repo: 'openwrt/luci', files: LUCI_TREE(app) }));
  });

  test("accepts the repository's own name, and only in that repository", async () => {
    const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(p => `net/pkg-${p}/Makefile`);
    exempt(await check('telephony: use PKG_HASH instead of PKG_MD5SUM', nine, { repo: 'openwrt/telephony' }));
    // Elsewhere it is an ordinary prefix: too many packages to read, so unchecked rather than waved through.
    assert.match(leftUnchecked(await check('telephony: use PKG_HASH instead of PKG_MD5SUM', nine)), /it changes more than 5 packages/);
    const files = { 'net/asterisk/Makefile': 'PKG_NAME:=asterisk\n', 'net/freeswitch/Makefile': 'PKG_NAME:=freeswitch\n' };
    const finding = warns(await check('telephony: use PKG_HASH instead of PKG_MD5SUM', ['net/asterisk/Makefile', 'net/freeswitch/Makefile'], { files }));
    assert.match(finding, /it changes `net\/asterisk\/` \(package `asterisk`\) and `net\/freeswitch\/` \(package `freeswitch`\)\./);
  });

  test('leaves a commit of upstream patches alone, and grades it once it changes anything else', async () => {
    const subject = 'net: phy: as21xxx: discard stale C45 read response';
    const patch = 'target/linux/mediatek/patches-6.18/999-net-phy-as21xxx-discard.patch';
    const res = await check(subject, [patch], { repo: 'openwrt/openwrt' });
    exempt(res);
    assert.deepStrictEqual(res.reads, []);
    exempt(await check('mac80211_hwsim: free a frame', ['package/kernel/mac80211/patches/subsys/350-hwsim.patch'], { repo: 'openwrt/openwrt' }));
    warns(await check(subject, [patch, 'package/utils/busybox/Makefile'], {
      repo: 'openwrt/openwrt', files: { 'package/utils/busybox/Makefile': 'PKG_NAME:=busybox\n' }
    }));
  });

  test('leaves a commit under target/ alone in the main repository only', async () => {
    const subject = 'ipq50xx: add label-mac-device to Linksys MX5500';
    const dts = 'target/linux/qualcommax/dts/ipq5018-mx5500.dts';
    const main = await check(subject, [dts], { repo: 'openwrt/openwrt' });
    exempt(main);
    assert.deepStrictEqual(main.reads, []);
    // A feed grades it: no package there to name instead, so still no finding.
    const feed = await check(subject, [dts]);
    exempt(feed);
    assert.ok(feed.reads.length > 0, 'the feed commit was not graded');
  });

  test('leaves a commit of shared build files alone', async () => {
    const res = await check('base-files: add warning to distfeeds.list', ['include/feeds.mk'], { repo: 'openwrt/openwrt' });
    exempt(res);
    assert.deepStrictEqual(res.reads, []);
    exempt(await check('npm: bump @eslint/json from 1.2.0 to 2.1.1', ['package.json'], { repo: 'openwrt/luci', config: { subject_scope_prefixes: [] } }));
    // Control: the same subject on a package is graded.
    warns(await check('base-files: add warning to distfeeds.list', [DROPBEAR], { repo: 'openwrt/openwrt', files: DROPBEAR_TREE }));
  });

  test('accepts the prefixes a repository lists, and nothing else unlisted', async () => {
    const app = 'luci-app-mosquitto';
    const files = [`applications/${app}/htdocs/x.js`];
    exempt(await check('widgets: require the right file', files, { repo: 'openwrt/luci', config: { subject_scope_prefixes: ['widgets'] } }));
    warns(await check('widgets: require the right file', files, { repo: 'openwrt/luci', files: LUCI_TREE(app) }));
    exempt(await check('housekeeping: tidy up', ['net/curl/Makefile']));
    warns(await check('housekeeping: tidy up', ['net/curl/Makefile'], { config: { subject_scope_prefixes: [] }, files: { 'net/curl/Makefile': 'PKG_NAME:=curl\n' } }));
  });

  test('accepts the package names a touched Makefile defines', async () => {
    const hw = 'package/system/hardware-support/Makefile';
    const video = await check('video-support: put the V4L2 nodes in the video group', [hw], {
      repo: 'openwrt/openwrt',
      files: { [hw]: 'PKG_NAME:=hardware-support\n\ndefine Package/video-support\nendef\n\ndefine Package/hidraw-support\nendef\n' }
    });
    passes(video, 'video-support');
    assert.match(video.successes[0], /names a package this commit changes$/);

    passes(await check('kmod-foo: fix the module autoload', ['package/kernel/bar/Makefile'], {
      repo: 'openwrt/openwrt', files: { 'package/kernel/bar/Makefile': 'PKG_NAME:=bar\n\n$(eval $(call KernelPackage,foo))\n' }
    }), 'kmod-foo');
    passes(await check('rtl8261n-firmware: set PKGARCH:=all', ['package/firmware/rtl826x-firmware/Makefile'], {
      repo: 'openwrt/openwrt', files: { 'package/firmware/rtl826x-firmware/Makefile': 'PKG_NAME:=rtl826x-firmware\n\ndefine Package/rtl8261n-firmware\nendef\n' }
    }), 'rtl8261n-firmware');
    passes(await check('moc: remove package', ['sound/mocp/Makefile'], { files: { 'sound/mocp/Makefile': 'PKG_NAME:=moc\n' } }), 'moc');
    // Spellings of the same name pass without reading anything.
    for (const [subject, path] of [
      ['libtiff: update to 4.7.0', 'libs/tiff/Makefile'],
      ['python3-openpyxl: update to 3.1.5', 'lang/python/openpyxl/Makefile'],
      ['modbus: update to 3.1.11', 'libs/libmodbus/Makefile'],
      ['ddns-script: fix the cloudflare provider', 'net/ddns-scripts/Makefile'],
      ['mini-snmpd: fix the init script', 'net/mini_snmpd/Makefile'],
      ['asterisk13: fix the build', 'net/asterisk-13.x/Makefile'],
      ['dovecot-pigeonhole: fix Makefile syntax', 'mail/pigeonhole/Makefile'],
      ['luci-app-vpnc: fix the form', 'protocols/luci-proto-vpnc/Makefile'],
      ['luci-app-ipsec: rename to luci-app-strongswan-swanctl', 'applications/luci-app-strongswan-ipsec/Makefile'],
      ['librespeed: update to 1.0.12', 'utils/librespeed-cli-rust/Makefile']
    ]) {
      const res = await check(subject, [path]);
      passes(res, subject.slice(0, subject.indexOf(':')));
      assert.deepStrictEqual(res.reads, [], subject);
    }
  });

  test('never reports a prefix it could not check against an unread Makefile', async () => {
    for (const fetch of [async () => null, async () => { throw new Error('GraphQL timeout'); }]) {
      const tree = treeOf({}, [DROPBEAR]);
      const res = await validateSubjectScope(commitOf('hostapd: fix WPS'), patchOf(DROPBEAR), SCOPE, 'openwrt/openwrt', fetch, { isMissing: tree.isMissing });
      assert.match(leftUnchecked(res), /`package\/network\/services\/dropbear\/Makefile` could not be read/);
    }
    // A fast-resolved root whose Makefile could not be read: the same.
    assert.match(leftUnchecked(await check('hostapd: fix WPS', ['net/dropbear/Makefile'], { failing: ['net/dropbear/Makefile'] })),
      /`net\/dropbear\/Makefile` could not be read/);
    // A Makefile that is genuinely not there adds nothing, and the miss stands.
    warns(await check('hostapd: fix WPS', ['net/dropbear/files/dropbear.init']));
  });

  test('does not look for the Makefile of a package the commit deletes', async () => {
    passes(await check('foo: remove package', [], { patch: deletion('utils/foo/Makefile') + deletion('utils/foo/files/foo.init') }), 'foo');
    const res = await check('bar: remove a stale package', [], { patch: deletion('utils/foo/Makefile') + deletion('utils/foo/files/foo.init') });
    exempt(res);
    assert.deepStrictEqual(res.reads, []);
  });

  test('leaves a Makefile that generates its package names unchecked, without calling it a gap', async () => {
    const gnunet = await check('reclaim: drop libgabe and libpbc', ['net/gnunet/Makefile'], {
      files: { 'net/gnunet/Makefile': 'PKG_NAME:=gnunet\n\ndefine Package/gnunet-$(1)\nendef\n' }
    });
    assert.match(leftUnchecked(gnunet, { gap: false }), /`net\/gnunet\/Makefile` builds package names from make expansions/);
    const perlbase = await check('perlbase-encode: added dependency on perlbase-storable', ['lang/perl/perlbase.mk'], {
      files: { 'lang/perl/Makefile': 'PKG_NAME:=perl\n' }
    });
    assert.match(leftUnchecked(perlbase, { gap: false }), /`lang\/perl\/perlbase\.mk` defines package names the package Makefile does not show/);
  });

  test('grades a revert on the subject it quotes', async () => {
    const body = 'This reverts commit 0123456789abcdef0123456789abcdef01234567.';
    passes(await check('Revert "curl: update to 8.23.0"', ['net/curl/Makefile'], { body }), 'curl');
    passes(await check('pkg: Revert "other: thing"', ['net/pkg/Makefile'], { body }), 'pkg');
    passes(await check('pkg: Revert "other: thing"', ['net/other/Makefile'], { body }), 'other');
    passes(await check('Revert "Revert "curl: update to 8.23.0""', ['net/curl/Makefile'], { body }), 'curl');
    // Without the reference it is no revert, and has no prefix to grade.
    const shaped = await check('Revert "hostapd: fix WPS"', [DROPBEAR], { repo: 'openwrt/openwrt', files: DROPBEAR_TREE });
    exempt(shaped);
    assert.deepStrictEqual(shaped.reads, []);
  });

  test('leaves fixup! and squash! commits alone', async () => {
    for (const marker of ['fixup!', 'squash!']) {
      const res = await check(`${marker} hostapd: fix WPS`, [DROPBEAR], { repo: 'openwrt/openwrt', files: DROPBEAR_TREE });
      exempt(res);
      assert.deepStrictEqual(res.reads, []);
    }
    // Control: without the marker the subject is graded.
    warns(await check('hostapd: fix WPS', [DROPBEAR], { repo: 'openwrt/openwrt', files: DROPBEAR_TREE }));
  });

  test('says nothing about a subject with no prefix, which the shape check reports', async () => {
    const res = await check('updated some stuff', [DROPBEAR], { repo: 'openwrt/openwrt', files: DROPBEAR_TREE });
    exempt(res);
    assert.deepStrictEqual(res.reads, []);
    warns(await check('updated: some stuff', [DROPBEAR], { repo: 'openwrt/openwrt', files: DROPBEAR_TREE }));
  });

  test('reports a commit audited as one diff whose part could not be told apart', async () => {
    const res = await validateSubjectScope(commitOf('curl: update'), null, SCOPE, 'openwrt/packages', async () => null,
      { patchUnavailable: "this pull request is audited as one diff, and this commit's part of it could not be told apart" });
    assert.match(leftUnchecked(res), /audited as one diff/);
    // Without a reason the missing patch is someone else's to report.
    exempt(await validateSubjectScope(commitOf('curl: update'), null, SCOPE, 'openwrt/packages', async () => null, {}));
  });
});

describe('validateSubjectScope bounds', () => {
  test('does not grade a commit over the file cap, and scans none of its paths', async () => {
    const budget = createSubjectScopeBudget();
    const paths = Array.from({ length: 500 }, (_, i) => `net/pkg${i}/files/x`);
    const res = await check('hostapd: fix WPS', paths, { budget });
    exempt(res);
    assert.deepStrictEqual(res.reads, []);
    assert.strictEqual(budget.segmentsScanned, 0);
    // Control: at the cap the same files are scanned, each distinct segment once.
    await check('hostapd: fix WPS', paths.slice(0, 120), { budget });
    assert.strictEqual(budget.segmentsScanned, ['net', 'files', 'x'].length + 120);
  });

  test('leaves a commit over six package roots unchecked before reading anything', async () => {
    const paths = ['a', 'b', 'c', 'd', 'e', 'f'].map(p => `net/pkg-${p}/Makefile`);
    const res = await check('hostapd: fix WPS', paths);
    assert.match(leftUnchecked(res), /it changes more than 5 packages/);
    assert.deepStrictEqual(res.reads, []);
  });

  test('leaves a commit unchecked whose packages take too many directories to find', async () => {
    const res = await check('hostapd: fix WPS', [LUCI_APP('luci-app-one'), LUCI_APP('luci-app-two')], { repo: 'openwrt/luci' });
    assert.match(leftUnchecked(res), /more than 8 directories looked up/);
    assert.deepStrictEqual(res.reads, []);
  });

  test('reads the Makefiles of three commits per run and says so for the fourth', async () => {
    const budget = createSubjectScopeBudget();
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await check('hostapd: fix WPS', [`net/pkg${i}/Makefile`], { budget, files: { [`net/pkg${i}/Makefile`]: `PKG_NAME:=pkg${i}\n` } }));
    }
    for (const res of results.slice(0, 3)) warns(res);
    assert.match(leftUnchecked(results[3]), /only the first commits of a run whose prefix matched no path have their Makefiles read/);
    assert.deepStrictEqual(results[3].reads, []);
  });

  test('parses no more Makefile text per run than its budget, and says so', async () => {
    const budget = createSubjectScopeBudget();
    const makefile = (name) => `PKG_NAME:=${name}\n# ${'x'.repeat(60 * 1024)}\n`;
    const first = await check('hostapd: fix WPS', ['net/aa/Makefile'], { budget, files: { 'net/aa/Makefile': makefile('aa') } });
    warns(first);
    // 60 KB more is past what the run has left.
    const second = await check('hostapd: fix WPS', ['net/bb/Makefile'], { budget, files: { 'net/bb/Makefile': makefile('bb') } });
    assert.match(leftUnchecked(second), /its Makefiles are larger than what is left for one run to read/);
    // A name that would have passed is not read either: unchecked, never reported.
    const third = await check('hostapd: fix WPS', ['net/cc/Makefile'], { budget, files: { 'net/cc/Makefile': makefile('cc').replace('PKG_NAME:=cc', 'PKG_NAME:=hostapd') } });
    leftUnchecked(third);
  });

  // The probe's own reads are charged too, as they arrive and before
  // findPkgRoot's tests run on them, and a text past the budget is never
  // looked at: a counter, not a clock.
  test('charges every Makefile it probes, once, and stops before reading past the budget', async () => {
    const app = 'luci-app-foo';
    const luci = `LUCI_TITLE:=Foo\n# ${'x'.repeat(20 * 1024)}\ninclude ../../luci.mk\n`;
    const budget = createSubjectScopeBudget();
    const start = budget.makefileChars;
    warns(await check('hostapd: fix the web UI', [LUCI_APP(app)], { repo: 'openwrt/luci', budget, files: { [`applications/${app}/Makefile`]: luci } }));
    // The probe and the root it found read the same text: charged once.
    assert.strictEqual(budget.makefileChars, start - luci.length);

    // A probed Makefile that is no package costs what it is, all the same.
    const notPackage = `# ${'y'.repeat(30 * 1024)}\n`;
    const other = createSubjectScopeBudget();
    const silentRes = await check('hostapd: fix it', ['foo/bar/x.c'], { budget: other, files: { 'foo/bar/Makefile': notPackage } });
    exempt(silentRes);
    assert.strictEqual(other.makefileChars, start - notPackage.length);

    // Past what is left, the commit is left unchecked, never reported, and
    // the text that did not fit is not charged.
    const left = createSubjectScopeBudget();
    left.makefileChars = luci.length - 1;
    const over = await check('hostapd: fix the web UI', [LUCI_APP(app)], { repo: 'openwrt/luci', budget: left, files: { [`applications/${app}/Makefile`]: luci } });
    assert.match(leftUnchecked(over), /its Makefiles are larger than what is left for one run to read/);
    assert.strictEqual(left.makefileChars, luci.length - 1);
  });

  test('resolves PKG_NAME in a package name, within a few expansions, and nothing else', async () => {
    const files = (makefile) => ({ files: { 'net/pkg/Makefile': makefile } });
    passes(await check('foo-utils: fix the init script', ['net/pkg/Makefile'], files('PKG_NAME:=foo\n\ndefine Package/$(PKG_NAME)-utils\nendef\n')), 'foo-utils');
    passes(await check('node-left-pad: update', ['net/pkg/Makefile'], files('PKG_NPM_NAME:=left-pad\nPKG_NAME:=node-$(PKG_NPM_NAME)\n')), 'node-left-pad');
    // Any other variable makes the name templated: unchecked, no gap.
    const other = await check('hostapd: fix WPS', ['net/pkg/Makefile'], files('PKG_NAME:=foo\nVARIANT:=extra\n\ndefine Package/$(PKG_NAME)-$(VARIANT)\nendef\n'));
    assert.match(leftUnchecked(other, { gap: false }), /`net\/pkg\/Makefile` builds package names from make expansions/);
    // A PKG_NAME chained past the budget is no name to compare, so a prefix
    // that names nothing is not reported against it either.
    let chain = 'PKG_NAME:=$(V0)\n';
    for (let i = 0; i < 20; i++) chain += `V${i}:=$(V${i + 1})x\n`;
    const chained = await check('hostapd: fix WPS', ['net/pkg/Makefile'], files(chain));
    assert.match(leftUnchecked(chained, { gap: false }), /builds package names from make expansions/);
    // Control: the same chain, short enough, resolves and is compared.
    warns(await check('hostapd: fix WPS', ['net/pkg/Makefile'], files('PKG_NAME:=$(V0)\nV0:=$(V1)x\nV1:=foo\n')));
  });

  test('stops scanning paths once the run has scanned its share, and says so', async () => {
    const budget = createSubjectScopeBudget();
    // 120 files of 10 unique segments each: past the cap's reach for the
    // fuzzy pass, a package root nowhere, so each commit really scans them all.
    const deep = (c) => patchOf(...Array.from({ length: 120 }, (_, f) => Array.from({ length: 10 }, (_, s) => `c${c}f${f}s${s}`).join('/')));
    const results = [];
    for (let c = 0; c < 15; c++) {
      const tree = treeOf();
      results.push(await validateSubjectScope(commitOf('hostapd: fix WPS'), deep(c), SCOPE, 'openwrt/packages', tree.fetch, { isMissing: tree.isMissing, budget }));
    }
    assert.ok(budget.segmentsScanned <= 3000, `scanned ${budget.segmentsScanned} segments`);
    // The first two scan 1200 each and stop at the directory cap; the third
    // runs out part-way, and every one after it scans nothing.
    const unchecked = results.filter(r => r.notices.some(n => n.includes('the commits before it used up the paths one run may scan')));
    assert.strictEqual(unchecked.length, 13);
    for (const res of unchecked) {
      assert.strictEqual(res.incomplete, true);
      assert.deepStrictEqual(res.warnings, []);
    }
  });

  // The cost is pinned without a clock: segments scanned is a counter, and the
  // prefix's own length is a ratio of two arms measured alternately in a
  // worker thread, so a busy machine slows both at once. The token spellings
  // are built once per commit and each path segment costs a few lookups; the
  // shape that rebuilt them per segment, or walked every token per segment,
  // grows with the prefix and costs over 9 ms at 400 files. The worker is
  // there so a regression that blocks the thread fails instead of hanging.
  const WORKER = `
    import { validateSubjectScope, createSubjectScopeBudget } from VALIDATORS;
    import { parentPort, workerData } from 'node:worker_threads';
    const { config, patch, long, short, overCap } = workerData;
    const commit = (subject) => ({ commit: { message: subject + '\\n\\nBody.' } });
    const run = async (subject, p, reps) => {
      const budget = createSubjectScopeBudget();
      let last = null;
      const started = performance.now();
      for (let i = 0; i < reps; i++) {
        budget.segments = 1e9;
        last = await validateSubjectScope(commit(subject), p, config, 'openwrt/packages', async () => null, { isMissing: () => true, budget });
      }
      return { elapsed: performance.now() - started, scanned: budget.segmentsScanned / reps, last };
    };
    await run(short, patch, 3);
    const ratios = [];
    let longRun = null;
    for (let round = 0; round < 5; round++) {
      const a = await run(short, patch, 10);
      longRun = await run(long, patch, 10);
      ratios.push(longRun.elapsed / Math.max(a.elapsed, 0.001));
    }
    const over = await run(long, overCap, 1);
    parentPort.postMessage({
      ratio: ratios.sort((x, y) => x - y)[2],
      scanned: longRun.scanned,
      notices: longRun.last.notices,
      overScanned: over.scanned,
      over: over.last
    });
  `;

  test('costs the same for a long chained prefix as for a short one, and nothing over the cap', async () => {
    const files = Array.from({ length: 120 }, (_, f) => Array.from({ length: 10 }, (_, s) => `dir${f}-seg${s}-x`).join('/'));
    const long = 'aaaa: bbbb: cccc: dddd: eeee: ffff: gggg: hhhh: iiii: jjjj: kkkk: llll: mmmm: n';
    assert.ok(long.length <= SCOPE.max_subject_len_hard);
    const validators = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../src/validators.js')).href);
    const worker = new Worker(WORKER.replace('VALIDATORS', validators), {
      eval: true,
      workerData: {
        config: SCOPE,
        patch: patchOf(...files),
        long,
        short: 'aaaa: fix it',
        overCap: patchOf(...Array.from({ length: 2000 }, (_, i) => `net/pkg${i}/Makefile`))
      }
    });
    let measured;
    try {
      measured = await new Promise((settle, fail) => {
        const cutOff = setTimeout(() => fail(new Error('the scope check did not settle 120 deep paths within 20 s')), 20000);
        worker.on('message', (value) => { clearTimeout(cutOff); settle(value); });
        worker.on('error', (err) => { clearTimeout(cutOff); fail(err); });
      });
    } finally {
      await worker.terminate();
    }
    // Every segment is unique and none matches, so all 1200 are scanned once.
    assert.strictEqual(measured.scanned, 1200);
    // No package root to read: left unchecked for the directory cap, not reported.
    assert.match(measured.notices[0], /more than 8 directories looked up/);
    assert.ok(measured.ratio < 4, `a 12-part prefix cost ${measured.ratio.toFixed(1)}x a one-part prefix on the same files`);
    assert.strictEqual(measured.overScanned, 0);
    assert.deepStrictEqual(measured.over.successes, []);
    assert.deepStrictEqual(measured.over.warnings, []);
  });

  // A contributor's Makefile whose package names each sit on a different link
  // of a 300-variable chain: resolving them all cost 12 ms for 8 KB. Pinned as
  // a ratio against a Makefile of the same size with literal names, measured
  // alternately in a worker thread.
  const NAMES_WORKER = `
    import { validateSubjectScope, createSubjectScopeBudget } from VALIDATORS;
    import { parentPort, workerData } from 'node:worker_threads';
    const { config, chained, literal } = workerData;
    const patch = 'diff --git a/net/foo/Makefile b/net/foo/Makefile\\n--- a/net/foo/Makefile\\n+++ b/net/foo/Makefile\\n@@ -1 +1 @@\\n-o\\n+n\\n';
    const commit = { commit: { message: 'hostapd: fix WPS\\n\\nBody.' } };
    const run = async (text, reps) => {
      let last = null;
      const started = performance.now();
      for (let i = 0; i < reps; i++) {
        last = await validateSubjectScope(commit, patch, config, 'openwrt/packages', async () => text,
          { isMissing: () => false, budget: createSubjectScopeBudget() });
      }
      return { elapsed: performance.now() - started, last };
    };
    await run(literal, 3);
    await run(chained, 1);
    const ratios = [];
    let chainedRun = null;
    for (let round = 0; round < 5; round++) {
      const a = await run(literal, 5);
      chainedRun = await run(chained, 5);
      ratios.push(chainedRun.elapsed / Math.max(a.elapsed, 0.001));
    }
    parentPort.postMessage({ ratio: ratios.sort((x, y) => x - y)[2], last: chainedRun.last });
  `;

  test('costs about what literal names cost for names built from a chain of variables', async () => {
    const size = 8 * 1024;
    let chained = 'PKG_NAME:=$(V0)\n';
    for (let i = 0; i < 300; i++) chained += `V${i}:=$(V${i + 1})x\n`;
    for (let i = 0; chained.length < size; i++) chained += `define Package/$(V${i % 300})-${i}\nendef\n`;
    let literal = 'PKG_NAME:=foo\n';
    for (let i = 0; literal.length < size; i++) literal += `define Package/foo-${i}\nendef\n`;
    const validators = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../src/validators.js')).href);
    const worker = new Worker(NAMES_WORKER.replace('VALIDATORS', validators), {
      eval: true,
      workerData: { config: SCOPE, chained: chained.slice(0, size), literal: literal.slice(0, size) }
    });
    let measured;
    try {
      measured = await new Promise((settle, fail) => {
        const cutOff = setTimeout(() => fail(new Error('the scope check did not settle a chained Makefile within 20 s')), 20000);
        worker.on('message', (value) => { clearTimeout(cutOff); settle(value); });
        worker.on('error', (err) => { clearTimeout(cutOff); fail(err); });
      });
    } finally {
      await worker.terminate();
    }
    assert.ok(measured.ratio < 8, `names from a chain of variables cost ${measured.ratio.toFixed(1)}x literal ones`);
    // And it says less, never more: templated names leave the prefix unchecked.
    assert.match(leftUnchecked(measured.last, { gap: false }), /builds package names from make expansions/);
  });
});

// The scope check probes Makefiles a pull request may have written, through
// findPkgRoot. Its `include ... luci.mk` test once let `^\s*` cross lines, so
// every line start of a Makefile of blank lines rescanned all the rest: 20,000
// of them cost over a second, and the 5,000 here hundreds of times what a
// Makefile of ordinary lines does. Pinned as a ratio against one of the same
// size whose lines are not blank, measured alternately in a worker thread.
describe('findPkgRoot on a Makefile of blank lines', () => {
  const WORKER = `
    import { findPkgRoot } from VALIDATORS;
    import { parentPort, workerData } from 'node:worker_threads';
    const { blank, plain } = workerData;
    const cost = async (text, reps) => {
      const started = performance.now();
      for (let i = 0; i < reps; i++) await findPkgRoot('foo/bar/baz/x.c', async () => text, {});
      return performance.now() - started;
    };
    await cost(plain, 2);
    const ratios = [];
    for (let round = 0; round < 5; round++) {
      const base = await cost(plain, 5);
      const measured = await cost(blank, 5);
      ratios.push(measured / Math.max(base, 0.001));
    }
    parentPort.postMessage(ratios.sort((a, b) => a - b)[2]);
  `;

  test('costs what a Makefile of the same size costs', async () => {
    const lines = 2500;
    const validators = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../src/validators.js')).href);
    const worker = new Worker(WORKER.replace('VALIDATORS', validators), {
      eval: true,
      workerData: { blank: '\n'.repeat(lines * 2), plain: 'x\n'.repeat(lines) }
    });
    let ratio;
    try {
      ratio = await new Promise((settle, fail) => {
        const cutOff = setTimeout(() => fail(new Error('findPkgRoot did not settle a Makefile of blank lines within 20 s')), 20000);
        worker.on('message', (value) => { clearTimeout(cutOff); settle(value); });
        worker.on('error', (err) => { clearTimeout(cutOff); fail(err); });
      });
    } finally {
      await worker.terminate();
    }
    assert.ok(ratio < 20, `a Makefile of blank lines cost ${ratio.toFixed(1)}x one of the same size`);
  });

  test('still recognises a LuCI, U-Boot or TF-A package by its include', async () => {
    for (const include of ['include ../../luci.mk', '  include $(INCLUDE_DIR)/u-boot.mk', 'include\t$(INCLUDE_DIR)/trusted-firmware-a.mk\r', 'include ../../luci.mk  ']) {
      assert.strictEqual(await findPkgRoot('applications/luci-app-foo/htdocs/x.js', async (p) => p === 'applications/luci-app-foo/Makefile' ? `# x\n${include}\n` : null, {}),
        'applications/luci-app-foo', JSON.stringify(include));
    }
    assert.strictEqual(await findPkgRoot('applications/luci-app-foo/htdocs/x.js', async () => '# include ../../luci.mk\n', {}), null);
  });
});

describe('findPkgRoot after its candidates moved into pkgRootProbeCandidates', () => {
  test('probes the same directories, deepest first', async () => {
    const asked = [];
    await findPkgRoot('applications/luci-app-foo/htdocs/luci-static/resources/view/foo.js', async (p) => { asked.push(p); return null; }, {});
    assert.deepStrictEqual(asked, [
      'applications/luci-app-foo/htdocs/luci-static/resources/view/Makefile',
      'applications/luci-app-foo/htdocs/luci-static/resources/Makefile',
      'applications/luci-app-foo/htdocs/luci-static/Makefile',
      'applications/luci-app-foo/Makefile',
      'applications/Makefile'
    ]);
  });
});
