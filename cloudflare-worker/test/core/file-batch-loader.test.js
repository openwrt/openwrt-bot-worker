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
});
