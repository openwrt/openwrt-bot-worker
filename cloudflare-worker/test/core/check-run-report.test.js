import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildCheckRunPayloads, enqueueCheckRuns } from '../../src/handlers/pull-request/check-run-report.ts';
import { GitHubWriteQueue } from '../../src/core/github-write-queue.ts';

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
});
