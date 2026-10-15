import { githubApiCall } from '../github.js';
import { optionalAttemptCounter } from './utils.ts';
import type { SubrequestBudget } from '../types/env.ts';
import type { GitHubApiResponse } from '../types/github.ts';

export interface GitHubClient {
  trackedApiCall: <T = any>(
    url: string,
    method?: string,
    payload?: any,
    accept?: string,
    options?: any
  ) => Promise<GitHubApiResponse<T>>;
  optionalApiCall: <T = any>(
    url: string,
    method?: string,
    payload?: any,
    accept?: string,
    options?: any
  ) => Promise<GitHubApiResponse<T>>;
  hasHeadroom: () => boolean;
  countOptionalAttempt: (attempt: number) => boolean;
  budget: SubrequestBudget;
}

export function createGitHubClient(token: string, budget: SubrequestBudget): GitHubClient {
  const countOptionalAttempt = optionalAttemptCounter(budget);

  const trackedApiCall = async <T = any>(
    url: string,
    method = 'GET',
    payload: any = null,
    accept = 'application/vnd.github+json',
    options: any = {}
  ): Promise<GitHubApiResponse<T>> => {
    return githubApiCall(url, token, method, payload, accept, {
      ...options,
      onAttempt: () => { budget.used++; }
    });
  };

  const optionalApiCall = async <T = any>(
    url: string,
    method = 'GET',
    payload: any = null,
    accept = 'application/vnd.github+json',
    options: any = {}
  ): Promise<GitHubApiResponse<T>> => {
    return githubApiCall(url, token, method, payload, accept, {
      ...options,
      onAttempt: countOptionalAttempt
    });
  };

  const hasHeadroom = (): boolean => budget.limit - budget.reserve - budget.used > 0;

  return {
    trackedApiCall,
    optionalApiCall,
    hasHeadroom,
    countOptionalAttempt,
    budget
  };
}
