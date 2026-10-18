import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  validatePkgSourcePins, validatePkgReleaseBumps, validatePkgHashes,
  resolveMakefileVar, sourcePinVersion, SOURCE_PIN_HEAD_CHARS
} from '../../src/validators.js';
import { CONFIG, makeCommit } from './helpers.js';

const PIN_CONFIG = { ...CONFIG, check_pkg_source_pin: 'warning' };
// The clock every test runs at, so no result depends on the day it runs.
const NOW = Date.UTC(2026, 9, 18);
const DAY = 86400000;

const PHANTAP = 'net/phantap/Makefile';
const FULL = 'e8d10eaf0d8a1d2f6c7ab3e2b4d5f6a7b8c9d0e1';
const FULL_B = '221ce7e7ff1bd1a0c9995fa9d32f58e865f7207f';

// One commit's diff of one Makefile; the lines carry their own +/- prefix.
const change = (path, lines) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n${lines.join('\n')}\n`;
const addition = (path, lines) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`;
const deletion = (path, lines) =>
  `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map(l => `-${l}`).join('\n')}\n`;

// Runs the audit over commits (patch strings or { commitPatch, fullCommit })
// and records every head read it asks for. `head` is the content served for
// every path, or a function of the path.
const audit = async (commits, { config = PIN_CONFIG, head = null, now = NOW } = {}) => {
  const reads = [];
  const res = await validatePkgSourcePins(
    commits.map(c => (typeof c === 'string' ? { commitPatch: c } : c)),
    config,
    async (path) => {
      reads.push(path);
      return typeof head === 'function' ? head(path) : head;
    },
    () => now
  );
  return { res, reads };
};

const lines = (...l) => `${l.join('\n')}\n`;

