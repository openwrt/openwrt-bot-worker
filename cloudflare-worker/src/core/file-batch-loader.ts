import { graphqlBatchFetchFiles } from '../github.js';
import type { SubrequestBudget } from '../types/env.ts';

export interface FileBatchLoaderOptions {
  token: string;
  repoFullname: string;
  headRepoFullname?: string;
  subrequestBudget: SubrequestBudget;
  countOptionalAttempt: (attempt: number) => boolean;
  graphqlChunkSize?: number;
  initialBaseSha?: string;
}

export interface FileBatchLoaderStats {
  budgetSkipCount: number;
  missingFilesCount: number;
}

export interface FileBatchLoader {
  fetchFileContentCached: (path: string, ref: string) => Promise<string | null>;
  isFileMissing: (path: string, ref: string) => boolean;
  getRefSource: (ref: string) => 'base' | 'fork' | undefined;
  setRefSource: (ref: string, source: 'base' | 'fork') => void;
  hasRefSource: (ref: string) => boolean;
  getBudgetSkipCount: () => number;
  getStats: () => FileBatchLoaderStats;
}

export function createFileBatchLoader(options: FileBatchLoaderOptions): FileBatchLoader {
  const {
    token,
    repoFullname,
    headRepoFullname,
    subrequestBudget,
    countOptionalAttempt,
    graphqlChunkSize = 50,
    initialBaseSha
  } = options;

  const safeChunkSize = (typeof graphqlChunkSize === 'number' && Number.isFinite(graphqlChunkSize) && graphqlChunkSize >= 1)
    ? Math.floor(graphqlChunkSize)
    : 50;

  const fileCache = new Map<string, Promise<string | null>>();
  // Tracks where each ref is resolvable: 'base' means the base repo serves the
  // ref, so a null (not-found) result for a path there is authoritative — the
  // fork holds the identical tree for that commit, and probing the fork too
  // would only burn a second subrequest to confirm the same absence (this
  // matters for speculative Makefile probes in findPkgRoot). 'fork' means the
  // base repo cannot resolve the ref at all, so lookups skip the base repo
  // entirely.
  const refSource = new Map<string, 'base' | 'fork'>();
  if (initialBaseSha) {
    refSource.set(initialBaseSha, 'base');
  }

  const pendingQueue = new Map<string, {
    key: string;
    path: string;
    ref: string;
    resolve: (content: string | null) => void;
    reject: (err: any) => void;
  }>();

  let flushScheduled = false;
  let budgetSkipCount = 0;
  const missingFiles = new Set<string>();

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushQueue().catch(err => console.error(`Unexpected error flushing file content queue: ${err.message}`));
    });
  }

  async function flushQueue() {
    flushScheduled = false;
    if (pendingQueue.size === 0) return;
    const batch = [...pendingQueue.values()];
    pendingQueue.clear();

    try {
      await flushBatch(batch);
    } catch (err) {
      for (const item of batch) item.reject(err);
    }
  }

  async function flushBatch(batch: Array<{
    key: string;
    path: string;
    ref: string;
    resolve: (content: string | null) => void;
    reject: (err: any) => void;
  }>) {
    const hasForkRepo = !!headRepoFullname && headRepoFullname !== repoFullname;

    const probes: Array<{ key: string; repoFullname: string; ref: string; path: string | null }> = [];
    const itemProbeKeys = new Map<string, { baseKey: string | null; forkKey: string | null }>();
    const unknownRefs = new Set<string>();

    for (const item of batch) {
      const source = refSource.get(item.ref);
      const keys = { baseKey: null as string | null, forkKey: null as string | null };
      if (!hasForkRepo || source === 'base') {
        keys.baseKey = `${item.key}|b`;
        probes.push({ key: keys.baseKey, repoFullname, ref: item.ref, path: item.path });
      } else if (source === 'fork') {
        keys.forkKey = `${item.key}|f`;
        probes.push({ key: keys.forkKey, repoFullname: headRepoFullname!, ref: item.ref, path: item.path });
      } else {
        unknownRefs.add(item.ref);
        keys.baseKey = `${item.key}|b`;
        keys.forkKey = `${item.key}|f`;
        probes.push({ key: keys.baseKey, repoFullname, ref: item.ref, path: item.path });
        probes.push({ key: keys.forkKey, repoFullname: headRepoFullname!, ref: item.ref, path: item.path });
      }
      itemProbeKeys.set(item.key, keys);
    }

    const refProbeKeys = new Map<string, { baseKey: string; forkKey: string }>();
    if (hasForkRepo) {
      for (const ref of unknownRefs) {
        const keys = { baseKey: `\u0000ref:${ref}|b`, forkKey: `\u0000ref:${ref}|f` };
        probes.push({ key: keys.baseKey, repoFullname, ref: ref, path: null });
        probes.push({ key: keys.forkKey, repoFullname: headRepoFullname!, ref: ref, path: null });
        refProbeKeys.set(ref, keys);
      }
    }

    const resultsByProbeKey = new Map<string, any>();
    const fires: Array<Promise<void>> = [];
    for (let i = 0; i < probes.length; i += safeChunkSize) {
      const chunk = probes.slice(i, i + safeChunkSize);
      const available = subrequestBudget.limit - subrequestBudget.reserve - subrequestBudget.used;
      if (available <= 0) {
        for (const p of chunk) resultsByProbeKey.set(p.key, { content: null, skipped: true });
        continue;
      }
      fires.push(
        graphqlBatchFetchFiles(token, chunk, countOptionalAttempt)
          .then((map: Map<string, any>) => { for (const [k, v] of map) resultsByProbeKey.set(k, v); })
          .catch((err: any) => { for (const p of chunk) resultsByProbeKey.set(p.key, { error: err }); })
      );
    }
    await Promise.all(fires);

    for (const [ref, keys] of refProbeKeys) {
      if (refSource.has(ref)) continue;
      const baseRef = resultsByProbeKey.get(keys.baseKey);
      const forkRef = resultsByProbeKey.get(keys.forkKey);
      if (baseRef && !baseRef.error && baseRef.exists) {
        refSource.set(ref, 'base');
      } else if (baseRef && !baseRef.error && !baseRef.skipped && forkRef && !forkRef.error && forkRef.exists) {
        refSource.set(ref, 'fork');
        console.warn(`Ref ${ref} only resolves under head repo ${headRepoFullname}; subsequent file lookups at this ref will go straight to the fork.`);
      }
    }

    for (const item of batch) {
      const keys = itemProbeKeys.get(item.key)!;
      const baseRes = keys.baseKey ? resultsByProbeKey.get(keys.baseKey) : null;
      const forkRes = keys.forkKey ? resultsByProbeKey.get(keys.forkKey) : null;
      const baseOk = baseRes && !baseRes.error;
      const forkOk = forkRes && !forkRes.error;

      if (baseOk && baseRes.content !== null) {
        if (!refSource.has(item.ref)) refSource.set(item.ref, 'base');
        item.resolve(baseRes.content);
      } else if (baseOk && baseRes.exists) {
        if (!refSource.has(item.ref)) refSource.set(item.ref, 'base');
        item.resolve(null);
      } else if (forkOk && forkRes.content !== null) {
        if (baseOk && !baseRes.skipped && !refSource.has(item.ref)) {
          refSource.set(item.ref, 'fork');
          console.warn(`Ref ${item.ref} only resolves under head repo ${headRepoFullname}; subsequent file lookups at this ref will go straight to the fork.`);
        }
        item.resolve(forkRes.content);
      } else if (baseOk || forkOk) {
        if (baseRes?.skipped || forkRes?.skipped) budgetSkipCount++;
        const source = hasForkRepo ? refSource.get(item.ref) : 'base';
        const answer = source === 'base' ? baseRes : (source === 'fork' ? forkRes : null);
        if (answer && !answer.error && !answer.skipped && !answer.failed && answer.exists === false) {
          missingFiles.add(item.key);
        }
        item.resolve(null);
      } else {
        const err = (forkRes && forkRes.error) || (baseRes && baseRes.error) ||
          new Error(`Failed to fetch file content for '${item.path}' at ref ${item.ref}: no data returned from GraphQL batch`);
        item.reject(err);
      }
    }
  }

  const fetchFileContentCached = (path: string, ref: string): Promise<string | null> => {
    const key = `${ref}:${path}`;
    if (!fileCache.has(key)) {
      fileCache.set(key, new Promise((resolve, reject) => {
        pendingQueue.set(key, { key, path, ref, resolve, reject });
        scheduleFlush();
      }));
    }
    return fileCache.get(key)!;
  };

  const isFileMissing = (path: string, ref: string): boolean => missingFiles.has(`${ref}:${path}`);

  return {
    fetchFileContentCached,
    isFileMissing,
    getRefSource: (ref: string) => refSource.get(ref),
    setRefSource: (ref: string, source: 'base' | 'fork') => { refSource.set(ref, source); },
    hasRefSource: (ref: string) => refSource.has(ref),
    getBudgetSkipCount: () => budgetSkipCount,
    getStats: () => ({
      budgetSkipCount,
      missingFilesCount: missingFiles.size
    })
  };
}
