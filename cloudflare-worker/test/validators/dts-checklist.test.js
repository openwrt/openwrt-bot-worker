import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateDeviceTrees } from '../../src/validators.js';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CONFIG, makeCommit, readFixture } from './helpers.js';

const DTS_CONFIG = { ...CONFIG, check_dts_checklist: 'warning' };

// Device trees from openwrt/openwrt as they were added, unchanged.
const RE700X = readFixture('dts/ipq5018-re700x.dts');
const S600WP = readFixture('dts/rtl9303_hasivo_s600wp-5gt-2s-plus.dts');
const S1100WP = readFixture('dts/rtl9303_hasivo_s1100wp-8xgt-se.dts');
const YUNCORE = readFixture('dts/mt7628an_yuncore_1200f.dts');

const textLines = (text) => text.replace(/\n$/, '').split('\n');
const addition = (path, body) => {
  const lines = Array.isArray(body) ? body : textLines(body);
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`;
};
const deletion = (path, lines) =>
  `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map(l => `-${l}`).join('\n')}\n`;
// One hunk of an existing file; the lines carry their own +/-/space prefix.
const change = (path, lines) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n${lines.join('\n')}\n`;

// Runs the audit over commits (patch strings or commit-detail objects) and
// records every head read it asks for. `head` is the content served for every
// path, or a function of the path.
const audit = async (commits, { config = DTS_CONFIG, head = null, isBackportPr = false } = {}) => {
  const reads = [];
  const res = await validateDeviceTrees(
    commits.map(c => (typeof c === 'string' ? { commitPatch: c } : c)),
    config,
    async (path) => {
      reads.push(path);
      return typeof head === 'function' ? head(path) : head;
    },
    isBackportPr
  );
  return { res, reads };
};

const SPDX = '// SPDX-License-Identifier: GPL-2.0-or-later OR MIT';
// A new device tree with one gpio-leds node; `led` is the body of its LED.
const board = (led, { header = SPDX } = {}) => [
  ...(header === null ? [] : [header]),
  '',
  '#include "mt7621.dtsi"',
  '#include <dt-bindings/leds/common.h>',
  '',
  '/ {',
  '\tcompatible = "vendor,board", "mediatek,mt7621-soc";',
  '\tmodel = "Vendor Board";',
  '',
  '\tleds {',
  '\t\tcompatible = "gpio-leds";',
  '',
  '\t\tled_power: power {',
  ...led.map(l => `\t\t\t${l}`),
  '\t\t};',
  '\t};',
  '};'
];
const MODERN_LED = ['color = <LED_COLOR_ID_GREEN>;', 'function = LED_FUNCTION_POWER;', 'gpios = <&gpio 1 GPIO_ACTIVE_LOW>;'];
const DTS = 'target/linux/ramips/dts/mt7621_vendor_board.dts';

const SPDX_FINDING = "has no 'SPDX-License-Identifier' comment in its file header";
const DEFAULT_STATE_FINDING = `sets 'default-state = "off"'`;
const LABEL_FINDING = `with the deprecated 'label = "<colour>:<function>"' form`;

const kinds = (list) => list.map(f => (f.includes(SPDX_FINDING) ? 'spdx' : f.includes(DEFAULT_STATE_FINDING) ? 'default-state' : f.includes(LABEL_FINDING) ? 'label' : f));

