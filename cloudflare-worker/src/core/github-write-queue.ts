import type { GitHubApiResponse } from '../types/github.ts';

export type WriteOperation = [string, () => Promise<GitHubApiResponse<any> | { code?: number }>];

export interface WriteResult {
  what: string;
  code?: number;
}

export class GitHubWriteQueue {
  private prNumber: number;
  private queue: WriteOperation[] = [];
  public statusWrites: WriteResult[] = [];

  constructor(prNumber: number) {
    this.prNumber = prNumber;
  }

  enqueue(what: string, operation: () => Promise<GitHubApiResponse<any> | { code?: number }>): void {
    this.queue.push([what, operation]);
  }

  enqueueAll(operations: WriteOperation[]): void {
    this.queue.push(...operations);
  }

  recordWrite(what: string, code?: number): void {
    this.statusWrites.push({ what, code });
  }

  async execute(): Promise<Response | null> {
    for (const [what, write] of this.queue) {
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
