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
  url: string;
  commits?: number;
  author_association?: string;
  user?: GitHubUser;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string; repo?: { full_name?: string } };
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

export interface PullRequestEventPayload extends BaseWebhookPayload {
  action: 'opened' | 'synchronize' | 'reopened' | 'edited' | string;
  pull_request: PullRequestData;
}

export interface IssueCommentEventPayload extends BaseWebhookPayload {
  action: 'created' | string;
  issue: IssueData;
  comment: IssueCommentData;
  pull_request?: PullRequestData;
}

export interface IssuesEventPayload extends BaseWebhookPayload {
  action: 'opened' | 'edited' | 'reopened' | string;
  issue: IssueData;
}

export type WebhookPayload = PullRequestEventPayload | IssueCommentEventPayload | IssuesEventPayload | BaseWebhookPayload;
