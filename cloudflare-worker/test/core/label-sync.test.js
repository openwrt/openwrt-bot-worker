import { describe, test } from 'node:test';
import assert from 'node:assert';
import { syncLabels } from '../../src/handlers/pull-request/label-sync.ts';
import { loadPullRequestContext } from '../../src/handlers/pull-request/context.ts';
import { GitHubWriteQueue } from '../../src/core/github-write-queue.ts';
import { createGitHubClient } from '../../src/core/github-client.ts';
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

  // Label creation goes through the shared ensureLabelExists, which issues its
  // own request, so a test that executes the queue has to answer that one too.
  const withLabelCreates = async (answer, fn) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/labels') && options?.method === 'POST') return answer();
      return new Response('{}', { status: 200 });
    };
    try {
      return await fn();
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  test('enqueues label creation and PR label assignment in correct order', async () => {
    const queue = new GitHubWriteQueue(42);
    const ctx = createMockContext();
    const patches = createMockPatches();
    const report = createMockReport({ allPassed: false });

    await syncLabels(ctx, patches, report, queue);

    assert.ok(queue.queue.some(([what]) => what === `ensure label "${LABEL_GUIDELINES}"`));
    assert.ok(queue.queue.some(([what]) => what === `ensure label "${LABEL_ADD_PACKAGE}"`));
    assert.ok(queue.queue.some(([what]) => what === 'labels'));

    const error = await withLabelCreates(
      () => new Response(JSON.stringify({ id: 1 }), { status: 201 }),
      () => queue.execute()
    );
    assert.strictEqual(error, null);
    assert.strictEqual(queue.statusWrites.every(w => w.code === 200), true);
  });

  test('returns 502 Bad Gateway when the label assignment fails in GitHubWriteQueue', async () => {
    const queue = new GitHubWriteQueue(42);
    // Simulating API failure (HTTP 500) during label addition
    const ctx = createMockContext({
      trackedApiResult: { code: 500, data: null, raw: 'Internal Server Error', headers: { get: () => null } }
    });
    const patches = createMockPatches();
    const report = createMockReport({ allPassed: false });

    await syncLabels(ctx, patches, report, queue);

    const errorResponse = await withLabelCreates(
      () => new Response(JSON.stringify({ id: 1 }), { status: 201 }),
      () => queue.execute()
    );
    assert.ok(errorResponse instanceof Response);
    assert.strictEqual(errorResponse.status, 502);
    const body = await errorResponse.text();
    assert.match(body, /Failed to report status for PR #42/);
    assert.match(body, /HTTP 500/);
  });

  // The shared helper says false both for a label that was already there and
  // for a create GitHub refused, so a 403 on POST /repos/:o/:r/labels - what
  // a missing issues:write permission looks like - was recorded as a write
  // that succeeded, and the webhook answered 200 with nothing to show for it.
  test('returns 502 Bad Gateway when the label create is refused', async () => {
    const queue = new GitHubWriteQueue(42);
    const ctx = createMockContext();
    const patches = createMockPatches();
    const report = createMockReport({ allPassed: false });

    await syncLabels(ctx, patches, report, queue);

    const errorResponse = await withLabelCreates(
      () => new Response('Resource not accessible by integration', { status: 403 }),
      () => queue.execute()
    );
    assert.ok(errorResponse instanceof Response, 'a refused label create is a failed write');
    assert.strictEqual(errorResponse.status, 502);
    const body = await errorResponse.text();
    assert.match(body, /ensure label/, body);
  });

  // Same on the Dependabot path, where the label listing is never fetched and
  // the create is blind: a refused one still has to reach the delivery log.
  test('returns 502 response when a blind Dependabot label create is refused', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      // The repository's label collection, not the pull request's labels: the
      // labels themselves go on fine, only creating them is refused.
      if (url.endsWith('/labels') && !url.includes('/issues/') && options?.method === 'POST') {
        return new Response('Resource not accessible by integration', { status: 403 });
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
      assert.match(text, /ensure label "dependencies"/, text);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  // The label says a violation was found, so when none was it comes off even
  // if the audit could not read everything: the neutral check run is where
  // that uncertainty belongs. Leaving it on would keep it on a pull request
  // whose every reported problem is fixed, and the nightly scan acts on this
  // label - it would mark that pull request stale and then close it.
  test('removes the guidelines label on a clean run whose audit was incomplete', async () => {
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

    const removals = queue.queue
      .map(([what]) => what)
      .filter((what) => typeof what === 'string' && what.startsWith('label removal '));
    assert.deepStrictEqual(removals, [`label removal "${LABEL_GUIDELINES}"`]);
  });

  // The re-read is an improvement on the payload, not a precondition for it:
  // the payload still describes the pull request this run was sent for, so a
  // failed re-read falls back to it instead of suppressing every label.
  test('decides from the payload when the live PR fetch returns 500', async () => {
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

    // The payload adds a package Makefile and carries no labels yet.
    assert.ok(queue.queue.some(([what]) => what === `ensure label "${LABEL_ADD_PACKAGE}"`),
      `labelling must carry on from the payload: ${JSON.stringify(queue.queue.map(([w]) => w))}`);
    assert.ok(queue.queue.some(([what]) => what === 'labels'));
  });

  test('removes the stale label from the payload when the live PR fetch returns 500', async () => {
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
    ctx.prData = { ...ctx.prData, labels: [{ name: 'stale' }] };
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

    assert.ok(queue.queue.some(([what]) => what === 'label removal "stale"'),
      `new commits take the stale marker off: ${JSON.stringify(queue.queue.map(([w]) => w))}`);
  });

  // 422 is GitHub for "that label already exists", which is a race with
  // another writer rather than a failure. The shared helper silences it; an
  // inline create logs it to console.error and makes the logs look broken.
  test('does not log an error when a label create races another writer to 422', async () => {
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => { errors.push(args.join(' ')); };
    globalThis.fetch = async (url, options) => {
      // The repository's label collection, not the pull request's labels.
      if (url.endsWith('/labels') && !url.includes('/issues/') && options?.method === 'POST') {
        return new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 });
      }
      return new Response('{}', { status: 200 });
    };

    try {
      const queue = new GitHubWriteQueue(42);
      // A real client, because whether the 422 is silenced is decided inside
      // githubApiCall and a stubbed client never reaches it.
      const ctx = createMockContext({
        client: createGitHubClient('fake-token', { limit: 50, used: 0, reserve: 5 })
      });
      const patches = createMockPatches();
      const report = createMockReport({ allPassed: false });

      await syncLabels(ctx, patches, report, queue);
      const error = await queue.execute();

      assert.strictEqual(error, null, 'a label that already exists is not a failed write');
      assert.deepStrictEqual(errors, [], `a benign 422 must not be logged: ${errors.join(' | ')}`);
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
    }
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
