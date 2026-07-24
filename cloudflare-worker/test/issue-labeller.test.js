import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseIssueForm, normalizeFields, parseIssueLabellerYaml, extractTemplateVars, DEFAULT_ISSUE_LABELLER_CONFIG, handleIssueLabeller } from '../src/issue-labeller.js';

describe('parseIssueForm', () => {
  test('parses structured issue form body', () => {
    const body = `### Description

Something is broken

### OpenWrt Release

24.10-SNAPSHOT

### OpenWrt Version

r28945-24a9f1c224

### Target/Subtarget

ramips/mt7621

### Device

TP-Link Archer C6 v3

### Image Kind

Official downloaded image`;

    const fields = parseIssueForm(body);
    assert.strictEqual(fields['Description'], 'Something is broken');
    assert.strictEqual(fields['OpenWrt Release'], '24.10-SNAPSHOT');
    assert.strictEqual(fields['OpenWrt Version'], 'r28945-24a9f1c224');
    assert.strictEqual(fields['Target/Subtarget'], 'ramips/mt7621');
    assert.strictEqual(fields['Device'], 'TP-Link Archer C6 v3');
    assert.strictEqual(fields['Image Kind'], 'Official downloaded image');
  });

  test('handles _No response_ as empty', () => {
    const body = `### Description

_No response_

### Release

23.05.0`;

    const fields = parseIssueForm(body);
    assert.strictEqual(fields['Description'], '');
    assert.strictEqual(fields['Release'], '23.05.0');
  });

  test('strips markdown code blocks and backticks from values (issue #31)', () => {
    const body = `### OpenWrt Release

\`\`\`
23.05.3
\`\`\`

### Target/Subtarget

\`x86/64\`

### OpenWrt Version

\`\`\`text
r28945-24a9f1c224
\`\`\``;

    const fields = parseIssueForm(body);
    assert.strictEqual(fields['OpenWrt Release'], '23.05.3');
    assert.strictEqual(fields['Target/Subtarget'], 'x86/64');
    assert.strictEqual(fields['OpenWrt Version'], 'r28945-24a9f1c224');
  });

  test('returns empty object for null/empty body', () => {
    assert.deepStrictEqual(parseIssueForm(null), {});
    assert.deepStrictEqual(parseIssueForm(''), {});
  });
});

describe('normalizeFields', () => {
  test('normalizes field names to snake_case and populates aliases', () => {
    const fields = { 'OpenWrt Release': '24.10', 'OpenWrt Target/Subtarget': 'ramips/mt7621' };
    const normalized = normalizeFields(fields);
    assert.strictEqual(normalized['openwrt_release'], '24.10');
    assert.strictEqual(normalized['release'], '24.10');
    assert.strictEqual(normalized['openwrt_target_subtarget'], 'ramips/mt7621');
    assert.strictEqual(normalized['target'], 'ramips/mt7621');
  });
});