describe('validatePkgSourcePins: PKG_SOURCE_DATE', () => {
  test('reports a dotted date once, quoting the value, the path and the version the build makes of it', async () => {
    const head = lines('PKG_NAME:=phantap', 'PKG_SOURCE_PROTO:=git', 'PKG_SOURCE_DATE:=2025.10.06', `PKG_SOURCE_VERSION:=${FULL}`, 'PKG_RELEASE:=1');
    const { res } = await audit([change(PHANTAP, [
      '-PKG_SOURCE_DATE:=2025-01-01', '+PKG_SOURCE_DATE:=2025.10.06',
      `-PKG_SOURCE_VERSION:=${FULL_B}`, `+PKG_SOURCE_VERSION:=${FULL}`
    ])], { head });

    assert.strictEqual(res.findings.length, 1, JSON.stringify(res.findings));
    const [finding] = res.findings;
    assert.match(finding, /^- PKG_SOURCE_DATE in 'net\/phantap\/Makefile' is '2025\.10\.06', which is not the YYYY-MM-DD form/);
    assert.ok(finding.includes("Write it as '2025-10-06'"), finding);
    assert.ok(finding.includes("the package version '2025.10.06~e8d10eaf'"), finding);
    assert.ok(!/PKG_RELEASE|HASH/.test(finding), finding);
    assert.deepStrictEqual(res.errors, []);
    assert.deepStrictEqual(res.successes, []);
    assert.strictEqual(res.incomplete, undefined);
  });

  // include/download.mk:13 and rules.mk:86 (version_abbrev): the wiki's own
  // `2018-10-06-221ce7e7` is not what the build produces.
  test('builds the version string the way download.mk does', () => {
    assert.strictEqual(sourcePinVersion('2018-10-06', FULL_B), '2018.10.06~221ce7e7');
    assert.strictEqual(sourcePinVersion(null, FULL_B), '0~221ce7e7');
  });

  test('leaves the version out where PKG_VERSION wins, or the head cannot say', async () => {
    const patch = change('net/tac_plus/Makefile', ['+PKG_SOURCE_DATE:=2019.02.11', `+PKG_SOURCE_VERSION:=${FULL}`]);
    const withVersion = await audit([patch], { head: lines('PKG_VERSION:=4.0.4.28', 'PKG_SOURCE_DATE:=2019.02.11', `PKG_SOURCE_VERSION:=${FULL}`) });
    assert.strictEqual(withVersion.res.findings.length, 1);
    assert.ok(!withVersion.res.findings[0].includes('package version'), withVersion.res.findings[0]);
    assert.ok(withVersion.res.findings[0].includes("Write it as '2019-02-11'"));

    // The finding stands on the patch alone; only the example is dropped.
    const unread = await audit([patch], { head: null });
    assert.strictEqual(unread.res.findings.length, 1);
    assert.ok(!unread.res.findings[0].includes('package version'));
    assert.deepStrictEqual(unread.res.notices, []);
    assert.strictEqual(unread.res.incomplete, undefined);
  });

  test('reports an eight-digit date, an unpadded one and a day-first one', async () => {
    for (const [value, advice] of [
      ['20241017', "Write it as '2024-10-17'"],
      ['2026-2-3', "Write it as '2026-02-03'"],
      ['06-10-2018', 'Write it in that form']
    ]) {
      const { res } = await audit([change(PHANTAP, [`+PKG_SOURCE_DATE:=${value}`])]);
      assert.strictEqual(res.findings.length, 1, `${value}: ${JSON.stringify(res.findings)}`);
      assert.ok(res.findings[0].includes('not the YYYY-MM-DD form'), res.findings[0]);
      assert.ok(res.findings[0].includes(advice), res.findings[0]);
    }
  });

  test('tells a date that does not exist apart from a malformed one', async () => {
    for (const value of ['2026-02-31', '2026-13-01']) {
      const { res } = await audit([change(PHANTAP, [`+PKG_SOURCE_DATE:=${value}`])]);
      assert.strictEqual(res.findings.length, 1);
      assert.ok(res.findings[0].includes(`is '${value}', which is not a real date`), res.findings[0]);
      assert.ok(!res.findings[0].includes('YYYY-MM-DD form the package policies'), res.findings[0]);
    }
  });

  test('reports a date years ahead, and leaves a week of slack', async () => {
    const ahead = await audit([change(PHANTAP, ['+PKG_SOURCE_DATE:=2033-10-18'])]);
    assert.strictEqual(ahead.res.findings.length, 1);
    assert.ok(ahead.res.findings[0].includes('which is in the future'), ahead.res.findings[0]);

    const twoDays = new Date(NOW + 2 * DAY).toISOString().slice(0, 10);
    const near = await audit([change(PHANTAP, [`+PKG_SOURCE_DATE:=${twoDays}`])]);
    assert.deepStrictEqual(near.res.findings, []);

    // The same value is judged against the injected clock, not the real one.
    const later = await audit([change(PHANTAP, ['+PKG_SOURCE_DATE:=2033-10-18'])], { now: Date.UTC(2033, 9, 15) });
    assert.deepStrictEqual(later.res.findings, []);
  });

  test('reports an epoch placeholder as too early, not as in the future', async () => {
    const { res } = await audit([change(PHANTAP, ['+PKG_SOURCE_DATE:=1970-01-01'])]);
    assert.strictEqual(res.findings.length, 1);
    assert.ok(res.findings[0].includes('too early to be the date of a source revision'), res.findings[0]);
  });

  test('passes a well-formed pin with one success naming both halves, and reads nothing', async () => {
    const { res, reads } = await audit([change(PHANTAP, [
      '-PKG_SOURCE_DATE:=2025-01-01', '+PKG_SOURCE_DATE:=2025-10-06',
      `-PKG_SOURCE_VERSION:=${FULL_B}`, `+PKG_SOURCE_VERSION:=${FULL}`
    ])]);
    assert.deepStrictEqual(res.findings, []);
    assert.deepStrictEqual(res.successes, [`✅ Package Makefile '${PHANTAP}' pins its source with PKG_SOURCE_VERSION 'e8d10eaf0d8a…' and PKG_SOURCE_DATE '2025-10-06'`]);
    assert.deepStrictEqual(reads, []);
  });

  test('leaves a malformed date alone when the diff does not write it', async () => {
    const { res } = await audit([change(PHANTAP, [`-PKG_SOURCE_VERSION:=${FULL_B}`, `+PKG_SOURCE_VERSION:=${FULL}`, ' PKG_SOURCE_DATE:=2025.10.06'])],
      { head: lines('PKG_SOURCE_PROTO:=git', 'PKG_SOURCE_DATE:=2025.10.06', `PKG_SOURCE_VERSION:=${FULL}`) });
    assert.deepStrictEqual(res.findings, []);
    assert.deepStrictEqual(res.successes, [`✅ Package Makefile '${PHANTAP}' pins its source with PKG_SOURCE_VERSION 'e8d10eaf0d8a…'`]);
  });

  test('checks nothing in a computed value, and claims nothing about it', async () => {
    const { res, reads } = await audit([change(PHANTAP, ['+PKG_SOURCE_DATE:=$(SOME_DATE)', '+PKG_SOURCE_VERSION:=v$(PKG_VERSION)'])]);
    assert.deepStrictEqual(res.findings, []);
    assert.deepStrictEqual(res.successes, []);
    assert.deepStrictEqual(reads, []);

    // Beside a literal half, only that half is checked and named.
    const mixed = await audit([change(PHANTAP, ['+PKG_SOURCE_DATE:=2025-10-06', '+PKG_SOURCE_VERSION:=v$(PKG_VERSION)'])]);
    assert.deepStrictEqual(mixed.res.successes, [`✅ Package Makefile '${PHANTAP}' pins its source with PKG_SOURCE_DATE '2025-10-06'`]);
  });

  test('does not read PKG_SOURCE_DATE_EPOCH or PKG_SOURCE_DATEX as the date', async () => {
    const { res, reads } = await audit([change(PHANTAP, ['+PKG_SOURCE_DATE_EPOCH = $(call date_epoch)', '+PKG_SOURCE_DATEX:=foo'])]);
    assert.deepStrictEqual(res, { errors: [], warnings: [], notices: [], findings: [], successes: [] });
    assert.deepStrictEqual(reads, []);

    // The date written after them is still found.
    const after = await audit([change(PHANTAP, ['+PKG_SOURCE_DATE_EPOCH = $(call date_epoch)', '+PKG_SOURCE_DATEX:=foo', '+PKG_SOURCE_DATE:=foo'])]);
    assert.strictEqual(after.res.findings.length, 1);
    assert.ok(after.res.findings[0].includes("is 'foo'"), after.res.findings[0]);
  });

  // parseMakefileVar reads only `:=` and `=`; this audit also takes `?=` and
  // `+=` as the assignment they are, so the value is still judged.
  test('judges a value assigned with ?= or +=', async () => {
    for (const op of ['?=', '+=', ' = ', '::=']) {
      const { res } = await audit([change(PHANTAP, [`+PKG_SOURCE_DATE${op}2025.10.06`])]);
      assert.strictEqual(res.findings.length, 1, `${op}: ${JSON.stringify(res.findings)}`);
      assert.ok(res.findings[0].includes("is '2025.10.06'"));
    }
    // The blanks before the operator are read up to 64 and no further, so a
    // padded line costs what any other does; past that it is not judged.
    const padded = (n) => audit([change(PHANTAP, [`+PKG_SOURCE_DATE${' '.repeat(n)}:=2025.10.06`])]);
    assert.strictEqual((await padded(64)).res.findings.length, 1);
    assert.deepStrictEqual((await padded(65)).res.findings, []);
  });

  test('reads the first of two assignments, the one the release and hash audits read', async () => {
    const body = ['PKG_SOURCE_DATE:=2025-10-06', 'PKG_SOURCE_DATE:=2025.10.06'];
    const { res } = await audit([change(PHANTAP, body.map(l => `+${l}`))]);
    assert.deepStrictEqual(res.findings, []);
    assert.deepStrictEqual(res.successes, [`✅ Package Makefile '${PHANTAP}' pins its source with PKG_SOURCE_DATE '2025-10-06'`]);
    assert.strictEqual(resolveMakefileVar(lines(...body), 'PKG_SOURCE_DATE'), '2025-10-06');
  });

  // The siblings judge the head, so a later commit that corrects the date
  // must win over the commit it corrects.
  test('judges the value the last commit of the series leaves', async () => {
    const wrong = change(PHANTAP, ['-PKG_SOURCE_DATE:=2025-01-01', '+PKG_SOURCE_DATE:=2025.10.06']);
    const fixed = change(PHANTAP, ['-PKG_SOURCE_DATE:=2025.10.06', '+PKG_SOURCE_DATE:=2025-10-06']);
    assert.deepStrictEqual((await audit([wrong, fixed])).res.findings, []);
    assert.strictEqual((await audit([fixed, wrong])).res.findings.length, 1);

    // A later commit that only removes the line leaves nothing to judge.
    const removed = change(PHANTAP, ['-PKG_SOURCE_DATE:=2025.10.06']);
    const after = await audit([wrong, removed]);
    assert.deepStrictEqual(after.res.findings, []);
    assert.deepStrictEqual(after.res.successes, []);
  });

  test('trims a CRLF line ending off the value', async () => {
    const { res } = await audit([change(PHANTAP, ['+PKG_SOURCE_DATE:=2026-03-02\r'])]);
    assert.deepStrictEqual(res.findings, []);
    assert.strictEqual(res.successes.length, 1);
  });
});

