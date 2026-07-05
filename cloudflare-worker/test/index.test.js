import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import worker from '../src/index.js';
import { handleScheduled } from '../src/stale.js';
import { githubApiCall } from '../src/github.js';

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

async function generateTestPrivateKeyPEM() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );

  const exported = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const exportedB64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  return `-----BEGIN PRIVATE KEY-----\n${exportedB64}\n-----END PRIVATE KEY-----`;
}

describe('Cloudflare Worker Webhook & Error Handling', { concurrency: 1 }, () => {
  let originalFetch;
  let fetchMock;
  let privateKeyPEM;

  before(async () => {
    privateKeyPEM = await generateTestPrivateKeyPEM();
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

  test('handles large PRs with > 15 commits by fetching overall PR patch and checking PR-wide', async () => {
    // Generate 17 commits
    const commitsList = Array.from({ length: 17 }, (_, i) => ({
      sha: `sha123456789${i}`,
      html_url: `https://github.com/commit/sha123456789${i}`,
      commit: {
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' },
        message: `mypkg: commit ${i}\n\nSigned-off-by: John Doe <john@doe.com>`
      }
    }));

    const payload = JSON.stringify({
      action: 'opened',
      pull_request: {
        number: 123,
        title: 'test pr crun: update to 1.15',
        body: 'Large PR test',
        base: { ref: 'main' },
        head: { ref: 'feature-branch', sha: 'headsha' },
        commits_url: 'https://api.github.com/repos/test/repo/pulls/123/commits',
        url: 'https://api.github.com/repos/test/repo/pulls/123'
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

    let overallPrPatchFetched = false;
    let checkRunsPosted = [];

    fetchMock = async (url, options) => {
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'mocktoken' }), { status: 200 });
      }
      if (url.includes('/formalities.json')) {
        return new Response(JSON.stringify({
          check_branch: false,
          enable_comments: false,
          require_linked_github_account: false,
          require_body: false
        }), { status: 200 });
      }
      if (url.includes('/labels')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/pulls/123/commits')) {
        return new Response(JSON.stringify(commitsList), { status: 200 });
      }
      if (url.includes('/repos/test/repo/commits/')) {
        throw new Error(`Unexpected per-commit patch fetch in PR-wide mode: ${url}`);
      }
      if (url.endsWith('/pulls/123') && options && options.headers && options.headers.Accept === 'application/vnd.github.patch') {
        overallPrPatchFetched = true;
        // Return a mock patch that introduces PKG_VERSION bump for crun to 1.15
        const mockPatch = `diff --git a/utils/crun/Makefile b/utils/crun/Makefile
index 123456..789012 100644
--- a/utils/crun/Makefile
+++ b/utils/crun/Makefile
@@ -1,5 +1,5 @@
 PKG_NAME:=crun
-PKG_VERSION:=1.14
+PKG_VERSION:=1.15
 PKG_RELEASE:=1
 PKG_MAINTAINER:=John Doe <john@doe.com>
 PKG_LICENSE:=GPL-2.0-or-later
`;
        return new Response(mockPatch, { status: 200 });
      }
      if (url.includes('/check-runs')) {
        if (options && options.method === 'POST') {
          checkRunsPosted.push(JSON.parse(options.body));
        }
        return new Response(JSON.stringify({}), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
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

      assert.strictEqual(response.status, 200);
      assert.ok(overallPrPatchFetched);
      
      const makefileCheck = checkRunsPosted.find(cr => cr.name === 'FormalityCheck / OpenWrt Makefiles');
      assert.ok(makefileCheck);
      assert.strictEqual(makefileCheck.conclusion, 'success');
    } finally {
      crypto.subtle.importKey = originalImportKey;
      crypto.subtle.sign = originalSign;
      fetchMock = null;
    }
  });

  test('handles large PRs modifying > 15 packages by warning and skipping the release bump audit', async () => {
    // Generate 17 commits
    const commitsList = Array.from({ length: 17 }, (_, i) => ({
      sha: `sha123456789${i}`,
      html_url: `https://github.com/commit/sha123456789${i}`,
      commit: {
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' },
        message: `mypkg: commit ${i}\n\nSigned-off-by: John Doe <john@doe.com>`
      }
    }));

    const payload = JSON.stringify({
      action: 'opened',
      pull_request: {
        number: 123,
        title: 'test pr: update many packages',
        body: 'Large PR test',
        base: { ref: 'main' },
        head: { ref: 'feature-branch', sha: 'headsha' },
        commits_url: 'https://api.github.com/repos/test/repo/pulls/123/commits',
        url: 'https://api.github.com/repos/test/repo/pulls/123'
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

    let overallPrPatchFetched = false;
    let checkRunsPosted = [];

    fetchMock = async (url, options) => {
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'mocktoken' }), { status: 200 });
      }
      if (url.includes('/formalities.json')) {
        return new Response(JSON.stringify({
          check_branch: false,
          enable_comments: false,
          require_linked_github_account: false,
          require_body: false
        }), { status: 200 });
      }
      if (url.includes('/labels')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/pulls/123/commits')) {
        return new Response(JSON.stringify(commitsList), { status: 200 });
      }
      if (url.includes('/repos/test/repo/commits/')) {
        throw new Error(`Unexpected per-commit patch fetch in PR-wide mode: ${url}`);
      }
      if (url.endsWith('/pulls/123') && options && options.headers && options.headers.Accept === 'application/vnd.github.patch') {
        overallPrPatchFetched = true;
        let mockPatch = '';
        for (let i = 1; i <= 16; i++) {
          mockPatch += `diff --git a/package/utils/pkg${i}/Makefile b/package/utils/pkg${i}/Makefile
index 123456..789012 100644
--- a/package/utils/pkg${i}/Makefile
+++ b/package/utils/pkg${i}/Makefile
`;
        }
        return new Response(mockPatch, { status: 200 });
      }
      if (url.includes('/check-runs')) {
        if (options && options.method === 'POST') {
          checkRunsPosted.push(JSON.parse(options.body));
        }
        return new Response(JSON.stringify({}), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
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

      assert.strictEqual(response.status, 200);
      assert.ok(overallPrPatchFetched);
      
      const makefileCheck = checkRunsPosted.find(cr => cr.name === 'FormalityCheck / OpenWrt Makefiles');
      assert.ok(makefileCheck);
      assert.strictEqual(makefileCheck.conclusion, 'success');
      assert.match(makefileCheck.output.text, /Package release bump audit skipped/);
      assert.match(makefileCheck.output.text, /PR modifies 16 packages/);
    } finally {
      crypto.subtle.importKey = originalImportKey;
      crypto.subtle.sign = originalSign;
      fetchMock = null;
    }
  });

  test('adds warning when PR has more than 300 commits and commit audit is capped', async () => {
    const commitsList = Array.from({ length: 300 }, (_, i) => ({
      sha: `sha300${i}`,
      html_url: `https://github.com/commit/sha300${i}`,
      commit: {
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' },
        message: `mypkg: commit ${i}\n\nSigned-off-by: John Doe <john@doe.com>`
      }
    }));

    const payload = JSON.stringify({
      action: 'opened',
      pull_request: {
        number: 123,
        title: 'test pr: huge commit set',
        body: 'Large PR test',
        base: { ref: 'main' },
        head: { ref: 'feature-branch', sha: 'headsha' },
        commits: 350,
        commits_url: 'https://api.github.com/repos/test/repo/pulls/123/commits',
        url: 'https://api.github.com/repos/test/repo/pulls/123'
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

    let checkRunsPosted = [];

    fetchMock = async (url, options) => {
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'mocktoken' }), { status: 200 });
      }
      if (url.includes('/formalities.json')) {
        return new Response(JSON.stringify({
          check_branch: false,
          enable_comments: false,
          require_linked_github_account: false,
          require_body: false
        }), { status: 200 });
      }
      if (url.includes('/labels')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/pulls/123/commits')) {
        const parsedUrl = new URL(url);
        const page = Number(parsedUrl.searchParams.get('page') || '1');
        if (page > 3) {
          throw new Error(`Unexpected commit page requested: ${page}`);
        }
        const start = (page - 1) * 100;
        const end = page * 100;
        return new Response(JSON.stringify(commitsList.slice(start, end)), { status: 200 });
      }
      if (url.includes('/repos/test/repo/commits/')) {
        throw new Error(`Unexpected per-commit patch fetch in PR-wide mode: ${url}`);
      }
      if (url.endsWith('/pulls/123') && options && options.headers && options.headers.Accept === 'application/vnd.github.patch') {
        return new Response('', { status: 200 });
      }
      if (url.includes('/check-runs')) {
        if (options && options.method === 'POST') {
          checkRunsPosted.push(JSON.parse(options.body));
        }
        return new Response(JSON.stringify({}), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const originalImportKey = crypto.subtle.importKey;
    crypto.subtle.importKey = async (format, keyData, algorithm, extractable, keyUsages) => {
      if (algorithm.name === 'RSASSA-PKCS1-v1_5') {
        return { type: 'private', extractable: false, algorithm, usages: keyUsages };
      }
      return originalImportKey.call(crypto.subtle, format, keyData, algorithm, extractable, keyUsages);
    };
    const originalSign = crypto.subtle.sign;
    crypto.subtle.sign = async (algorithm, key, data) => {
      if (algorithm === 'RSASSA-PKCS1-v1_5') {
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

      assert.strictEqual(response.status, 200);

      const formalityCheck = checkRunsPosted.find(cr => cr.name === 'FormalityCheck / Git & Commits');
      assert.ok(formalityCheck);
      assert.match(formalityCheck.output.text, /Commit scan is capped at 300 commits/);
      assert.match(formalityCheck.output.text, /This PR has 350 commits/);
    } finally {
      crypto.subtle.importKey = originalImportKey;
      crypto.subtle.sign = originalSign;
      fetchMock = null;
    }
  });


  test('does not scan repository if enable_stale_bot is not true in formalities.json', async () => {
    const urls = [];
    fetchMock = async (url, options) => {
      urls.push(url);
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'inst-token' }), { status: 200 });
      }
      if (url.includes('/app/installations')) {
        return new Response(JSON.stringify([{ id: 101, account: { login: 'testorg' } }]), { status: 200 });
      }
      if (url.includes('/installation/repositories')) {
        return new Response(JSON.stringify({ repositories: [{ full_name: 'testorg/repo1' }] }), { status: 200 });
      }
      if (url.includes('/contents/.github/formalities.json')) {
        // formalities.json exists but enable_stale_bot is unset / false
        return new Response(JSON.stringify({ enable_stale_bot: false }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const env = {
        APP_ID: "12345",
        PRIVATE_KEY: privateKeyPEM
      };
      const ctx = {
        waitUntil: async (promise) => {
          await promise;
        }
      };

      // Invoke handleScheduled directly to await execution
      await handleScheduled(env);

      // Should have checked config but skipped label list and issues query
      assert.ok(urls.some(u => u.includes('/contents/.github/formalities.json')));
      assert.ok(!urls.some(u => u.includes('/labels')));
      assert.ok(!urls.some(u => u.includes('/issues')));
    } finally {
      fetchMock = null;
    }
  });

  test('marks inactive PRs stale if they violate guidelines', async () => {
    const apiCalls = [];
    fetchMock = async (url, options) => {
      apiCalls.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });

      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'inst-token' }), { status: 200 });
      }
      if (url.includes('/app/installations')) {
        return new Response(JSON.stringify([{ id: 101, account: { login: 'testorg' } }]), { status: 200 });
      }
      if (url.includes('/installation/repositories')) {
        return new Response(JSON.stringify({ repositories: [{ full_name: 'testorg/repo1' }] }), { status: 200 });
      }
      if (url.includes('/contents/.github/formalities.json')) {
        return new Response(JSON.stringify({ enable_stale_bot: true }), { status: 200 });
      }
      if (url.includes('/labels') && !url.includes('/issues/')) {
        return new Response(JSON.stringify([{ name: 'stale' }]), { status: 200 });
      }
      if (url.includes('/issues') && !url.includes('/events')) {
        // Query returns 1 open guidelines-violating PR (number 55) which is older than 14 days and doesn't have the stale label
        const daysAgo15 = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
        return new Response(JSON.stringify([
          {
            number: 55,
            updated_at: daysAgo15,
            labels: [{ name: 'not following guidelines' }],
            pull_request: {}
          }
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const env = {
        APP_ID: "12345",
        PRIVATE_KEY: privateKeyPEM
      };
      const ctx = {
        waitUntil: async (promise) => {
          await promise;
        }
      };

      await handleScheduled(env);

      // Verify it added the "stale" label and posted a warning comment
      const labelCall = apiCalls.find(c => c.url.includes('/issues/55/labels') && c.method === 'POST');
      assert.ok(labelCall);
      assert.deepStrictEqual(labelCall.body, { labels: ['stale'] });

      const commentCall = apiCalls.find(c => c.url.includes('/issues/55/comments') && c.method === 'POST');
      assert.ok(commentCall);
      assert.ok(commentCall.body.body.includes('inactive for 14 days'));
    } finally {
      fetchMock = null;
    }
  });

  test('removes stale label from active PRs (activity detected post-stale)', async () => {
    const apiCalls = [];
    fetchMock = async (url, options) => {
      apiCalls.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });

      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'inst-token' }), { status: 200 });
      }
      if (url.includes('/app/installations')) {
        return new Response(JSON.stringify([{ id: 101, account: { login: 'testorg' } }]), { status: 200 });
      }
      if (url.includes('/installation/repositories')) {
        return new Response(JSON.stringify({ repositories: [{ full_name: 'testorg/repo1' }] }), { status: 200 });
      }
      if (url.includes('/contents/.github/formalities.json')) {
        return new Response(JSON.stringify({ enable_stale_bot: true }), { status: 200 });
      }
      if (url.includes('/labels') && !url.includes('/issues/')) {
        return new Response(JSON.stringify([{ name: 'stale' }]), { status: 200 });
      }
      if (url.includes('/issues') && !url.includes('/events')) {
        // PR number 66 has both 'stale' and 'not following guidelines' labels
        // and was updated 1 minute ago (recent activity)
        const minuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
        return new Response(JSON.stringify([
          {
            number: 66,
            updated_at: minuteAgo,
            labels: [{ name: 'stale' }, { name: 'not following guidelines' }],
            pull_request: {}
          }
        ]), { status: 200 });
      }
      if (url.includes('/issues/66/events')) {
        // Stale label was added 1 hour ago (which is older than the recent 1-minute-ago update, i.e., user active post-stale)
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        return new Response(JSON.stringify([
          {
            event: 'labeled',
            label: { name: 'stale' },
            created_at: hourAgo
          }
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const env = {
        APP_ID: "12345",
        PRIVATE_KEY: privateKeyPEM
      };
      const ctx = {
        waitUntil: async (promise) => {
          await promise;
        }
      };

      await handleScheduled(env);

      // Verify it sent a DELETE request for the stale label
      const deleteCall = apiCalls.find(c => c.url.includes('/issues/66/labels/stale') && c.method === 'DELETE');
      assert.ok(deleteCall);
    } finally {
      fetchMock = null;
    }
  });

  test('closes stale PRs if close threshold is reached without activity', async () => {
    const apiCalls = [];
    fetchMock = async (url, options) => {
      apiCalls.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });

      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'inst-token' }), { status: 200 });
      }
      if (url.includes('/app/installations')) {
        return new Response(JSON.stringify([{ id: 101, account: { login: 'testorg' } }]), { status: 200 });
      }
      if (url.includes('/installation/repositories')) {
        return new Response(JSON.stringify({ repositories: [{ full_name: 'testorg/repo1' }] }), { status: 200 });
      }
      if (url.includes('/contents/.github/formalities.json')) {
        return new Response(JSON.stringify({ enable_stale_bot: true }), { status: 200 });
      }
      if (url.includes('/labels') && !url.includes('/issues/')) {
        return new Response(JSON.stringify([{ name: 'stale' }]), { status: 200 });
      }
      if (url.includes('/issues') && !url.includes('/events')) {
        // PR 77 has stale and guidelines labels and was updated 15 days ago
        const daysAgo15 = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
        return new Response(JSON.stringify([
          {
            number: 77,
            updated_at: daysAgo15,
            labels: [{ name: 'stale' }, { name: 'not following guidelines' }],
            pull_request: {}
          }
        ]), { status: 200 });
      }
      if (url.includes('/issues/77/events')) {
        // Stale label was added 15 days ago (older than 14 days stale threshold)
        const daysAgo15 = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
        return new Response(JSON.stringify([
          {
            event: 'labeled',
            label: { name: 'stale' },
            created_at: daysAgo15
          }
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const env = {
        APP_ID: "12345",
        PRIVATE_KEY: privateKeyPEM
      };
      const ctx = {
        waitUntil: async (promise) => {
          await promise;
        }
      };

      await handleScheduled(env);

      // Verify it sent a POST comment and a PATCH pulls state:closed
      const commentCall = apiCalls.find(c => c.url.includes('/issues/77/comments') && c.method === 'POST');
      assert.ok(commentCall);
      assert.ok(commentCall.body.body.includes('closed because it has been marked stale'));

      const patchCall = apiCalls.find(c => c.url.includes('/pulls/77') && c.method === 'PATCH');
      assert.ok(patchCall);
      assert.deepStrictEqual(patchCall.body, { state: 'closed' });
    } finally {
      fetchMock = null;
    }
  });

  test('removes stale label immediately if guidelines label was removed (resolved)', async () => {
    const apiCalls = [];
    fetchMock = async (url, options) => {
      apiCalls.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });

      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'inst-token' }), { status: 200 });
      }
      if (url.includes('/app/installations')) {
        return new Response(JSON.stringify([{ id: 101, account: { login: 'testorg' } }]), { status: 200 });
      }
      if (url.includes('/installation/repositories')) {
        return new Response(JSON.stringify({ repositories: [{ full_name: 'testorg/repo1' }] }), { status: 200 });
      }
      if (url.includes('/contents/.github/formalities.json')) {
        return new Response(JSON.stringify({ enable_stale_bot: true }), { status: 200 });
      }
      if (url.includes('/labels') && !url.includes('/issues/')) {
        return new Response(JSON.stringify([{ name: 'stale' }]), { status: 200 });
      }
      if (url.includes('/issues') && !url.includes('/events')) {
        // PR 88 has only the stale label (the guidelines label is missing/resolved)
        return new Response(JSON.stringify([
          {
            number: 88,
            updated_at: new Date().toISOString(),
            labels: [{ name: 'stale' }],
            pull_request: {}
          }
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const env = {
        APP_ID: "12345",
        PRIVATE_KEY: privateKeyPEM
      };
      const ctx = {
        waitUntil: async (promise) => {
          await promise;
        }
      };

      await handleScheduled(env);

      // Verify it sent a DELETE request for the stale label of PR 88
      const deleteCall = apiCalls.find(c => c.url.includes('/issues/88/labels/stale') && c.method === 'DELETE');
      assert.ok(deleteCall);
    } finally {
      fetchMock = null;
    }
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
        if (url.includes('/commits?') || url.endsWith('/commits')) {
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
        if (url.includes('/commits?') || url.endsWith('/commits')) {
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

  test('processes issue_comment created event on a pull request', async () => {
    let prFetched = false;
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
      if (url.endsWith('/pulls/123')) {
        prFetched = true;
        return new Response(JSON.stringify({
          number: 123,
          title: 'test pr',
          body: 'Bypass cherry-pick please',
          base: { ref: 'openwrt-25.12', sha: 'base-sha' },
          head: { ref: 'feature-branch', sha: 'abcdef1234567890' },
          author_association: 'NONE',
          commits_url: 'https://api.github.com/repos/test/repo/pulls/123/commits',
          user: { login: 'somecontributor', type: 'User' }
        }), { status: 200 });
      }
      if (url.includes('/commits/abcdef1234567890')) {
        if (options && options.headers && options.headers.Accept === 'application/vnd.github.patch') {
          return new Response('Mock patch content', { status: 200 });
        }
        return new Response(JSON.stringify({
          parents: [{ sha: 'parent-sha' }],
          commit: {
            message: 'mypkg: update\n\nSigned-off-by: John Doe <john@doe.com>',
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
              message: 'mypkg: update\n\nSigned-off-by: John Doe <john@doe.com>',
              author: { name: 'John Doe', email: 'john@doe.com' },
              committer: { name: 'John Doe', email: 'john@doe.com' },
              verification: { verified: true, key_id: 'GPGKEYID' }
            }
          }
        ]), { status: 200 });
      }
      if (url.includes('/issues/123/comments')) {
        return new Response(JSON.stringify([
          { body: '[allow cherry-pick]', author_association: 'MEMBER' }
        ]), { status: 200 });
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
      action: 'created',
      issue: {
        number: 123,
        pull_request: {
          url: 'https://api.github.com/repos/test/repo/pulls/123'
        }
      },
      comment: {
        body: '[allow cherry-pick]',
        author_association: 'MEMBER'
      },
      repository: {
        full_name: 'test/repo'
      },
      installation: { id: 456 }
    });

    const secret = 'mysecret';
    const signature = await calculateHmac(secret, payload);

    const response = await worker.fetch(new Request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': signature
      },
      body: payload
    }), {
      WEBHOOK_SECRET: secret,
      APP_ID: '123',
      PRIVATE_KEY: 'YW55Y29udGVudA=='
    });

    assert.strictEqual(response.status, 200);
    assert.ok(prFetched);
    const commitCheck = postedCheckRuns.find(cr => cr.name === 'FormalityCheck / Git & Commits');
    assert.ok(commitCheck);
    assert.strictEqual(commitCheck.conclusion, 'success');
  });

  test('truncates check run output text if it exceeds GitHub limits', async () => {
    // Generate a long list of commits with long messages to bloat the output text
    const commitsList = Array.from({ length: 300 }, (_, i) => ({
      sha: `sha${i}`.padEnd(40, 'x'),
      html_url: `https://github.com/commit/sha${i}`,
      commit: {
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' },
        message: `mypkg: ` + 'a'.repeat(250) + ` ${i}\n\nSigned-off-by: John Doe <john@doe.com>`
      }
    }));

    const payload = JSON.stringify({
      action: 'opened',
      pull_request: {
        number: 123,
        title: 'test pr: long output test',
        body: 'Large PR test',
        base: { ref: 'main' },
        head: { ref: 'feature-branch', sha: 'headsha' },
        commits_url: 'https://api.github.com/repos/test/repo/pulls/123/commits',
        url: 'https://api.github.com/repos/test/repo/pulls/123'
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

    let checkRunsPosted = [];

    fetchMock = async (url, options) => {
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'mocktoken' }), { status: 200 });
      }
      if (url.includes('/formalities.json')) {
        return new Response(JSON.stringify({
          check_branch: false,
          enable_comments: false,
          require_linked_github_account: false,
          require_body: false
        }), { status: 200 });
      }
      if (url.includes('/labels')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/pulls/123/commits')) {
        return new Response(JSON.stringify(commitsList), { status: 200 });
      }
      if (url.includes('/repos/test/repo/commits/')) {
        throw new Error(`Unexpected per-commit patch fetch in PR-wide mode: ${url}`);
      }
      if (url.endsWith('/pulls/123') && options && options.headers && options.headers.Accept === 'application/vnd.github.patch') {
        return new Response('', { status: 200 });
      }
      if (url.includes('/check-runs')) {
        if (options && options.method === 'POST') {
          checkRunsPosted.push(JSON.parse(options.body));
        }
        return new Response(JSON.stringify({}), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
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

      assert.strictEqual(response.status, 200);
      
      const commitCheck = checkRunsPosted.find(cr => cr.name === 'FormalityCheck / Git & Commits');
      assert.ok(commitCheck);
      const byteLength = new TextEncoder().encode(commitCheck.output.text).length;
      assert.ok(byteLength <= 65000);
      assert.ok(commitCheck.output.text.includes('[Output truncated due to GitHub character limit]'));
    } finally {
      crypto.subtle.importKey = originalImportKey;
      crypto.subtle.sign = originalSign;
      fetchMock = null;
    }
  });

  test('does not append truncation marker when check run output stays below limit', async () => {
    const commitsList = Array.from({ length: 20 }, (_, i) => ({
      sha: `sha${i}`.padEnd(40, 'x'),
      html_url: `https://github.com/commit/sha${i}`,
      commit: {
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' },
        message: `mypkg: short message ${i}\n\nSigned-off-by: John Doe <john@doe.com>`
      }
    }));

    const payload = JSON.stringify({
      action: 'opened',
      pull_request: {
        number: 123,
        title: 'test pr: non-truncated output',
        body: 'Small PR test',
        base: { ref: 'main' },
        head: { ref: 'feature-branch', sha: 'headsha' },
        commits_url: 'https://api.github.com/repos/test/repo/pulls/123/commits',
        url: 'https://api.github.com/repos/test/repo/pulls/123'
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

    let checkRunsPosted = [];

    fetchMock = async (url, options) => {
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'mocktoken' }), { status: 200 });
      }
      if (url.includes('/formalities.json')) {
        return new Response(JSON.stringify({
          check_branch: false,
          enable_comments: false,
          require_linked_github_account: false,
          require_body: false
        }), { status: 200 });
      }
      if (url.includes('/labels')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/pulls/123/commits')) {
        return new Response(JSON.stringify(commitsList), { status: 200 });
      }
      if (url.includes('/repos/test/repo/commits/')) {
        throw new Error(`Unexpected per-commit patch fetch in PR-wide mode: ${url}`);
      }
      if (url.endsWith('/pulls/123') && options && options.headers && options.headers.Accept === 'application/vnd.github.patch') {
        return new Response('', { status: 200 });
      }
      if (url.includes('/check-runs')) {
        if (options && options.method === 'POST') {
          checkRunsPosted.push(JSON.parse(options.body));
        }
        return new Response(JSON.stringify({}), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const response = await worker.fetch(request, {
        WEBHOOK_SECRET: secret,
        APP_ID: '12345',
        PRIVATE_KEY: 'YW55Y29udGVudA=='
      }, {});

      assert.strictEqual(response.status, 200);

      const commitCheck = checkRunsPosted.find(cr => cr.name === 'FormalityCheck / Git & Commits');
      assert.ok(commitCheck);
      const byteLength = new TextEncoder().encode(commitCheck.output.text).length;
      assert.ok(byteLength < 65000);
      assert.ok(!commitCheck.output.text.includes('[Output truncated due to GitHub character limit]'));
    } finally {
      fetchMock = null;
    }
  });

  test('caps truncated check run output at exactly 65000 characters', async () => {
    const commitsList = Array.from({ length: 350 }, (_, i) => ({
      sha: `sha${i}`.padEnd(40, 'x'),
      html_url: `https://github.com/commit/sha${i}`,
      commit: {
        author: { name: 'John Doe', email: 'john@doe.com' },
        committer: { name: 'John Doe', email: 'john@doe.com' },
        message: `mypkg: ` + 'b'.repeat(260) + ` ${i}\n\nSigned-off-by: John Doe <john@doe.com>`
      }
    }));

    const payload = JSON.stringify({
      action: 'opened',
      pull_request: {
        number: 123,
        title: 'test pr: exact truncation cap',
        body: 'Large PR test',
        commits: 350,
        base: { ref: 'main' },
        head: { ref: 'feature-branch', sha: 'headsha' },
        commits_url: 'https://api.github.com/repos/test/repo/pulls/123/commits',
        url: 'https://api.github.com/repos/test/repo/pulls/123'
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

    let checkRunsPosted = [];

    fetchMock = async (url, options) => {
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'mocktoken' }), { status: 200 });
      }
      if (url.includes('/formalities.json')) {
        return new Response(JSON.stringify({
          check_branch: false,
          enable_comments: false,
          require_linked_github_account: false,
          require_body: false
        }), { status: 200 });
      }
      if (url.includes('/labels')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/pulls/123/commits')) {
        return new Response(JSON.stringify(commitsList), { status: 200 });
      }
      if (url.includes('/repos/test/repo/commits/')) {
        throw new Error(`Unexpected per-commit patch fetch in PR-wide mode: ${url}`);
      }
      if (url.endsWith('/pulls/123') && options && options.headers && options.headers.Accept === 'application/vnd.github.patch') {
        return new Response('', { status: 200 });
      }
      if (url.includes('/check-runs')) {
        if (options && options.method === 'POST') {
          checkRunsPosted.push(JSON.parse(options.body));
        }
        return new Response(JSON.stringify({}), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const response = await worker.fetch(request, {
        WEBHOOK_SECRET: secret,
        APP_ID: '12345',
        PRIVATE_KEY: 'YW55Y29udGVudA=='
      }, {});

      assert.strictEqual(response.status, 200);

      const commitCheck = checkRunsPosted.find(cr => cr.name === 'FormalityCheck / Git & Commits');
      assert.ok(commitCheck);
      const byteLength = new TextEncoder().encode(commitCheck.output.text).length;
      assert.strictEqual(byteLength, 65000);
      assert.ok(commitCheck.output.text.includes('[Output truncated due to GitHub character limit]'));
    } finally {
      fetchMock = null;
    }
  });

  test('githubApiCall: does not log 404 error for GET requests to /contents/', async () => {
    let loggedError = null;
    const originalConsoleError = console.error;
    console.error = (msg) => {
      loggedError = msg;
    };

    try {
      fetchMock = (url, options) => {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      };

      const res = await githubApiCall('https://api.github.com/repos/openwrt/packages/contents/utils/cros-vboot/Makefile?ref=abc', 'token', 'GET');
      assert.strictEqual(res.code, 404);
      assert.strictEqual(loggedError, null);
    } finally {
      console.error = originalConsoleError;
      fetchMock = null;
    }
  });

  test('githubApiCall: logs 404 error for GET requests to other endpoints', async () => {
    let loggedError = null;
    const originalConsoleError = console.error;
    console.error = (msg) => {
      loggedError = msg;
    };

    try {
      fetchMock = (url, options) => {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      };

      const res = await githubApiCall('https://api.github.com/repos/openwrt/packages/issues/1', 'token', 'GET');
      assert.strictEqual(res.code, 404);
      assert.match(loggedError, /GitHub API call failed: GET https:\/\/api.github.com\/repos\/openwrt\/packages\/issues\/1 -> HTTP 404:/);
    } finally {
      console.error = originalConsoleError;
      fetchMock = null;
    }
  });

  test('githubApiCall: logs 404 error for POST requests to /contents/', async () => {
    let loggedError = null;
    const originalConsoleError = console.error;
    console.error = (msg) => {
      loggedError = msg;
    };

    try {
      fetchMock = (url, options) => {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      };

      const res = await githubApiCall('https://api.github.com/repos/openwrt/packages/contents/utils/cros-vboot/Makefile', 'token', 'POST', { message: 'test' });
      assert.strictEqual(res.code, 404);
      assert.match(loggedError, /GitHub API call failed: POST https:\/\/api.github.com\/repos\/openwrt\/packages\/contents\/utils\/cros-vboot\/Makefile -> HTTP 404:/);
    } finally {
      console.error = originalConsoleError;
      fetchMock = null;
    }
  });
});
