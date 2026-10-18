export interface GitHubUser {
  login?: string;
  type?: string;
  [key: string]: unknown;
}

export interface GitHubApiResponse<T = any> {
  code: number;
  data: T | null;
  raw: string;
  headers: {
    get: (name: string) => string | null;
    [key: string]: unknown;
  };
}

export interface CommitAuthor {
  name?: string;
  email?: string;
  date?: string;
}

export interface CommitData {
  sha: string;
  html_url?: string;
  changed_files?: number | null;
  parents?: Array<{ sha: string }>;
  commit?: {
    message?: string;
    author?: CommitAuthor;
    committer?: CommitAuthor;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PullRequestData {
  number: number;
  title?: string;
  body?: string;
  state?: string;
  merged?: boolean;
  url?: string;
  commits?: number;
  author_association?: string;
  user?: GitHubUser;
  base: { ref: string; sha: string; repo?: { full_name?: string; default_branch?: string }; [key: string]: unknown };
  head: { ref: string; sha: string; repo?: { full_name?: string }; [key: string]: unknown };
  labels?: Array<string | { name: string }>;
  [key: string]: unknown;
}

export interface IssueData {
  number: number;
  title?: string;
  body?: string;
  pull_request?: Record<string, unknown>;
  labels?: Array<string | { name: string }>;
  [key: string]: unknown;
}

export interface IssueCommentData {
  id: number | string;
  body?: string;
  user?: GitHubUser;
  author_association?: string;
  [key: string]: unknown;
}

export interface BaseWebhookPayload {
  action?: string;
  installation?: { id: number };
  repository?: {
    full_name?: string;
    default_branch?: string;
    [key: string]: unknown;
  };
  changes?: {
    base?: unknown;
    body?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type PullRequestAction =
  | 'opened'
  | 'synchronize'
  | 'reopened'
  | 'edited'
  | 'closed'
  | 'labeled'
  | 'unlabeled'
  | 'assigned'
  | 'unassigned'
  | 'review_requested'
  | 'review_request_removed'
  | 'ready_for_review'
  | 'converted_to_draft';

export type IssueCommentAction =
  | 'created'
  | 'edited'
  | 'deleted';

export type IssuesAction =
  | 'opened'
  | 'edited'
  | 'deleted'
  | 'pinned'
  | 'unpinned'
  | 'closed'
  | 'reopened'
  | 'assigned'
  | 'unassigned'
  | 'labeled'
  | 'unlabeled'
  | 'locked'
  | 'unlocked'
  | 'transferred';

export interface PullRequestEventPayload extends BaseWebhookPayload {
  event?: 'pull_request';
  action: PullRequestAction;
  pull_request: PullRequestData;
}

export interface IssueCommentEventPayload extends BaseWebhookPayload {
  event?: 'issue_comment';
  action: IssueCommentAction;
  issue: IssueData;
  comment: IssueCommentData;
  pull_request?: PullRequestData;
}

export interface IssuesEventPayload extends BaseWebhookPayload {
  event?: 'issues';
  action: IssuesAction;
  issue: IssueData;
}

export type WebhookPayload = PullRequestEventPayload | IssueCommentEventPayload | IssuesEventPayload;

export function isPullRequestPayload(payload: unknown): payload is PullRequestEventPayload {
  if (typeof payload !== 'object' || payload === null || 'comment' in payload) {
    return false;
  }
  const p = payload as Record<string, unknown>;
  if (!p.pull_request || typeof p.pull_request !== 'object') {
    return false;
  }
  const pr = p.pull_request as Record<string, unknown>;
  if (typeof pr.number !== 'number') {
    return false;
  }
  if (!pr.base || typeof pr.base !== 'object' || !pr.head || typeof pr.head !== 'object') {
    return false;
  }
  const base = pr.base as Record<string, unknown>;
  const head = pr.head as Record<string, unknown>;
  return (
    typeof base.ref === 'string' && base.ref.trim().length > 0 &&
    typeof base.sha === 'string' && base.sha.trim().length > 0 &&
    typeof head.ref === 'string' && head.ref.trim().length > 0 &&
    typeof head.sha === 'string' && head.sha.trim().length > 0
  );
}

export function isIssueCommentPayload(payload: unknown): payload is IssueCommentEventPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const p = payload as Record<string, unknown>;
  if (!p.comment || typeof p.comment !== 'object' || !p.issue || typeof p.issue !== 'object') {
    return false;
  }
  const issue = p.issue as Record<string, unknown>;
  return typeof issue.number === 'number';
}

export function isIssuesPayload(payload: unknown): payload is IssuesEventPayload {
  if (typeof payload !== 'object' || payload === null || 'comment' in payload) {
    return false;
  }
  const p = payload as Record<string, unknown>;
  if (!p.issue || typeof p.issue !== 'object') {
    return false;
  }
  const issue = p.issue as Record<string, unknown>;
  return typeof issue.number === 'number';
}