describe('validatePkgSourcePins: PKG_SOURCE_VERSION', () => {
  test('reports a branch name or branch ref instead of a revision', async () => {
    for (const value of ['master', 'main', 'HEAD', 'refs/heads/main', 'origin/master', 'latest']) {
      const { res } = await audit([change(PHANTAP, ['+PKG_SOURCE_PROTO:=git', `+PKG_SOURCE_VERSION:=${value}`])]);
      assert.strictEqual(res.findings.length, 1, `${value}: ${JSON.stringify(res.findings)}`);
      assert.ok(res.findings[0].includes(`is '${value}', which names a branch instead of a revision`), res.findings[0]);
      assert.ok(res.findings[0].includes('using the head of a branch will create unpredictable results'));
    }
  });

  test('leaves tags, release names and SVN revision numbers alone', async () => {
    for (const value of ['release-0.1', '1_91_0', 'lf-6.18.2-1.0.0', 'mc_release_10.40.0', 'v2.0.2', '7.2', '48123', 'mainline', 'stable-2.0']) {
      const { res, reads } = await audit([change(PHANTAP, ['+PKG_SOURCE_PROTO:=git', `+PKG_SOURCE_VERSION:=${value}`])]);
      assert.deepStrictEqual(res.findings, [], value);
      assert.strictEqual(res.successes.length, 1, value);
      assert.deepStrictEqual(reads, [], value);
    }
  });

  test('reports an abbreviated hash in a git checkout, wherever the proto is set', async () => {
    const inHunk = await audit([change(PHANTAP, ['+PKG_SOURCE_PROTO:=git', '+PKG_SOURCE_VERSION:=a1b2c3d'])]);
    assert.strictEqual(inHunk.res.findings.length, 1);
    assert.ok(inHunk.res.findings[0].includes("is the abbreviated hash 'a1b2c3d'"), inHunk.res.findings[0]);
    assert.deepStrictEqual(inHunk.reads, []);

    const inHead = await audit([change(PHANTAP, ['+PKG_SOURCE_VERSION:=a1b2c3d'])],
      { head: lines('PKG_SOURCE_PROTO:=git', 'PKG_SOURCE_VERSION:=a1b2c3d') });
    assert.strictEqual(inHead.res.findings.length, 1);
    assert.deepStrictEqual(inHead.reads, [PHANTAP]);
  });

  test('leaves the same value alone in a tarball download', async () => {
    const { res } = await audit([change(PHANTAP, ['+PKG_SOURCE_VERSION:=a1b2c3d'])],
      { head: lines('PKG_SOURCE_URL:=https://example.com/', 'PKG_SOURCE_VERSION:=a1b2c3d', `PKG_HASH:=${'a'.repeat(64)}`) });
    assert.deepStrictEqual(res.findings, []);
    // Read and settled, so it is a pass rather than a gap.
    assert.deepStrictEqual(res.successes, [`✅ Package Makefile '${PHANTAP}' pins its source with PKG_SOURCE_VERSION 'a1b2c3d'`]);

    // An svn checkout, set in the patch, is not a git one either.
    const svn = await audit([change(PHANTAP, ['+PKG_SOURCE_PROTO:=svn', '+PKG_SOURCE_VERSION:=a1b2c3d'])]);
    assert.deepStrictEqual(svn.res.findings, []);
    assert.strictEqual(svn.res.successes.length, 1);
  });

  test('reports a head it could not read as a gap, never as a pass', async () => {
    const { res } = await audit([change(PHANTAP, ['+PKG_SOURCE_VERSION:=a1b2c3d'])], { head: null });
    assert.deepStrictEqual(res.findings, []);
    assert.deepStrictEqual(res.successes, []);
    assert.deepStrictEqual(res.notices, [`Could not read '${PHANTAP}' at the head commit, so its PKG_SOURCE_DATE and PKG_SOURCE_VERSION were not fully checked.`]);
    assert.strictEqual(res.incomplete, true);
  });
});