describe('validateDeviceTrees: the three items', () => {
  test('passes a modern device tree with one success line; default-state "on" and "keep" never fire', async () => {
    for (const state of ['on', 'keep']) {
      const { res, reads } = await audit([addition(DTS, board([...MODERN_LED, `default-state = "${state}";`]))]);
      assert.deepStrictEqual(res.warnings, [], state);
      assert.deepStrictEqual(res.errors, []);
      assert.deepStrictEqual(res.notices, []);
      assert.deepStrictEqual(res.successes, [`✅ New device tree '${DTS}' carries an SPDX header and uses no deprecated LED pattern`]);
      assert.strictEqual(res.incomplete, false);
      assert.deepStrictEqual(reads, []);
    }
  });

  test('the real ipq5018-re700x.dts: one finding naming its four gpio-leds LEDs, no SPDX finding', async () => {
    const path = 'target/linux/qualcommax/dts/ipq5018-re700x.dts';
    const { res, reads } = await audit([addition(path, RE700X)]);
    assert.deepStrictEqual(kinds(res.warnings), ['default-state']);
    const [finding] = res.warnings;
    assert.ok(finding.startsWith(`- New device tree '${path}' sets 'default-state = "off"' on 4 LED nodes inside a 'compatible = "gpio-leds"' block ('wps-red', 'wps-blue', 'wlan-2g', and 1 more).`), finding);
    assert.ok(finding.includes('0d23fd2'), finding);
    assert.deepStrictEqual(res.successes, []);
    assert.deepStrictEqual(reads, [], 'a single commit carries the whole file, so nothing is read');
  });

  // The pin for node-scoped ownership: this file has a gpio-leds node and,
  // elsewhere, four register-bit-led nodes with default-state "off". A
  // file-level "has gpio-leds and has default-state off" heuristic fires.
  test('the real rtl9303_hasivo_s600wp-5gt-2s-plus.dts: no finding for its register-bit-led nodes', async () => {
    assert.ok(S600WP.includes('compatible = "gpio-leds"') && S600WP.includes('compatible = "register-bit-led"'));
    assert.strictEqual(S600WP.split('default-state = "off"').length - 1, 4);
    const path = 'target/linux/realtek/dts/rtl9303_hasivo_s600wp-5gt-2s-plus.dts';
    const { res } = await audit([addition(path, S600WP)]);
    assert.deepStrictEqual(res.warnings, []);
    assert.deepStrictEqual(res.successes, [`✅ New device tree '${path}' carries an SPDX header and uses no deprecated LED pattern`]);
  });

  test('the real rtl9303_hasivo_s1100wp-8xgt-se.dts: no finding for eight register-bit-led nodes', async () => {
    assert.strictEqual(S1100WP.split('default-state = "off"').length - 1, 8);
    const { res } = await audit([addition('target/linux/realtek/dts/rtl9303_hasivo_s1100wp-8xgt-se.dts', S1100WP)]);
    assert.deepStrictEqual(res.warnings, []);
    assert.strictEqual(res.successes.length, 1);
  });

  test('the real mt7628an_yuncore_1200f.dts: the SPDX finding and nothing else', async () => {
    const path = 'target/linux/ramips/dts/mt7628an_yuncore_1200f.dts';
    const { res } = await audit([addition(path, YUNCORE)]);
    assert.deepStrictEqual(kinds(res.warnings), ['spdx']);
    assert.ok(res.warnings[0].startsWith(`- New device tree '${path}' has no 'SPDX-License-Identifier' comment in its file header.`), res.warnings[0]);
    assert.ok(res.warnings[0].includes("'// SPDX-License-Identifier: GPL-2.0-or-later OR MIT'"));
    assert.ok(!/\blicense\b/.test(res.warnings[0].split(' — ')[0].replace(/SPDX-License-Identifier/g, '')), 'the bare word belongs to check_spdx_license');
  });

  test('an override by label has no owner in the diff: no finding, no notice', async () => {
    const { res } = await audit([addition(DTS, [SPDX, '#include "mt7621_vendor_common.dtsi"', '', '&leds {', '\tled-0 {', '\t\tdefault-state = "off";', '\t};', '};'])]);
    assert.deepStrictEqual(res.warnings, []);
    assert.deepStrictEqual(res.notices, []);
    assert.strictEqual(res.successes.length, 1);
  });

  // `/ {` and `&leds {` open nodes too, and a gpio-leds node closed before
  // them owns nothing after it. A register-bit-led node whose compatible
  // follows its default-state is owned by that compatible.
  test('keeps the node stack balanced across the root node and label overrides', async () => {
    const lines = [
      SPDX,
      '/ {',
      '\tleds {',
      '\t\tcompatible = "gpio-leds";',
      '\t\tlan { color = <LED_COLOR_ID_GREEN>; };',
      '\t};',
      '',
      '\tmfd {',
      '\t\tcompatible = "vendor,mfd";',
      '\t\tled@0 {',
      '\t\t\tdefault-state = "off";',
      '\t\t\tcompatible = "register-bit-led";',
      '\t\t};',
      '\t};',
      '};',
      '',
      '&gpio_leds {',
      '\tled-1 {',
      '\t\tdefault-state = "off";',
      '\t};',
      '};'
    ];
    const { res } = await audit([addition(DTS, lines)]);
    assert.deepStrictEqual(res.warnings, []);
    // GUARD: the same LED inside the gpio-leds node is reported.
    const inside = lines.slice(0, 5).concat(['\t\tled-1 {', '\t\t\tdefault-state = "off";', '\t\t};'], lines.slice(5));
    assert.deepStrictEqual(kinds((await audit([addition(DTS, inside)])).res.warnings), ['default-state']);
  });

  // dtc takes a node's properties in any order, so the owner is settled when
  // the node closes, not at the default-state line.
  test('a node\'s own compatible decides, even when written after default-state', async () => {
    const lines = [SPDX, '/ {', '\tleds {', '\t\tcompatible = "gpio-leds";',
      '\t\tled@0 {', '\t\t\tdefault-state = "off";', '\t\t\tcompatible = "register-bit-led";', '\t\t};',
      '\t\tled@1 {', '\t\t\tdefault-state = "off";', '\t\t};',
      '\t};', '};'];
    const { res } = await audit([addition(DTS, lines)]);
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes("on 1 LED node inside a 'compatible = \"gpio-leds\"' block ('led@1')"), res.warnings[0]);
  });

  test('ignores a default-state "off" inside a block comment or behind //', async () => {
    const block = await audit([addition(DTS, board([...MODERN_LED, '/*', ' * default-state = "off";', 'default-state = "off";', '*/']))]);
    assert.deepStrictEqual(block.res.warnings, []);
    const line = await audit([addition(DTS, board([...MODERN_LED, '// default-state = "off";']))]);
    assert.deepStrictEqual(line.res.warnings, []);
    // GUARD: the same property outside the comment is reported.
    const live = await audit([addition(DTS, board([...MODERN_LED, 'default-state = "off";']))]);
    assert.deepStrictEqual(kinds(live.res.warnings), ['default-state']);
  });

  test('reports a colour-first LED label and leaves partition, port and function-first labels alone', async () => {
    const lines = [
      SPDX, '/ {',
      '\tleds {', '\t\tcompatible = "gpio-leds";',
      '\t\tlan { label = "green:lan"; };',
      '\t\twan {', '\t\t\tlabel = "green:wan";', '\t\t};',
      '\t\tsys {', '\t\t\tlabel = "system:red";', '\t\t};',
      '\t};',
      '\tpartitions {', '\t\tpartition@0 {', '\t\t\tlabel = "0:APPSBL";', '\t\t};',
      '\t\tpartition@1 {', '\t\t\tlabel = "firmware";', '\t\t};', '\t};',
      '\tport@1 {', '\t\tlabel = "lan1";', '\t};',
      '\tlabel-mac-device = &wifi;',
      '};'
    ];
    const { res } = await audit([addition(DTS, lines)]);
    assert.deepStrictEqual(kinds(res.warnings), ['label']);
    // The one-line node is not read; the property on its own line is.
    assert.ok(res.warnings[0].includes(`names 1 LED with the deprecated 'label = "<colour>:<function>"' form ('green:wan').`), res.warnings[0]);
    assert.ok(res.warnings[0].includes(`function = "<func>";`), 'the fallback for names with no LED_FUNCTION_* constant');
    assert.ok(!/0:APPSBL|firmware|lan1|system:red/.test(res.warnings[0]));
  });

  test('lists three excerpts and counts the rest', async () => {
    const leds = ['white:signal1', 'white:signal2', 'white:signal3', 'red:rssi', 'blue:rssi'];
    const lines = [SPDX, '/ {', '\tleds {', '\t\tcompatible = "gpio-leds";',
      ...leds.flatMap((l, i) => [`\t\tled-${i} {`, `\t\t\tlabel = "${l}";`, '\t\t};']), '\t};', '};'];
    const { res } = await audit([addition(DTS, lines)]);
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes("names 5 LEDs with the deprecated 'label = \"<colour>:<function>\"' form ('white:signal1', 'white:signal2', 'white:signal3', and 2 more)."), res.warnings[0]);
  });

  test('reports all three items for one file, one finding each', async () => {
    const { res } = await audit([addition(DTS, board(['label = "green:power";', 'default-state = "off";'], { header: null }))]);
    assert.deepStrictEqual(kinds(res.warnings), ['spdx', 'default-state', 'label']);
    assert.ok(res.warnings[1].includes("on 1 LED node inside a 'compatible = \"gpio-leds\"' block ('power')"), res.warnings[1]);
  });
});

