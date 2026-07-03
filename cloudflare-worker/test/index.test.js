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

describe('Backport Cherry-pick and Bypass Validation', () => {
  let originalFetch;
  let fetchMock;
  let originalImportKey;
  let originalSign;
  let postedCheckRuns = [];

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (fetchMock) {
        return fetchMock(url, options);
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    originalImportKey = crypto.subtle.importKey;
    crypto.subtle.importKey = async (format, keyData, algorithm, extractable, keyUsages) => {
      if (algorithm.name === "RSASSA-PKCS1-v1_5") {
        return { type: 'private', extractable: false, algorithm, usages: keyUsages };
      }
      return originalImportKey.call(crypto.subtle, format, keyData, algorithm, extractable, keyUsages);
    };

    originalSign = crypto.subtle.sign;
    crypto.subtle.sign = async (algorithm, key, data) => {
      if (algorithm === "RSASSA-PKCS1-v1_5") {
        return new ArrayBuffer(256);
      }
      return originalSign.call(crypto.subtle, algorithm, key, data);
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    crypto.subtle.importKey = originalImportKey;
    crypto.subtle.sign = originalSign;
  });

  async function sendWebhookPR(prBody, baseBranch, authorAssociation, commitMessage, comments = []) {
    postedCheckRuns = [];
    fetchMock = async (url, options) => {
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'mocktoken' }), { status: 200 });
      }
      if (url.includes('/formalities.json')) {
        return new Response(JSON.stringify({
          check_branch: false,
          require_linked_github_account: false,
          require_body: false
        }), { status: 200 });
      }
      if (url.includes('/labels')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/issues/123/comments') && (!options || options.method === 'GET')) {
        const parsedUrl = new URL(url);
        const page = parsedUrl.searchParams.get('page') || '1';
        if (page === '1') {
          return new Response(JSON.stringify(comments), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/check-runs')) {
        if (options && options.method === 'POST') {
          const body = JSON.parse(options.body);
          postedCheckRuns.push(body);
        }
        return new Response(JSON.stringify({}), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const payload = JSON.stringify({
      action: 'opened',
      pull_request: {
        number: 123,
        title: 'test pr',
        body: prBody,
        base: { ref: baseBranch },
        head: { ref: 'feature-branch', sha: 'abcdef1234567890' },
        author_association: authorAssociation,
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

    const baseMock = fetchMock;
    fetchMock = async (url, options) => {
      if (url.includes('/commits/abcdef1234567890')) {
        if (options && options.headers && options.headers.Accept === 'application/vnd.github.patch') {
          return new Response('Mock patch content', { status: 200 });
        }
        return new Response(JSON.stringify({
          parents: [{ sha: 'parent-sha' }],
          commit: {
            message: commitMessage,
            author: { name: 'John Doe', email: 'john@doe.com' },
            committer: { name: 'John Doe', email: 'john@doe.com' },
            verification: { verified: true, key_id: 'GPGKEYID' }
          }
        }), { status: 200 });
      }
      if (url.includes('/commits')) {
        return new Response(JSON.stringify([
          {
            sha: 'abcdef1234567890',
            html_url: 'https://github.com/test/repo/commit/abcdef1234567890',
            commit: {
              message: commitMessage,
              author: { name: 'John Doe', email: 'john@doe.com' },
              committer: { name: 'John Doe', email: 'john@doe.com' },
              verification: { verified: true, key_id: 'GPGKEYID' }
            }
          }
        ]), { status: 200 });
      }
      return baseMock(url, options);
    };

    const response = await worker.fetch(request, {
      WEBHOOK_SECRET: secret,
      APP_ID: '12345',
      PRIVATE_KEY: 'YW55Y29udGVudA=='
    }, {});

    return response;
  }

  test('fails on stable branch backport if commit message lacks cherry-picked context line', async () => {
    const response = await sendWebhookPR('', 'openwrt-25.12', 'NONE', 'mypkg: update to 1.2.3\n\nSigned-off-by: John Doe <john@doe.com>');
    assert.strictEqual(response.status, 200);
    
    const commitCheck = postedCheckRuns.find(cr => cr.name === 'FormalityCheck / Git & Commits');
    assert.ok(commitCheck);
    assert.strictEqual(commitCheck.conclusion, 'failure');
    assert.match(commitCheck.output.text, /Commit to stable branch must be marked as cherry-picked/);
  });

  test('passes on stable branch backport with warning if commit message lacks cherry-picked context line but PR description contains [allow cherry-pick] and author is a maintainer', async () => {
    const response = await sendWebhookPR('Please [allow cherry-pick] for this PR', 'openwrt-25.12', 'OWNER', 'mypkg: update to 1.2.3\n\nSigned-off-by: John Doe <john@doe.com>');
    assert.strictEqual(response.status, 200);

    const commitCheck = postedCheckRuns.find(cr => cr.name === 'FormalityCheck / Git & Commits');
    assert.ok(commitCheck);
    assert.strictEqual(commitCheck.conclusion, 'success');
    assert.match(commitCheck.output.text, /bypasses cherry-pick requirement via override command/);
  });

  test('fails on stable branch backport if commit message lacks cherry-picked context line and non-maintainer specifies [allow cherry-pick] in PR description', async () => {
    const response = await sendWebhookPR('Please [allow cherry-pick] for this PR', 'openwrt-25.12', 'NONE', 'mypkg: update to 1.2.3\n\nSigned-off-by: John Doe <john@doe.com>');
    assert.strictEqual(response.status, 200);

    const commitCheck = postedCheckRuns.find(cr => cr.name === 'FormalityCheck / Git & Commits');
    assert.ok(commitCheck);
    assert.strictEqual(commitCheck.conclusion, 'failure');
    assert.match(commitCheck.output.text, /Commit to stable branch must be marked as cherry-picked/);
  });

  test('passes on stable branch backport with warning if commit message lacks cherry-picked context line, PR description is from contributor, but a maintainer posted an [allow cherry-pick] comment', async () => {
    const comments = [
      { body: 'Contribute comment', author_association: 'NONE' },
      { body: 'Looks good, [allow cherry-pick] please', author_association: 'MEMBER' }
    ];
    const response = await sendWebhookPR('Contribute feature', 'openwrt-25.12', 'NONE', 'mypkg: update to 1.2.3\n\nSigned-off-by: John Doe <john@doe.com>', comments);
    assert.strictEqual(response.status, 200);

    const commitCheck = postedCheckRuns.find(cr => cr.name === 'FormalityCheck / Git & Commits');
    assert.ok(commitCheck);
    assert.strictEqual(commitCheck.conclusion, 'success');
    assert.match(commitCheck.output.text, /bypasses cherry-pick requirement via override command/);
  });

  test('fails on stable branch backport if commit message lacks cherry-picked context line, PR description is from contributor, and a non-maintainer posted an [allow cherry-pick] comment', async () => {
    const comments = [
      { body: 'Can someone [allow cherry-pick] please?', author_association: 'NONE' }
    ];
    const response = await sendWebhookPR('Contribute feature', 'openwrt-25.12', 'NONE', 'mypkg: update to 1.2.3\n\nSigned-off-by: John Doe <john@doe.com>', comments);
    assert.strictEqual(response.status, 200);

    const commitCheck = postedCheckRuns.find(cr => cr.name === 'FormalityCheck / Git & Commits');
    assert.ok(commitCheck);
    assert.strictEqual(commitCheck.conclusion, 'failure');
    assert.match(commitCheck.output.text, /Commit to stable branch must be marked as cherry-picked/);
  });

  test('passes on stable branch backport with warning if PR comment contains hyphenated [allow-cherry-pick]', async () => {
    const comments = [
      { body: 'Please [allow-cherry-pick]', author_association: 'MEMBER' }
    ];
    const response = await sendWebhookPR('Contribute feature', 'openwrt-25.12', 'NONE', 'mypkg: update to 1.2.3\n\nSigned-off-by: John Doe <john@doe.com>', comments);
    assert.strictEqual(response.status, 200);

    const commitCheck = postedCheckRuns.find(cr => cr.name === 'FormalityCheck / Git & Commits');
    assert.ok(commitCheck);
    assert.strictEqual(commitCheck.conclusion, 'success');
    assert.match(commitCheck.output.text, /bypasses cherry-pick requirement via override command/);
  });

  test('successfully paginates to find bypass comment on page 2 when page 1 is full of other comments', async () => {
    const page1Comments = Array.from({ length: 100 }, (_, i) => ({
      body: `Dummy comment ${i}`,
      author_association: 'NONE'
    }));
    const page2Comments = [
      { body: 'Please [allow cherry-pick]', author_association: 'OWNER' }
    ];

    postedCheckRuns = [];
    fetchMock = async (url, options) => {
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'mocktoken' }), { status: 200 });
      }
      if (url.includes('/formalities.json')) {
        return new Response(JSON.stringify({
          check_branch: false,
          require_linked_github_account: false,
          require_body: false
        }), { status: 200 });
      }
      if (url.includes('/labels')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/commits')) {
        const commitData = {
          sha: 'abcdef123456',
          html_url: 'https://github.com/commit/abcdef',
          commit: {
            author: { name: 'John Doe', email: 'john@doe.com' },
            committer: { name: 'John Doe', email: 'john@doe.com' },
            message: 'mypkg: update to 1.2.3\n\nSigned-off-by: John Doe <john@doe.com>'
          }
        };
        if (url.endsWith('/commits')) {
          return new Response(JSON.stringify([commitData]), { status: 200 });
        }
        return new Response(JSON.stringify(commitData), { status: 200 });
      }
      if (url.includes('/issues/123/comments') && (!options || options.method === 'GET')) {
        const parsedUrl = new URL(url);
        const page = parsedUrl.searchParams.get('page') || '1';
        if (page === '1') {
          return new Response(JSON.stringify(page1Comments), { status: 200 });
        }
        if (page === '2') {
          return new Response(JSON.stringify(page2Comments), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/check-runs')) {
        if (options && options.method === 'POST') {
          const body = JSON.parse(options.body);
          postedCheckRuns.push(body);
        }
        return new Response(JSON.stringify({}), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const payload = JSON.stringify({
      action: 'opened',
      pull_request: {
        number: 123,
        title: 'test pr',
        body: 'Contribute feature',
        base: { ref: 'openwrt-25.12' },
        head: { ref: 'feature-branch' },
        author_association: 'NONE',
        commits_url: 'https://api.github.com/repos/test/repo/pulls/123/commits',
        user: { login: 'somecontributor', type: 'User' }
      },
      repository: {
        full_name: 'test/repo',
        owner: { login: 'test' }
      },
      installation: { id: 456 }
    });

    const secret = 'mysecret';
    const signature = await calculateHmac(secret, payload);

    const response = await worker.fetch(new Request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature
      },
      body: payload
    }), {
      WEBHOOK_SECRET: secret,
      APP_ID: '123',
      PRIVATE_KEY: 'YW55Y29udGVudA=='
    });

    assert.strictEqual(response.status, 200);

    const commitCheck = postedCheckRuns.find(cr => cr.name === 'FormalityCheck / Git & Commits');
    assert.ok(commitCheck);
    assert.strictEqual(commitCheck.conclusion, 'success');
    assert.match(commitCheck.output.text, /bypasses cherry-pick requirement via override command/);
  });

  test('falls back to fetching comments in comment-management block if initial prefetch fails with 500', async () => {
    let callCount = 0;
    const comments = [
      { body: 'Looks good, [allow cherry-pick]', author_association: 'OWNER' }
    ];

    postedCheckRuns = [];
    fetchMock = async (url, options) => {
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'mocktoken' }), { status: 200 });
      }
      if (url.includes('/formalities.json')) {
        return new Response(JSON.stringify({
          check_branch: false,
          require_linked_github_account: false,
          require_body: false
        }), { status: 200 });
      }
      if (url.includes('/labels')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/commits')) {
        const commitData = {
          sha: 'abcdef123456',
          html_url: 'https://github.com/commit/abcdef',
          commit: {
            author: { name: 'John Doe', email: 'john@doe.com' },
            committer: { name: 'John Doe', email: 'john@doe.com' },
            message: 'mypkg: update to 1.2.3\n\nSigned-off-by: John Doe <john@doe.com>'
          }
        };
        if (url.endsWith('/commits')) {
          return new Response(JSON.stringify([commitData]), { status: 200 });
        }
        return new Response(JSON.stringify(commitData), { status: 200 });
      }
      if (url.includes('/issues/123/comments') && (!options || options.method === 'GET')) {
        callCount++;
        if (callCount === 1) {
          return new Response('Internal Server Error', { status: 500 });
        }
        return new Response(JSON.stringify(comments), { status: 200 });
      }
      if (url.includes('/check-runs')) {
        if (options && options.method === 'POST') {
          const body = JSON.parse(options.body);
          postedCheckRuns.push(body);
        }
        return new Response(JSON.stringify({}), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const payload = JSON.stringify({
      action: 'opened',
      pull_request: {
        number: 123,
        title: 'test pr',
        body: 'Contribute feature',
        base: { ref: 'openwrt-25.12' },
        head: { ref: 'feature-branch' },
        author_association: 'NONE',
        commits_url: 'https://api.github.com/repos/test/repo/pulls/123/commits',
        user: { login: 'somecontributor', type: 'User' }
      },
      repository: {
        full_name: 'test/repo',
        owner: { login: 'test' }
      },
      installation: { id: 456 }
    });

    const secret = 'mysecret';
    const signature = await calculateHmac(secret, payload);

    const response = await worker.fetch(new Request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature
      },
      body: payload
    }), {
      WEBHOOK_SECRET: secret,
      APP_ID: '123',
      PRIVATE_KEY: 'YW55Y29udGVudA=='
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(callCount, 2);
  });
});
