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

  enqueueAll(operations: Array<[string, () => Promise<GitHubApiResponse<any> | { code?: number }>, WriteOptions?] | WriteOperation>): void {
    for (const op of operations) {
      this.queue.push([op[0], op[1], op[2]]);
    }
  }

  recordWrite(what: string, code?: number): void {
    this.statusWrites.push({ what, code });
  }

  async execute(budget?: SubrequestBudget): Promise<Response | null> {
    for (let i = 0; i < this.queue.length; i++) {
      const [what, write, options] = this.queue[i];

      if (budget && !options?.isCritical) {
        const pendingCritical = this.queue.slice(i).filter(([_, __, opt]) => opt?.isCritical).length;
        const remainingCalls = budget.limit - budget.used;
        if (remainingCalls <= pendingCritical) {
          console.warn(
            `Skipping non-critical write '${what}' for PR #${this.prNumber}: preserving remaining subrequest budget (${remainingCalls}) for ${pendingCritical} check-runs.`
          );
          continue;
        }
      }

      try {
        const res = await write();
        this.recordWrite(what, res?.code);
      } catch (err: any) {
        console.error(`Write operation '${what}' threw an exception:`, err);
        this.recordWrite(what, 599);
      }
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

