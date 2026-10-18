import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createFileBatchLoader } from '../../src/core/file-batch-loader.ts';

describe('FileBatchLoader', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('batches multiple concurrent file fetches into a single GraphQL request and caches results', async () => {
    let callCount = 0;
    let requestBody = null;

    globalThis.fetch = async (url, options) => {
      callCount++;
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        data: {
          repo0: {
            f0: { oid: 'blob1', text: 'PKG_NAME:=foo\n', isBinary: false },
            f1: { oid: 'blob2', text: 'PKG_NAME:=bar\n', isBinary: false }
          }
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const budget = { limit: 50, used: 0, reserve: 5 };
    const loader = createFileBatchLoader({
      token: 'fake-token',
      repoFullname: 'openwrt/openwrt',
      subrequestBudget: budget,
      countOptionalAttempt: () => { budget.used++; return true; }
    });

    const [content1, content2] = await Promise.all([
      loader.fetchFileContentCached('package/foo/Makefile', 'main'),
      loader.fetchFileContentCached('package/bar/Makefile', 'main')
    ]);

    assert.strictEqual(callCount, 1);
    assert.strictEqual(content1, 'PKG_NAME:=foo\n');
    assert.strictEqual(content2, 'PKG_NAME:=bar\n');

    // Repeated fetch should come from cache and not trigger another fetch
    const cachedContent = await loader.fetchFileContentCached('package/foo/Makefile', 'main');
    assert.strictEqual(cachedContent, 'PKG_NAME:=foo\n');
    assert.strictEqual(callCount, 1);
  });

  test('respects subrequest budget and skips fetches when budget is exhausted', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };

    const budget = { limit: 50, used: 46, reserve: 5 }; // available = 50 - 5 - 46 = -1
    const loader = createFileBatchLoader({
      token: 'fake-token',
      repoFullname: 'openwrt/openwrt',
      subrequestBudget: budget,
      countOptionalAttempt: () => { budget.used++; return true; }
    });

    const content = await loader.fetchFileContentCached('Makefile', 'main');
    assert.strictEqual(content, null);
    assert.strictEqual(callCount, 0);
    assert.strictEqual(loader.getBudgetSkipCount(), 1);
    assert.strictEqual(loader.getStats().budgetSkipCount, 1);
  });

  test('tracks missing files when GraphQL reports object does not exist', async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        data: {
          repo0: {
            f0: null // Object not found in git tree
          }
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const budget = { limit: 50, used: 0, reserve: 5 };
    const loader = createFileBatchLoader({
      token: 'fake-token',
      repoFullname: 'openwrt/openwrt',
      subrequestBudget: budget,
      countOptionalAttempt: () => true
    });

    const content = await loader.fetchFileContentCached('nonexistent.txt', 'main');
    assert.strictEqual(content, null);
    assert.strictEqual(loader.isFileMissing('nonexistent.txt', 'main'), true);
    assert.strictEqual(loader.isFileMissing('existing.txt', 'main'), false);
    assert.strictEqual(loader.getStats().missingFilesCount, 1);
  });

  test('encapsulates ref source state and exposes query/mutation methods', () => {
    const budget = { limit: 50, used: 0, reserve: 5 };
    const loader = createFileBatchLoader({
      token: 'fake-token',
      repoFullname: 'openwrt/openwrt',
      subrequestBudget: budget,
      countOptionalAttempt: () => true,
      initialBaseSha: 'base-sha-123'
    });

    assert.strictEqual(loader.hasRefSource('base-sha-123'), true);
    assert.strictEqual(loader.getRefSource('base-sha-123'), 'base');

    assert.strictEqual(loader.hasRefSource('fork-ref-456'), false);
    loader.setRefSource('fork-ref-456', 'fork');
    assert.strictEqual(loader.hasRefSource('fork-ref-456'), true);
    assert.strictEqual(loader.getRefSource('fork-ref-456'), 'fork');
  });

  test('rejects pending requests if GraphQL returns non-200 HTTP code', async () => {
    globalThis.fetch = async () => {
      return new Response('GraphQL endpoint down', { status: 500 });
    };

    const budget = { limit: 50, used: 0, reserve: 5 };
    const loader = createFileBatchLoader({
      token: 'fake-token',
      repoFullname: 'openwrt/openwrt',
      subrequestBudget: budget,
      countOptionalAttempt: () => true
    });

    await assert.rejects(
      () => loader.fetchFileContentCached('Makefile', 'main'),
      /GraphQL batch file fetch failed \(HTTP 500\)/
    );
  });

  test('enforces safe chunk size when graphqlChunkSize is 0, negative, or invalid to prevent infinite loops', async () => {
    let callCount = 0;
    globalThis.fetch = async (url, options) => {
      callCount++;
      return new Response(JSON.stringify({
        data: {
          repo0: {
            f0: { oid: 'blob1', text: 'content\n', isBinary: false }
          }
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const budget = { limit: 50, used: 0, reserve: 5 };
    // Passing 0 would cause i += 0 infinite loop without safeChunkSize clamp
    const loaderZero = createFileBatchLoader({
      token: 'fake-token',
      repoFullname: 'openwrt/openwrt',
      subrequestBudget: budget,
      countOptionalAttempt: () => true,
      graphqlChunkSize: 0
    });

    const resZero = await loaderZero.fetchFileContentCached('test.txt', 'main');
    assert.strictEqual(resZero, 'content\n');
    assert.strictEqual(callCount, 1);

    // Negative number
    const loaderNegative = createFileBatchLoader({
      token: 'fake-token',
      repoFullname: 'openwrt/openwrt',
      subrequestBudget: budget,
      countOptionalAttempt: () => true,
      graphqlChunkSize: -10
    });

    const resNeg = await loaderNegative.fetchFileContentCached('test2.txt', 'main');
    assert.strictEqual(resNeg, 'content\n');
    assert.strictEqual(callCount, 2);
  });

  test('resolves null when every probed repo answered cleanly and none knows the ref', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      // repo0 is the base, repo1 the fork; f0 is the file probe and f1 the
      // bare-ref probe. Neither repo resolves the ref, so all four are null.
      return new Response(JSON.stringify({
        data: {
          repo0: { f0: null, f1: null },
          repo1: { f0: null, f1: null }
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const budget = { limit: 50, used: 0, reserve: 5 };
    const loader = createFileBatchLoader({
      token: 'fake-token',
      repoFullname: 'openwrt/openwrt',
      headRepoFullname: 'janedoe/openwrt',
      subrequestBudget: budget,
      countOptionalAttempt: () => { budget.used++; return true; }
    });

    const content = await loader.fetchFileContentCached('package/foo/Makefile', 'deadbeef');
    assert.strictEqual(content, null);
    assert.strictEqual(callCount, 1);
    assert.strictEqual(loader.getFetchFailureCount(), 0, 'a clean miss is not a fetch failure');
    assert.strictEqual(loader.getStats().fetchFailureCount, 0);
    // No repository claimed the ref, so nothing proves the file is gone.
    assert.strictEqual(loader.isFileMissing('package/foo/Makefile', 'deadbeef'), false);
    assert.strictEqual(loader.hasRefSource('deadbeef'), false);
  });

  test('resolves null when the budget skips the ref probes but the file probes answered', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({
        data: {
          repo0: { f0: null },
          repo1: { f0: null }
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    // Two probes per chunk puts the file probes in the first chunk and the
    // ref-existence probes in the second, which the budget guard skips.
    const budget = { limit: 10, used: 4, reserve: 5 };
    const loader = createFileBatchLoader({
      token: 'fake-token',
      repoFullname: 'openwrt/openwrt',
      headRepoFullname: 'janedoe/openwrt',
      subrequestBudget: budget,
      countOptionalAttempt: () => { budget.used++; return true; },
      graphqlChunkSize: 2
    });

    const content = await loader.fetchFileContentCached('package/foo/Makefile', 'deadbeef');
    assert.strictEqual(content, null);
    assert.strictEqual(callCount, 1, 'only the file probes were affordable');
    assert.strictEqual(loader.getFetchFailureCount(), 0, 'a skipped ref probe is not a fetch failure');
    assert.strictEqual(loader.getBudgetSkipCount(), 0, 'the file lookup itself was not skipped');
    assert.strictEqual(loader.isFileMissing('package/foo/Makefile', 'deadbeef'), false);
  });

  test('rejects and increments fetchFailureCount when GraphQL returns field-level error (failed: true)', async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        data: {
          repo0: {
            f0: null
          }
        },
        errors: [
          { message: 'Git object lookup failed', path: ['repo0', 'f0'] }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const budget = { limit: 50, used: 0, reserve: 5 };
    const loader = createFileBatchLoader({
      token: 'fake-token',
      repoFullname: 'openwrt/openwrt',
      subrequestBudget: budget,
      countOptionalAttempt: () => true
    });

    await assert.rejects(
      () => loader.fetchFileContentCached('problematic.txt', 'main'),
      /GitHub GraphQL query returned an error/
    );
    assert.strictEqual(loader.isFileMissing('problematic.txt', 'main'), false, 'should not be recorded as missing file');
    assert.strictEqual(loader.getFetchFailureCount(), 1);
    assert.strictEqual(loader.getStats().fetchFailureCount, 1);
  });

  test('rejects and increments fetchFailureCount when Blob object exists but has GraphQL error in text', async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        data: {
          repo0: {
            f0: { oid: 'abc123', text: null, isBinary: false }
          }
        },
        errors: [
          { message: 'Read failed', path: ['repo0', 'f0', 'text'] }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const budget = { limit: 50, used: 0, reserve: 5 };
    const loader = createFileBatchLoader({
      token: 'fake-token',
      repoFullname: 'openwrt/openwrt',
      subrequestBudget: budget,
      countOptionalAttempt: () => true
    });

    await assert.rejects(
      () => loader.fetchFileContentCached('package/foo/Makefile', 'main'),
      /GitHub GraphQL query returned an error/
    );
    assert.strictEqual(loader.isFileMissing('package/foo/Makefile', 'main'), false, 'should not be recorded as missing file');
    assert.strictEqual(loader.getFetchFailureCount(), 1);
    assert.strictEqual(loader.getStats().fetchFailureCount, 1);
  });
});

