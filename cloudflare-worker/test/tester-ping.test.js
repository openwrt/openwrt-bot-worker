import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { parseTesters, previouslyPinged, buildTesterPingComment, handleTesterPing, TESTER_PING_MARKER } from '../src/tester-ping.js';

const logins = (testers, label) => [...(testers.get(label)?.values() || [])];

describe('parseTesters', () => {
  test('matches lines against the pull request labels', () => {
    const { testers } = parseTesters('target/x86 alice\ntarget/ath79 bob\n', ['target/x86', 'RFT']);
    assert.deepStrictEqual([...testers.keys()], ['target/x86']);
    assert.deepStrictEqual(logins(testers, 'target/x86'), ['alice']);
  });

  test('takes several logins per line and strips a leading @', () => {
    const { testers } = parseTesters('target/x86 alice @bob\tcarol\n', ['target/x86']);
    assert.deepStrictEqual(logins(testers, 'target/x86'), ['alice', 'bob', 'carol']);
  });

  test('ignores comments, blank lines and CRLF', () => {
    const { testers, invalid } = parseTesters('# header\r\n\r\ntarget/x86 alice  # x86/64: APU2\r\n', ['target/x86']);
    assert.deepStrictEqual(logins(testers, 'target/x86'), ['alice']);
    assert.deepStrictEqual(invalid, []);
  });

  test('matches labels containing spaces, longest first', () => {
    const { testers } = parseTesters('core packages alice\ncore bob\n', ['core', 'core packages']);
    assert.deepStrictEqual(logins(testers, 'core packages'), ['alice']);
    assert.deepStrictEqual(logins(testers, 'core'), ['bob']);
  });

  test('never reads a word of a longer repository label as a login', () => {
    // PR only has 'core' but the repo also has 'core packages', so
    // @packages must not get pinged.
    const { testers } = parseTesters('core packages carol\ncore bob\n', ['core'], new Set(['core', 'core packages']));
    assert.deepStrictEqual([...testers.keys()], ['core']);
    assert.deepStrictEqual(logins(testers, 'core'), ['bob']);
  });

  test('requires whitespace after the label', () => {
    const { testers } = parseTesters('target/x86_64 alice\ntarget/x86\n', ['target/x86']);
    assert.strictEqual(testers.size, 0);
  });

  test('compares labels case-insensitively and keeps the PR spelling', () => {
    const { testers } = parseTesters('Target/X86 alice\n', ['target/x86']);
    assert.deepStrictEqual(logins(testers, 'target/x86'), ['alice']);
  });

  test('reports logins GitHub would not accept', () => {
    const { testers, invalid } = parseTesters('target/x86 alice -bad a--b openwrt/team\n', ['target/x86']);
    assert.deepStrictEqual(logins(testers, 'target/x86'), ['alice']);
    assert.deepStrictEqual(invalid.map(i => i.login), ['-bad', 'a--b', 'openwrt/team']);
  });

  test('deduplicates logins case-insensitively', () => {
    const { testers } = parseTesters('target/x86 Alice\ntarget/x86 alice\n', ['target/x86']);
    assert.strictEqual(testers.get('target/x86').size, 1);
  });

  test('handles a missing file', () => {
    assert.strictEqual(parseTesters(null, ['target/x86']).testers.size, 0);
  });
});

describe('previouslyPinged', () => {
  test('reads mentions from own marked comments only', () => {
    const comments = [
      { performed_via_github_app: { id: 1 }, body: `- \`target/x86\`: @Alice\n${TESTER_PING_MARKER}` },
      { performed_via_github_app: { id: 2 }, body: `- \`target/x86\`: @bob\n${TESTER_PING_MARKER}` },
      { user: { login: 'carol', type: 'User' }, body: `- \`target/x86\`: @carol\n${TESTER_PING_MARKER}` },
      { performed_via_github_app: { id: 1 }, body: '- `target/x86`: @dave' }
    ];
    assert.deepStrictEqual([...previouslyPinged(comments, 1)], ['alice']);
  });

  test('ignores mentions inside a label', () => {
    const comments = [
      { performed_via_github_app: { id: 1 }, body: `- \`odd: @foo\`: @alice\nreport back @here\n${TESTER_PING_MARKER}` }
    ];
    assert.deepStrictEqual([...previouslyPinged(comments, 1)], ['alice']);
  });
});

