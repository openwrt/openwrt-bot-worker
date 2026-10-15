import { isBotUser, optionalAttemptCounter } from './utils.ts';
import { fetchUserRepoPermission } from '../github.js';
import { MAINTAINER_ASSOCIATIONS } from './policy.ts';
import type { SubrequestBudget } from '../types/env.ts';
import type { GitHubUser } from '../types/github.ts';

export function createMaintainerResolver(
  repoFullname: string,
  token: string,
  subrequestBudget: SubrequestBudget
) {
  const cache = new Map<string, Promise<boolean>>();
  let budgetWarned = false;

  return async function isMaintainerUser(
    user: GitHubUser | null | undefined,
    association: string | null | undefined
  ): Promise<boolean> {
    if (isBotUser(user)) {
      return false;
    }
    if (MAINTAINER_ASSOCIATIONS.includes((association || '').toUpperCase())) {
      return true;
    }
    const login = user?.login;
    if (!login) {
      return false;
    }
    // GitHub logins are case-insensitive, and the same user can reach us with
    // different casing across payloads, so memoize on a normalized key. The
    // lookup itself keeps the login as written.
    const cacheKey = login.toLowerCase();
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey)!;
    }
    // Leave the reserve untouched so the terminal writes (labels, PR comment,
    // check-runs) at the end of the handler always have headroom left.
    if (subrequestBudget.limit - subrequestBudget.reserve - subrequestBudget.used <= 0) {
      if (!budgetWarned) {
        budgetWarned = true;
        console.warn(`Subrequest budget exhausted (used ${subrequestBudget.used}/${subrequestBudget.limit}, ${subrequestBudget.reserve} reserved): permission lookups skipped, maintainers outside the organization are treated as contributors.`);
      }
      return false;
    }
    // Cache the pending promise, not the result, so concurrent questions about
    // the same login share a single lookup.
    const pending = fetchUserRepoPermission(repoFullname, login, token, optionalAttemptCounter(subrequestBudget))
      .then((hasWriteAccess: boolean | null) => {
        // A failed lookup is not evidence of missing access, so it must not
        // stick: drop it and let a later question about the same login retry.
        if (hasWriteAccess === null) {
          cache.delete(cacheKey);
          return false;
        }
        return hasWriteAccess;
      });
    cache.set(cacheKey, pending);
    return pending;
  };
}