describe('validatePkgSourcePins: a new Makefile', () => {
  const NEW = 'utils/open-plc-utils/Makefile';
  const REV = '1ba7d5a042e4e8ff6858b08e113eec5dc4e89cf2';
  const body = (...extra) => [
    'include $(TOPDIR)/rules.mk', 'PKG_NAME:=open-plc-utils', 'PKG_RELEASE:=1',
    'PKG_SOURCE_PROTO:=git', 'PKG_SOURCE_URL:=https://github.com/qca/open-plc-utils.git',
    `PKG_SOURCE_VERSION:=${REV}`, `PKG_MIRROR_HASH:=${'b'.repeat(64)}`, ...extra,
    'include $(INCLUDE_DIR)/package.mk'
  ];
  const run = (lines_) => audit([addition(NEW, lines_)], { head: lines(...lines_) });

  test('reports a revision pinned with neither a date nor PKG_VERSION, quoting the version it becomes', async () => {
    const { res, reads } = await run(body());
    assert.strictEqual(res.findings.length, 1, JSON.stringify(res.findings));
    assert.ok(res.findings[0].startsWith(`- New package Makefile '${NEW}' pins the revision '${REV}' but sets neither PKG_SOURCE_DATE nor PKG_VERSION`), res.findings[0]);
    assert.ok(res.findings[0].includes("becomes version '0~1ba7d5a0'"), res.findings[0]);
    assert.deepStrictEqual(reads, [NEW]);
  });

  test('passes once it has a date or a PKG_VERSION', async () => {
    const dated = await run(body('PKG_SOURCE_DATE:=2025-03-01'));
    assert.deepStrictEqual(dated.res.findings, []);
    assert.deepStrictEqual(dated.reads, [], 'the date is in the patch, so the head is not needed');
    assert.strictEqual(dated.res.successes.length, 1);
    const versioned = await run(body('PKG_VERSION:=0.9'));
    assert.deepStrictEqual(versioned.res.findings, []);
    assert.deepStrictEqual(versioned.reads, [NEW], 'the absence is settled on the head');
    assert.strictEqual(versioned.res.successes.length, 1);
  });

  test('says nothing where a helper or a condition may supply the version', async () => {
    // The build system's own includes do not count as such a helper.
    assert.strictEqual((await run(body('include $(INCLUDE_DIR)/cmake.mk'))).res.findings.length, 1);
    for (const extra of [
      ['include ../../luci.mk'],
      ['include ../golang-package.mk'],
      ['include $(TOPDIR)/feeds/luci/luci.mk'],
      ['ifeq ($(CONFIG_FOO),y)', '  PKG_SOURCE_DATE:=2025-03-01', 'endif'],
      ['ifeq ($(CONFIG_FOO),y)', '  PKG_VERSION:=0.9', 'endif']
    ]) {
      const { res } = await run(body(...extra));
      assert.deepStrictEqual(res.findings, [], extra.join(' / '));
    }
  });

  test('is not judged as new when the series deleted and re-added it', async () => {
    const { res } = await audit([deletion(NEW, body()), addition(NEW, body())], { head: lines(...body()) });
    assert.deepStrictEqual(res.findings, []);
    // Its revision is still judged like any other modified Makefile's.
    assert.strictEqual(res.successes.length, 1);
  });

  test('ignores a deleted Makefile entirely', async () => {
    const pinned = ['PKG_SOURCE_DATE:=2025.10.06', 'PKG_SOURCE_VERSION:=master'];
    const { res, reads } = await audit([deletion(PHANTAP, pinned)]);
    assert.deepStrictEqual(res, { errors: [], warnings: [], notices: [], findings: [], successes: [] });
    assert.deepStrictEqual(reads, []);
    // The same lines, added back by a later commit, are judged.
    assert.strictEqual((await audit([deletion(PHANTAP, pinned), addition(PHANTAP, pinned)])).res.findings.length, 2);
  });

  test('reports an unreadable head as a gap', async () => {
    const { res } = await audit([addition(NEW, body())], { head: null });
    assert.deepStrictEqual(res.findings, []);
    assert.strictEqual(res.incomplete, true);
    assert.strictEqual(res.notices.length, 1);
  });

  // The CPU guard on head text, pinned as a count rather than a clock: the
  // head scans cost their length, so the audit reads exactly
  // SOURCE_PIN_HEAD_CHARS of it and treats a head past that as unread.
  test('scans no more head text than its budget, and says less past it, never something else', async () => {
    const padded = (size, lines_ = body()) => {
      const text = lines(...lines_);
      return `${text}# ${'x'.repeat(size - text.length - 3)}\n`;
    };
    assert.strictEqual(padded(SOURCE_PIN_HEAD_CHARS).length, SOURCE_PIN_HEAD_CHARS);
    const at = await audit([addition(NEW, body())], { head: padded(SOURCE_PIN_HEAD_CHARS) });
    assert.strictEqual(at.res.findings.length, 1, 'a head of exactly the budget is judged');
    assert.strictEqual(at.res.incomplete, undefined);

    const over = await audit([addition(NEW, body())], { head: padded(SOURCE_PIN_HEAD_CHARS + 1) });
    assert.deepStrictEqual(over.res.findings, []);
    assert.deepStrictEqual(over.res.successes, []);
    assert.deepStrictEqual(over.res.notices, [`'${NEW}' at the head commit is larger than what this audit has left to read, so its PKG_SOURCE_DATE and PKG_SOURCE_VERSION were not fully checked.`]);
    assert.strictEqual(over.res.incomplete, true);

    // One budget for the audit, spent in path order: the second head is over
    // what the first left, whichever read answers first.
    const SECOND = 'utils/second/Makefile';
    const half = Math.floor(SOURCE_PIN_HEAD_CHARS / 2) + 1;
    const both = await audit([addition(NEW, body()), addition(SECOND, body())], { head: async () => padded(half) });
    assert.strictEqual(both.res.findings.length, 1);
    assert.ok(both.res.findings[0].includes(`'${NEW}'`), both.res.findings[0]);
    assert.deepStrictEqual(both.res.notices, [`'${SECOND}' at the head commit is larger than what this audit has left to read, so its PKG_SOURCE_DATE and PKG_SOURCE_VERSION were not fully checked.`]);
    assert.strictEqual(both.res.incomplete, true);

    // A malformed date rests on the patch line alone: still reported, only
    // without the version the oversized head would have shown.
    const dotted = ['PKG_SOURCE_DATE:=2025.10.06', `PKG_SOURCE_VERSION:=${REV}`];
    const form = await audit([change(PHANTAP, dotted.map(l => `+${l}`))], { head: padded(SOURCE_PIN_HEAD_CHARS + 1, dotted) });
    assert.strictEqual(form.res.findings.length, 1);
    assert.ok(form.res.findings[0].endsWith("Write it as '2025-10-06', so a reader can tell it is a date."), form.res.findings[0]);
    assert.deepStrictEqual(form.res.notices, []);
    assert.strictEqual(form.res.incomplete, undefined);
  });
});

