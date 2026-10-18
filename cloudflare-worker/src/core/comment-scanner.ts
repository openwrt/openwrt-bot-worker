import { ALLOW_BRANCH_PATTERN, ALLOW_CHERRY_PICK_PATTERN } from './policy.ts';
import { isOwnAppComment } from '../issue-labeller.js';
import { githubApiCall } from '../github.js';
import type { GitHubUser, GitHubApiResponse } from '../types/github.ts';

export interface CommentScanResult {
  hasCherryPickBypassComment: boolean;
  hasBranchBypassComment: boolean;
  existingCommentId: string | number | null;
  // Whether the whole thread was read. What an unfinished scan did find still
  // holds - an override seen on page 1 is an override - but the absence of one
  // says nothing, so "no override found" and "could not look" are not the same
  // answer: reading the second as the first fails a pull request a maintainer
  // already waved through.
  incomplete: boolean;
  // Set when an override command was found but GitHub would not say whether
  // its author has write access. Access is never assumed, so the override is
  // not honoured - and the rule it waives cannot be called violated either,
  // because the evidence that would waive it is exactly what is missing. Each
  // rule carries its own flag, so an unverifiable `[allow branch]` leaves the
  // cherry-pick rule alone. Kept off `incomplete`: the thread itself was read
  // in full, and re-reading it would spend the reserve on the same answer.
  branchOverrideUnverified: boolean;
  cherryPickOverrideUnverified: boolean;
}

export function emptyCommentScan(): CommentScanResult {
  return {
    hasCherryPickBypassComment: false,
    hasBranchBypassComment: false,
    existingCommentId: null,
    incomplete: false,
    branchOverrideUnverified: false,
    cherryPickOverrideUnverified: false
  };
}

export function incompleteCommentScan(): CommentScanResult {
  return { ...emptyCommentScan(), incomplete: true };
}

// Reads one list of issue comments for the three facts a run needs: the id
// of this app's own earlier report, and whether a maintainer left either
// override command. Shared by the list that arrives with the setup query and
// the paged REST listing below.
export async function scanCommentList(
  comments: Array<any>,
  isMaintainerUser: (user: GitHubUser | null | undefined, association: string | null | undefined) => Promise<boolean | null>,
  appId: number | null,
  scan: CommentScanResult = emptyCommentScan()
): Promise<CommentScanResult> {
  for (const c of comments) {
    if ((c.viewer_did_author === true || isOwnAppComment(c, appId)) && c.body?.startsWith('## Formality Check:')) {
      scan.existingCommentId = c.id;
    }
    const body = c.body || '';
    const hasCherryPickPattern = ALLOW_CHERRY_PICK_PATTERN.test(body);
    const hasBranchPattern = ALLOW_BRANCH_PATTERN.test(body);

    if (hasCherryPickPattern || hasBranchPattern) {
      const isMaintainer = await isMaintainerUser(c.user, c.author_association);
      if (isMaintainer === true) {
        if (hasCherryPickPattern) scan.hasCherryPickBypassComment = true;
        if (hasBranchPattern) scan.hasBranchBypassComment = true;
      } else if (isMaintainer === null) {
        if (hasCherryPickPattern) scan.cherryPickOverrideUnverified = true;
        if (hasBranchPattern) scan.branchOverrideUnverified = true;
      }
    }
  }
  return scan;
}

// `hasHeadroom` is asked before every page after the first: a thread long
// enough to page is also long enough to eat the headroom kept for the closing
// writes, and losing those loses the whole report. Page 1 is always read,
// because it is the one page nearly every thread fits in and the overrides
// this scan looks for are on it. A scan that stops short, or a page GitHub
// does not serve, comes back marked `incomplete` rather than as a thread
// without overrides.
export async function scanPrComments(
  repoFullname: string,
  prNumber: number,
  token: string,
  onCall: (attempt: number) => boolean,
  isMaintainerUser: (user: GitHubUser | null | undefined, association: string | null | undefined) => Promise<boolean | null>,
  appId: number | null,
  hasHeadroom: () => boolean = () => true
): Promise<CommentScanResult> {
  let page = 1;
  const scan: CommentScanResult = emptyCommentScan();

  while (true) {
    const url = `https://api.github.com/repos/${repoFullname}/issues/${prNumber}/comments?per_page=100&page=${page}`;
    const res: GitHubApiResponse<any> = await githubApiCall(url, token, 'GET', null, 'application/vnd.github+json', { onAttempt: onCall });
    if (!res || res.code !== 200 || !Array.isArray(res.data)) {
      scan.incomplete = true;
      return scan;
    }

    await scanCommentList(res.data, isMaintainerUser, appId, scan);

    if (scan.hasCherryPickBypassComment && scan.hasBranchBypassComment && scan.existingCommentId !== null) {
      break;
    }

    if (res.data.length < 100) {
      break;
    }
    if (typeof hasHeadroom === 'function' && !hasHeadroom()) {
      console.warn(`Comment scan for PR #${prNumber} stopped after page ${page}: no request budget left beyond the reserve.`);
      scan.incomplete = true;
      return scan;
    }
    page++;
  }

  return scan;
}
