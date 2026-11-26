import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import worker from '../src/index.js';
import { calculateHmac, generateTestPrivateKeyPEM } from './github-mocks.js';

const APP_ID = 123;
const CODEOWNERS = [
  '# rft: /target/linux/mediatek/ @alice @bob @author1 @maint1',
  '# rft: /target/linux/x86/ @carol',
  '/package/network/services/dropbear/ @owner # rft: @dave'
].join('\n');

let fetchMock = null;
let originalFetch;
let privateKey;
before(async () => {
  privateKey = await generateTestPrivateKeyPEM();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => fetchMock(url, options);
});
after(() => {
  globalThis.fetch = originalFetch;
});

// One RFT delivery against a repository whose reads are answered from the
// arguments. Returns what was asked and what was posted.
async function sendLabel({ label = 'RFT', sender = { login: 'maint1', type: 'User' }, state = 'open', codeowners = CODEOWNERS, rootCodeowners = null, files = ['target/linux/mediatek/dts/mt7986a-example.dts'], comments = [], fail = {}, env = {} } = {}) {
  const calls = [];
  const posted = [];
  fetchMock = async (url, options) => {
    const method = options?.method || 'GET';
    calls.push({ url, method });
    if (url.includes('/access_tokens')) return new Response(JSON.stringify({ token: 'mocktoken' }), { status: 200 });
    if (url.includes('/graphql')) {
      if (fail.codeowners) return new Response('boom', { status: 500 });
      const vars = JSON.parse(options.body).variables;
      const repo0 = {};
      for (const [key, expr] of Object.entries(vars)) {
        if (!key.startsWith('e0_')) continue;
        const field = `f${key.slice(3)}`;
        const text = expr === 'main:.github/CODEOWNERS' ? codeowners : expr === 'main:CODEOWNERS' ? rootCodeowners : null;
        repo0[field] = text !== null ? { oid: 'x', text, isBinary: false } : null;
      }
      return new Response(JSON.stringify({ data: { repo0 } }), { status: 200 });
    }
    if (url.includes('/pulls/77/files')) {
      const page = Number(new URL(url).searchParams.get('page'));
      const slice = files.slice((page - 1) * 100, page * 100).map(filename => ({ filename }));
      return new Response(JSON.stringify(slice), { status: 200 });
    }
    if (url.includes('/issues/77/comments')) {
      if (method === 'POST') {
        posted.push(JSON.parse(options.body).body);
        return new Response('{}', { status: 201 });
      }
      if (fail.comments) return new Response('nope', { status: 502 });
      const page = Number(new URL(url).searchParams.get('page'));
      return new Response(JSON.stringify(comments.slice((page - 1) * 100, page * 100)), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };

  const payload = JSON.stringify({
    action: 'labeled',
    label: { name: label },
    sender,
    pull_request: { number: 77, state, user: { login: 'author1', type: 'User' }, base: { ref: 'main', sha: 'b' }, head: { ref: 'x', sha: 'h' } },
    repository: { full_name: 'test/repo', default_branch: 'main' },
    installation: { id: 456 }
  });
  const secret = 'mysecret';
  const response = await worker.fetch(new Request('http://localhost/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': await calculateHmac(secret, payload) },
    body: payload
  }), { WEBHOOK_SECRET: secret, APP_ID: String(APP_ID), PRIVATE_KEY: privateKey, ...env });
  return { response, text: await response.text(), calls, posted };
}

const ownPing = (body) => ({ body, performed_via_github_app: { id: APP_ID }, user: { login: 'bot[bot]', type: 'Bot' } });

describe('tester ping', () => {
  test('mentions the testers of the changed files once, leaving out the author and whoever added the label', async () => {
    const { response, posted } = await sendLabel();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(posted.length, 1);
    assert.ok(posted[0].startsWith('<!-- tester-ping -->\n@alice @bob: this pull request is ready for testing.'), posted[0]);
    assert.ok(!posted[0].includes('@author1') && !posted[0].includes('@maint1') && !posted[0].includes('@carol'));
  });

  test('does not mention a tester an earlier ping did', async () => {
    const { posted } = await sendLabel({ comments: [ownPing('<!-- tester-ping -->\n@alice: this pull request is ready for testing.')] });
    assert.ok(posted[0].includes('\n@bob:'), posted[0]);
    const again = await sendLabel({ comments: [ownPing('<!-- tester-ping -->\n@alice @bob: ready.')] });
    assert.deepStrictEqual(again.posted, []);
    assert.strictEqual(again.text, 'Every tester was already pinged');
  });

  test('ignores a ping someone else wrote', async () => {
    const { posted } = await sendLabel({ comments: [{ body: '<!-- tester-ping -->\n@alice @bob', user: { login: 'someone', type: 'User' } }] });
    assert.ok(posted[0].includes('@alice @bob:'));
  });

  test('pings nobody when it cannot tell who was already pinged', async () => {
    const failed = await sendLabel({ fail: { comments: true } });
    assert.strictEqual(failed.response.status, 500);
    assert.deepStrictEqual(failed.posted, []);
    const tooMany = await sendLabel({ comments: Array.from({ length: 1000 }, () => ({ body: 'hi', user: { login: 'x', type: 'User' } })) });
    assert.deepStrictEqual(tooMany.posted, []);
  });

  test('fails the delivery when CODEOWNERS could not be read, and stays quiet without one', async () => {
    const failed = await sendLabel({ fail: { codeowners: true } });
    assert.strictEqual(failed.response.status, 500);
    assert.deepStrictEqual(failed.posted, []);
    const absent = await sendLabel({ codeowners: null });
    assert.strictEqual(absent.text, 'No CODEOWNERS on main');
    assert.deepStrictEqual(absent.posted, []);
  });

  test('stops at the first CODEOWNERS that exists, even an empty one', async () => {
    const { text, posted } = await sendLabel({ codeowners: '', rootCodeowners: CODEOWNERS });
    assert.strictEqual(text, 'No testers in .github/CODEOWNERS');
    assert.deepStrictEqual(posted, []);
  });

  test('pings nobody when the reads would eat into the attempts the comment needs', async () => {
    const { text, posted } = await sendLabel({ env: { SUBREQUEST_BUDGET_LIMIT: '6' } });
    assert.strictEqual(text, 'Ran out of requests before every file and comment was read, so nobody was pinged');
    assert.deepStrictEqual(posted, []);
  });

  test('says so when the file list or the mentions were cut short', async () => {
    const logins = Array.from({ length: 55 }, (_, i) => `@t${i}`).join(' ');
    const files = Array.from({ length: 1001 }, (_, i) => `target/linux/mediatek/f${i}`);
    const { posted } = await sendLabel({ codeowners: `# rft: /target/linux/mediatek/ ${logins}`, files });
    assert.strictEqual((posted[0].match(/@t\d+/g) || []).length, 50);
    assert.ok(posted[0].includes('Only its first 1000 files were matched.'));
    assert.ok(posted[0].includes('5 more testers were left out to keep this comment to 50 mentions.'));
  });

  test('drops any other label, a bot and a closed pull request before minting a token', async () => {
    for (const over of [{ label: 'target/mediatek' }, { sender: { login: 'labeler[bot]', type: 'Bot' } }, { state: 'closed' }]) {
      const { text, calls } = await sendLabel(over);
      assert.strictEqual(text, 'Ignored pull request label');
      assert.deepStrictEqual(calls, [], JSON.stringify(over));
    }
  });
});
