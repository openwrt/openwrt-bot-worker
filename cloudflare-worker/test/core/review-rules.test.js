import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseReviewRules, matchReviewRules, validateReviewRules } from '../../src/core/review-rules.ts';

const RULES = `# LLM review rules

## Deprecated device-tree patterns

- **MAC from MTD.** \`mediatek,mtd-eeprom = <&factory 0xNNNN>;\` --> use
  \`nvmem-cells\`.

  \`\`\`formality-rule
  files: target/linux/*/dts/**
  added: mediatek,mtd-eeprom
  message: Use nvmem-cells instead of mediatek,mtd-eeprom.
  \`\`\`

## Out-of-tree apps

~~~formality-rule
# Maintained upstream, not here.
files: applications/luci-app-example/**
added: PKG_RELEASE
message: This app lives in its own repository.
level: error
~~~

\`\`\`yaml
files: not/a/rule/**
\`\`\`
`;

const diff = (path, hunks) => `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
${hunks}`;

describe('parseReviewRules', () => {
  test('reads fenced rule blocks, also indented under a bullet, and ignores other fences', () => {
    const { rules, problems } = parseReviewRules(RULES);
    assert.deepStrictEqual(problems, []);
    assert.strictEqual(rules.length, 2);
    assert.deepStrictEqual(rules.map(r => r.line), [8, 16]);
    assert.deepStrictEqual(rules[0].added, ['mediatek,mtd-eeprom']);
    assert.strictEqual(rules[0].level, 'warning');
    assert.deepStrictEqual(rules[1].added, ['PKG_RELEASE']);
    assert.strictEqual(rules[1].level, 'error');
    assert.ok(rules[0].files[0].test('target/linux/mediatek/dts/mt7621_example.dts'));
    assert.ok(!rules[0].files[0].test('package/kernel/mt76/Makefile'));
  });

  test('keeps a value as written, colons and quotes included', () => {
    const { rules } = parseReviewRules('```formality-rule\nfiles: **/*.dts\nadded: label = "green:\nmessage: Use color and function: see the rule.\n```\n');
    assert.deepStrictEqual(rules[0].added, ['label = "green:']);
    assert.strictEqual(rules[0].message, 'Use color and function: see the rule.');
  });

  test('names a broken block by its line and checks the rest', () => {
    const text = [
      '```formality-rule',
      'files: a/**',
      'adds: typo',
      'message: one',
      '```',
      '```formality-rule',
      'added: x',
      'level: fatal',
      '```',
      '```formality-rule',
      'files: b/**',
      'added: y',
      'message: fine',
      '```',
      '```formality-rule',
      'files: c/**'
    ].join('\n');
    const { rules, problems } = parseReviewRules(text);
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].message, 'fine');
    assert.strictEqual(problems.length, 3);
    assert.match(problems[0], /line 1 .*line 3 is not one of files, added, message or level/);
    assert.match(problems[0], /names no added text/);
    assert.match(problems[1], /line 6 .*names no files, it needs exactly one message, its level must be warning or error/);
    assert.match(problems[2], /line 15 .*never closed/);
  });

  test('checks at most 50 rules and says so', () => {
    const block = '```formality-rule\nfiles: a/**\nadded: x\nmessage: m\n```\n';
    const { rules, problems } = parseReviewRules(block.repeat(51));
    assert.strictEqual(rules.length, 50);
    assert.deepStrictEqual(problems, ['Only the first 50 rules in `.github/llm-review-rules.md` were checked.']);
  });

  test('skips any other code block, an example of the syntax included', () => {
    const text = [
      '````markdown',
      '```formality-rule',
      'files: a/**',
      'added: x',
      'message: an example',
      '```',
      '````',
      '``` text with words',
      '```formality-rule',
      '```',
      '```formality-rule',
      'files: b/**',
      'added: y',
      'message: real',
      '```'
    ].join('\n');
    const { rules, problems } = parseReviewRules(text);
    assert.deepStrictEqual(rules.map(r => r.message), ['real']);
    assert.deepStrictEqual(problems, []);
  });

  test('names a code block that never closes, since it hides the rules after it', () => {
    const { rules, problems } = parseReviewRules('```text\n```formality-rule\nfiles: a/**\nadded: x\nmessage: m\n');
    assert.strictEqual(rules.length, 0);
    assert.deepStrictEqual(problems, ['The code block at line 1 of `.github/llm-review-rules.md` is never closed, so no rule after it was checked.']);
  });

  test('answers no rules for a missing file', () => {
    assert.deepStrictEqual(parseReviewRules(null), { rules: [], problems: [] });
  });
});

