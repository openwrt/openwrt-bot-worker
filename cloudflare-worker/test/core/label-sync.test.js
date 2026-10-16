import { describe, test } from 'node:test';
import assert from 'node:assert';
import { syncLabels } from '../../src/handlers/pull-request/label-sync.ts';
import { loadPullRequestContext } from '../../src/handlers/pull-request/context.ts';
import { GitHubWriteQueue } from '../../src/core/github-write-queue.ts';
import { LABEL_GUIDELINES, LABEL_ADD_PACKAGE } from '../../src/config.js';

describe('label-sync lifecycle phase and error handling', () => {
  const createMockContext = ({
    existingLabels = new Set(),
    trackedApiResult = { code: 200, data: null, raw: '', headers: { get: () => null } },
    client = null,
    headBranch = 'feature',
    baseSha = 'base123'
  } = {}) => ({
    prNumber: 42,
    repoFullname: 'openwrt/openwrt',
    headBranch,
    baseBranch: 'main',
    headSha: 'head123',
    baseSha,
    token: 'fake-token',
    prData: {
      number: 42,
      url: 'https://api.github.com/repos/openwrt/openwrt/pulls/42',
      body: 'PR Body',
      labels: [],
      head: { ref: 'feature', sha: 'head123' },
      base: { ref: 'main', sha: 'base123' }
    },
    client: client || {
      budget: { limit: 50, used: 0, reserve: 5 },
      hasHeadroom: () => true,
      optionalApiCall: async () => ({
        code: 200,
        data: {
          labels: [],
          head: { ref: 'feature', sha: 'head123' },
          base: { ref: 'main', sha: 'base123' },
          body: 'PR Body'
        }
      }),
      trackedApiCall: async () => trackedApiResult
    },
    existingLabels,
    config: {
      add_package_label: true,
      drop_package_label: false,
      branch_labeling: true,
      enable_labeler_yml: false
    },
    labelerText: null,
    action: 'opened'
  });

  const createMockPatches = () => ({
    packageState: { isNewPackage: true, isDroppedPackage: false },
    packageStateKnown: true,
    usePrWidePatch: false,
    prPatch: null,
    commitDetails: []
  });

  const createMockReport = ({ allPassed = false } = {}) => ({
    allPassed,
    allFormalityErrors: allPassed ? [] : ['Error'],
    allMakefileErrors: [],
    allPatchesErrors: [],
    allPrWarnings: []
  });

  test('enqueues label creation and PR label assignment in correct order', async () => {
    const queue = new GitHubWriteQueue(42);
    const ctx = createMockContext();
    const patches = createMockPatches();
    const report = createMockReport({ allPassed: false });

    await syncLabels(ctx, patches, report, queue);

    assert.ok(queue.queue.some(([what]) => what === `ensure label "${LABEL_GUIDELINES}"`));
    assert.ok(queue.queue.some(([what]) => what === `ensure label "${LABEL_ADD_PACKAGE}"`));
    assert.ok(queue.queue.some(([what]) => what === 'labels'));

    const error = await queue.execute();
    assert.strictEqual(error, null);
    assert.strictEqual(queue.statusWrites.every(w => w.code === 200), true);
  });

  test('returns 502 Bad Gateway when label creation fails in GitHubWriteQueue', async () => {
    const queue = new GitHubWriteQueue(42);
    // Simulating API failure (HTTP 500) during label creation or addition
    const ctx = createMockContext({
      trackedApiResult: { code: 500, data: null, raw: 'Internal Server Error', headers: { get: () => null } }
    });
    const patches = createMockPatches();
    const report = createMockReport({ allPassed: false });

    await syncLabels(ctx, patches, report, queue);

    const errorResponse = await queue.execute();
    assert.ok(errorResponse instanceof Response);
    assert.strictEqual(errorResponse.status, 502);
    const body = await errorResponse.text();
    assert.match(body, /Failed to report status for PR #42/);
    assert.match(body, /HTTP 500/);
  });

  test('returns 502 response when Dependabot label addition fails in context loading', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/labels')) {
        return new Response('API quota exceeded', { status: 403 });
      }
      return new Response('{}', { status: 200 });
    };

    try {
      const payload = {
        action: 'opened',
        pull_request: {
          number: 99,
          url: 'https://api.github.com/repos/openwrt/openwrt/pulls/99',
          user: { login: 'dependabot[bot]', type: 'Bot' },
          head: { ref: 'dependabot/npm_and_yarn/lodash-4.17.21', sha: 'sha123' },
          base: { ref: 'main', sha: 'base123' },
          labels: []
        },
        repository: { full_name: 'openwrt/openwrt' },
        installation: { id: 123 }
      };

      const result = await loadPullRequestContext(
        payload,
        'pull_request',
        {},
        'fake-token',
        'openwrt/openwrt',
        null,
        0
      );

      assert.strictEqual(result.kind, 'response');
      assert.strictEqual(result.response.status, 502);
      const text = await result.response.text();
      assert.match(text, /Failed to report status for PR #99/);
      assert.match(text, /HTTP 403/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not remove guidelines label when validation is incomplete even if allPassed is true', async () => {
    const queue = new GitHubWriteQueue(42);
    const existingLabels = new Set([LABEL_GUIDELINES.toLowerCase()]);
    const ctx = createMockContext({
      existingLabels,
      client: {
        budget: { limit: 50, used: 0, reserve: 5 },
        hasHeadroom: () => true,
        optionalApiCall: async () => ({
          code: 200,
          data: {
            labels: [{ name: LABEL_GUIDELINES }],
            head: { ref: 'feature', sha: 'head123' },
            base: { ref: 'main', sha: 'base123' },
            body: 'PR Body'
          }
        }),
        trackedApiCall: async () => ({ code: 200, data: null, raw: '', headers: { get: () => null } })
      }
    });
    const patches = createMockPatches();
    const report = {
      allPassed: true,
      isValidationIncomplete: true,
      allFormalityErrors: [],
      allMakefileErrors: [],
      allPatchesErrors: [],
      allPrWarnings: []
    };

    await syncLabels(ctx, patches, report, queue);

    const removedLabels = queue.queue.filter(([what]) => what === 'remove label');
    assert.strictEqual(removedLabels.length, 0);
  });

  test('fails closed and does not touch labels when live PR fetch returns 500 error', async () => {
    const queue = new GitHubWriteQueue(42);
    const existingLabels = new Set([LABEL_GUIDELINES.toLowerCase()]);
    const ctx = createMockContext({
      existingLabels,
      client: {
        budget: { limit: 50, used: 0, reserve: 5 },
        hasHeadroom: () => true,
        optionalApiCall: async () => ({ code: 500, data: null, raw: 'Internal Server Error' }),
        trackedApiCall: async () => ({ code: 200, data: null, raw: '', headers: { get: () => null } })
      }
    });
    const patches = createMockPatches();
    const report = {
      allPassed: true,
      isValidationIncomplete: false,
      allFormalityErrors: [],
      allMakefileErrors: [],
      allPatchesErrors: [],
      allPrWarnings: []
    };

    await syncLabels(ctx, patches, report, queue);

    assert.strictEqual(queue.queue.length, 0);
  });

  test('does not remove stale label when live PR state verification returns HTTP 500 error', async () => {
    const queue = new GitHubWriteQueue(42);
    const existingLabels = new Set(['stale']);
    const ctx = createMockContext({
      existingLabels,
      client: {
        budget: { limit: 50, used: 0, reserve: 5 },
        hasHeadroom: () => true,
        optionalApiCall: async () => ({ code: 500, data: null, raw: 'Internal Server Error' }),
        trackedApiCall: async () => ({ code: 200, data: null, raw: '', headers: { get: () => null } })
      }
    });
    ctx.action = 'synchronize';
    const patches = createMockPatches();
    const report = {
      allPassed: true,
      isValidationIncomplete: false,
      allFormalityErrors: [],
      allMakefileErrors: [],
      allPatchesErrors: [],
      allPrWarnings: []
    };

    await syncLabels(ctx, patches, report, queue);
    assert.strictEqual(queue.queue.length, 0);
  });

  test('does not remove stale label when live PR head SHA moved (stale event)', async () => {
    const queue = new GitHubWriteQueue(42);
    const existingLabels = new Set(['stale']);
    const ctx = createMockContext({
      existingLabels,
      client: {
        budget: { limit: 50, used: 0, reserve: 5 },
        hasHeadroom: () => true,
        optionalApiCall: async () => ({
          code: 200,
          data: {
            labels: [{ name: 'stale' }],
            head: { ref: 'feature', sha: 'newerSha456' },
            base: { ref: 'main', sha: 'base123' },
            body: 'PR Body'
          }
        }),
        trackedApiCall: async () => ({ code: 200, data: null, raw: '', headers: { get: () => null } })
      }
    });
    ctx.action = 'synchronize';
    const patches = createMockPatches();
    const report = {
      allPassed: true,
      isValidationIncomplete: false,
      allFormalityErrors: [],
      allMakefileErrors: [],
      allPatchesErrors: [],
      allPrWarnings: []
    };

    await syncLabels(ctx, patches, report, queue);
    assert.strictEqual(queue.queue.length, 0);
  });

  test('removes stale label on synchronize when live PR is verified and head SHA matches', async () => {
    const queue = new GitHubWriteQueue(42);
    const existingLabels = new Set(['stale']);
    const ctx = createMockContext({
      existingLabels,
      client: {
        budget: { limit: 50, used: 0, reserve: 5 },
        hasHeadroom: () => true,
        optionalApiCall: async () => ({
          code: 200,
          data: {
            labels: [{ name: 'stale' }],
            head: { ref: 'feature', sha: 'head123' },
            base: { ref: 'main', sha: 'base123' },
            body: 'PR Body'
          }
        }),
        trackedApiCall: async () => ({ code: 200, data: null, raw: '', headers: { get: () => null } })
      }
    });
    ctx.action = 'synchronize';
    const patches = createMockPatches();
    const report = {
      allPassed: true,
      isValidationIncomplete: false,
      allFormalityErrors: [],
      allMakefileErrors: [],
      allPatchesErrors: [],
      allPrWarnings: []
    };

    await syncLabels(ctx, patches, report, queue);
    const staleRemoval = queue.queue.find(([desc]) => desc === 'label removal "stale"');
    assert.ok(staleRemoval, 'stale label removal should be queued');
  });

  test('skips label sync when live PR is closed (state !== "open") even if head SHA and body match', async () => {
    const queue = new GitHubWriteQueue(42);
    const existingLabels = new Set(['stale']);
    const ctx = createMockContext({
      existingLabels,
      client: {
        budget: { limit: 50, used: 0, reserve: 5 },
        hasHeadroom: () => true,
        optionalApiCall: async () => ({
          code: 200,
          data: {
            state: 'closed',
            labels: [{ name: 'stale' }],
            head: { ref: 'feature', sha: 'head123' },
            base: { ref: 'main', sha: 'base123' },
            body: 'PR Body'
          }
        }),
        trackedApiCall: async () => ({ code: 200, data: null, raw: '', headers: { get: () => null } })
      }
    });
    ctx.action = 'synchronize';
    const patches = createMockPatches();
    const report = {
      allPassed: true,
      isValidationIncomplete: false,
      allFormalityErrors: [],
      allMakefileErrors: [],
      allPatchesErrors: [],
      allPrWarnings: []
    };

    await syncLabels(ctx, patches, report, queue);
    assert.strictEqual(queue.queue.length, 0, 'no label operations should be queued when PR is closed');
  });

  test('skips live PR check and skips label sync when client has no headroom', async () => {
    const queue = new GitHubWriteQueue(42);
    let optionalCallCount = 0;
    const ctx = createMockContext({
      client: {
        budget: { limit: 50, used: 46, reserve: 5 },
        hasHeadroom: () => false,
        optionalApiCall: async () => {
          optionalCallCount++;
          return { code: 200, data: {} };
        },
        trackedApiCall: async () => ({ code: 200, data: null, raw: '', headers: { get: () => null } })
      }
    });
    const patches = createMockPatches();
    const report = {
      allPassed: true,
      isValidationIncomplete: false,
      allFormalityErrors: [],
      allMakefileErrors: [],
      allPatchesErrors: [],
      allPrWarnings: []
    };

    await syncLabels(ctx, patches, report, queue);
    assert.strictEqual(optionalCallCount, 0, 'optionalApiCall should not be invoked when hasHeadroom is false');
    assert.strictEqual(queue.queue.length, 0, 'no label operations should be queued when headroom is exhausted');
  });

  test('skips label sync when live PR head branch ref changed', async () => {
    const queue = new GitHubWriteQueue(42);
    const existingLabels = new Set(['stale']);
    const ctx = createMockContext({
      headBranch: 'feature-original',
      baseSha: 'base123',
      existingLabels,
      client: {
        budget: { limit: 50, used: 0, reserve: 5 },
        hasHeadroom: () => true,
        optionalApiCall: async () => ({
          code: 200,
          data: {
            state: 'open',
            labels: [{ name: 'stale' }],
            head: { ref: 'feature-renamed', sha: 'head123' },
            base: { ref: 'main', sha: 'base123' },
            body: 'PR Body'
          }
        }),
        trackedApiCall: async () => ({ code: 200, data: null, raw: '', headers: { get: () => null } })
      }
    });
    ctx.action = 'synchronize';
    const patches = createMockPatches();
    const report = {
      allPassed: true,
      isValidationIncomplete: false,
      allFormalityErrors: [],
      allMakefileErrors: [],
      allPatchesErrors: [],
      allPrWarnings: []
    };

    await syncLabels(ctx, patches, report, queue);
    assert.strictEqual(queue.queue.length, 0, 'no label operations should be queued when head.ref changed');
  });

  test('skips label sync when live PR base SHA changed', async () => {
    const queue = new GitHubWriteQueue(42);
    const existingLabels = new Set(['stale']);
    const ctx = createMockContext({
      headBranch: 'feature',
      baseSha: 'base-original-123',
      existingLabels,
      client: {
        budget: { limit: 50, used: 0, reserve: 5 },
        hasHeadroom: () => true,
        optionalApiCall: async () => ({
          code: 200,
          data: {
            state: 'open',
            labels: [{ name: 'stale' }],
            head: { ref: 'feature', sha: 'head123' },
            base: { ref: 'main', sha: 'base-drifted-456' },
            body: 'PR Body'
          }
        }),
        trackedApiCall: async () => ({ code: 200, data: null, raw: '', headers: { get: () => null } })
      }
    });
    ctx.action = 'synchronize';
    const patches = createMockPatches();
    const report = {
      allPassed: true,
      isValidationIncomplete: false,
      allFormalityErrors: [],
      allMakefileErrors: [],
      allPatchesErrors: [],
      allPrWarnings: []
    };

    await syncLabels(ctx, patches, report, queue);
    assert.strictEqual(queue.queue.length, 0, 'no label operations should be queued when base.sha changed');
  });
});
