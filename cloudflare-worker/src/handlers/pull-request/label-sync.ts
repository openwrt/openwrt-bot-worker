import { LABEL_GUIDELINES, LABEL_ADD_PACKAGE, LABEL_DROP_PACKAGE } from '../../config.js';
import { parseYaml, getLabelsForChangedFiles, getAllChangedFiles } from '../../labeler.js';
import { ensureLabelExists, DECLINED_ATTEMPT } from '../../github.js';
import { fetchLivePrState, type PullRequestContext } from './context.ts';
import type { ResolvedPatchesResult } from './patches.ts';
import type { AggregatedReport } from './report.ts';
import type { GitHubWriteQueue } from '../../core/github-write-queue.ts';

export async function syncLabels(
  ctx: PullRequestContext,
  patchesResult: ResolvedPatchesResult,
  report: AggregatedReport,
  queue: GitHubWriteQueue
): Promise<void> {
  const { prNumber, repoFullname, baseBranch, token, client, existingLabels, config, labelerText, action } = ctx;
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

  const { livePr, branchMoved, verdictMoved } = await fetchLivePrState(ctx);

  const currentPrLabels = new Set<string>((livePr.labels || []).map((l: any) => l.name.toLowerCase()));
  const currentPrLabelNames = new Map<string, string>((livePr.labels || []).map((l: any) => [l.name.toLowerCase(), l.name]));
  const spelledAsOnPr = (name: string) => currentPrLabelNames.get(name.toLowerCase()) || name;

  // Every label write is optional work: the write queue may skip it to keep
  // the check-runs' attempts, so it goes through the counter that can also
  // decline a retry once only those attempts are left. trackedApiCall counts
  // an attempt without ever being able to refuse one.
  const enqueueRemove = (name: string) => {
    queue.enqueue(`label removal "${name}"`, async () => {
      const res = await client.optionalApiCall(`${prLabelUrl}/${encodeURIComponent(name)}`, 'DELETE');
      return res.code === 404 ? { code: 200 } : res;
    });
  };

  if (!branchMoved && (action === 'synchronize' || action === 'reopened') && currentPrLabels.has('stale')) {
    enqueueRemove(spelledAsOnPr('stale'));
  }

  if (!allPassed) {
    if (!verdictMoved && !currentPrLabels.has(LABEL_GUIDELINES.toLowerCase())) {
      requestLabel(LABEL_GUIDELINES, 'e11d48', 'Pull request does not follow formatting guidelines');
    }
  } else {
    // The label says a violation was found, and none was. An audit that could
    // not read everything says so through its neutral check run, which is
    // where that uncertainty belongs: leaving the label on instead would keep
    // it on a pull request whose every reported problem is fixed, and the
    // nightly scan acts on this label - it would mark that pull request stale.
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

  if (!branchMoved && config.enable_labeler_yml && labelerText) {
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

  // Ensure labels exist before adding them to the PR. The shared helper is
  // what keeps the 422 GitHub answers for a label another writer created
  // first out of the error log. It says false both for a label that was
  // already there and for a create GitHub refused, and the set it records
  // confirmed labels in is what tells the two apart: a 403 on POST /labels is
  // what a missing issues:write permission looks like, and it has to answer
  // the webhook 502 instead of passing as a write that never happened.
  // The set is this run's own when the repository listing could not be read.
  // The create retries, so its attempts go through countOptionalAttempt
  // rather than a bare `used++`, which counted an attempt but could never
  // refuse one. A refused attempt leaves the create unconfirmed, which stays
  // what it was: a failed write the run reports.
  const confirmedLabels = existingLabels ?? new Set<string>();
  for (const lbl of labelsToEnsure) {
    queue.enqueue(`ensure label "${lbl.name}"`, async () => {
      const chargedBefore = client.budget.used;
      const created = await ensureLabelExists(token, repoFullname, lbl.name, lbl.color, lbl.description, confirmedLabels, client.countOptionalAttempt);
      // Nothing charged means nothing was sent: the counter declined the
      // attempt to keep the reserve. That is this worker's decision, so it is
      // reported as a request never made rather than as a create GitHub
      // refused.
      if (!created && client.budget.used === chargedBefore) return DECLINED_ATTEMPT;
      return (created || confirmedLabels.has(lbl.name.toLowerCase())) ? { code: 200 } : { code: 502 };
    });
  }

  if (labelsToAdd.length > 0) {
    queue.enqueue('labels', () => client.optionalApiCall(prLabelUrl, 'POST', { labels: labelsToAdd }));
  }
}