describe('matchReviewRules', () => {
  const { rules } = parseReviewRules(RULES);
  const [eeprom, outOfTree] = rules;

  test('matches added lines only, with their line in the new file', () => {
    const patch = diff('target/linux/ramips/dts/mt7621_example.dts', `@@ -10,3 +10,4 @@
 &wifi {
-	mediatek,mtd-eeprom = <&factory 0x0>;
+	mediatek,mtd-eeprom = <&factory 0x8000>;
+	status = "okay";
 };
`);
    const { applied, hits } = matchReviewRules(rules, [{ sha: 'abc', patch }]);
    assert.deepStrictEqual([...applied], [eeprom]);
    assert.deepStrictEqual(hits.get(eeprom), [{ sha: 'abc', path: 'target/linux/ramips/dts/mt7621_example.dts', line: 11 }]);
  });

  test('does not read a commit message or a file no rule names', () => {
    const patch = `From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001
From: Dev <dev@example.com>
Subject: [PATCH] ramips: example

+++ b/target/linux/ramips/dts/fake.dts
@@ -1 +1 @@
+mediatek,mtd-eeprom quoted in the message
---
${diff('package/example/Makefile', `@@ -1,1 +1,2 @@
 PKG_NAME:=example
++++ b/target/linux/ramips/dts/fake.dts
`)}`;
    const { applied, hits } = matchReviewRules(rules, [{ sha: null, patch }]);
    assert.strictEqual(applied.size, 0);
    assert.strictEqual(hits.size, 0);
  });

  test('does not report a line a commit deletes', () => {
    const deleted = `diff --git a/applications/luci-app-example/Makefile b/applications/luci-app-example/Makefile
deleted file mode 100644
--- a/applications/luci-app-example/Makefile
+++ /dev/null
@@ -1,1 +0,0 @@
-PKG_RELEASE:=1
`;
    const { hits } = matchReviewRules(rules, [{ sha: 'abc', patch: deleted }]);
    assert.strictEqual(hits.get(outOfTree), undefined);
  });
});

describe('validateReviewRules', () => {
  const ruleSet = parseReviewRules(RULES);
  const eepromPatch = diff('target/linux/ramips/dts/mt7621_example.dts', `@@ -1,0 +1,1 @@
+	mediatek,mtd-eeprom = <&factory 0x8000>;
`);

  test('reports a hit with a link to the line and to the rule', () => {
    const report = validateReviewRules([{ sha: 'abc123', commitPatch: eepromPatch }], ruleSet, 'openwrt/openwrt', 'main');
    assert.deepStrictEqual(report.errors, []);
    assert.deepStrictEqual(report.warnings, [
      '- Use nvmem-cells instead of mediatek,mtd-eeprom. Found in [target/linux/ramips/dts/mt7621_example.dts:1](https://github.com/openwrt/openwrt/blob/abc123/target/linux/ramips/dts/mt7621_example.dts#L1). See [the rule](https://github.com/openwrt/openwrt/blob/main/.github/llm-review-rules.md#L8).'
    ]);
    assert.strictEqual(report.incomplete, false);
  });

  test('reports an error-level rule as an error', () => {
    const patch = diff('applications/luci-app-example/Makefile', '@@ -1,0 +1,1 @@\n+PKG_RELEASE:=2\n');
    const report = validateReviewRules([{ sha: 'abc123', commitPatch: patch }], ruleSet, 'openwrt/luci', 'master');
    assert.strictEqual(report.errors.length, 1);
    assert.match(report.errors[0], /^- This app lives in its own repository\. Found in/);
  });

  test('says the rules held when they applied and nothing matched', () => {
    const patch = diff('target/linux/ramips/dts/mt7621_example.dts', '@@ -1,0 +1,1 @@\n+	status = "okay";\n');
    const report = validateReviewRules([{ sha: 'abc123', commitPatch: patch }], ruleSet, 'openwrt/openwrt', 'main');
    assert.deepStrictEqual(report.successes, ['✅ No added line breaks the repository rule that applies to the changed files']);
  });

  test('skips what the caller marks, and reports an unread diff as a gap', () => {
    const report = validateReviewRules([
      { sha: 'merge1', commitPatch: eepromPatch, skip: true },
      { sha: 'lost1', commitPatch: null }
    ], ruleSet, 'openwrt/openwrt', 'main');
    assert.deepStrictEqual(report.warnings, []);
    assert.strictEqual(report.incomplete, true);
    assert.deepStrictEqual(report.notices, ['The repository rules were not checked against 1 commit whose diff could not be read.']);
  });

  test('leaves out a line the upstream commit of a backport added too, but not a second copy', () => {
    const twice = diff('target/linux/ramips/dts/mt7621_example.dts', `@@ -1,0 +1,2 @@
+	mediatek,mtd-eeprom = <&factory 0x8000>;
+	mediatek,mtd-eeprom = <&factory 0x8000>;
`);
    const carried = validateReviewRules([{ sha: 'abc123', commitPatch: eepromPatch, upstreamPatch: eepromPatch }], ruleSet, 'openwrt/openwrt', 'openwrt-25.12');
    assert.deepStrictEqual(carried.warnings, []);
    const added = validateReviewRules([{ sha: 'abc123', commitPatch: twice, upstreamPatch: eepromPatch }], ruleSet, 'openwrt/openwrt', 'openwrt-25.12');
    assert.match(added.warnings[0], /mt7621_example\.dts:2\]/);
  });

  test('does nothing without rules', () => {
    const report = validateReviewRules([{ sha: 'abc', commitPatch: eepromPatch }], { rules: [], problems: [] }, 'openwrt/openwrt', 'main');
    assert.deepStrictEqual(report, { errors: [], warnings: [], notices: [], successes: [], incomplete: false });
  });
});
