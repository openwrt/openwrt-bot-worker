// githubApiCall retries a failed write, and Cloudflare counts every attempt
// against the per-invocation subrequest cap, so one critical check-run write
// can cost MAX_ATTEMPTS subrequests rather than one. Room kept for the writes
// that must still go out is therefore counted in attempts: counting operations
// leaves two thirds of their worst case unreserved. The ceiling is imported
// rather than restated, so raising the retries cannot quietly unreserve the
// attempts they add.
import { MAX_ATTEMPTS, wasAttemptDeclined } from '../github.js';
import type { GitHubApiResponse } from '../types/github.ts';
import type { SubrequestBudget } from '../types/env.ts';

export interface WriteOptions {
  isCritical?: boolean;
}

export type WriteOperation = [
  string,
  () => Promise<GitHubApiResponse<any> | { code?: number }>,
  WriteOptions | undefined
];

export interface WriteResult {
  what: string;
  code?: number;
}

export class GitHubWriteQueue {
  private prNumber: number;
  public queue: WriteOperation[] = [];
  public statusWrites: WriteResult[] = [];

  constructor(prNumber: number) {
    this.prNumber = prNumber;
  }

  enqueue(
    what: string,
    operation: () => Promise<GitHubApiResponse<any> | { code?: number }>,
    options?: WriteOptions
  ): void {
    this.queue.push([what, operation, options]);
  }

  recordWrite(what: string, code?: number): void {
    this.statusWrites.push({ what, code });
  }

  // The policy for the closing writes, in one place. A critical write is
  // never skipped and its attempts are never declined, so what its retries
  // may cost is what every other write has to leave alone. The reading phase
  // kept a flat `reserve` off the top for this phase; from here on that
  // reserve is restated as what the critical writes still queued may yet
  // cost - pendingCritical * MAX_ATTEMPTS - and an optional write
  // may only start while more than that is left. Its retries are charged
  // through the declining counter the optional reads already use
  // (client.optionalApiCall / client.countOptionalAttempt), which reads the
  // same reserve, so no optional write can push `used` past `limit - reserve`
  // and the three check-runs reach `limit` at worst, never beyond it.
  async execute(budget?: SubrequestBudget): Promise<Response | null> {
    const readingPhaseReserve = budget?.reserve;
    try {
      for (let i = 0; i < this.queue.length; i++) {
        const [what, write, options] = this.queue[i];

        if (budget) {
          const pendingCritical = this.queue.slice(i).filter(([_, __, opt]) => opt?.isCritical).length;
          budget.reserve = pendingCritical * MAX_ATTEMPTS;
          const remainingCalls = budget.limit - budget.used;
          if (!options?.isCritical && remainingCalls <= budget.reserve) {
            console.warn(
              `Skipping non-critical write '${what}' for PR #${this.prNumber}: ${remainingCalls} subrequest attempt(s) left, all of them reserved for ${pendingCritical} critical write(s) that may need up to ${budget.reserve}.`
            );
            continue;
          }
        }

        try {
          const res = await write();
          // A write the budget refused was never made, so it is skipped like
          // the ones this queue holds back above - not recorded as a write
          // GitHub rejected. Reporting it as a failure would blame GitHub for
          // this worker's own decision, and would fail a delivery whose
          // essential writes all went out.
          if (wasAttemptDeclined(res as any)) {
            console.warn(`Skipping write '${what}' for PR #${this.prNumber}: no subrequest attempt left outside the reserve.`);
            continue;
          }
          this.recordWrite(what, res?.code);
        } catch (err: any) {
          console.error(`Write operation '${what}' threw an exception:`, err);
          this.recordWrite(what, 599);
        }
      }
    } finally {
      // The budget outlives this queue, so leave it saying what it said
      // before rather than carrying the last reservation made here.
      if (budget && readingPhaseReserve !== undefined) budget.reserve = readingPhaseReserve;
    }

    const failedWrites = this.statusWrites.filter(w => !(w.code !== undefined && w.code >= 200 && w.code < 300));
    if (failedWrites.length > 0) {
      const summary = failedWrites.map(w => `${w.what} (HTTP ${w.code ?? 'no response'})`).join(', ');
      console.error(`Status reporting for PR #${this.prNumber} failed: ${summary}`);
      return new Response(`Failed to report status for PR #${this.prNumber}: ${summary}`, { status: 502 });
    }

    return null;
  }
}