describe('validatePkgSourcePins: series and limits', () => {
  const revert = (patch) => ({
    commitPatch: patch,
    fullCommit: makeCommit('Revert "phantap: fix the date"\n\nThis reverts commit 9fceb02d0ae598e95dc970b74767f19372d61af8.')
  });

  test('leaves a value only a revert restored to the revert, unless reverts are held to the rules', async () => {
    const patch = change(PHANTAP, ['-PKG_SOURCE_DATE:=2025-10-06', '+PKG_SOURCE_DATE:=2025.10.06']);
    assert.deepStrictEqual((await audit([revert(patch)])).res.findings, []);
    const strict = await audit([revert(patch)], { config: { ...PIN_CONFIG, allow_revert: false } });
    assert.strictEqual(strict.res.findings.length, 1);
  });

  // ipq-wifi, 9d849ee4 then 7a556193: the same day, the date stays.
  test('asks nothing of the date when only the revision moves', async () => {
    const { res } = await audit([change('package/firmware/ipq-wifi/Makefile', [
      `-PKG_SOURCE_VERSION:=${FULL_B}`, `+PKG_SOURCE_VERSION:=${FULL}`,
      `-PKG_MIRROR_HASH:=${'a'.repeat(64)}`, `+PKG_MIRROR_HASH:=${'b'.repeat(64)}`
    ])]);
    assert.deepStrictEqual(res.findings, []);
    assert.strictEqual(res.successes.length, 1);
    assert.ok(!res.successes[0].includes('PKG_SOURCE_DATE'), res.successes[0]);
  });

  test('skips more than fifteen Makefiles without reading any, and audits fifteen', async () => {
    const many = (n) => Array.from({ length: n }, (_, i) => change(`net/pkg${i}/Makefile`, ['+PKG_SOURCE_DATE:=2025.10.06'])).join('');
    const sixteen = await audit([many(16)], { head: () => { throw new Error('no read expected'); } });
    assert.deepStrictEqual(sixteen.res.notices, ['Package source pin audit skipped: PR modifies 16 Makefiles. Batch updates of >15 Makefiles are not automatically audited to prevent hitting API rate/subrequest limits.']);
    assert.strictEqual(sixteen.res.incomplete, true);
    assert.deepStrictEqual(sixteen.res.findings, []);
    assert.deepStrictEqual(sixteen.reads, []);

    const fifteen = await audit([many(15)]);
    assert.strictEqual(fifteen.res.findings.length, 15);
    assert.strictEqual(fifteen.res.incomplete, undefined);
  });

  // The CPU guard, pinned as a count rather than a clock: lines shaped like
  // the date that never complete it defeat the early exit, so the scan stops
  // after exactly 6000 of them.
  test('stops after 6000 changed Makefile lines and says so', async () => {
    const epoch = (n) => Array.from({ length: n }, (_, i) => `+PKG_SOURCE_DATE_EPOCH_${i} = 1`);
    // The second Makefile's one line is the 6000th.
    const within = await audit([change(PHANTAP, epoch(5999)), change('net/other/Makefile', ['+PKG_SOURCE_DATE:=2025.10.06'])]);
    assert.deepStrictEqual(within.res.notices, []);
    assert.strictEqual(within.res.incomplete, undefined);
    assert.strictEqual(within.res.findings.length, 1);

    const over = await audit([change(PHANTAP, epoch(6000)), change('net/other/Makefile', ['+PKG_SOURCE_DATE:=2025.10.06'])]);
    assert.deepStrictEqual(over.res.notices, ['Package source pin audit stopped after 6000 changed Makefile lines, so the remaining Makefiles in this pull request were not checked.']);
    assert.strictEqual(over.res.incomplete, true);
    assert.deepStrictEqual(over.res.findings, [], 'the Makefile after the budget was not scanned');

    const huge = await audit([change(PHANTAP, epoch(7000))]);
    assert.strictEqual(huge.res.incomplete, true);
    assert.strictEqual(huge.res.notices.length, 1);
  });

  // uboot-mediatek, the largest Makefile in either tree, rewritten in full.
  test('audits a full rewrite of a 1667-line Makefile normally', async () => {
    const old = Array.from({ length: 1667 }, (_, i) => `-OLD_${i}:=x`);
    const rewritten = Array.from({ length: 1665 }, (_, i) => `+NEW_${i}:=x`);
    const { res } = await audit([change('package/boot/uboot-mediatek/Makefile', [...old, ...rewritten, '+PKG_SOURCE_DATE:=2025.10.06', `+PKG_SOURCE_VERSION:=${FULL}`])]);
    assert.strictEqual(res.findings.length, 1);
    assert.deepStrictEqual(res.notices, []);
  });

  test('reports a PR-wide patch it cannot split as a gap, and splits one it can', async () => {
    const envelope = (sha) => `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: Dev <dev@example.com>\nSubject: [PATCH] phantap: update\n\n---\n`;
    const broken = `${envelope('a'.repeat(40))}${change(PHANTAP, ['+PKG_SOURCE_DATE:=2025.10.06'])}${envelope('b'.repeat(40))}no diff here\n`;
    const { res } = await audit([broken]);
    assert.deepStrictEqual(res, { errors: [], successes: [], warnings: [], notices: ['Could not safely verify commit boundaries in PR-wide patch series'], findings: [], incomplete: true });

    const first = change(PHANTAP, ['+PKG_SOURCE_DATE:=2025.10.06']);
    const second = change('net/other/Makefile', ['+PKG_SOURCE_VERSION:=master']);
    const whole = await audit([`${envelope('a'.repeat(40))}${first}${envelope('b'.repeat(40))}${second}`]);
    const perCommit = await audit([first, second]);
    assert.strictEqual(whole.res.findings.length, 2);
    assert.deepStrictEqual(whole.res.findings, perCommit.res.findings);
  });

  test('does nothing, and reads nothing, when disabled', async () => {
    for (const value of [false, 'disabled']) {
      const { res, reads } = await audit([addition(PHANTAP, ['PKG_SOURCE_VERSION:=a1b2c3d', 'PKG_SOURCE_DATE:=2025.10.06'])],
        { config: { ...PIN_CONFIG, check_pkg_source_pin: value } });
      assert.deepStrictEqual(res, { errors: [], warnings: [], notices: [], findings: [], successes: [] });
      assert.deepStrictEqual(reads, []);
    }
    const enabled = await audit([addition(PHANTAP, ['PKG_SOURCE_VERSION:=a1b2c3d', 'PKG_SOURCE_DATE:=2025.10.06'])]);
    assert.strictEqual(enabled.res.findings.length, 1);
  });

  test('reads nothing for a tarball package that touches neither name', async () => {
    const bump = ['-PKG_VERSION:=5.2', '+PKG_VERSION:=5.3', '-PKG_RELEASE:=2', '+PKG_RELEASE:=1'];
    const { res, reads } = await audit([change('utils/bash/Makefile', bump)]);
    assert.deepStrictEqual(res, { errors: [], warnings: [], notices: [], findings: [], successes: [] });
    assert.deepStrictEqual(reads, []);
    // One pin line in the same diff is enough to be judged.
    const pinned = await audit([change('utils/bash/Makefile', [...bump, '+PKG_SOURCE_DATE:=2025-10-06'])]);
    assert.strictEqual(pinned.res.successes.length, 1);
  });

  // Each audit reports the variable it owns, once: this one only the date's
  // shape, never the release or the checksum.
  test('reports a forgotten bump once per audit, each about its own variable', async () => {
    const path = 'net/phantap/Makefile';
    const base = lines('PKG_NAME:=phantap', 'PKG_RELEASE:=2', 'PKG_SOURCE_PROTO:=git', 'PKG_SOURCE_DATE:=2025-01-01', `PKG_SOURCE_VERSION:=${FULL_B}`, `PKG_MIRROR_HASH:=${'a'.repeat(64)}`);
    const head = lines('PKG_NAME:=phantap', 'PKG_RELEASE:=2', 'PKG_SOURCE_PROTO:=git', 'PKG_SOURCE_DATE:=2025.10.06', `PKG_SOURCE_VERSION:=${FULL}`, `PKG_MIRROR_HASH:=${'a'.repeat(64)}`);
    const commits = [{ commitPatch: change(path, ['-PKG_SOURCE_DATE:=2025-01-01', '+PKG_SOURCE_DATE:=2025.10.06', `-PKG_SOURCE_VERSION:=${FULL_B}`, `+PKG_SOURCE_VERSION:=${FULL}`]) }];
    const atHead = async (p) => (p === path ? head : null);
    const atBase = async (p) => (p === path ? base : null);

    const release = await validatePkgReleaseBumps(commits, { ...CONFIG, check_pkg_release: 'warning' }, atHead, atBase);
    const hashes = await validatePkgHashes(commits, { ...CONFIG, check_pkg_hash: 'warning' }, atHead, atBase);
    const pins = await validatePkgSourcePins(commits, PIN_CONFIG, atHead, () => NOW);

    assert.strictEqual(release.errors.length, 1, JSON.stringify(release.errors));
    assert.match(release.errors[0], /PKG_RELEASE/);
    assert.strictEqual(hashes.findings.length + hashes.errors.length, 1, JSON.stringify(hashes));
    assert.match(hashes.findings[0], /PKG_MIRROR_HASH/);
    assert.strictEqual(pins.findings.length, 1, JSON.stringify(pins.findings));
    assert.ok(!/PKG_RELEASE|HASH/.test(pins.findings[0]), pins.findings[0]);
  });
});
