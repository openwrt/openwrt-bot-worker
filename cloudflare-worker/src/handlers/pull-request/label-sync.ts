import { LABEL_GUIDELINES, LABEL_ADD_PACKAGE, LABEL_DROP_PACKAGE } from '../../config.js';
import { parseYaml, getLabelsForChangedFiles, getAllChangedFiles } from '../../labeler.js';
import type { PullRequestContext } from './context.ts';
import type { ResolvedPatchesResult } from './patches.ts';
import type { AggregatedReport } from './report.ts';
import type { GitHubWriteQueue } from '../../core/github-write-queue.ts';

export async function syncLabels(
  ctx: PullRequestContext,
  patchesResult: ResolvedPatchesResult,
  report: AggregatedReport,
  queue: GitHubWriteQueue
): Promise<void> {
  const { prNumber, repoFullname, baseBranch, headSha, prData, client, existingLabels, config, labelerText, action } = ctx;
  const { allPassed } = report;
  const { packageState, packageStateKnown, usePrWidePatch, prPatch, commitDetails } = patchesResult;

  const prLabelUrl = `https://api.github.com/repos/${repoFullname}/issues/${prNumber}/labels`;
  const labelsToAdd: string[] = [];
  const labelsToEnsure: Array<{ name: string; color: string; description: string }> = [];

  const requestLabel = (name: string, color: string, description: string) => {
    if (!existingLabels?.has(name.toLowerCase())) {
      labelsToEnsure.push({ name, color, description });
    }
    labelsToAdd.push(name);
  };

  let livePr = prData;
  if (client.hasHeadroom()) {
    const prUrl = prData.url || `https://api.github.com/repos/${repoFullname}/pulls/${prNumber}`;
    const liveRes = await client.optionalApiCall(prUrl);
    if (liveRes && liveRes.code === 200 && Array.isArray(liveRes.data?.labels)) {
      livePr = liveRes.data;
    }
  }

  const branchMoved = livePr.head?.sha !== headSha || livePr.base?.ref !== baseBranch;
  const verdictMoved = branchMoved || (livePr.body ?? '') !== (prData.body ?? '');

  const currentPrLabels = new Set<string>((livePr.labels || []).map((l: any) => l.name.toLowerCase()));
  const currentPrLabelNames = new Map<string, string>((livePr.labels || []).map((l: any) => [l.name.toLowerCase(), l.name]));
  const spelledAsOnPr = (name: string) => currentPrLabelNames.get(name.toLowerCase()) || name;

  const enqueueRemove = (name: string) => {
    queue.enqueue(`label removal "${name}"`, async () => {
      const res = await client.trackedApiCall(`${prLabelUrl}/${encodeURIComponent(name)}`, 'DELETE');
      return res.code === 404 ? { code: 200 } : res;
    });
  };

  if ((action === 'synchronize' || action === 'reopened') && currentPrLabels.has('stale')) {
    enqueueRemove(spelledAsOnPr('stale'));
  }

  if (!allPassed) {
    if (!verdictMoved && !currentPrLabels.has(LABEL_GUIDELINES.toLowerCase())) {
      requestLabel(LABEL_GUIDELINES, 'e11d48', 'Pull request does not follow formatting guidelines');
    }
  } else {
    if (!verdictMoved && currentPrLabels.has(LABEL_GUIDELINES.toLowerCase())) {
      enqueueRemove(spelledAsOnPr(LABEL_GUIDELINES));
    }
  }

  if (!branchMoved && config.add_package_label && packageState.isNewPackage && !currentPrLabels.has(LABEL_ADD_PACKAGE.toLowerCase())) {
    requestLabel(LABEL_ADD_PACKAGE, '0e7490', 'Introduces a new package Makefile build script');
  }

  if (!branchMoved && packageStateKnown && !packageState.isNewPackage && currentPrLabels.has(LABEL_ADD_PACKAGE.toLowerCase())) {
    enqueueRemove(spelledAsOnPr(LABEL_ADD_PACKAGE));
  }

  if (!branchMoved && config.drop_package_label && packageState.isDroppedPackage && !currentPrLabels.has(LABEL_DROP_PACKAGE.toLowerCase())) {
    requestLabel(LABEL_DROP_PACKAGE, '3b82f6', 'Removes an existing package Makefile from the tracking tree');
  }

  if (!branchMoved && packageStateKnown && !packageState.isDroppedPackage && currentPrLabels.has(LABEL_DROP_PACKAGE.toLowerCase())) {
    enqueueRemove(spelledAsOnPr(LABEL_DROP_PACKAGE));
  }

  const releaseMatch = baseBranch.match(/^openwrt-(\d{2}\.\d{2})$/);
  const releaseLabel = releaseMatch ? `release/${releaseMatch[1]}` : null;

  if (!branchMoved && config.branch_labeling && releaseLabel && !currentPrLabels.has(releaseLabel.toLowerCase())) {
    requestLabel(releaseLabel, '6b7280', `Pull request targets the stable release branch ${releaseLabel}`);
  }

  for (const existing of currentPrLabels) {
    if (!branchMoved && /^release\/\d{2}\.\d{2}$/.test(existing) && existing !== releaseLabel?.toLowerCase()) {
      enqueueRemove(spelledAsOnPr(existing));
    }
  }

  if (config.enable_labeler_yml && labelerText) {
    let changedFiles: string[] = [];
    if (usePrWidePatch) {
      changedFiles = getAllChangedFiles(prPatch);
    } else {
      const filesSet = new Set<string>();
      for (const item of commitDetails) {
        if (item.commitPatch) {
          const files = getAllChangedFiles(item.commitPatch);
          for (const f of files) {
            filesSet.add(f);
          }
        }
      }
      changedFiles = Array.from(filesSet);
    }

    try {
      const parsedLabeler = parseYaml(labelerText);
      const matchedLabels = getLabelsForChangedFiles(changedFiles, parsedLabeler);
      for (const label of matchedLabels) {
        if (!currentPrLabels.has(label.toLowerCase())) {
          requestLabel(label, 'bfd4f2', '');
        }
      }
    } catch (e: any) {
      console.error(`Failed to parse or process labeler.yml: ${e.message}`);
    }
  }

  // Ensure labels exist before adding them to the PR
  for (const lbl of labelsToEnsure) {
    queue.enqueue(`ensure label "${lbl.name}"`, async () => {
      if (existingLabels?.has(lbl.name.toLowerCase())) {
        return { code: 200 };
      }
      const url = `https://api.github.com/repos/${repoFullname}/labels`;
      const res = await client.trackedApiCall(url, 'POST', {
        name: lbl.name,
        color: lbl.color || 'ededed',
        description: lbl.description || ''
      });
      if (res.code === 422) {
        existingLabels?.add(lbl.name.toLowerCase());
        return { code: 200 };
      }
      if (res.code >= 200 && res.code < 300) {
        existingLabels?.add(lbl.name.toLowerCase());
        return { code: 200 };
      }
      return res;
    });
  }

  if (labelsToAdd.length > 0) {
    queue.enqueue('labels', () => client.trackedApiCall(prLabelUrl, 'POST', { labels: labelsToAdd }));
  }
}
