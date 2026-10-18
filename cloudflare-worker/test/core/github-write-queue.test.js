import { describe, test } from 'node:test';
import assert from 'node:assert';
import { GitHubWriteQueue } from '../../src/core/github-write-queue.ts';
import { MAX_ATTEMPTS } from '../../src/github.js';
import { createGitHubClient } from '../../src/core/github-client.ts';
import { enqueueCheckRuns } from '../../src/handlers/pull-request/check-run-report.ts';

// The three check-runs production closes every run with, as the report
// aggregation hands them over.
const checkRunReport = {
  formalityPassed: true,
  makefilePassed: false,
  patchesPassed: true,
  formalityConclusion: 'success',
  makefileConclusion: 'failure',
  patchesConclusion: 'neutral',
  formalityOutputText: 'Git & Commits passed\n',
  makefileOutputText: 'Missing PKG_RELEASE bump\n',
  patchesOutputText: 'Patches skipped\n',
  patchesHeading: '## Patches\n',
  unreadPatchNotes: new Set()
};

describe('GitHubWriteQueue', () => {
  test('executes operations in sequential order and records results', async () => {
    const queue = new GitHubWriteQueue(123);
    const executionOrder = [];

    queue.enqueue('first', async () => {
      executionOrder.push('first');
      return { code: 200, data: null, raw: '', headers: { get: () => null } };
    });

    queue.enqueue('second', async () => {
      executionOrder.push('second');
      return { code: 201, data: null, raw: '', headers: { get: () => null } };
    });

    const result = await queue.execute();
    assert.strictEqual(result, null);
    assert.deepStrictEqual(executionOrder, ['first', 'second']);
    assert.deepStrictEqual(queue.statusWrites, [
      { what: 'first', code: 200 },
      { what: 'second', code: 201 }
    ]);
  });

  test('returns 502 response when a write operation fails', async () => {
    const queue = new GitHubWriteQueue(456);

    queue.enqueue('success-write', async () => ({ code: 200, data: null, raw: '', headers: { get: () => null } }));
    queue.enqueue('failed-write', async () => ({ code: 500, data: null, raw: 'Internal Server Error', headers: { get: () => null } }));

    const response = await queue.execute();
    assert.ok(response instanceof Response);
    assert.strictEqual(response.status, 502);
    const body = await response.text();
    assert.match(body, /failed-write \(HTTP 500\)/);
  });

  test('handles thrown exceptions in write operations gracefully', async () => {
    const queue = new GitHubWriteQueue(789);

    queue.enqueue('crash-write', async () => {
      throw new Error('Network timeout');
    });

    const response = await queue.execute();
    assert.ok(response instanceof Response);
    assert.strictEqual(response.status, 502);
    assert.strictEqual(queue.statusWrites[0].code, 599);
  });

  // Production enqueues three check-runs, and each of them may cost up to
  // MAX_ATTEMPTS subrequests, so the room they need is 9 - not 3.
  const enqueueThreeCheckRuns = (queue, budget, executed) => {
    for (const name of ['Git & Commits', 'OpenWrt Makefiles', 'Code Patches']) {
      queue.enqueue(`check-run "${name}"`, async () => {
        executed.push(`check-run "${name}"`);
        budget.used++;
        return { code: 201 };
      }, { isCritical: true });
    }
  };

  test('executes all writes when subrequest budget has sufficient headroom', async () => {
    const queue = new GitHubWriteQueue(101);
    const executed = [];
    // 10 remaining > the 9 attempts the three check-runs may need.
    const budget = { limit: 50, used: 40, reserve: 15 };

    queue.enqueue('label-add', async () => {
      executed.push('label-add');
      budget.used++;
      return { code: 200 };
    });
    enqueueThreeCheckRuns(queue, budget, executed);

    const result = await queue.execute(budget);
    assert.strictEqual(result, null);
    assert.deepStrictEqual(executed, [
      'label-add', 'check-run "Git & Commits"', 'check-run "OpenWrt Makefiles"', 'check-run "Code Patches"'
    ]);
    assert.strictEqual(budget.reserve, 15, 'the reading-phase reserve is left as it was');
  });

  test('skips non-critical writes when the remaining attempts are reserved for the check-runs', async () => {
    const queue = new GitHubWriteQueue(102);
    const executed = [];
    // 50 - 41 = 9 remaining attempts, which is exactly what three check-runs
    // may need: one more operation would fit, three more attempts would not.
    const budget = { limit: 50, used: 41, reserve: 15 };

    queue.enqueue('label-add', async () => {
      executed.push('label-add');
      budget.used++;
      return { code: 200 };
    });
    enqueueThreeCheckRuns(queue, budget, executed);

    const result = await queue.execute(budget);
    assert.strictEqual(result, null);
    // 'label-add' must be skipped: the check-runs may still need all nine.
    assert.deepStrictEqual(executed, [
      'check-run "Git & Commits"', 'check-run "OpenWrt Makefiles"', 'check-run "Code Patches"'
    ]);
    assert.strictEqual(queue.statusWrites.length, 3);
  });

  // The queue has to hold a line in attempts, not in operations: with the
  // reserve counted in operations the optional writes below keep starting
  // while three calls are left, and the retries of the three check-runs then
  // run the internal limit over.
  test('keeps the internal limit while the check-runs retry, optional writes and all', async () => {
    const budget = { limit: 45, used: 33, reserve: 15 };
    const client = createGitHubClient('fake-token', budget);
    const queue = new GitHubWriteQueue(123);
    const labelUrl = 'https://api.github.com/repos/openwrt/openwrt/issues/123/labels';

    // Six optional label writes, each answered at the first attempt.
    for (let i = 1; i <= 6; i++) {
      queue.enqueue(`label write ${i}`, () => client.optionalApiCall(labelUrl, 'POST', { labels: [`l${i}`] }));
    }
    enqueueCheckRuns({
      repoFullname: 'openwrt/openwrt',
      headSha: 'sha-abc-123',
      client
    }, checkRunReport, queue);

    const originalFetch = globalThis.fetch;
    const calls = [];
    const checkRunsWritten = [];
    globalThis.fetch = async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      calls.push(`${options?.method} ${url}`);
      if (url.endsWith('/check-runs')) {
        // Every check-run write is answered by a transient failure twice, so
        // all three of them need all three attempts: 9 in total.
        const attempts = calls.filter(c => c.endsWith('/check-runs')).length;
        if (attempts % 3 !== 0) return new Response('{}', { status: 500 });
        checkRunsWritten.push({ name: body.name, conclusion: body.conclusion });
        return new Response(JSON.stringify({ id: attempts }), { status: 201 });
      }
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    };

    let result;
    try {
      result = await queue.execute(budget);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.strictEqual(result, null);
    assert.strictEqual(calls.length, 12,
      `three label writes plus three check-runs at three attempts each: ${JSON.stringify(calls)}`);
    assert.strictEqual(budget.used, 45, 'every attempt is charged, and none beyond the limit');
    assert.ok(budget.used <= budget.limit, `the internal limit was passed: used ${budget.used}/${budget.limit}`);
    assert.strictEqual(budget.reserve, 15, 'the reading-phase reserve is left as it was');

    // What the pull request must end up with, whatever had to be dropped.
    assert.deepStrictEqual(checkRunsWritten, [
      { name: 'FormalityCheck / Git & Commits', conclusion: 'success' },
      { name: 'FormalityCheck / OpenWrt Makefiles', conclusion: 'failure' },
      { name: 'FormalityCheck / Code Patches', conclusion: 'neutral' }
    ]);
    assert.deepStrictEqual(
      queue.statusWrites.filter(w => w.what.startsWith('check-run')).map(w => w.code),
      [201, 201, 201]
    );
    // Three of the six label writes had nothing left to spend.
    assert.strictEqual(queue.statusWrites.filter(w => w.what.startsWith('label write')).length, 3);
  });

  // A critical write is the one thing the queue may not economise on: it is
  // never skipped, and its retries are never declined, even past the limit.
  test('retries a critical write even with the whole budget spent', async () => {
    const budget = { limit: 45, used: 45, reserve: 15 };
    const client = createGitHubClient('fake-token', budget);
    const queue = new GitHubWriteQueue(124);
    const checkRunsUrl = 'https://api.github.com/repos/openwrt/openwrt/check-runs';

    queue.enqueue('check-run "Git & Commits"', () =>
      client.trackedApiCall(checkRunsUrl, 'POST', { name: 'FormalityCheck / Git & Commits' }), { isCritical: true });

    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      return fetches < 3 ? new Response('{}', { status: 500 }) : new Response('{}', { status: 201 });
    };

    let result;
    try {
      result = await queue.execute(budget);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.strictEqual(result, null);
    assert.strictEqual(fetches, 3, 'the write is attempted until GitHub accepts it');
    assert.strictEqual(budget.used, 48, 'all three attempts are charged');
    assert.deepStrictEqual(queue.statusWrites, [{ what: 'check-run "Git & Commits"', code: 201 }]);
  });

  // Two constants for one truth is how a third of the worst case gets
  // silently unreserved: the room the queue keeps and the attempts
  // githubApiCall spends have to move together, so the test reads the ceiling
  // from the same place the queue does and compares it with real fetches.
  test('reserves for one critical write exactly the attempts githubApiCall spends on it', async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const originalError = console.error;
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; return new Response('boom', { status: 500 }); };
    console.warn = () => {};
    console.error = () => {};

    let reserveSeen = null;
    let response;
    try {
      const budget = { limit: 50, used: 0, reserve: 15 };
      const client = createGitHubClient('token', budget);
      const queue = new GitHubWriteQueue(103);
      queue.enqueue('check-run "Git & Commits"', async () => {
        reserveSeen = budget.reserve;
        return client.trackedApiCall('https://api.github.com/repos/o/r/check-runs', 'POST', { name: 'x' });
      }, { isCritical: true });

      response = await queue.execute(budget);
      assert.strictEqual(fetches, MAX_ATTEMPTS, 'one write that keeps failing costs the retry ceiling');
      assert.strictEqual(budget.used, MAX_ATTEMPTS, 'and every attempt is charged');
      assert.strictEqual(reserveSeen, MAX_ATTEMPTS, 'which is what the queue had reserved for it');
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      console.error = originalError;
    }

    assert.strictEqual(response.status, 502);
  });

  // The same line the two hardcoded cases above draw at 9 and 10 remaining
  // attempts, stated in terms of the constant instead of the number.
  test('draws the skip line at pendingCritical times the retry ceiling', async () => {
    const results = [];
    for (const remaining of [3 * MAX_ATTEMPTS, 3 * MAX_ATTEMPTS + 1]) {
      const queue = new GitHubWriteQueue(104);
      const executed = [];
      const budget = { limit: 50, used: 50 - remaining, reserve: 15 };
      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        queue.enqueue('label-add', async () => { executed.push('label-add'); budget.used++; return { code: 200 }; });
        enqueueThreeCheckRuns(queue, budget, executed);
        await queue.execute(budget);
      } finally {
        console.warn = originalWarn;
      }
      results.push(executed.includes('label-add'));
    }
    assert.deepStrictEqual(results, [false, true],
      'a non-critical write may start only while more than the critical writes may cost is left');
  });
});
