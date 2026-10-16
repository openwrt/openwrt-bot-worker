import { safeTruncate } from '../../core/utils.ts';
import { fetchLivePrState, type PullRequestContext } from './context.ts';
import type { AggregatedReport } from './report.ts';
import type { GitHubWriteQueue } from '../../core/github-write-queue.ts';
import type { Env } from '../../types/env.ts';

export interface CommentBodyParams {
  allPassed: boolean;
  allFormalityErrors: string[];
  allMakefileErrors: string[];
  allPatchesErrors: string[];
  allPrWarnings: string[];
  showForcePushTip?: boolean;
  deployHash?: string;
  deployDate?: string;
}

export function buildCommentBody(params: CommentBodyParams): string {
  const {
    allPassed,
    allFormalityErrors,
    allMakefileErrors,
    allPatchesErrors,
    allPrWarnings,
    showForcePushTip,
    deployHash,
    deployDate
  } = params;

  const titleStatus = !allPassed ? "Failed" : "Suggestions Available";
  let commentBody = `## Formality Check: ${titleStatus}\n\n`;
  commentBody += "We checked this pull request against the contribution guidelines. Here is what needs your attention:\n\n";

  if (!allPassed) {
    commentBody += "### 🛑 CRITICAL ERRORS\n";

    if (allFormalityErrors.length > 0) {
      allFormalityErrors.forEach(errorBlock => {
        commentBody += "> " + errorBlock.replace(/\n/g, "\n> ") + "\n>\n";
      });
    }
    if (allMakefileErrors.length > 0) {
      allMakefileErrors.forEach(errorBlock => {
        commentBody += "> " + errorBlock.replace(/\n/g, "\n> ") + "\n>\n";
      });
    }
    if (allPatchesErrors.length > 0) {
      allPatchesErrors.forEach(errorBlock => {
        commentBody += "> " + errorBlock.replace(/\n/g, "\n> ") + "\n>\n";
      });
    }
  }

  if (allPrWarnings.length > 0) {
    commentBody += "### ⚠️ STYLISTIC WARNINGS & SUGGESTIONS\n";
    allPrWarnings.forEach(warnBlock => {
      commentBody += "> " + warnBlock.replace(/\n/g, "\n> ") + "\n>\n";
    });
  }

  if (!allPassed && showForcePushTip) {
    commentBody += "\n> [!TIP]\n";
    commentBody += "> **Do not close this pull request** to make corrections. Instead, modify your existing commits (e.g. `git commit --amend`) and update the branch using `git push --force-with-lease --force-if-includes`. The checks will re-run automatically.\n\n";
  }

  let footerMd = `\n\n---\n<sub>Something broken? Consider [reporting an issue](https://github.com/openwrt/openwrt-bot-worker/issues/new).</sub>`;

  if (deployHash && deployHash !== 'unknown') {
    const shortHash = deployHash.slice(0, 7);
    let versionInfo = `Running version [\`${shortHash}\`](https://github.com/openwrt/openwrt-bot-worker/commit/${deployHash})`;
    if (deployDate && deployDate !== 'unknown') {
      versionInfo += ` deployed on ${deployDate}`;
    }
    footerMd += `<br><sub>_${versionInfo}_</sub>`;
  }

  commentBody += footerMd;
  return safeTruncate(commentBody);
}

export async function syncPrComment(
  ctx: PullRequestContext,
  report: AggregatedReport,
  queue: GitHubWriteQueue,
  env: Env
): Promise<void> {
  const { config, repoFullname, prNumber, client, getCommentsScanWithRetry } = ctx;
  const { allPassed, isValidationIncomplete, allFormalityErrors, allMakefileErrors, allPatchesErrors, allPrWarnings } = report;

  if (!config.enable_comments) {
    return;
  }

  const scanResult = await getCommentsScanWithRetry();
  if (scanResult === null) {
    return;
  }

  // Prevent older runs from overwriting comments if PR moved or verification fails
  const { verdictMoved } = await fetchLivePrState(ctx);
  if (verdictMoved) {
    console.warn(`Skipping PR comment sync for #${prNumber}: PR state moved or could not be verified`);
    return;
  }

  const commentsUrl = `https://api.github.com/repos/${repoFullname}/issues/${prNumber}/comments`;
  const existingCommentId = scanResult.existingCommentId;

  if (!allPassed || allPrWarnings.length > 0) {
    const commentBody = buildCommentBody({
      allPassed,
      allFormalityErrors,
      allMakefileErrors,
      allPatchesErrors,
      allPrWarnings,
      showForcePushTip: config.show_force_push_tip,
      deployHash: env.DEPLOY_HASH,
      deployDate: env.DEPLOY_DATE
    });

    if (existingCommentId) {
      queue.enqueue('PR comment update', () =>
        client.trackedApiCall(`https://api.github.com/repos/${repoFullname}/issues/comments/${existingCommentId}`, 'PATCH', { body: commentBody })
      );
    } else {
      queue.enqueue('PR comment', () =>
        client.trackedApiCall(commentsUrl, 'POST', { body: commentBody })
      );
    }
  } else if (!isValidationIncomplete) {
    if (existingCommentId) {
      queue.enqueue('PR comment removal', async () => {
        const res = await client.trackedApiCall(`https://api.github.com/repos/${repoFullname}/issues/comments/${existingCommentId}`, 'DELETE');
        return res.code === 404 ? { code: 200 } : res;
      });
    }
  }
}
