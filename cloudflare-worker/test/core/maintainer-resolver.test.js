import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createMaintainerResolver } from '../../src/core/maintainer-resolver.ts';

describe('MaintainerResolver', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns false immediately for bot users without checking association or API', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return new Response('{}', { status: 200 });
    };

    const budget = { limit: 50, used: 0, reserve: 5 };
    const resolver = createMaintainerResolver('openwrt/openwrt', 'token', budget);

    const isBot = await resolver({ login: 'github-actions[bot]', type: 'Bot' }, 'OWNER');
    assert.strictEqual(isBot, false);
    assert.strictEqual(callCount, 0);
  });

  test('returns true for users with maintainer associations without API calls', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return new Response('{}', { status: 200 });
    };

    const budget = { limit: 50, used: 0, reserve: 5 };
    const resolver = createMaintainerResolver('openwrt/openwrt', 'token', budget);

    for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      const res = await resolver({ login: 'maintainer-user' }, assoc);
      assert.strictEqual(res, true);
    }
    assert.strictEqual(callCount, 0);
  });

  test('calls GitHub permission API for non-maintainer association and caches the result', async () => {
    let callCount = 0;
    globalThis.fetch = async (url) => {
      callCount++;
      assert.match(url, /collaborators\/contributor-user\/permission/);
      return new Response(JSON.stringify({
        permission: 'write',
        user: { permissions: { push: true } }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const budget = { limit: 50, used: 0, reserve: 5 };
    const resolver = createMaintainerResolver('openwrt/openwrt', 'token', budget);

    const firstResult = await resolver({ login: 'contributor-user' }, 'CONTRIBUTOR');
    assert.strictEqual(firstResult, true);
    assert.strictEqual(callCount, 1);
    assert.strictEqual(budget.used, 1);

    // Second call for same user should hit the cache
    const secondResult = await resolver({ login: 'contributor-user' }, 'CONTRIBUTOR');
    assert.strictEqual(secondResult, true);
    assert.strictEqual(callCount, 1);
  });

  test('returns false without calling API when subrequest budget is exhausted', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return new Response('{}', { status: 200 });
    };

    const budget = { limit: 50, used: 47, reserve: 5 }; // available = 50 - 5 - 47 = -2
    const resolver = createMaintainerResolver('openwrt/openwrt', 'token', budget);

    const result = await resolver({ login: 'external-dev' }, 'CONTRIBUTOR');
    assert.strictEqual(result, false);
    assert.strictEqual(callCount, 0);
  });
});
