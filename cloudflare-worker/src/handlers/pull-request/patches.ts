import {
  getDiffFromPatch,
  splitPrPatchByCommit,
  normalizeDiff
} from '../../core/patch-utils.ts';
import { CHERRY_PICK_MARKER } from '../../core/policy.ts';
import { collectPackageMakefiles } from '../../validators.js';
import { wasAttemptDeclined } from '../../github.js';
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

// Counted per pass: an abandoned per-commit pass keeps resolving after the
// PR-wide pass has taken over, and a comparison one of its commits skips then
// is not one the pass whose result is used ever made.
interface UpstreamCounts {
  comparisonSkips: number;
  fetchFailures: number;
}

export interface ResolvedPatchesResult {
  usePrWidePatch: boolean;
  prPatch: string | null;
  patchUnavailable: boolean;
  commitDetails: CommitDetail[];
  upstreamComparisonSkips: number;
  upstreamFetchFailures: number;
  commitDetailsIncomplete: boolean;
  packageState: { isNewPackage: boolean; isDroppedPackage: boolean };
  packageStateKnown: boolean;
  // Package Makefiles the scanned patches add or remove (see
  // collectPackageMakefiles), trimmed and deduplicated.
  addedPackageMakefiles: Set<string>;
  removedPackageMakefiles: Set<string>;
  splitCommitPatches?: Map<string, string>;
}

