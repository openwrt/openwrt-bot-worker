import {
  getDiffFromPatch,
  splitPrPatchByCommit,
  normalizeDiff
} from '../../core/patch-utils.ts';
import { CHERRY_PICK_MARKER } from '../../core/policy.ts';
import { collectPackageMakefiles } from '../../validators.js';
import type { PullRequestContext } from './context.ts';

export interface CommitDetail {
  sha: string;
  html_url: string;
  fullCommit: any;
  commitPatch: string | null;
  isVerbatim: boolean;
  upstreamPatch: string | null;
  upstreamSha: string | null;
  upstreamFetchError: string | null;
}

export interface ResolvedPatchesResult {
  usePrWidePatch: boolean;
  prPatch: string | null;
  patchUnavailable: boolean;
  commitDetails: CommitDetail[];
  upstreamComparisonSkips: number;
  packageState: { isNewPackage: boolean; isDroppedPackage: boolean };
  packageStateKnown: boolean;
}

export async function resolvePatchesAndCommits(ctx: PullRequestContext): Promise<ResolvedPatchesResult> {
  const { commits, client, fileBatchLoader, isBackportPr, repoFullname, prData, startPrPatchFetch } = ctx;

  let usePrWidePatch = commits.length > 15;
  let prPatch: string | null = null;
  let patchUnavailable = false;
  let upstreamComparisonSkips = 0;

  let prWidePatchText: string | null = null;
  if (commits.length > 1) {
    const prPatchRes = await startPrPatchFetch();
    if (prPatchRes && prPatchRes.code === 200 && typeof prPatchRes.raw === 'string') {
      prWidePatchText = prPatchRes.raw;
    } else {
      console.warn(`PR-wide patch unavailable (HTTP ${prPatchRes?.code}).`);
    }
  }

  if (usePrWidePatch) {
    if (prWidePatchText !== null) {
      prPatch = prWidePatchText;
    } else if (commits.length <= client.budget.limit - client.budget.reserve - client.budget.used) {
      console.warn(`Fetching the ${commits.length} commit patches one by one instead.`);
      usePrWidePatch = false;
    } else {
      patchUnavailable = true;
    }
  }

  let splitCommitPatches = new Map<string, string>();
  if (!usePrWidePatch && prWidePatchText !== null) {
    splitCommitPatches = splitPrPatchByCommit(prWidePatchText, commits);
    for (const sha of splitCommitPatches.keys()) {
      if (!fileBatchLoader.hasRefSource(sha)) {
        fileBatchLoader.setRefSource(sha, 'base');
      }
    }
  }

  const mapCommitData = async (commitData: any, fetchPatch: boolean): Promise<CommitDetail> => {
    const commitItemType = (commitData === null)
      ? 'null'
      : (Array.isArray(commitData) ? 'array' : typeof commitData);
    if (!commitData || commitItemType !== 'object') {
      throw new Error(`Expected commit item in PR commits list to be an object, but got: ${commitItemType}`);
    }
    const sha = commitData.sha;
    if (!sha) {
      const cleanResp = JSON.stringify(commitData).slice(0, 200);
      throw new Error(`Commit item is missing 'sha' property. Response: ${cleanResp}`);
    }
    if (!commitData.commit) {
      const cleanResp = JSON.stringify(commitData).slice(0, 200);
      throw new Error(`Commit object is missing '.commit' metadata for SHA ${sha}. Response: ${cleanResp}`);
    }

    let commitPatch: string | null = null;
    const isMergeCommit = (commitData.parents || []).length > 1;
    if (fetchPatch && isMergeCommit) {
      commitPatch = null;
    } else if (fetchPatch && splitCommitPatches.has(sha)) {
      commitPatch = splitCommitPatches.get(sha)!;
    } else if (fetchPatch) {
      const detailUrl = `https://api.github.com/repos/${repoFullname}/commits/${sha}`;
      let patchRes = await client.trackedApiCall(detailUrl, 'GET', null, 'application/vnd.github.patch');
      if (patchRes && patchRes.code === 200 && !fileBatchLoader.hasRefSource(sha)) {
        fileBatchLoader.setRefSource(sha, 'base');
      }

      const headRepoFullname = prData.head?.repo?.full_name;
      if (patchRes && (patchRes.code === 404 || patchRes.code === 422) && headRepoFullname && headRepoFullname !== repoFullname) {
        console.warn(`Commit ${sha} not found in base repo ${repoFullname} (HTTP ${patchRes.code}). Retrying fetch from head repo ${headRepoFullname}...`);
        const forkDetailUrl = `https://api.github.com/repos/${headRepoFullname}/commits/${sha}`;
        patchRes = await client.trackedApiCall(forkDetailUrl, 'GET', null, 'application/vnd.github.patch', { silent: true });
        if (patchRes && patchRes.code === 200 && !fileBatchLoader.hasRefSource(sha)) {
          fileBatchLoader.setRefSource(sha, 'fork');
        }
      }

      if (!patchRes || patchRes.code !== 200) {
        const cleanRaw = (patchRes?.raw || "").trim().slice(0, 200);
        throw new Error(`Failed to fetch commit patch for SHA ${sha} (HTTP ${patchRes?.code}): ${cleanRaw}`);
      }
      commitPatch = patchRes.raw;
    }

    let isVerbatim = false;
    let upstreamPatch: string | null = null;
    let upstreamSha: string | null = null;
    let upstreamFetchError: string | null = null;

    if (isBackportPr) {
      const commitMsg = commitData.commit?.message || '';
      const match = commitMsg.match(CHERRY_PICK_MARKER);
      if (match && (!fetchPatch || !commitPatch)) {
        upstreamComparisonSkips++;
      } else if (match && client.hasHeadroom && !client.hasHeadroom()) {
        upstreamComparisonSkips++;
      } else if (match && commitPatch) {
        const targetSha = match[1];
        upstreamSha = targetSha;
        const upstreamUrl = `https://api.github.com/repos/${repoFullname}/commits/${targetSha}`;
        const upstreamRes = await client.optionalApiCall(upstreamUrl, 'GET', null, 'application/vnd.github.patch');
        if (upstreamRes && upstreamRes.code === 200) {
          if (!fileBatchLoader.hasRefSource(targetSha)) {
            fileBatchLoader.setRefSource(targetSha, 'base');
          }
          upstreamPatch = upstreamRes.raw;
          isVerbatim = normalizeDiff(getDiffFromPatch(commitPatch)) === normalizeDiff(getDiffFromPatch(upstreamPatch));
        } else {
          upstreamComparisonSkips++;
          upstreamFetchError = `Could not fetch upstream commit ${targetSha.slice(0, 7)} from GitHub API (HTTP ${upstreamRes?.code})`;
        }
      }
    }

    return {
      sha,
      html_url: commitData.html_url || `https://github.com/${repoFullname}/commit/${sha}`,
      fullCommit: commitData,
      commitPatch,
      isVerbatim,
      upstreamPatch,
      upstreamSha,
      upstreamFetchError
    };
  };

  let commitDetails: CommitDetail[] = [];
  if (!usePrWidePatch) {
    try {
      commitDetails = await Promise.all(commits.map(commitData => mapCommitData(commitData, true)));
    } catch (e: any) {
      console.warn(`Failed to fetch individual commit patches, falling back to PR-wide patch: ${e.message}`);
      usePrWidePatch = true;
      if (prWidePatchText !== null) {
        prPatch = prWidePatchText;
      } else if (commits.length <= 1) {
        const prPatchRes = await startPrPatchFetch();
        if (prPatchRes && prPatchRes.code === 200 && typeof prPatchRes.raw === 'string') {
          prPatch = prPatchRes.raw;
        } else {
          patchUnavailable = true;
        }
      } else {
        patchUnavailable = true;
      }
    }
  }

  if (usePrWidePatch) {
    commitDetails = await Promise.all(commits.map(commitData => mapCommitData(commitData, false)));
  }

  const scannedPatches = usePrWidePatch
    ? [prPatch]
    : commitDetails.map(item => item.commitPatch);
  let packageStateKnown = false;
  const packageState = { isNewPackage: false, isDroppedPackage: false };
  for (const patch of scannedPatches) {
    if (!patch) continue;
    packageStateKnown = true;
    if (collectPackageMakefiles(patch, 'added').length > 0) {
      packageState.isNewPackage = true;
    }
    if (collectPackageMakefiles(patch, 'removed').length > 0) {
      packageState.isDroppedPackage = true;
    }
  }

  return {
    usePrWidePatch,
    prPatch,
    patchUnavailable,
    commitDetails,
    upstreamComparisonSkips,
    packageState,
    packageStateKnown
  };
}