describe('validateDeviceTrees: what is in scope', () => {
  test('confirms a folded finding at the head: fixed there is no finding, unread is a gap', async () => {
    const first = addition(DTS, board([...MODERN_LED, 'default-state = "off";']));
    const fix = change(DTS, ['\t\t\tgpios = <&gpio 1 GPIO_ACTIVE_LOW>;', '-\t\t\tdefault-state = "off";', '\t\t};']);
    const fixedHead = `${board(MODERN_LED).join('\n')}\n`;

    const fixed = await audit([first, fix], { head: fixedHead });
    assert.deepStrictEqual(fixed.reads, [DTS]);
    assert.deepStrictEqual(fixed.res.warnings, []);
    assert.deepStrictEqual(fixed.res.successes, [`✅ New device tree '${DTS}' carries an SPDX header and uses no deprecated LED pattern`]);
    assert.strictEqual(fixed.res.incomplete, false);

    const unread = await audit([first, fix], { head: null });
    assert.deepStrictEqual(unread.res.warnings, []);
    assert.deepStrictEqual(unread.res.successes, []);
    assert.deepStrictEqual(unread.res.notices, [`Device tree '${DTS}' could not be read at the head commit, so the DTS checklist items it appeared to miss were not confirmed and are not reported.`]);
    assert.strictEqual(unread.res.incomplete, true);

    // A read that throws is unread too, not a crash of the audit.
    const thrown = await audit([first, fix], { head: () => { throw new Error('boom'); } });
    assert.strictEqual(thrown.res.incomplete, true);
    assert.deepStrictEqual(thrown.res.warnings, []);

    // Still there at the head: reported, with what the head shows.
    const kept = await audit([first, fix], { head: `${board([...MODERN_LED, 'default-state = "off";']).join('\n')}\n` });
    assert.deepStrictEqual(kinds(kept.res.warnings), ['default-state']);
  });

  test('reads nothing for a file only one commit wrote, nor for a single net patch', async () => {
    const other = addition('package/utils/foo/files/foo.sh', ['#!/bin/sh']);
    const withSibling = await audit([addition(DTS, board(MODERN_LED, { header: null })), other], { head: null });
    assert.deepStrictEqual(withSibling.reads, []);
    assert.deepStrictEqual(kinds(withSibling.res.warnings), ['spdx']);

    const prWide = await audit([`${other}${addition(DTS, board(MODERN_LED, { header: null }))}`], { head: null });
    assert.deepStrictEqual(prWide.reads, []);
    assert.deepStrictEqual(kinds(prWide.res.warnings), ['spdx']);
  });

  test('confirms at the head when a commit of the series has no patch to read', async () => {
    const { res, reads } = await audit([addition(DTS, board(MODERN_LED, { header: null })), { commitPatch: null }], { head: null });
    assert.deepStrictEqual(reads, [DTS]);
    assert.deepStrictEqual(res.warnings, []);
    assert.strictEqual(res.incomplete, true);
  });

  test('confirms each commit of a PR-wide mbox series the same way', async () => {
    const envelope = (sha, subject) => `From ${sha.repeat(40)} Mon Sep 17 00:00:00 2001\nFrom: Dev <dev@example.com>\nDate: Wed, 14 Oct 2026 10:00:00 +0200\nSubject: [PATCH] ${subject}\n\n---\n`;
    const series = envelope('a', 'ramips: add support for Vendor Board') + addition(DTS, board([...MODERN_LED, 'default-state = "off";'])) + '\n' +
      envelope('b', 'ramips: drop default-state') + change(DTS, ['-\t\t\tdefault-state = "off";']);
    const { res, reads } = await audit([series], { head: `${board(MODERN_LED).join('\n')}\n` });
    assert.deepStrictEqual(reads, [DTS]);
    assert.deepStrictEqual(res.warnings, []);
  });

  test('reports an unsplittable PR-wide series as a gap', async () => {
    const broken = `From ${'a'.repeat(40)} Mon Sep 17 00:00:00 2001\nFrom: Dev <dev@example.com>\nSubject: [PATCH] one\n\n---\n${addition(DTS, board(MODERN_LED, { header: null }))}\nFrom ${'b'.repeat(40)} Mon Sep 17 00:00:00 2001\nFrom: Dev <dev@example.com>\nSubject: [PATCH] two\n\nno diff here\n`;
    const { res } = await audit([broken]);
    assert.deepStrictEqual(res.notices, ['Could not safely verify commit boundaries in PR-wide patch series']);
    assert.deepStrictEqual(res.warnings, []);
    assert.strictEqual(res.incomplete, true);
  });

  test('leaves a revert alone unless allow_revert is off', async () => {
    const legacy = addition(DTS, board(['label = "green:power";', ...MODERN_LED.slice(2)]));
    const revert = {
      commitPatch: legacy,
      fullCommit: makeCommit('Revert "ramips: drop Vendor Board"\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.\n\nSigned-off-by: Dev <dev@example.com>')
    };
    assert.deepStrictEqual((await audit([revert])).res.warnings, []);
    assert.deepStrictEqual((await audit([revert])).res.successes, []);
    const strict = await audit([revert], { config: { ...DTS_CONFIG, allow_revert: false } });
    assert.deepStrictEqual(kinds(strict.res.warnings), ['label']);
  });

  test('leaves a verbatim backport commit alone, but not a deviating one beside it', async () => {
    const mr2000 = 'target/linux/qualcommax/dts/ipq5018-mr2000.dts';
    const other = 'target/linux/qualcommax/dts/ipq5018-other.dts';
    const verbatim = { commitPatch: addition(mr2000, board(MODERN_LED, { header: null })), isVerbatim: true, fullCommit: makeCommit('qualcommax: add support for Linksys MR2000') };
    const deviating = { commitPatch: addition(other, board(MODERN_LED, { header: null })), isVerbatim: false, fullCommit: makeCommit('qualcommax: add support for Other') };

    const res = (await audit([verbatim], { isBackportPr: true })).res;
    assert.deepStrictEqual(res.warnings, []);
    assert.deepStrictEqual(res.successes, []);

    const mixed = (await audit([verbatim, deviating], { isBackportPr: true })).res;
    assert.strictEqual(mixed.warnings.length, 1);
    assert.ok(mixed.warnings[0].includes(`'${other}' has no 'SPDX-License-Identifier'`), mixed.warnings[0]);

    // A skipped commit that changes the file afterwards still counts as a
    // second writer, so the finding is confirmed at the head.
    const fixup = { commitPatch: change(other, [`+${SPDX}`]), isVerbatim: true, fullCommit: makeCommit('qualcommax: add SPDX header') };
    const fixed = await audit([deviating, fixup], { isBackportPr: true, head: `${board(MODERN_LED).join('\n')}\n` });
    assert.deepStrictEqual(fixed.reads, [other]);
    assert.deepStrictEqual(fixed.res.warnings, []);
  });

  test('a rename with edits is not an addition', async () => {
    const rename = `diff --git a/target/linux/ramips/dts/old.dts b/${DTS}\nsimilarity index 90%\nrename from target/linux/ramips/dts/old.dts\nrename to ${DTS}\nindex 1111111..2222222 100644\n--- a/target/linux/ramips/dts/old.dts\n+++ b/${DTS}\n@@ -1,3 +1,3 @@\n-\tmodel = "Old";\n+\tmodel = "New";\n+\t\tlabel = "green:lan";\n`;
    const { res } = await audit([rename]);
    assert.deepStrictEqual(res.warnings, []);
    assert.deepStrictEqual(res.successes, []);
    // Said in the check-run body, so a skipped file does not read as passed.
    assert.deepStrictEqual(res.notes, [`The DTS checklist runs only on device trees a pull request adds, so the changes to '${DTS}' were not checked against it.`]);
    assert.strictEqual(res.incomplete, false);
  });

  test('a modified device tree is named as unchecked, without making the audit incomplete', async () => {
    const dtsi = 'target/linux/ramips/dts/mt7621_vendor_common.dtsi';
    const { res } = await audit([change(dtsi, ['+\t\tlabel = "green:lan";', '+\t\tdefault-state = "off";'])]);
    assert.deepStrictEqual(res.warnings, []);
    assert.deepStrictEqual(res.notices, []);
    assert.deepStrictEqual(res.notes, [`The DTS checklist runs only on device trees a pull request adds, so the changes to '${dtsi}' were not checked against it.`]);
    assert.strictEqual(res.incomplete, false);
  });

  test('an added-then-deleted and a deleted-then-re-added device tree are not reported', async () => {
    const lines = board(MODERN_LED, { header: null });
    const gone = await audit([addition(DTS, lines), deletion(DTS, lines)]);
    assert.deepStrictEqual(gone.res.warnings, []);
    assert.deepStrictEqual(gone.res.successes, []);
    assert.deepStrictEqual(gone.res.notes, []);
    const replaced = await audit([deletion(DTS, lines), addition(DTS, lines)]);
    assert.deepStrictEqual(replaced.res.warnings, []);
    assert.deepStrictEqual(replaced.res.successes, []);
    assert.deepStrictEqual(replaced.res.notices, []);
    assert.deepStrictEqual(replaced.reads, []);
    assert.strictEqual(replaced.res.incomplete, false);
    // GUARD: the addition alone is reported.
    assert.deepStrictEqual(kinds((await audit([addition(DTS, lines)])).res.warnings), ['spdx']);
  });

  // A header pair with no hunk carries none of the file, so the absence of
  // an SPDX line in it says nothing.
  test('an added device tree whose diff carries no lines is not judged', async () => {
    const bare = `diff --git a/${DTS} b/${DTS}\nnew file mode 100644\n--- /dev/null\n+++ b/${DTS}\n`;
    const { res, reads } = await audit([bare]);
    assert.deepStrictEqual(res, { errors: [], warnings: [], notices: [], successes: [], notes: [], incomplete: false });
    assert.deepStrictEqual(reads, []);
    // GUARD: one line of it is enough to judge.
    const oneLine = await audit([`${bare}@@ -0,0 +1,1 @@\n+/dts-v1/;\n`]);
    assert.deepStrictEqual(kinds(oneLine.res.warnings), ['spdx']);
  });

  test('a device tree inside a kernel patch is the patch, not a device tree', async () => {
    const patchPath = 'target/linux/generic/pending-6.12/900-arm64-dts-add-board.patch';
    const kernelPatch = ['From: Dev <dev@example.com>', 'Subject: arm64: dts: add board', '', '--- /dev/null', '+++ b/arch/arm64/boot/dts/vendor/board.dts', '@@ -0,0 +1,3 @@', '+/ {', '+\tlabel = "green:lan";', '+};'];
    const { res } = await audit([addition(patchPath, kernelPatch)]);
    assert.deepStrictEqual(res, { errors: [], warnings: [], notices: [], successes: [], notes: [], incomplete: false });
    // GUARD: the same device tree added as a file of its own is reported.
    const own = await audit([addition('target/linux/mediatek/dts/board.dts', kernelPatch.slice(6).map(l => l.slice(1)))]);
    assert.deepStrictEqual(kinds(own.res.warnings), ['spdx', 'label']);
  });

  test('covers .dtso overlays and .dtsi includes', async () => {
    for (const path of ['target/linux/mediatek/dts/mt7988a-board-overlay.dtso', 'target/linux/mediatek/dts/mt7988a-board.dtsi']) {
      const { res } = await audit([addition(path, ['/dts-v1/;', '/plugin/;', '', '&{/} {', '\tmodel = "x";', '};'])]);
      assert.deepStrictEqual(kinds(res.warnings), ['spdx'], path);
    }
  });

  test('accepts any SPDX identifier, the kernel\'s spelling included', async () => {
    const path = 'target/linux/mvebu/files/arch/arm/boot/dts/marvell/armada-385-board.dts';
    const { res } = await audit([addition(path, board(MODERN_LED, { header: '// SPDX-License-Identifier: (GPL-2.0 OR MIT)' }))]);
    assert.deepStrictEqual(res.warnings, []);
    const block = await audit([addition(path, board(MODERN_LED, { header: '/* SPDX-License-Identifier: GPL-2.0-only */' }))]);
    assert.deepStrictEqual(block.res.warnings, []);
    // GUARD: a license named in words is not an identifier.
    const words = await audit([addition(path, board(MODERN_LED, { header: '// Licensed under the GPL version 2 or later' }))]);
    assert.deepStrictEqual(kinds(words.res.warnings), ['spdx']);
  });

  test('reads CRLF line endings as it reads LF', async () => {
    const lines = board(['label = "green:power";', 'default-state = "off";'], { header: null });
    const lf = await audit([addition(DTS, lines)]);
    const crlf = await audit([addition(DTS, lines.map(l => `${l}\r`))]);
    assert.deepStrictEqual(kinds(lf.res.warnings), ['spdx', 'default-state', 'label']);
    assert.deepStrictEqual(crlf.res.warnings, lf.res.warnings);
  });

  test('a feed pull request with no device tree gets nothing at all', async () => {
    const patch = addition('net/foo/Makefile', ['include $(TOPDIR)/rules.mk', 'PKG_NAME:=foo']) +
      addition('net/foo/files/etc/config/foo', ['config foo', "\toption enabled '1'"]);
    const { res, reads } = await audit([patch]);
    assert.deepStrictEqual(res, { errors: [], warnings: [], notices: [], successes: [], notes: [], incomplete: false });
    assert.deepStrictEqual(reads, []);
    // GUARD: one device tree in the same pull request is seen.
    const withDts = await audit([patch + addition(DTS, board(MODERN_LED))]);
    assert.strictEqual(withDts.res.successes.length, 1);
  });
});