export async function resolvePatchesAndCommits(ctx: PullRequestContext): Promise<ResolvedPatchesResult> {
  const { commits, client, fileBatchLoader, isBackportPr, repoFullname, prData, startPrPatchFetch } = ctx;

  let usePrWidePatch = commits.length > 15;
  let prPatch: string | null = null;
  let patchUnavailable = false;
  // Comparisons the budget never allowed, kept apart from the ones GitHub
  // refused to serve: only the first is a matter of this PR being too large.
  let upstreamCounts: UpstreamCounts = { comparisonSkips: 0, fetchFailures: 0 };
  let commitDetailsIncomplete = false;

  let prWidePatchText: string | null = null;
  if (commits.length > 1) {
    const prPatchRes = await startPrPatchFetch();
    if (prPatchRes && prPatchRes.code === 200 && typeof prPatchRes.raw === 'string') {
      prWidePatchText = prPatchRes.raw;
    } else {
      console.warn(`PR-wide patch unavailable (HTTP ${prPatchRes?.code}).`);
    }
  }

  let splitCommitPatches = new Map<string, string>();
  if (prWidePatchText !== null) {
    splitCommitPatches = splitPrPatchByCommit(prWidePatchText, commits);
    for (const sha of splitCommitPatches.keys()) {
      if (!fileBatchLoader.hasRefSource(sha)) {
        fileBatchLoader.setRefSource(sha, 'base');
      }
    }
  }

  // Determine how many commits actually require an individual patch fetch
  const commitsToFetch = commits.filter(
    (c: any) => (c.parents || []).length <= 1 && !splitCommitPatches.has(c.sha)
  );

  const remainingCalls = client.budget.limit - client.budget.reserve - client.budget.used;
  const canFetchCommits = client.hasHeadroom() && remainingCalls >= commitsToFetch.length;

  if (usePrWidePatch) {
    if (prWidePatchText !== null) {
      prPatch = prWidePatchText;
    } else if (canFetchCommits) {
      console.warn(`Fetching the ${commitsToFetch.length} commit patches one by one instead.`);
      usePrWidePatch = false;
    } else {
      patchUnavailable = true;
    }
  } else if (commits.length > 1 && commitsToFetch.length > 0 && !canFetchCommits) {
    console.warn(`Insufficient headroom to fetch ${commitsToFetch.length} commit patches (${remainingCalls} calls remaining before reserve). Falling back to PR-wide patch.`);
    usePrWidePatch = true;
    if (prWidePatchText !== null) {
      prPatch = prWidePatchText;
    } else {
      patchUnavailable = true;
    }
  } else if (commits.length <= 1 && client.budget.limit - client.budget.used <= 0) {
    patchUnavailable = true;
    usePrWidePatch = true;
  }

  const mapCommitData = async (commitData: any, fetchPatch: boolean, counts: UpstreamCounts): Promise<CommitDetail> => {
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
    } else if (!isMergeCommit && splitCommitPatches.has(sha)) {
      commitPatch = splitCommitPatches.get(sha)!;
    } else if (fetchPatch) {
      const detailUrl = `https://api.github.com/repos/${repoFullname}/commits/${sha}`;
      // With no PR-wide patch behind it, a single commit's patch is the only
      // copy of the diff the whole audit reads, and the fallback below already
      // re-fetches it with a tracked call for exactly that reason. Spending the
      // attempt here keeps the one request the run cannot do without from being
      // made twice and from being declined at the reserve; where there is a
      // fallback, the attempt is optional and a decline costs only this pass.
      const patchIsOnlySource = prWidePatchText === null && commits.length <= 1;
      let patchRes = patchIsOnlySource
        ? await client.trackedApiCall(detailUrl, 'GET', null, 'application/vnd.github.patch')
        : await client.optionalApiCall(detailUrl, 'GET', null, 'application/vnd.github.patch');
      if (patchRes && patchRes.code === 200 && !fileBatchLoader.hasRefSource(sha)) {
        fileBatchLoader.setRefSource(sha, 'base');
      }

      // The headroom is asked again here: canFetchCommits above budgeted one
      // call per commit, and this retry is a second one for the same commit.
      // Without the question a fork PR whose commits all miss in the base
      // repo spends the reserve the closing writes are kept for.
      const headRepoFullname = prData.head?.repo?.full_name;
      if (patchRes && (patchRes.code === 404 || patchRes.code === 422) && headRepoFullname && headRepoFullname !== repoFullname
          && (typeof client.hasHeadroom !== 'function' || client.hasHeadroom())) {
        console.warn(`Commit ${sha} not found in base repo ${repoFullname} (HTTP ${patchRes.code}). Retrying fetch from head repo ${headRepoFullname}...`);
        const forkDetailUrl = `https://api.github.com/repos/${headRepoFullname}/commits/${sha}`;
        const baseRes = patchRes;
        patchRes = await client.optionalApiCall(forkDetailUrl, 'GET', null, 'application/vnd.github.patch', { silent: true });
        if (wasAttemptDeclined(patchRes)) {
          // The retry never went out, so the base repo's answer is still the
          // only one there is. Keeping it is what makes the failure below name
          // what GitHub said instead of the 599 a declined attempt reports.
          console.warn(`Fork fallback for commit ${sha} not attempted: no request budget left outside the reserve kept for the closing writes.`);
          patchRes = baseRes;
        } else if (patchRes && patchRes.code === 200 && !fileBatchLoader.hasRefSource(sha)) {
          fileBatchLoader.setRefSource(sha, 'fork');
        }
      }

      // A declined attempt is not an answer, and a commit left without a patch
      // reads downstream as a commit that changed no text file - a pass for an
      // audit that never ran. So this pass is abandoned either way and the
      // caller falls back to the PR-wide patch; only a budget decline must not
      // be reported as something GitHub refused to serve.
      if (wasAttemptDeclined(patchRes)) {
        throw new Error(`Commit patch for SHA ${sha} was not fetched: no request budget left outside the reserve kept for the closing writes`);
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
      // One upstream lookup per cherry-picked commit, and a backport PR can
      // carry hundreds of them, so the headroom decides. It does not depend on
      // this commit's own patch: without it the two cannot be compared for a
      // verbatim match, but the upstream diff is still what the release-bump
      // and style audits filter the downstream findings against, and in
      // PR-wide mode no commit has a patch of its own.
      if (match && client.hasHeadroom && !client.hasHeadroom()) {
        counts.comparisonSkips++;
      } else if (match) {
        const targetSha = match[1];
        upstreamSha = targetSha;
        const upstreamUrl = `https://api.github.com/repos/${repoFullname}/commits/${targetSha}`;
        const upstreamRes = await client.optionalApiCall(upstreamUrl, 'GET', null, 'application/vnd.github.patch');
        if (upstreamRes && upstreamRes.code === 200) {
          if (!fileBatchLoader.hasRefSource(targetSha)) {
            fileBatchLoader.setRefSource(targetSha, 'base');
          }
          upstreamPatch = upstreamRes.raw;
          // "Verbatim" is what lets the per-commit audits be skipped, so it is
          // only claimed where those audits run: in PR-wide mode the whole
          // diff is audited at once and no commit is waved through.
          if (fetchPatch && commitPatch) {
            isVerbatim = normalizeDiff(getDiffFromPatch(commitPatch)) === normalizeDiff(getDiffFromPatch(upstreamPatch));
          }
        } else if (wasAttemptDeclined(upstreamRes)) {
          // Nothing was asked, so nothing is known: counted and reported
          // exactly like the lookup the headroom refused up front, rather than
          // as an upstream GitHub would not serve. upstreamSha goes back to
          // null because a comparison that never happened must not be
          // described below as a diff that deviates from its original.
          counts.comparisonSkips++;
          upstreamSha = null;
        } else {
          counts.fetchFailures++;
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
    const perCommitCounts: UpstreamCounts = { comparisonSkips: 0, fetchFailures: 0 };
    upstreamCounts = perCommitCounts;
    try {
      commitDetails = await Promise.all(commits.map(commitData => mapCommitData(commitData, true, perCommitCounts)));
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
    // This pass recomputes every commit from scratch, so it counts into its
    // own object: what the abandoned per-commit pass counted, before or after
    // this one took over, is not what the reported numbers are about.
    const prWideCounts: UpstreamCounts = { comparisonSkips: 0, fetchFailures: 0 };
    upstreamCounts = prWideCounts;
    try {
      commitDetails = await Promise.all(commits.map(commitData => mapCommitData(commitData, false, prWideCounts)));
    } catch (e: any) {
      // Without this the whole webhook answers 500 and the pull request gets
      // no check-runs at all. An audit with no commits to show is reported as
      // incomplete, which is neutral rather than a pass.
      console.warn(`Failed to resolve commit details for the PR-wide patch: ${e.message}`);
      commitDetails = [];
      commitDetailsIncomplete = true;
    }
  }

  const scannedPatches = usePrWidePatch
    ? [prPatch]
    : commitDetails.map(item => item.commitPatch);
  let packageStateKnown = false;
  const packageState = { isNewPackage: false, isDroppedPackage: false };
  // Unions over whichever patches were scanned, so one pull request gives the
  // same paths audited commit by commit and as one diff.
  const addedPackageMakefiles = new Set<string>();
  const removedPackageMakefiles = new Set<string>();
  for (const patch of scannedPatches) {
    if (!patch) continue;
    packageStateKnown = true;
    const added = collectPackageMakefiles(patch, 'added');
    const removed = collectPackageMakefiles(patch, 'removed');
    for (const path of added) addedPackageMakefiles.add(path);
    for (const path of removed) removedPackageMakefiles.add(path);
    if (added.length > 0) {
      packageState.isNewPackage = true;
    }
    if (removed.length > 0) {
      packageState.isDroppedPackage = true;
    }
  }

  return {
    usePrWidePatch,
    prPatch,
    patchUnavailable,
    commitDetails,
    upstreamComparisonSkips: upstreamCounts.comparisonSkips,
    upstreamFetchFailures: upstreamCounts.fetchFailures,
    commitDetailsIncomplete,
    packageState,
    packageStateKnown,
    addedPackageMakefiles,
    removedPackageMakefiles,
    splitCommitPatches
  };
}