describe('parseIssueLabellerYaml', () => {
  test('parses meta config and label rules', () => {
    const yaml = `
_trigger_label: "to-triage"
_invalid_label: "invalid"
_remove_labels: ["to-triage", "bug-report"]

"release/{major}.{minor}":
  - field: "release"
    format: '^\\d+\\.\\d+'
    exists: "tag:v{value}"

"Official Image":
  - field: "image_kind"
    contains: "official"

"Supported Device":
  - field: "device"
    not_empty: true
`;
    const config = parseIssueLabellerYaml(yaml);
    assert.strictEqual(config.meta._trigger_label, 'to-triage');
    assert.strictEqual(config.meta._invalid_label, 'invalid');
    assert.deepStrictEqual(config.meta._remove_labels, ['to-triage', 'bug-report']);
    assert.strictEqual(config.rules.length, 3);
    assert.strictEqual(config.rules[0].label, 'release/{major}.{minor}');
    assert.strictEqual(config.rules[0].conditions[0].field, 'release');
    assert.strictEqual(config.rules[0].conditions[0].exists, 'tag:v{value}');
    assert.strictEqual(config.rules[1].label, 'Official Image');
    assert.strictEqual(config.rules[1].conditions[0].contains, 'official');
    assert.strictEqual(config.rules[2].label, 'Supported Device');
    assert.strictEqual(config.rules[2].conditions[0].not_empty, true);
  });

  test('returns null for empty input', () => {
    assert.strictEqual(parseIssueLabellerYaml(null), null);
    assert.strictEqual(parseIssueLabellerYaml(''), null);
  });

  test('parses multiple condition alternatives under one label', () => {
    const yaml = `
"release/{major}.{minor}":
  - field: "release"
    format: '^\\d+\\.\\d+\\.\\d+(-rc\\d+)*$'
    exists: "tag:v{value}"
  - field: "release"
    format: '^\\d+\\.\\d+-SNAPSHOT$'
`;
    const config = parseIssueLabellerYaml(yaml);
    assert.strictEqual(config.rules.length, 1);
    assert.strictEqual(config.rules[0].conditions.length, 2);
    assert.strictEqual(config.rules[0].conditions[0].exists, 'tag:v{value}');
    assert.strictEqual(config.rules[0].conditions[1].format, '^\\d+\\.\\d+-SNAPSHOT$');
    assert.strictEqual(config.rules[0].conditions[1].exists, undefined);
  });

  test('handles comments', () => {
    const yaml = `
# This is a comment
_trigger_label: "to-triage"  # inline comment

"target/{segment0}":
  - field: "target"
    contains: "ramips"
`;
    const config = parseIssueLabellerYaml(yaml);
    assert.strictEqual(config.meta._trigger_label, 'to-triage');
    assert.strictEqual(config.rules.length, 1);
    assert.strictEqual(config.rules[0].conditions[0].contains, 'ramips');
  });
});

describe('extractTemplateVars', () => {
  test('extracts segments from slash-separated value', () => {
    const vars = extractTemplateVars('ramips/mt7621');
    assert.strictEqual(vars.value, 'ramips/mt7621');
    assert.strictEqual(vars.segment0, 'ramips');
    assert.strictEqual(vars.segment1, 'mt7621');
  });

  test('extracts major/minor/patch from dot-separated value', () => {
    const vars = extractTemplateVars('24.10.0');
    assert.strictEqual(vars.major, '24');
    assert.strictEqual(vars.minor, '10');
    assert.strictEqual(vars.patch, '0');
  });

  test('strips dash suffix from numeric version parts', () => {
    const vars = extractTemplateVars('24.10-SNAPSHOT');
    assert.strictEqual(vars.major, '24');
    assert.strictEqual(vars.minor, '10');
    const rc = extractTemplateVars('25.12.0-rc2');
    assert.strictEqual(rc.minor, '12');
    assert.strictEqual(rc.patch, '0');
  });

  test('extracts hash from version string', () => {
    const vars = extractTemplateVars('r28945-24a9f1c224');
    assert.strictEqual(vars.hash, '24a9f1c224');
  });
});