describe('validateDeviceTrees: bounds', () => {
  // The guard skips a line before trim() copies it. A property padded past
  // the limit is therefore not read at all; just under it, it is.
  test('skips an over-long line, and still reads the rest of the file', async () => {
    const padded = (n) => `default-state = "off";${' '.repeat(n)}`;
    const under = await audit([addition(DTS, board([...MODERN_LED, padded(512 - 'default-state = "off";'.length - 3)]))]);
    assert.deepStrictEqual(kinds(under.res.warnings), ['default-state']);
    const over = await audit([addition(DTS, board([...MODERN_LED, padded(600)]))]);
    assert.deepStrictEqual(over.res.warnings, []);

    const huge = await audit([addition(DTS, board([`compatible = "${'x'.repeat(2 * 1024 * 1024)}";`, 'label = "green:power";']))]);
    assert.deepStrictEqual(kinds(huge.res.warnings), ['label']);
  });

  test('stops past 25 added device trees and says how many it did not check', async () => {
    const files = Array.from({ length: 26 }, (_, i) => `target/linux/ramips/dts/board${String(i).padStart(2, '0')}.dts`);
    const { res } = await audit([files.map(f => addition(f, board(MODERN_LED, { header: null }))).join('')]);
    assert.strictEqual(res.warnings.length, 25);
    assert.ok(!res.warnings.some(w => w.includes('board25.dts')));
    assert.deepStrictEqual(res.notices, ['Device tree checklist not run on 1 of 26 added device trees: the diff is larger than this check scans in one run.']);
    assert.strictEqual(res.incomplete, true);
  });

  test('stops past 6,000 added device-tree lines and says how many files it did not check', async () => {
    const filler = (n) => Array.from({ length: n }, (_, i) => `\t/* ${i} */`);
    const first = 'target/linux/ramips/dts/first.dts';
    const second = 'target/linux/ramips/dts/second.dts';
    const head = board(MODERN_LED, { header: null });
    const firstLines = [...head, ...filler(3000 - head.length)];
    const secondLines = [SPDX, ...filler(3000)];
    // 6,001 lines in all, one over.
    assert.strictEqual(firstLines.length + secondLines.length, 6001);
    const { res } = await audit([addition(first, firstLines) + addition(second, secondLines)]);
    assert.deepStrictEqual(kinds(res.warnings), ['spdx']);
    assert.ok(res.warnings[0].includes(first));
    assert.deepStrictEqual(res.successes, []);
    assert.deepStrictEqual(res.notices, ['Device tree checklist not run on 1 of 2 added device trees: the diff is larger than this check scans in one run.']);
    assert.strictEqual(res.incomplete, true);

    // GUARD: one line fewer and both are checked.
    const fits = await audit([addition(first, firstLines) + addition(second, secondLines.slice(0, -1))]);
    assert.deepStrictEqual(fits.res.notices, []);
    assert.deepStrictEqual(kinds(fits.res.warnings), ['spdx']);
    assert.deepStrictEqual(fits.res.successes, [`✅ New device tree '${second}' carries an SPDX header and uses no deprecated LED pattern`]);
  });

  test('confirms at most 10 files at the head and names the rest as unchecked', async () => {
    const files = Array.from({ length: 12 }, (_, i) => `target/linux/ramips/dts/board${String(i).padStart(2, '0')}.dts`);
    const commitOne = files.map(f => addition(f, board(MODERN_LED, { header: null }))).join('');
    const commitTwo = files.map(f => change(f, ['-\tmodel = "Vendor Board";', '+\tmodel = "Vendor Board v2";'])).join('');
    const { res, reads } = await audit([commitOne, commitTwo], { head: `${board(MODERN_LED, { header: null }).join('\n')}\n` });
    assert.strictEqual(reads.length, 10);
    assert.deepStrictEqual(kinds(res.warnings), Array(10).fill('spdx'));
    assert.deepStrictEqual(res.notices, [`Device tree checklist findings in 2 added device trees ('${files[10]}', '${files[11]}') were not confirmed at the head commit, which this check reads for at most 10 files, so they are not reported.`]);
    assert.strictEqual(res.incomplete, true);
  });

  // The scan costs by the character: 6,000 lines of 512 characters are 3 MB.
  test('stops past 256 KiB of added device-tree text, well under 6,000 lines', async () => {
    const wide = (n) => Array.from({ length: n }, (_, i) => `\t/* ${String(i).padStart(4, '0')} ${'x'.repeat(430)} */`);
    const first = 'target/linux/ramips/dts/first.dts';
    const second = 'target/linux/ramips/dts/second.dts';
    const { res } = await audit([addition(first, [SPDX, ...wide(299)]) + addition(second, [SPDX, ...wide(300)])]);
    assert.deepStrictEqual(res.successes, [`✅ New device tree '${first}' carries an SPDX header and uses no deprecated LED pattern`]);
    assert.deepStrictEqual(res.notices, ['Device tree checklist not run on 1 of 2 added device trees: the diff is larger than this check scans in one run.']);
    assert.strictEqual(res.incomplete, true);
  });

  const unconfirmedNotice = `Device tree '${DTS}' is too large at the head commit for what is left of this check's scan limit, so the DTS checklist items it appeared to miss were not confirmed and are not reported.`;

  test('does not split a head that a later commit grew past the line cap', async () => {
    const first = addition(DTS, board(MODERN_LED, { header: null }));
    const grow = change(DTS, ['+\t/* grown */']);
    const { res } = await audit([first, grow], { head: `${'\t/* x */\n'.repeat(6001)}` });
    assert.deepStrictEqual(res.warnings, []);
    assert.deepStrictEqual(res.notices, [unconfirmedNotice]);
    assert.strictEqual(res.incomplete, true);
  });

  // One budget for the diff and the head reads together, so confirming
  // cannot double what the check scans.
  test('confirms at the head only within what the diff scan left of the caps', async () => {
    const filler = (n) => Array.from({ length: n }, (_, i) => `\t/* ${i} */`);
    const lines = [...board(MODERN_LED, { header: null }), ...filler(5000)];
    const grow = change(DTS, ['+\t/* grown */']);
    const headOf = (n) => `${[...board(MODERN_LED, { header: null }), ...filler(n)].join('\n')}\n`;
    // The 5,019 lines of the two commits leave 981 for the head.
    const over = await audit([addition(DTS, lines), grow], { head: headOf(1000) });
    assert.deepStrictEqual(over.res.notices, [unconfirmedNotice]);
    assert.deepStrictEqual(over.res.warnings, []);
    const within = await audit([addition(DTS, lines), grow], { head: headOf(900) });
    assert.deepStrictEqual(within.res.notices, []);
    assert.deepStrictEqual(kinds(within.res.warnings), ['spdx']);
  });
});

