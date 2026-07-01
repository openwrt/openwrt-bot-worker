import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import worker from '../src/index.js';

async function calculateHmac(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const hashArray = Array.from(new Uint8Array(sigBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hashHex}`;
}

describe('Cloudflare Worker Webhook & Error Handling', () => {
  let originalFetch;
  let fetchMock;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (fetchMock) {
        return fetchMock(url, options);
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns 400 for non-webhook path', async () => {
    const request = new Request('http://localhost/invalid', {
      method: 'POST'
    });
    const response = await worker.fetch(request, {}, {});
    assert.strictEqual(response.status, 400);
    const body = await response.text();
    assert.strictEqual(body, 'Invalid Request');
  });

  test('returns 400 for non-POST method', async () => {
    const request = new Request('http://localhost/webhook', {
      method: 'GET'
    });
    const response = await worker.fetch(request, {}, {});
    assert.strictEqual(response.status, 400);
    const body = await response.text();
    assert.strictEqual(body, 'Invalid Request');
  });

  test('rejects webhook with invalid signature', async () => {
    const payload = JSON.stringify({ action: 'opened' });
    const request = new Request('http://localhost/webhook', {
      method: 'POST',
      body: payload,
      headers: {
        'x-hub-signature-256': 'sha256=invalidhashvalueherepathshouldbeforbiddenforinvalidhashvaluehere',
        'x-github-event': 'pull_request'
      }
    });
    const response = await worker.fetch(request, { WEBHOOK_SECRET: 'secret' }, {});
    assert.strictEqual(response.status, 403);
    const body = await response.text();
    assert.strictEqual(body, 'Invalid signature');
  });

  test('catches global exception and returns detailed crashlog JSON (HTTP 500)', async () => {
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: {
        user: { login: 'someuser', type: 'User' },
        number: 123
      },
      installation: { id: 456 },
      repository: { full_name: 'test/repo' }
    });
    const secret = 'mysecret';
    const signature = await calculateHmac(secret, payload);

    const request = new Request('http://localhost/webhook', {
      method: 'POST',
      body: payload,
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'pull_request'
      }
    });

    const response = await worker.fetch(request, {
      WEBHOOK_SECRET: secret,
      APP_ID: '12345',
      PRIVATE_KEY: 'invalidpemkey'
    }, {});

    assert.strictEqual(response.status, 500);
    const resJson = await response.json();
    assert.ok(resJson.exception);
    assert.ok(resJson.exception.message);
    assert.strictEqual(resJson.exception.stack, undefined);
    assert.ok(resJson.exception.timestamp);
    assert.strictEqual(resJson.message, resJson.exception.message);
  });

  test('throws and catches explicit error when GitHub API returns non-200 status for commits list', async () => {
    const payload = JSON.stringify({
      action: 'synchronize',
      pull_request: {
        user: { login: 'someuser', type: 'User' },
        number: 123,
        title: 'test pr',
        base: { ref: 'main' },
        head: { ref: 'feature' },
        commits_url: 'https://api.github.com/repos/test/repo/pulls/123/commits'
      },
      installation: { id: 456 },
      repository: { full_name: 'test/repo' }
    });
    const secret = 'mysecret';
    const signature = await calculateHmac(secret, payload);

    const request = new Request('http://localhost/webhook', {
      method: 'POST',
      body: payload,
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'pull_request'
      }
    });

    fetchMock = async (url, options) => {
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'mocktoken' }), { status: 200 });
      }
      if (url.includes('/formalities.json')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes('/labels')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/commits')) {
        return new Response('API rate limit exceeded', { status: 403 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    const originalImportKey = crypto.subtle.importKey;
    crypto.subtle.importKey = async (format, keyData, algorithm, extractable, keyUsages) => {
      if (algorithm.name === "RSASSA-PKCS1-v1_5") {
        return { type: 'private', extractable: false, algorithm, usages: keyUsages };
      }
      return originalImportKey.call(crypto.subtle, format, keyData, algorithm, extractable, keyUsages);
    };
    const originalSign = crypto.subtle.sign;
    crypto.subtle.sign = async (algorithm, key, data) => {
      if (algorithm === "RSASSA-PKCS1-v1_5") {
        return new ArrayBuffer(256);
      }
      return originalSign.call(crypto.subtle, algorithm, key, data);
    };

    try {
      const response = await worker.fetch(request, {
        WEBHOOK_SECRET: secret,
        APP_ID: '12345',
        PRIVATE_KEY: 'YW55Y29udGVudA=='
      }, {});

      assert.strictEqual(response.status, 500);
      const resJson = await response.json();
      assert.ok(resJson.exception);
      assert.match(resJson.exception.message, /GitHub API returned HTTP 403/);
    } finally {
      crypto.subtle.importKey = originalImportKey;
      crypto.subtle.sign = originalSign;
      fetchMock = null;
    }
  });

  test('handles thrown null value in catch block gracefully without secondary TypeError', async () => {
    const badRequest = {
      method: 'POST',
      url: 'http://localhost/webhook',
      headers: {
        get(name) {
          throw null;
        }
      },
      text() {
        return Promise.resolve(JSON.stringify({}));
      }
    };

    const response = await worker.fetch(badRequest, {}, {});
    assert.strictEqual(response.status, 500);
    const resJson = await response.json();
    assert.ok(resJson.exception);
    assert.strictEqual(resJson.exception.message, 'null');
    assert.strictEqual(resJson.message, 'null');
  });

  test('handles thrown custom object in catch block gracefully without secondary TypeError', async () => {
    const badRequest = {
      method: 'POST',
      url: 'http://localhost/webhook',
      headers: {
        get(name) {
          throw { name: 'CustomError', message: 'Something went wrong' };
        }
      },
      text() {
        return Promise.resolve(JSON.stringify({}));
      }
    };

    const response = await worker.fetch(badRequest, {}, {});
    assert.strictEqual(response.status, 500);
    const resJson = await response.json();
    assert.ok(resJson.exception);
    assert.strictEqual(resJson.exception.name, 'CustomError');
    assert.strictEqual(resJson.exception.message, 'Something went wrong');
    assert.strictEqual(resJson.message, 'Something went wrong');
  });
});
