import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseIssueForm, normalizeFields, parseIssueLabellerYaml, extractTemplateVars, DEFAULT_ISSUE_LABELLER_CONFIG, handleIssueLabeller, applyIssueLabelling, ISSUE_LABELLER_MARKER } from '../src/issue-labeller.js';

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

describe('parseIssueLabellerYaml block scalars', () => {
  test('folds a multi-line hint into one line', () => {
    const config = parseIssueLabellerYaml(`
"target/{segment0}":
  - field: "target"
    format: '^\\w+/\\w+$'
    hint: >-
      Run \`echo $DISTRIB_TARGET\` on the device
      and paste that line.
    exists: "path:target/linux/{segment0}"
`);
    const cond = config.rules[0].conditions[0];
    assert.strictEqual(cond.hint, 'Run `echo $DISTRIB_TARGET` on the device and paste that line.');
    // The key after the block still parses
    assert.strictEqual(cond.exists, 'path:target/linux/{segment0}');
  });

  test('keeps line breaks in a literal block and does not treat # as a comment', () => {
    const config = parseIssueLabellerYaml(`
_invalid_comment_footer: |
  Line one
  # not a comment

_invalid_label: "invalid"
`);
    assert.strictEqual(config.meta._invalid_comment_footer, 'Line one\n# not a comment');
    assert.strictEqual(config.meta._invalid_label, 'invalid');
  });

  test('a top-level block scalar is a string, not a label rule', () => {
    const config = parseIssueLabellerYaml('_valid_comment: >-\n  Thanks, all good.\n');
    assert.strictEqual(config.meta._valid_comment, 'Thanks, all good.');
    assert.strictEqual(config.rules.length, 0);
  });

  test('folds a blank line into a paragraph break', () => {
    const config = parseIssueLabellerYaml('_valid_comment: >-\n  First para.\n\n  Second para.\n');
    assert.strictEqual(config.meta._valid_comment, 'First para.\nSecond para.');
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
    assert.ok(result.comments[0].includes('Please fix these by **editing the issue description**'));
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

  test('re-runs on an already flagged issue without the trigger label', async () => {
    const data = makeIssueData(['bug', 'invalid'], '### OpenWrt Release\n\nstill-not-a-release');
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.ok(result.labelsToAdd.includes('invalid'));
    assert.strictEqual(result.comments.length, 1);
  });

  test('clears the invalid label and acknowledges when an edit fixes the form', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    stubGraphql({});

    const data = makeIssueData(['bug', 'invalid'], '### OpenWrt Release\n\nSNAPSHOT');
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.ok(result.labelsToRemove.includes('invalid'));
    assert.strictEqual(result.comments.length, 0);
    assert.match(result.resolvedComment, /ready for triage/);
    assert.deepStrictEqual(result.labelsToAdd, ['SNAPSHOT']);
  });

  test('keeps labels that did validate alongside the invalid label', async () => {
    const body = `### OpenWrt Release\n\nnot-a-release\n\n### Image Kind\n\nOfficial downloaded image`;
    const data = makeIssueData(['to-triage', 'bug', 'bug-report'], body);
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.ok(result.labelsToAdd.includes('Official Image'));
    assert.ok(result.labelsToAdd.includes('invalid'));
  });

  test('never mistakes the invalid label for the issue type label', async () => {
    // A maintainer re-adding the trigger to an already flagged report: the
    // invalid label must survive, it is what brings the issue back on an edit.
    const data = makeIssueData(['bug', 'invalid', 'to-triage', 'bug-report'], '### OpenWrt Release\n\nstill-broken');
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.ok(!result.labelsToRemove.includes('invalid'));
    assert.ok(result.labelsToRemove.includes('bug-report'));
  });

  test('leaves maintainer labels alone when an edit re-triggers the check', async () => {
    const data = makeIssueData(['bug', 'invalid', 'high priority'], '### OpenWrt Release\n\nstill-broken');
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.ok(!result.labelsToRemove.includes('high priority'));
  });

  test('ignores an issue that skipped the template unless _require_form is set', async () => {
    const data = { issue: { number: 1, labels: [], body: 'Hi, is there a package for my VPN provider? Cannot find it in the list.', author_association: 'NONE' } };
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.strictEqual(result.labelsToAdd.length, 0);
    assert.strictEqual(result.comments.length, 0);
  });

  test('flags a template-less issue from an outside reporter when _require_form is set', async () => {
    const config = { ...DEFAULT_ISSUE_LABELLER_CONFIG, meta: { ...DEFAULT_ISSUE_LABELLER_CONFIG.meta, _require_form: true } };
    const data = { issue: { number: 1, labels: [], body: 'Hi, is there a package for my VPN provider? Cannot find it in the list.', author_association: 'NONE' } };
    const result = await handleIssueLabeller(data, 'token', config, 'openwrt/openwrt');
    assert.deepStrictEqual(result.labelsToAdd, ['invalid']);
    assert.match(result.comments[0], /without the bug report form/);
    assert.match(result.comments[0], /forum\.openwrt\.org/);
  });

  test('still spends the trigger label when it rejects a template-less issue', async () => {
    const config = { ...DEFAULT_ISSUE_LABELLER_CONFIG, meta: { ...DEFAULT_ISSUE_LABELLER_CONFIG.meta, _require_form: true } };
    const data = { issue: { number: 1, labels: [{ name: 'to-triage' }], body: 'no form here', author_association: 'NONE' } };
    const result = await handleIssueLabeller(data, 'token', config, 'openwrt/openwrt');
    assert.ok(result.labelsToAdd.includes('invalid'));
    assert.ok(result.labelsToRemove.includes('to-triage'));
  });

  test('leaves a maintainer tracking issue alone even with _require_form set', async () => {
    const config = { ...DEFAULT_ISSUE_LABELLER_CONFIG, meta: { ...DEFAULT_ISSUE_LABELLER_CONFIG.meta, _require_form: true } };
    for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      const data = { issue: { number: 1, labels: [], body: '- run the throughput test\n- wait\n\nneeds a closer look later', author_association: assoc } };
      const result = await handleIssueLabeller(data, 'token', config, 'openwrt/openwrt');
      assert.strictEqual(result.labelsToAdd.length, 0, assoc);
      assert.strictEqual(result.comments.length, 0, assoc);
    }
  });

  test('validates a form-shaped report that never received the template labels', async () => {
    const config = { ...DEFAULT_ISSUE_LABELLER_CONFIG, meta: { ...DEFAULT_ISSUE_LABELLER_CONFIG.meta, _require_form: true } };
    const body = '### OpenWrt Release\n\nnot-a-release\n\n### Image Kind\n\nOfficial downloaded image';
    const data = { issue: { number: 1, labels: [], body, author_association: 'NONE' } };
    const result = await handleIssueLabeller(data, 'token', config, 'openwrt/openwrt');
    assert.ok(result.labelsToAdd.includes('invalid'));
    assert.ok(result.labelsToAdd.includes('Official Image'));
  });

  test('spells out the command behind each built-in hint', async () => {
    const data = makeIssueData(['to-triage'], '### OpenWrt Release\n\nopenwrt 12.34.5\n\n### OpenWrt target/subtarget\n\nfoobar-generic-somerouter');
    const result = await handleIssueLabeller(data, 'token', DEFAULT_ISSUE_LABELLER_CONFIG, 'openwrt/openwrt');
    assert.match(result.comments[0], /DISTRIB_RELEASE/);
    assert.match(result.comments[0], /DISTRIB_TARGET/);
    assert.match(result.comments[0], /re-runs on every edit/);
  });

  test('honours a config-provided hint in the invalid comment', async () => {
    const config = parseIssueLabellerYaml(`
_trigger_label: "to-triage"

"release/{major}.{minor}":
  - field: "release"
    format: '^\\d+$'
    hint: "Run \`. /etc/openwrt_release && echo $DISTRIB_RELEASE\` and paste that value"
`);
    const data = makeIssueData(['to-triage'], '### Release\n\nopenwrt 12.34.5');
    const result = await handleIssueLabeller(data, 'token', config, 'openwrt/openwrt');
    assert.match(result.comments[0], /DISTRIB_RELEASE/);
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

describe('applyIssueLabelling comment handling', () => {
  // Records every request and answers comment listings from `existing`.
  // `existing` is either a flat list of comments (one page) or an array of
  // pages, which lets a test put the marker beyond the first 100.
  const stubApi = (existing) => {
    const pages = Array.isArray(existing[0]) ? existing : [existing];
    const requests = [];
    globalThis.fetch = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      requests.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
      let payload = [];
      if (method === 'GET' && url.includes('/comments?')) {
        const page = Number(new URL(url).searchParams.get('page') || 1);
        payload = pages[page - 1] || [];
      }
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
    };
    return requests;
  };

  // A full page, so the pager keeps going.
  const filler = (n) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, body: `chatter ${i}` }));

  const empty = { labelsToAdd: [], labelsToRemove: [], comments: [], resolvedComment: null, legacyHeader: null, labelMeta: {} };
  const LEGACY_HEADER = 'Thank you for reporting this issue! Some required form fields could not be validated:';
  const bot = (id, body) => ({ id, body, user: { type: 'Bot' } });

  test('posts a marker-tagged comment when none exists yet', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([]);

    await applyIssueLabelling({ ...empty, comments: ['Fields are wrong'] }, 'token', 'openwrt/openwrt', 7, new Set(), new Set(), null);
    const posted = requests.find(r => r.method === 'POST');
    assert.ok(posted.body.body.includes(ISSUE_LABELLER_MARKER));
    assert.ok(posted.body.body.startsWith('Fields are wrong'));
  });

  test('edits the existing comment instead of posting a second one', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([bot(42, `Old text\n\n${ISSUE_LABELLER_MARKER}`)]);

    await applyIssueLabelling({ ...empty, comments: ['New text'] }, 'token', 'openwrt/openwrt', 7, new Set(), new Set(), null);
    assert.strictEqual(requests.filter(r => r.method === 'POST').length, 0);
    const patched = requests.find(r => r.method === 'PATCH');
    assert.ok(patched.url.endsWith('/issues/comments/42'));
    assert.ok(patched.body.body.startsWith('New text'));
  });

  test('leaves an unchanged comment alone', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([bot(42, `Same text\n\n${ISSUE_LABELLER_MARKER}`)]);

    await applyIssueLabelling({ ...empty, comments: ['Same text'] }, 'token', 'openwrt/openwrt', 7, new Set(), new Set(), null);
    assert.ok(!requests.some(r => r.method === 'PATCH' || r.method === 'POST'));
  });

  test('finds its comment past the first page instead of posting a second one', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([
      filler(100),
      [...filler(20), bot(42, `Old text\n\n${ISSUE_LABELLER_MARKER}`)]
    ]);

    await applyIssueLabelling({ ...empty, comments: ['New text'] }, 'token', 'openwrt/openwrt', 7, new Set(), new Set(), null);
    assert.strictEqual(requests.filter(r => r.method === 'POST').length, 0);
    const patched = requests.find(r => r.method === 'PATCH');
    assert.ok(patched.url.endsWith('/issues/comments/42'));
  });

  test('stops paging as soon as the marker is found', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([
      [...filler(99), bot(42, `Old text\n\n${ISSUE_LABELLER_MARKER}`)],
      filler(100)
    ]);

    await applyIssueLabelling({ ...empty, comments: ['New text'] }, 'token', 'openwrt/openwrt', 7, new Set(), new Set(), null);
    assert.strictEqual(requests.filter(r => r.method === 'GET').length, 1);
  });

  test('posts once when a long thread has no marker anywhere', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([filler(100), filler(100), filler(30)]);

    await applyIssueLabelling({ ...empty, comments: ['Fields are wrong'] }, 'token', 'openwrt/openwrt', 7, new Set(), new Set(), null);
    assert.strictEqual(requests.filter(r => r.method === 'GET').length, 3);
    assert.strictEqual(requests.filter(r => r.method === 'POST').length, 1);
  });

  test('adopts a pre-marker comment instead of posting beside it', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([bot(11, `${LEGACY_HEADER}\n\n- **release**: Invalid value \`x\``)]);

    await applyIssueLabelling(
      { ...empty, comments: ['New text'], legacyHeader: LEGACY_HEADER },
      'token', 'openwrt/openwrt', 7, new Set(), new Set(), null
    );
    assert.strictEqual(requests.filter(r => r.method === 'POST').length, 0);
    const patched = requests.find(r => r.method === 'PATCH');
    assert.ok(patched.url.endsWith('/issues/comments/11'));
    // Patching writes the marker in, so the next run finds it the normal way.
    assert.ok(patched.body.body.includes(ISSUE_LABELLER_MARKER));
  });

  test('prefers the marked comment over a legacy one', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([
      bot(11, `${LEGACY_HEADER}\n\nstale`),
      bot(22, `Current text\n\n${ISSUE_LABELLER_MARKER}`)
    ]);

    await applyIssueLabelling(
      { ...empty, comments: ['New text'], legacyHeader: LEGACY_HEADER },
      'token', 'openwrt/openwrt', 7, new Set(), new Set(), null
    );
    assert.ok(requests.find(r => r.method === 'PATCH').url.endsWith('/issues/comments/22'));
  });

  test('never adopts another app\'s comment carrying the marker', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const foreign = { id: 55, body: `Copied text\n\n${ISSUE_LABELLER_MARKER}`, user: { type: 'Bot' }, performed_via_github_app: { id: 111 } };
    const requests = stubApi([foreign]);

    await applyIssueLabelling({ ...empty, comments: ['New text'] }, 'token', 'openwrt/openwrt', 7, new Set(), new Set(), null, 999);
    assert.strictEqual(requests.filter(r => r.method === 'PATCH').length, 0);
    assert.strictEqual(requests.filter(r => r.method === 'POST').length, 1);
  });

  test('never adopts a bot comment without an app id when its own id is known', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([bot(55, `Planted text\n\n${ISSUE_LABELLER_MARKER}`)]);

    await applyIssueLabelling({ ...empty, comments: ['New text'] }, 'token', 'openwrt/openwrt', 7, new Set(), new Set(), null, 999);
    assert.strictEqual(requests.filter(r => r.method === 'PATCH').length, 0);
    assert.strictEqual(requests.filter(r => r.method === 'POST').length, 1);
  });

  test('adopts its own comment matched by the app id', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const own = { id: 55, body: `Old text\n\n${ISSUE_LABELLER_MARKER}`, user: { type: 'Bot' }, performed_via_github_app: { id: 999 } };
    const requests = stubApi([own]);

    await applyIssueLabelling({ ...empty, comments: ['New text'] }, 'token', 'openwrt/openwrt', 7, new Set(), new Set(), null, 999);
    const patched = requests.find(r => r.method === 'PATCH');
    assert.ok(patched.url.endsWith('/issues/comments/55'));
  });

  test('never adopts a human comment that quotes the marker', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([{ id: 33, body: `quoted:\n\n${ISSUE_LABELLER_MARKER}`, user: { type: 'User' } }]);

    await applyIssueLabelling({ ...empty, comments: ['New text'] }, 'token', 'openwrt/openwrt', 7, new Set(), new Set(), null);
    assert.strictEqual(requests.filter(r => r.method === 'PATCH').length, 0);
    assert.strictEqual(requests.filter(r => r.method === 'POST').length, 1);
  });

  test('never adopts a human comment that quotes the header', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([{ id: 33, body: `> ${LEGACY_HEADER}\n\nwhat does this mean?`, user: { type: 'User' } }]);

    await applyIssueLabelling(
      { ...empty, comments: ['New text'], legacyHeader: LEGACY_HEADER },
      'token', 'openwrt/openwrt', 7, new Set(), new Set(), null
    );
    assert.strictEqual(requests.filter(r => r.method === 'PATCH').length, 0);
    assert.strictEqual(requests.filter(r => r.method === 'POST').length, 1);
  });

  test('clears a pre-marker comment when the form is fixed', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([bot(11, `${LEGACY_HEADER}\n\n- **release**: Invalid value \`x\``)]);

    await applyIssueLabelling(
      { ...empty, resolvedComment: 'All good now', legacyHeader: LEGACY_HEADER },
      'token', 'openwrt/openwrt', 7, new Set(), new Set(), null
    );
    const patched = requests.find(r => r.method === 'PATCH');
    assert.ok(patched.body.body.startsWith('All good now'));
    assert.strictEqual(requests.filter(r => r.method === 'POST').length, 0);
  });

  test('does not announce validity on an issue it never commented on', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([{ id: 9, body: 'a human comment' }]);

    await applyIssueLabelling({ ...empty, resolvedComment: 'All good now' }, 'token', 'openwrt/openwrt', 7, new Set(), new Set(), null);
    assert.ok(!requests.some(r => r.method === 'PATCH' || r.method === 'POST'));
  });

  test('skips the comment listing entirely when there is nothing to say', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const requests = stubApi([]);

    await applyIssueLabelling(empty, 'token', 'openwrt/openwrt', 7, new Set(), new Set(), null);
    assert.strictEqual(requests.length, 0);
  });
});