describe('validateDeviceTrees: configuration', () => {
  const patch = addition(DTS, board(MODERN_LED, { header: null }));
  test('false and "disabled" turn it off, "error" and "warning" grade it', async () => {
    for (const level of [false, 'disabled']) {
      const { res } = await audit([patch], { config: { ...DTS_CONFIG, check_dts_checklist: level } });
      assert.deepStrictEqual(res, { errors: [], warnings: [], notices: [], successes: [], notes: [], incomplete: false }, String(level));
    }
    const error = (await audit([patch], { config: { ...DTS_CONFIG, check_dts_checklist: 'error' } })).res;
    assert.deepStrictEqual(kinds(error.errors), ['spdx']);
    assert.deepStrictEqual(error.warnings, []);
    const warning = (await audit([patch], { config: { ...DTS_CONFIG, check_dts_checklist: 'warning' } })).res;
    assert.deepStrictEqual(kinds(warning.warnings), ['spdx']);
    assert.deepStrictEqual(warning.errors, []);
  });
});

// A contributor decides how deep nodes nest. Looking a node's owner up by
// walking the open nodes costs the depth per node, so 3,000 nested nodes
// each with a default-state was 4.5 million steps; each node now takes its
// owner from its parent when it opens.
//
// Pinned as a ratio against as many lines of sibling nodes, measured
// alternately and in a worker thread so a regression that hangs fails with a
// message (see 'subject prefix grammar cost' in formalities.test.js). A
// preemption can multiply a round of a few milliseconds, so the ratio
// compares the best of 25 short rounds of each arm: load only ever adds time.
// Measured with twelve CPU-bound processes and six copies of this suite
// running beside it: 1.3-1.6x fixed, 16-27x with the walk. The patch text is
// reused, so the shared parsers answer from their cache and only this check
// is measured.
describe('device tree nesting cost', () => {
  const WORKER = `
    import { validateDeviceTrees } from VALIDATORS;
    import { parentPort, workerData } from 'node:worker_threads';
    const { deep, flat } = workerData;
    const config = { check_dts_checklist: 'warning' };
    const cost = async (patch, reps) => {
      const commits = [{ commitPatch: patch }];
      const started = performance.now();
      let last = null;
      for (let i = 0; i < reps; i++) last = await validateDeviceTrees(commits, config, async () => null, false);
      return { elapsed: performance.now() - started, warnings: last.warnings, notices: last.notices };
    };
    await cost(flat, 2);
    await cost(deep, 2);
    let flatBest = Infinity;
    let deepBest = Infinity;
    let result = null;
    for (let round = 0; round < 25; round++) {
      flatBest = Math.min(flatBest, (await cost(flat, 4)).elapsed);
      result = await cost(deep, 4);
      deepBest = Math.min(deepBest, result.elapsed);
    }
    parentPort.postMessage({ ratio: deepBest / Math.max(flatBest, 0.001), warnings: result.warnings, notices: result.notices });
  `;

  test('settles a node 3,000 levels deep as fast as one of 3,000 siblings', async () => {
    const depth = 2998;
    const deepLines = [SPDX, '\tleds {', '\t\tcompatible = "gpio-leds";'];
    const flatLines = [...deepLines];
    for (let i = 0; i < depth; i++) {
      deepLines.push(`\t\tled-${i} {`, '\t\t\tdefault-state = "off";');
      flatLines.push(`\t\tled-${i} {`, '\t\t\tdefault-state = "off";', '\t\t};');
    }
    // As many lines in each arm, just under the line cap.
    assert.strictEqual(deepLines.length, 5999);
    const deep = addition(DTS, deepLines);
    const flat = addition(DTS, flatLines.slice(0, deepLines.length));

    const validators = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../src/validators.js')).href);
    const worker = new Worker(WORKER.replace('VALIDATORS', validators), { eval: true, workerData: { deep, flat } });
    let measured;
    try {
      measured = await new Promise((settle, fail) => {
        const cutOff = setTimeout(() => fail(new Error('3,000 nested device-tree nodes did not settle within 20 s')), 20000);
        worker.on('message', (value) => { clearTimeout(cutOff); settle(value); });
        worker.on('error', (err) => { clearTimeout(cutOff); fail(err); });
      });
    } finally {
      await worker.terminate();
    }

    // Every nested LED really is judged: one finding naming all of them.
    assert.deepStrictEqual(measured.notices, []);
    assert.strictEqual(measured.warnings.length, 1);
    assert.ok(measured.warnings[0].includes(`on ${depth} LED nodes`), measured.warnings[0]);
    assert.ok(measured.ratio < 5, `3,000 nested nodes cost ${measured.ratio.toFixed(1)}x as many siblings`);
  });
});