describe('handleIssueLabeller', () => {
  const makeIssueData = (labels, body) => ({
    issue: {
      number: 123,
      labels: labels.map(name => ({ name })),
      body
    }
  });

  test('ignores issues without trigger label', async () => {
    const data = makeIssueData(['bug', 'bug-report'], '### Release\n\nSNAPSHOT');
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.strictEqual(result.labelsToAdd.length, 0);
    assert.strictEqual(result.labelsToRemove.length, 0);
  });

  test('removes triage labels when no rules match', async () => {
    const data = makeIssueData(['to-triage', 'feature-request'], '### Description\n\nFoo');
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.ok(result.labelsToRemove.includes('to-triage'));
    assert.ok(result.labelsToRemove.includes('feature-request'));
  });

  test('combines multiple invalid field comments into a single CTA comment', async () => {
    const body = `### Release\n\nnot-a-release\n\n### Target\n\ninvalid-target`;
    const data = makeIssueData(['to-triage', 'bug', 'bug-report'], body);
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.ok(result.labelsToAdd.includes('invalid'));
    assert.strictEqual(result.comments.length, 1);
    assert.ok(result.comments[0].includes('Thank you for reporting this issue!'));
    assert.ok(result.comments[0].includes('- **release**: Invalid value `not-a-release`'));
    assert.ok(result.comments[0].includes('- **target**: Invalid value `invalid-target`'));
    assert.ok(result.comments[0].includes('Please edit your issue description'));
  });

  test('adds contains-based labels (Official Image)', async () => {
    const body = `### Image Kind\n\nOfficial downloaded image\n\n### Device\n\nTP-Link Archer C6`;
    const data = makeIssueData(['to-triage', 'bug', 'bug-report'], body);
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.ok(result.labelsToAdd.includes('Official Image'));
    assert.ok(result.labelsToAdd.includes('Supported Device'));
  });

  test('adds Self Built Image label', async () => {
    const body = `### Image Kind\n\nSelf built from source`;
    const data = makeIssueData(['to-triage', 'bug', 'bug-report'], body);
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.ok(result.labelsToAdd.includes('Self Built Image'));
  });

  test('removes to-triage and type label after processing', async () => {
    const body = `### Device\n\nSome device`;
    const data = makeIssueData(['to-triage', 'bug', 'bug-report'], body);
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.ok(result.labelsToRemove.includes('to-triage'));
    assert.ok(result.labelsToRemove.includes('bug-report'));
  });

  // Stubs global fetch with a GraphQL response; returns a call counter.
  const stubGraphql = (repository) => {
    const calls = { count: 0 };
    globalThis.fetch = async () => {
      calls.count++;
      return {
        status: 200,
        headers: {},
        text: async () => JSON.stringify({ data: { repository } })
      };
    };
    return calls;
  };

  test('labels concrete release when its tag exists', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const calls = stubGraphql({ p0: { name: 'v24.10.7' } });

    const data = makeIssueData(['to-triage', 'bug', 'bug-report'], '### OpenWrt Release\n\n24.10.7');
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.strictEqual(calls.count, 1);
    assert.deepStrictEqual(result.labelsToAdd, ['release/24.10']);
    assert.strictEqual(result.comments.length, 0);
  });

  test('marks release invalid when its tag does not exist', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    stubGraphql({ p0: null });

    const data = makeIssueData(['to-triage', 'bug', 'bug-report'], '### OpenWrt Release\n\n24.10.99');
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.deepStrictEqual(result.labelsToAdd, ['invalid']);
    assert.ok(result.comments[0].includes('`24.10.99`'));
  });

  test('labels stable-branch snapshot without tag existence check', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const calls = stubGraphql({});

    const data = makeIssueData(['to-triage', 'bug', 'bug-report'], '### OpenWrt Release\n\n24.10-SNAPSHOT');
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.strictEqual(calls.count, 0);
    assert.deepStrictEqual(result.labelsToAdd, ['release/24.10']);
    assert.strictEqual(result.comments.length, 0);
  });

  test('labels development snapshot release', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const calls = stubGraphql({});

    const data = makeIssueData(['to-triage', 'bug', 'bug-report'], '### OpenWrt Release\n\nSNAPSHOT');
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.strictEqual(calls.count, 0);
    assert.deepStrictEqual(result.labelsToAdd, ['SNAPSHOT']);
    assert.strictEqual(result.comments.length, 0);
  });

  test('reports an invalid field only once despite multiple release rules', async () => {
    const data = makeIssueData(['to-triage', 'bug', 'bug-report'], '### OpenWrt Release\n\nnot-a-release');
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.deepStrictEqual(result.labelsToAdd, ['invalid']);
    const mentions = result.comments[0].split('\n').filter(l => l.startsWith('- **release**'));
    assert.strictEqual(mentions.length, 1);
  });

  test('uses custom config from YAML', async () => {
    const yaml = `
_trigger_label: "needs-triage"
_invalid_label: "bad-report"
_remove_labels: ["needs-triage"]

"area/{segment0}":
  - field: "component"
    format: '^[a-z]+/'

"urgent":
  - field: "severity"
    contains: "critical"
`;
    const config = parseIssueLabellerYaml(yaml);
    const body = `### Component\n\nnetwork/wifi\n\n### Severity\n\nCritical issue`;
    const data = makeIssueData(['needs-triage', 'bug-report'], body);
    const result = await handleIssueLabeller(data, 'token', config, 'openwrt/openwrt');
    assert.ok(result.labelsToAdd.includes('area/network'));
    assert.ok(result.labelsToAdd.includes('urgent'));
    assert.ok(result.labelsToRemove.includes('needs-triage'));
    assert.ok(result.labelsToRemove.includes('bug-report'));
  });
});
