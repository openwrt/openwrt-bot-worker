import { parseAndValidateConfig } from '../../types/config.ts';
import { graphqlFetchRepoSetup } from '../../github.js';
import { GitHubWriteQueue } from '../../core/github-write-queue.ts';
import { parseEnvInt } from '../../core/utils.ts';
import { createMaintainerResolver } from '../../core/maintainer-resolver.ts';
import { scanCommentList, scanPrComments } from '../../core/comment-scanner.ts';
import { createFileBatchLoader } from '../../core/file-batch-loader.ts';
import { createGitHubClient } from '../../core/github-client.ts';
import {
  IGNORED_USERS,
  MAINTAINER_ASSOCIATIONS,
  ALLOW_BRANCH_PATTERN,
  ALLOW_CHERRY_PICK_PATTERN,
  isProtectedHeadBranch
} from '../../core/policy.ts';
import type { Env, SubrequestBudget } from '../../types/env.ts';
import {
  isIssueCommentPayload,
  isPullRequestPayload,
  type PullRequestData,
  type GitHubApiResponse,
  type CommitData,
  type GitHubUser,
  type PullRequestEventPayload,
  type IssueCommentEventPayload
} from '../../types/github.ts';
import type { FormalitiesConfig } from '../../types/config.ts';
import type { FileBatchLoader } from '../../core/file-batch-loader.ts';
import type { GitHubClient } from '../../core/github-client.ts';
import type { CommentScanResult } from '../../core/comment-scanner.ts';

export interface PullRequestContext {
  prNumber: number;
  prTitle: string;
  prBody: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  baseSha: string;
  isBackportPr: boolean;
  repoFullname: string;
  token: string;
  client: GitHubClient;
  config: FormalitiesConfig;
  configError: string | null;
  existingLabels: Set<string> | null;
  labelerText: string | null;
  commits: CommitData[];
  commitsCount: number;
  commitScanCapped: boolean;
  fileBatchLoader: FileBatchLoader;
  action: string;
  prData: PullRequestData;
  startPrPatchFetch: () => Promise<GitHubApiResponse<string>>;
  getCommentsScanWithRetry: () => Promise<CommentScanResult | null>;
  isMaintainerUser: (user: GitHubUser | null | undefined, assoc?: string | null) => Promise<boolean>;
  isAuthorMaintainer: (bodyRequestsBypass: boolean) => Promise<boolean>;
  bodyRequestsCherryPickBypass: boolean;
  branchCheckViolated: boolean;
  bypassBranchCheck: boolean;
  branchCheckError: string | null;
  branchCheckOutputText: string;
}

export type ContextResult =
  | { kind: 'response'; response: Response }
  | { kind: 'context'; context: PullRequestContext };