describe('buildTesterPingComment', () => {
  test('groups by label in order and skips listed logins', () => {
    const { testers } = parseTesters('target/x86 alice bob\ncore packages carol\n', ['target/x86', 'core packages']);
    const body = buildTesterPingComment(testers, new Set(['bob']));
    assert.match(body, /- `core packages`: @carol\n- `target\/x86`: @alice\n/);
    assert.ok(!body.includes('@bob'));
    assert.ok(body.includes(TESTER_PING_MARKER));
  });

  test('mentions a tester listed under several labels once', () => {
    const { testers } = parseTesters('target/x86 alice\ncore alice bob\n', ['target/x86', 'core']);
    const body = buildTesterPingComment(testers, new Set());
    assert.strictEqual(body.match(/@alice/g).length, 1);
    assert.match(body, /- `core`: @alice @bob\n/);
    assert.ok(!body.includes('`target/x86`'));
  });

  test('renders a label with markdown or a mention as code', () => {
    const { testers } = parseTesters('evil @foo `x` alice\n', ['evil @foo `x`']);
    const body = buildTesterPingComment(testers, new Set());
    assert.match(body, /- `` evil @foo `x` ``: @alice\n/);
  });

  test('returns null when nobody is left', () => {
    const { testers } = parseTesters('target/x86 alice\n', ['target/x86']);
    assert.strictEqual(buildTesterPingComment(testers, new Set(['alice'])), null);
  });
});

describe('handleTesterPing', { concurrency: 1 }, () => {
  let originalFetch;
  let requests;
  let existingComments;
  let listStatus;
  let postStatus;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const method = options?.method || 'GET';
      requests.push({ url, method, body: options?.body ? JSON.parse(options.body) : null });
      if (method === 'GET' && url.includes('/comments')) {
        return new Response(JSON.stringify(existingComments), { status: listStatus });
      }
      return new Response(JSON.stringify({ id: 1 }), { status: postStatus });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  const data = (labels, author = 'author') => ({
    pull_request: { number: 7, user: { login: author }, labels: labels.map(name => ({ name })) }
  });

  test('posts one comment for new testers, skipping the author', async () => {
    requests = [];
    existingComments = [];
    listStatus = 200;
    postStatus = 201;
    const result = await handleTesterPing(data(['target/x86', 'RFT'], 'Bob'), 'tok', 'o/r', 'target/x86 alice bob\n', new Set(), 1);
    assert.strictEqual(result, 'Pinged testers on #7');
    const post = requests.find(r => r.method === 'POST');
    assert.ok(post.url.endsWith('/issues/7/comments'));
    assert.match(post.body.body, /@alice/);
    assert.ok(!post.body.body.includes('@bob'));
  });

  test('does not ping the same testers twice', async () => {
    requests = [];
    listStatus = 200;
    postStatus = 201;
    existingComments = [{ performed_via_github_app: { id: 1 }, body: `- \`target/x86\`: @alice\n${TESTER_PING_MARKER}` }];
    const result = await handleTesterPing(data(['target/x86']), 'tok', 'o/r', 'target/x86 alice\n', new Set(), 1);
    assert.strictEqual(result, 'Every listed tester was pinged already');
    assert.ok(!requests.some(r => r.method === 'POST'));
  });

  test('makes no call when nobody is listed', async () => {
    requests = [];
    existingComments = [];
    listStatus = 200;
    postStatus = 201;
    const result = await handleTesterPing(data(['target/ath79']), 'tok', 'o/r', 'target/x86 alice\n', new Set(), 1);
    assert.strictEqual(result, 'No testers listed for the labels on this pull request');
    assert.strictEqual(requests.length, 0);
  });

  test('fails when the earlier comments cannot be listed', async () => {
    requests = [];
    existingComments = [];
    listStatus = 404;
    postStatus = 201;
    await assert.rejects(
      handleTesterPing(data(['target/x86']), 'tok', 'o/r', 'target/x86 alice\n', new Set(), 1),
      /Failed to list comments on #7 \(HTTP 404\)/
    );
    assert.ok(!requests.some(r => r.method === 'POST'));
  });

  test('fails when the comment is not posted', async () => {
    requests = [];
    existingComments = [];
    listStatus = 200;
    postStatus = 403;
    await assert.rejects(
      handleTesterPing(data(['target/x86']), 'tok', 'o/r', 'target/x86 alice\n', new Set(), 1),
      /Failed to post tester ping on #7 \(HTTP 403\)/
    );
  });
});
