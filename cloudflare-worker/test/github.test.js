import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { graphqlBatchFetchFiles, GRAPHQL_URL } from '../src/github.js';

describe('graphqlBatchFetchFiles', { concurrency: 1 }, () => {
  let originalFetch;
  let fetchMock;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (fetchMock) {
        return fetchMock(url, options);
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns an empty map without making any request when probes is empty', async () => {
    let called = false;
    fetchMock = () => { called = true; return new Response(JSON.stringify({ data: {} }), { status: 200 }); };

    const result = await graphqlBatchFetchFiles('token', []);
    assert.strictEqual(result.size, 0);
    assert.strictEqual(called, false);
  });

  test('fetches a single file in one POST to the GraphQL endpoint', async () => {
    let requestCount = 0;
    let capturedUrl = null;
    let capturedBody = null;
    fetchMock = (url, options) => {
      requestCount++;
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        data: { repo0: { f0: { text: 'PKG_NAME:=bash\n' } } }
      }), { status: 200 });
    };

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'k1', repoFullname: 'openwrt/openwrt', ref: 'abc123', path: 'package/utils/bash/Makefile' }
    ]);

    assert.strictEqual(requestCount, 1);
    assert.strictEqual(capturedUrl, GRAPHQL_URL);
    assert.strictEqual(capturedBody.variables.o0, 'openwrt');
    assert.strictEqual(capturedBody.variables.n0, 'openwrt');
    assert.strictEqual(capturedBody.variables.e0_0, 'abc123:package/utils/bash/Makefile');
    assert.deepStrictEqual(result.get('k1'), { content: 'PKG_NAME:=bash\n', exists: true, isBinary: false });
  });

  test('batches many files from the same repo into a single query', async () => {
    let requestCount = 0;
    let aliasCount = 0;
    fetchMock = (url, options) => {
      requestCount++;
      const body = JSON.parse(options.body);
      aliasCount = (body.query.match(/f\d+: object/g) || []).length;
      const fields = {};
      for (let i = 0; i < 5; i++) {
        fields[`f${i}`] = { text: `content-${i}` };
      }
      return new Response(JSON.stringify({ data: { repo0: fields } }), { status: 200 });
    };

    const probes = Array.from({ length: 5 }, (_, i) => ({
      key: `k${i}`, repoFullname: 'openwrt/openwrt', ref: 'sha', path: `pkg${i}/Makefile`
    }));

    const result = await graphqlBatchFetchFiles('token', probes);

    assert.strictEqual(requestCount, 1);
    assert.strictEqual(aliasCount, 5);
    for (let i = 0; i < 5; i++) {
      assert.deepStrictEqual(result.get(`k${i}`), { content: `content-${i}`, exists: true, isBinary: false });
    }
  });

  test('groups probes across multiple repos into aliased repository() blocks in one query', async () => {
    let requestCount = 0;
    let capturedVariables = null;
    fetchMock = (url, options) => {
      requestCount++;
      capturedVariables = JSON.parse(options.body).variables;
      return new Response(JSON.stringify({
        data: {
          repo0: { f0: { text: 'base content' } },
          repo1: { f0: { text: 'fork content' } }
        }
      }), { status: 200 });
    };

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'base', repoFullname: 'openwrt/openwrt', ref: 'sha1', path: 'a/Makefile' },
      { key: 'fork', repoFullname: 'someuser/openwrt', ref: 'sha1', path: 'a/Makefile' }
    ]);

    assert.strictEqual(requestCount, 1);
    assert.strictEqual(capturedVariables.o0, 'openwrt');
    assert.strictEqual(capturedVariables.o1, 'someuser');
    assert.deepStrictEqual(result.get('base'), { content: 'base content', exists: true, isBinary: false });
    assert.deepStrictEqual(result.get('fork'), { content: 'fork content', exists: true, isBinary: false });
  });

  test('maps a null object (path/ref not found) to content: null, not an error', async () => {
    fetchMock = () => new Response(JSON.stringify({
      data: { repo0: { f0: null } }
    }), { status: 200 });

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'missing', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'does/not/exist' }
    ]);

    assert.deepStrictEqual(result.get('missing'), { content: null, exists: false, isBinary: false });
  });

  test('treats a field missing due to a partial errors[] entry as content: null with a warning, not a crash', async () => {
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    try {
      fetchMock = () => new Response(JSON.stringify({
        data: { repo0: { f0: { text: 'ok' } } },
        errors: [{ message: 'Something went wrong for f1', path: ['repo0', 'f1'] }]
      }), { status: 200 });

      const result = await graphqlBatchFetchFiles('token', [
        { key: 'ok', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'a' },
        { key: 'broken', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'b' }
      ]);

      assert.deepStrictEqual(result.get('ok'), { content: 'ok', exists: true, isBinary: false });
      assert.deepStrictEqual(result.get('broken'), { content: null, exists: false, isBinary: false });
      assert.strictEqual(warned, true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('resolves every probe to an error when the HTTP call itself fails', async () => {
    fetchMock = () => new Response('Too many subrequests', { status: 500 });

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'a', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'x' },
      { key: 'b', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'y' }
    ]);

    assert.ok(result.get('a').error instanceof Error);
    assert.ok(result.get('b').error instanceof Error);
  });

  test('resolves every probe to an error when GraphQL returns no top-level data', async () => {
    fetchMock = () => new Response(JSON.stringify({
      errors: [{ message: 'Could not resolve to a Repository' }]
    }), { status: 200 });

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'a', repoFullname: 'openwrt/doesnotexist', ref: 'sha', path: 'x' }
    ]);

    assert.ok(result.get('a').error instanceof Error);
    assert.ok(result.get('a').error.message.includes('Could not resolve to a Repository'));
  });

  test('marks a binary blob as existing without content instead of treating it as not found', async () => {
    fetchMock = () => new Response(JSON.stringify({
      data: { repo0: { f0: { oid: 'abc123', text: null, isBinary: true } } }
    }), { status: 200 });

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'bin', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'files/logo.png' }
    ]);

    assert.deepStrictEqual(result.get('bin'), { content: null, exists: true, isBinary: true });
  });

  test('probes ref existence with a bare-ref expression when path is null', async () => {
    let capturedVariables = null;
    fetchMock = (url, options) => {
      capturedVariables = JSON.parse(options.body).variables;
      return new Response(JSON.stringify({
        data: { repo0: { f0: { oid: 'commitsha' } } }
      }), { status: 200 });
    };

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'refprobe', repoFullname: 'openwrt/openwrt', ref: 'abc123', path: null }
    ]);

    // The expression must be the bare ref — no ':path' suffix.
    assert.strictEqual(capturedVariables.e0_0, 'abc123');
    assert.deepStrictEqual(result.get('refprobe'), { content: null, exists: true, isBinary: false });
  });

  test('reports a non-existing ref via a null bare-ref probe result', async () => {
    fetchMock = () => new Response(JSON.stringify({
      data: { repo0: { f0: null } }
    }), { status: 200 });

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'refprobe', repoFullname: 'openwrt/openwrt', ref: 'deadbeef', path: null }
    ]);

    assert.deepStrictEqual(result.get('refprobe'), { content: null, exists: false, isBinary: false });
  });
});
