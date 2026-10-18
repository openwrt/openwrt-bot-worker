import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildCheckRunPayloads, enqueueCheckRuns } from '../../src/handlers/pull-request/check-run-report.ts';
import { aggregateReport } from '../../src/handlers/pull-request/report.ts';
import { GitHubWriteQueue } from '../../src/core/github-write-queue.ts';
import { createGitHubClient } from '../../src/core/github-client.ts';

describe('check-run-report lifecycle phase', () => {
  const mockReport = {
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
    unreadPatchNotes: new Set(['file1.patch', 'file2.patch'])
  };

  test('buildCheckRunPayloads constructs 3 completed check-run payloads with matching conclusions', () => {
    const runs = buildCheckRunPayloads(mockReport, 'sha-abc-123');
    assert.strictEqual(runs.length, 3);

    const [gitRun, makefileRun, patchesRun] = runs;

    assert.strictEqual(gitRun.label, 'check-run "Git & Commits"');
    assert.strictEqual(gitRun.payload.conclusion, 'success');
    assert.strictEqual(gitRun.payload.output.title, 'Git & Commits: Passed');

    assert.strictEqual(makefileRun.label, 'check-run "OpenWrt Makefiles"');
    assert.strictEqual(makefileRun.payload.conclusion, 'failure');
    assert.strictEqual(makefileRun.payload.output.title, 'OpenWrt Makefiles: Failed');

    assert.strictEqual(patchesRun.label, 'check-run "Code Patches"');
    assert.strictEqual(patchesRun.payload.conclusion, 'neutral');
    assert.strictEqual(patchesRun.payload.output.title, 'Code Patches: Partially checked');
    assert.match(patchesRun.payload.output.summary, /Some of this pull request could not be inspected/);
  });

  test('enqueueCheckRuns enqueues all 3 check runs into GitHubWriteQueue', async () => {
    const queue = new GitHubWriteQueue(777);
    const postedPayloads = [];
    const ctx = {
      repoFullname: 'openwrt/openwrt',
      headSha: 'sha-abc-123',
      client: {
        trackedApiCall: async (_url, _method, body) => {
          postedPayloads.push(body);
          return { code: 201 };
        }
      }
    };

    enqueueCheckRuns(ctx, mockReport, queue);
    assert.strictEqual(queue.queue.length, 3);

    const error = await queue.execute();
    assert.strictEqual(error, null);
    assert.strictEqual(postedPayloads.length, 3);
    assert.strictEqual(queue.statusWrites.length, 3);
    assert.strictEqual(queue.statusWrites.every(w => w.code === 201), true);
  });

  // What the queue exists for: a pull request too large to audit fully still
  // has to end with its three check-runs, retries included, after the
  // optional writes were refused.
  test('writes all three check-runs with their conclusions once the budget is spent', async () => {
    const budget = { limit: 45, used: 44, reserve: 15 };
    const client = createGitHubClient('fake-token', budget);
    const queue = new GitHubWriteQueue(123);
    const ctx = { repoFullname: 'openwrt/openwrt', headSha: 'sha-abc-123', client };

    queue.enqueue('labels', () => client.optionalApiCall(
      'https://api.github.com/repos/openwrt/openwrt/issues/123/labels', 'POST', { labels: ['x'] }));
    enqueueCheckRuns(ctx, mockReport, queue);

    const originalFetch = globalThis.fetch;
    const calls = [];
    const written = [];
    globalThis.fetch = async (url, options) => {
      calls.push(`${options?.method} ${url}`);
      const body = JSON.parse(options.body);
      // One transient failure, on the middle check-run.
      if (body.name === 'FormalityCheck / OpenWrt Makefiles' &&
          !calls.some(c => c === 'retried')) {
        calls.push('retried');
        return new Response('{}', { status: 500 });
      }
      written.push({ name: body.name, conclusion: body.conclusion });
      return new Response(JSON.stringify({ id: written.length }), { status: 201 });
    };

    let result;
    try {
      result = await queue.execute(budget);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.strictEqual(result, null);
    assert.deepStrictEqual(written, [
      { name: 'FormalityCheck / Git & Commits', conclusion: 'success' },
      { name: 'FormalityCheck / OpenWrt Makefiles', conclusion: 'failure' },
      { name: 'FormalityCheck / Code Patches', conclusion: 'neutral' }
    ]);
    assert.strictEqual(calls.filter(c => c.endsWith('/check-runs')).length, 4,
      `three check-runs, one of them attempted twice: ${JSON.stringify(calls)}`);
    assert.strictEqual(calls.filter(c => c.endsWith('/labels')).length, 0,
      'the optional label write had nothing left to spend');
    assert.strictEqual(budget.used, 48, 'the check-run attempts are charged, the reserve is what pays');
    assert.deepStrictEqual(queue.statusWrites.map(w => w.what), [
      'check-run "Git & Commits"', 'check-run "OpenWrt Makefiles"', 'check-run "Code Patches"'
    ]);
  });

  test('returns 502 Bad Gateway response when a check-run API call fails', async () => {
    const queue = new GitHubWriteQueue(888);
    const ctx = {
      repoFullname: 'openwrt/openwrt',
      headSha: 'sha-abc-123',
      client: {
        trackedApiCall: async (_url, _method, body) => {
          if (body.name.includes('OpenWrt Makefiles')) {
            return { code: 500, raw: 'Internal Server Error' };
          }
          return { code: 201 };
        }
      }
    };

    enqueueCheckRuns(ctx, mockReport, queue);

    const errorResponse = await queue.execute();
    assert.ok(errorResponse instanceof Response);
    assert.strictEqual(errorResponse.status, 502);
    const responseBody = await errorResponse.text();
    assert.match(responseBody, /Failed to report status for PR #888/);
    assert.match(responseBody, /check-run "OpenWrt Makefiles" \(HTTP 500\)/);
  });
  // A long series fills the details past GitHub's limit and safeTruncate cuts
  // the tail, so a coverage note appended there is the first thing dropped -
  // including the sentence a neutral summary sends the reader to look for.
  test('keeps the coverage note and the first finding inside truncated details', () => {
    let formalityOutputText = '### Checking PR #123: big backport series (Formalities Audit)\n\n';
    formalityOutputText += '#### Commit [0000001](https://github.com/commit/1) - mypkg: first:\n';
    formalityOutputText += '  ❌ Commit to stable branch must be marked as cherry-picked\n\n';
    for (let i = 2; i <= 200; i++) {
      formalityOutputText += `#### Commit [000000${i}](https://github.com/commit/${i}) - mypkg: commit ${i}:\n`;
      formalityOutputText += `  ✅ ${'subject, body and sign-off all check out '.repeat(16)}\n\n`;
    }

    const ctx = {
      client: { budget: { limit: 50, used: 10, reserve: 15 } },
      fileBatchLoader: { getBudgetSkipCount: () => 0 },
      commitScanCapped: false,
      commits: new Array(200).fill({ sha: 'dummy' })
    };
    const patchesResult = {
      patchUnavailable: false,
      upstreamComparisonSkips: 3,
      upstreamFetchFailures: 0,
      commitDetailsIncomplete: false
    };
    const outcome = {
      allFormalityErrors: ['**Commit [0000001](https://github.com/commit/1)**:\n- not marked as cherry-picked'],
      allPrWarnings: [],
      allMakefileErrors: [],
      allPatchesErrors: [],
      formalityOutputText,
      makefileOutputText: 'Makefile OK\n',
      patchesOutputText: 'Patches OK\n',
      patchesHeading: '## Patches\n',
      patchChecksIncomplete: false,
      makefileChecksIncomplete: false,
      formalityChecksIncomplete: false,
      makefileReportedFinding: false,
      patchesReportedFinding: false,
      unreadPatchNotes: new Set()
    };

    const report = aggregateReport(ctx, patchesResult, outcome);
    const [gitRun] = buildCheckRunPayloads(report, 'sha-abc-123');
    const text = gitRun.payload.output.text;

    assert.match(text, /Output truncated due to GitHub character limit/,
      'the body has to be long enough that the cut happens');
    assert.match(text, /Upstream comparison skipped for 3 cherry-picked commit\(s\)/,
      'the note explaining the gap has to survive the cut');
    assert.match(text, /must be marked as cherry-picked/,
      'the finding the contributor has to act on has to survive the cut');
  });

  // The same cut, over the one reason that was left as a per-commit line: the
  // unfetchable upstream turns the check neutral, and on a long series the
  // commit carrying it is below the cut, so the summary would send the reader
  // to a detail page that no longer says why.
  test('keeps the reason for a neutral upstream comparison inside truncated details', () => {
    let formalityOutputText = '### Checking PR #123: big backport series (Formalities Audit)\n\n';
    for (let i = 1; i <= 200; i++) {
      formalityOutputText += `#### Commit [000000${i}](https://github.com/commit/${i}) - mypkg: commit ${i}:\n`;
      formalityOutputText += `  ✅ ${'subject, body and sign-off all check out '.repeat(16)}\n`;
      formalityOutputText += i === 150
        ? '  ⚠️ Could not fetch upstream commit def5678 from GitHub API (HTTP 404)\n\n'
        : '\n';
    }

    const ctx = {
      client: { budget: { limit: 50, used: 10, reserve: 15 } },
      fileBatchLoader: { getBudgetSkipCount: () => 0 },
      commitScanCapped: false,
      commits: new Array(200).fill({ sha: 'dummy' })
    };
    const patchesResult = {
      patchUnavailable: false,
      upstreamComparisonSkips: 0,
      upstreamFetchFailures: 1,
      commitDetailsIncomplete: false
    };
    const outcome = {
      allFormalityErrors: [],
      allPrWarnings: [],
      allMakefileErrors: [],
      allPatchesErrors: [],
      formalityOutputText,
      makefileOutputText: 'Makefile OK\n',
      patchesOutputText: 'Patches OK\n',
      patchesHeading: '## Patches\n',
      patchChecksIncomplete: false,
      makefileChecksIncomplete: false,
      formalityChecksIncomplete: false,
      makefileReportedFinding: false,
      patchesReportedFinding: false,
      unreadPatchNotes: new Set()
    };

    const report = aggregateReport(ctx, patchesResult, outcome);
    assert.strictEqual(report.formalityConclusion, 'neutral');

    const [gitRun] = buildCheckRunPayloads(report, 'sha-abc-123');
    const text = gitRun.payload.output.text;

    assert.match(text, /Output truncated due to GitHub character limit/,
      'the body has to be long enough that the cut happens');
    assert.doesNotMatch(text, /HTTP 404/,
      'the per-commit line this stands in for is below the cut, which is the point');
    assert.match(text, /1 upstream commit\(s\) could not be fetched from GitHub, so those backports were not compared with the commits they were taken from/,
      'the reason the summary points at has to survive the cut');
  });
});
