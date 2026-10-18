import { loadPullRequestContext } from './context.ts';
import { resolvePatchesAndCommits } from './patches.ts';
import { runValidations } from './validation.ts';
import { aggregateReport } from './report.ts';
import { syncLabels } from './label-sync.ts';
import { syncPrComment } from './comment-report.ts';
import { enqueueCheckRuns } from './check-run-report.ts';
import { GitHubWriteQueue } from '../../core/github-write-queue.ts';
import type { Env } from '../../types/env.ts';
import { isPullRequestPayload, isIssueCommentPayload, type PullRequestEventPayload, type IssueCommentEventPayload } from '../../types/github.ts';

export async function handlePullRequestEvent(
  data: unknown,
  event: string,
  env: Env,
  token: string,
  repoFullname: string,
  appId: number | null,
  tokenMintAttempts: number
): Promise<Response> {
  let payload: PullRequestEventPayload | IssueCommentEventPayload;
  if (event === 'issue_comment') {
    if (!isIssueCommentPayload(data)) {
      return new Response("Invalid payload: expected issue_comment event payload with issue and comment objects", { status: 400 });
    }
    payload = data;
  } else if (event === 'pull_request') {
    if (!isPullRequestPayload(data)) {
      return new Response("Invalid payload: expected pull_request event payload with pull_request object", { status: 400 });
    }
    payload = data;
  } else {
    return new Response("Invalid event for pull request handler", { status: 400 });
  }

  // 1. Context loading & early bot filtering
  const contextResult = await loadPullRequestContext(payload, event, env, token, repoFullname, appId, tokenMintAttempts);
  if (contextResult.kind === 'response') {
    return contextResult.response;
  }
  const ctx = contextResult.context;

  // 2. Patches & commits resolution
  const patchesResult = await resolvePatchesAndCommits(ctx);

  // 3. Validation execution
  const validationOutcome = await runValidations(ctx, patchesResult);

  // 4. Report aggregation
  const report = aggregateReport(ctx, patchesResult, validationOutcome);

  // 5. Build write queue for labels, comments, and check runs
  const queue = new GitHubWriteQueue(ctx.prNumber);
  await syncLabels(ctx, patchesResult, report, queue);
  await syncPrComment(ctx, report, queue, env);
  enqueueCheckRuns(ctx, report, queue);

  // 6. Execute writes sequentially & check results
  const errorResponse = await queue.execute(ctx.client.budget);
  if (errorResponse) {
    return errorResponse;
  }

  return new Response(`Success: Processed check runs for PR #${ctx.prNumber}`, { status: 200 });
}