export async function loadPullRequestContext(
  data: PullRequestEventPayload | IssueCommentEventPayload,
  _event: string,
  env: Env,
  token: string,
  repoFullname: string,
  appId: number | null,
  tokenMintAttempts: number
): Promise<ContextResult> {
  const subrequestBudget: SubrequestBudget = {
    limit: parseEnvInt(env.SUBREQUEST_BUDGET_LIMIT, 45),
    reserve: parseEnvInt(env.SUBREQUEST_RESERVE_HEADROOM, 15),
    used: tokenMintAttempts
  };

  const client = createGitHubClient(token, subrequestBudget);
  const isMaintainerUser = createMaintainerResolver(repoFullname, token, subrequestBudget);

  let prData: PullRequestData;

  if (isIssueCommentPayload(data)) {
    const prNumberFromIssue = data.issue.number;
    if (!prNumberFromIssue) {
      console.error("Webhook processing failed: Missing pull request number in issue_comment payload.");
      return { kind: 'response', response: new Response("Missing pull request number", { status: 400 }) };
    }

    if (!await isMaintainerUser(data.comment?.user, data.comment?.author_association)) {
      return { kind: 'response', response: new Response("Ignored non-maintainer issue comment", { status: 200 }) };
    }

    const prUrl = `https://api.github.com/repos/${repoFullname}/pulls/${prNumberFromIssue}`;
    const prRes = await client.trackedApiCall<PullRequestData>(prUrl);
    if (!prRes || prRes.code !== 200 || !prRes.data) {
      throw new Error(`Failed to fetch PR details from ${prUrl} (HTTP ${prRes?.code})`);
    }

    if (prRes.data.state === 'closed') {
      return { kind: 'response', response: new Response(`Ignored comment on ${prRes.data.merged ? 'merged' : 'closed'} pull request #${prNumberFromIssue}`, { status: 200 }) };
    }
    prData = prRes.data;
  } else if (isPullRequestPayload(data)) {
    prData = data.pull_request;
  } else {
    return { kind: 'response', response: new Response("Invalid payload for pull request context", { status: 400 }) };
  }

  const prAuthor = prData.user?.login || 'unknown';
  const senderType = prData.user?.type || 'User';

  if (IGNORED_USERS.map(u => u.toLowerCase()).includes(prAuthor.toLowerCase()) || senderType === 'Bot') {
    if (prAuthor.toLowerCase().startsWith('dependabot') && (data.action === 'opened')) {
      const currentPrLabels = new Set(
        (prData.labels || []).map((l: any) => (typeof l === 'string' ? l : l.name).toLowerCase())
      );
      const headRef = prData.head?.ref || '';
      const dependabotLabels = [
        { name: 'dependencies', color: '0366d6', description: 'Pull requests that update a dependency file' }
      ];

      if (headRef.includes('/github_actions/') || headRef.includes('/github-actions/')) {
        dependabotLabels.push(
          { name: 'GitHub/CI',      color: 'e6a742', description: 'Pull requests/issues for GitHub, CI and related stuff' },
          { name: 'github_actions', color: '2088ff', description: 'Pull requests that update GitHub Actions code' }
        );
      }
      if (headRef.includes('/npm_and_yarn/')) {
        dependabotLabels.push(
          { name: 'javascript', color: 'f1e05a', description: 'Pull requests that update Javascript code' }
        );
      }

      const labelsToEnsure = dependabotLabels.filter(lbl => !currentPrLabels.has(lbl.name.toLowerCase()));

      if (labelsToEnsure.length > 0) {
        const prNumber = prData.number || 0;
        const queue = new GitHubWriteQueue(prNumber);

        for (const lbl of labelsToEnsure) {
          queue.enqueue(`ensure label "${lbl.name}"`, async () => {
            const url = `https://api.github.com/repos/${repoFullname}/labels`;
            const res = await client.trackedApiCall(url, 'POST', {
              name: lbl.name,
              color: lbl.color,
              description: lbl.description
            });
            if (res.code === 422 || (res.code >= 200 && res.code < 300)) {
              return { code: 200 };
            }
            return res;
          });
        }

        if (prNumber) {
          const prLabelUrl = `https://api.github.com/repos/${repoFullname}/issues/${prNumber}/labels`;
          queue.enqueue('apply Dependabot labels', () =>
            client.trackedApiCall(prLabelUrl, 'POST', { labels: labelsToEnsure.map(l => l.name) })
          );
        }

        const writeError = await queue.execute();
        if (writeError) {
          return { kind: 'response', response: writeError };
        }
      }
    }
    return { kind: 'response', response: new Response(`Success: Ignored PR from bot/system user (@${prAuthor})`, { status: 200 }) };
  }

  const baseBranch = prData.base.ref;
  const headBranch = prData.head.ref;
  const prNumber = prData.number;
  const prTitle = prData.title || '';
  const prBody = prData.body || '';
  const headSha = prData.head.sha;
  const baseSha = prData.base.sha;
  const isBackportPr = /^(stable|openwrt-)/.test(baseBranch) || /^\[\d{2}\.\d{2}\]/.test(prTitle);

  const fileBatchLoader = createFileBatchLoader({
    token,
    repoFullname,
    headRepoFullname: prData.head?.repo?.full_name,
    subrequestBudget,
    countOptionalAttempt: client.countOptionalAttempt,
    graphqlChunkSize: parseEnvInt(env.GRAPHQL_CHUNK_SIZE, 50),
    initialBaseSha: baseSha
  });

  let prPatchPromise: Promise<GitHubApiResponse<string>> | null = null;
  const startPrPatchFetch = (): Promise<GitHubApiResponse<string>> => {
    if (prPatchPromise === null) {
      const prUrl = prData.url || `https://api.github.com/repos/${repoFullname}/pulls/${prNumber}`;
      prPatchPromise = client.trackedApiCall<string>(prUrl, 'GET', null, 'application/vnd.github.patch');
    }
    return prPatchPromise;
  };
  if ((prData.commits || 1) > 1) {
    void startPrPatchFetch();
  }

  const setup = await graphqlFetchRepoSetup(
    token,
    repoFullname,
    baseBranch,
    '.github/formalities.json',
    '.github/labeler.yml',
    () => { subrequestBudget.used++; },
    prNumber
  );

  const { config, error: configError } = parseAndValidateConfig(setup.configText);
  if (configError) {
    console.warn(`Repository config .github/formalities.json in ${repoFullname} could not be used, falling back to the defaults: ${configError}`);
  }

  const commits = setup.commits || [];
  const commitsCount = setup.commitsTotal || commits.length;
  const commitScanCapped = commitsCount > commits.length;

  let fetchCommentsPromise: Promise<CommentScanResult | null> | null = null;
  let fetchCommentsRetried = false;

  // The comments came with the setup query. The one thing they cannot settle
  // on their own is whether a Formality Check comment left by some GitHub App
  // is this app's: GraphQL's viewerDidAuthor should say so under the
  // installation token, but until that has been seen in production a thread
  // where it denies such a comment is listed through REST instead, which
  // names the app outright. A thread longer than one page takes that road too.
  const inlineComments = setup.comments as any[] | null;
  const inlineCommentsSuffice = Array.isArray(inlineComments) && !inlineComments.some((c: any) =>
    c.user?.type === 'Bot' && c.viewer_did_author !== true && (c.body || '').startsWith('## Formality Check:'));

  const getCommentsScan = (): Promise<CommentScanResult | null> => {
    if (fetchCommentsPromise === null) {
      fetchCommentsPromise = inlineCommentsSuffice
        ? scanCommentList(inlineComments, isMaintainerUser, appId).catch(() => null)
        : scanPrComments(repoFullname, prNumber, token, client.countOptionalAttempt, isMaintainerUser, appId, client.hasHeadroom).catch(() => null);
    }
    return fetchCommentsPromise;
  };

  const getCommentsScanWithRetry = async (): Promise<CommentScanResult | null> => {
    const result = await getCommentsScan();
    // A scan that stopped because the budget ran out is not a transient
    // failure: running it again would spend the very headroom it stopped to
    // protect, and end the same way.
    if (result !== null || fetchCommentsRetried || !client.hasHeadroom()) {
      return result;
    }
    fetchCommentsRetried = true;
    fetchCommentsPromise = null;
    return getCommentsScan();
  };

  const branchCheckViolated = !!config.check_branch && isProtectedHeadBranch(headBranch);
  if (config.enable_comments || isBackportPr || branchCheckViolated) {
    void getCommentsScan();
  }

  if (!Array.isArray(commits)) {
    throw new Error(`Expected commits list to be an array, but received: ${typeof commits}`);
  }

  const association = (prData.author_association || 'NONE').toUpperCase();
  const bodyRequestsBranchBypass = ALLOW_BRANCH_PATTERN.test(prBody);
  const bodyRequestsCherryPickBypass = ALLOW_CHERRY_PICK_PATTERN.test(prBody);

  // Resolved on demand, like the comment scan above: for an outside
  // contributor the answer costs a subrequest (see createMaintainerResolver),
  // so it is only worth asking when the description actually carries an
  // override. Without one the association alone decides, which at most picks
  // the wording of the hint printed with the failure.
  const isAuthorMaintainer = (bodyRequestsBypass: boolean) => bodyRequestsBypass
    ? isMaintainerUser(prData.user, association)
    : Promise.resolve(MAINTAINER_ASSOCIATIONS.includes(association));

  let bypassBranchCheck = false;
  let branchCheckError: string | null = null;
  let branchCheckOutputText = '';

  if (config.check_branch) {
    if (isProtectedHeadBranch(headBranch)) {
      const isMaintainer = await isAuthorMaintainer(bodyRequestsBranchBypass);
      const scanResult = await getCommentsScanWithRetry() || { hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null };
      bypassBranchCheck = scanResult.hasBranchBypassComment || (bodyRequestsBranchBypass && isMaintainer);

      if (bypassBranchCheck) {
        branchCheckOutputText = `⚠️ Pull request originates from protected branch \`${headBranch}\` but was allowed via override command\n\n`;
      } else {
        let errorMsg = `### PR Targeting Violation\n- Pull requests must originate from a dedicated feature branch. Cannot use \`${headBranch}\` directly.`;
        if (isMaintainer) {
          errorMsg += ` (Use \`[allow branch]\` in PR description or comment to override this check)`;
        } else {
          errorMsg += ` (A maintainer can override this check by commenting \`[allow branch]\` on this PR)`;
        }
        branchCheckError = errorMsg;
        branchCheckOutputText = `❌ Pull request must originate from a feature branch\n       Reason: Target branch \`${headBranch}\` used as origin.\n\n`;
      }
    } else {
      branchCheckOutputText = `✅ Pull request originates from a dedicated feature branch (\`${headBranch}\`)\n\n`;
    }
  }

  return {
    kind: 'context',
    context: {
      prNumber,
      prTitle,
      prBody,
      baseBranch,
      headBranch,
      headSha,
      baseSha,
      isBackportPr,
      repoFullname,
      token,
      client,
      config,
      configError,
      existingLabels: setup.labels,
      labelerText: setup.labelerText,
      commits,
      commitsCount,
      commitScanCapped,
      fileBatchLoader,
      action: data.action || '',
      prData,
      startPrPatchFetch,
      getCommentsScanWithRetry,
      isMaintainerUser,
      isAuthorMaintainer,
      bodyRequestsCherryPickBypass,
      branchCheckViolated,
      bypassBranchCheck,
      branchCheckError,
      branchCheckOutputText
    }
  };
}
