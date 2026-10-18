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
  // Three answers, not two: GitHub saying "no write access" and GitHub saying
  // nothing at all are different facts, and only the first one may fail a
  // pull request that carries an override.
  test('answers null when the permission lookup itself fails, and does not remember the failure', async () => {
    let callCount = 0;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = () => {};
    console.error = () => {};
    try {
      globalThis.fetch = async () => {
        callCount++;
        return new Response('upstream hiccup', { status: 503 });
      };

      const budget = { limit: 50, used: 0, reserve: 5 };
      const resolver = createMaintainerResolver('openwrt/openwrt', 'token', budget);

      const first = await resolver({ login: 'privatemaintainer' }, 'CONTRIBUTOR');
      assert.strictEqual(first, null, 'an unanswered lookup is not an answer of "no"');
      // One logical lookup, three real subrequests: the 5xx retries are
      // attempts Cloudflare counts, so the budget has to count them too.
      assert.strictEqual(callCount, 3, 'the one lookup is retried up to the attempt limit');
      assert.strictEqual(budget.used, 3, 'every attempt is charged, retries included');

      const second = await resolver({ login: 'privatemaintainer' }, 'CONTRIBUTOR');
      assert.strictEqual(second, null);
      assert.strictEqual(callCount, 6, 'a failure is not cached, so the next question asks again');
      assert.strictEqual(budget.used, 6);
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  test('answers false, in one request, for a login GitHub says is no collaborator', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return new Response('{"message":"Not Found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    };

    const budget = { limit: 50, used: 0, reserve: 5 };
    const resolver = createMaintainerResolver('openwrt/openwrt', 'token', budget);

    const result = await resolver({ login: 'outsider' }, 'CONTRIBUTOR');
    assert.strictEqual(result, false, '404 is GitHub answering, so it is a verdict');
    assert.strictEqual(callCount, 1, 'an answer is not retried');
    assert.strictEqual(budget.used, 1);
  });

  test('answers false, not null, when the reserve stops the lookup from being made', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      let callCount = 0;
      globalThis.fetch = async () => { callCount++; return new Response('{}', { status: 200 }); };

      const budget = { limit: 50, used: 47, reserve: 5 };
      const resolver = createMaintainerResolver('openwrt/openwrt', 'token', budget);

      // Deliberate: the reserve exists so the three check-run writes, the PR
      // comment and the label writes always fit, and a run this tight has to
      // reach them. Changing this to null would turn every tight run neutral.
      assert.strictEqual(await resolver({ login: 'external-dev' }, 'CONTRIBUTOR'), false);
      assert.strictEqual(callCount, 0);
      assert.strictEqual(budget.used, 47, 'and the reserve stays where it was');
    } finally {
      console.warn = originalWarn;
    }
  });
});
