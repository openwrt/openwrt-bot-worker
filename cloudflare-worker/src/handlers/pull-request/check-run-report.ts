import { safeTruncate } from '../../core/utils.ts';
import { isPatchRefreshFinding } from '../../validators.js';
import type { PullRequestContext } from './context.ts';
import type { AggregatedReport } from './report.ts';
import type { GitHubWriteQueue } from '../../core/github-write-queue.ts';

export interface CheckRunPayload {
  name: string;
  head_sha: string;
  status: 'completed';
  conclusion: 'success' | 'failure' | 'neutral';
  output: {
    title: string;
    summary: string;
    text: string;
  };
}

export const INCOMPLETE_NOTE = ' Some of this pull request could not be inspected, so this check reports neutral instead of a pass — see the warnings in the details below.';

export function buildCheckRunPayloads(
  report: AggregatedReport,
  headSha: string
): Array<{ label: string; payload: CheckRunPayload }> {
  const {
    formalityPassed,
    makefilePassed,
    patchesPassed,
    formalityConclusion,
    makefileConclusion,
    patchesConclusion,
    formalityOutputText,
    makefileOutputText,
    patchesOutputText,
    patchesHeading,
    unreadPatchNotes,
    patchesReportedFinding,
    allPatchesErrors,
    patchRules
  } = report;

  // A passing check that reported a finding reported it as a warning: an
  // older patch file this pull request edits, or any patch with the check set
  // to warn. Its title and summary say so instead of claiming a clean pass.
  const patchesWarned = patchesPassed && Boolean(patchesReportedFinding);

  // Two rules can fail the check. The summary names the one that did, so a
  // header problem is not reported as a refresh one, or the other way round.
  const blockingFindings = (allPatchesErrors || [])
    .flatMap((block: string) => block.split('\n'))
    .filter((line: string) => line.startsWith('- '));
  const refreshBlocked = blockingFindings.some((line: string) => isPatchRefreshFinding(line));
  const headersBlocked = blockingFindings.some((line: string) => !isPatchRefreshFinding(line));
  const patchesFailedSummary = headersBlocked && refreshBlocked
    ? 'Some patch files are missing required Git headers or were not written by the refresh target — open the details below to see what to change.'
    : refreshBlocked
      ? 'Some patch files were not written by the refresh target — open the details below to see what to change.'
      : 'Some patch files are missing the required Git headers — open the details below to see what to change.';
  const rules = patchRules ?? { headers: true, refresh: false };
  const patchesCleanSummary = rules.headers
    ? 'All downstream patch files contain correct Git tracking headers.'
    : rules.refresh
      ? 'All downstream patch files match what the refresh target writes.'
      : 'No patch rule is enabled for this repository.';

  const UNREAD_PATCHES_LISTED = 20;
  let patchesText = patchesHeading + patchesOutputText;
  if (patchesConclusion === 'neutral' && unreadPatchNotes.size > 0 && safeTruncate(patchesText) !== patchesText) {
    const listed = [...unreadPatchNotes].slice(0, UNREAD_PATCHES_LISTED);
    const more = unreadPatchNotes.size - listed.length;
    if (more > 0) listed.push(`⚠️ ${more} more patch file${more === 1 ? '' : 's'} could not be read`);
    patchesText = `${patchesHeading}${listed.join('\n')}\n\n${patchesOutputText}`;
  }

  return [
    {
      label: 'check-run "Git & Commits"',
      payload: {
        name: 'FormalityCheck / Git & Commits',
        head_sha: headSha,
        status: 'completed',
        conclusion: formalityConclusion,
        output: {
          title: formalityPassed
            ? (formalityConclusion === 'neutral' ? 'Git & Commits: Partially checked' : 'Git & Commits: Passed')
            : 'Git & Commits: Failed',
          summary: (formalityPassed
            ? 'All commits follow the commit message guidelines.'
            : 'Some commits do not follow the commit message guidelines — open the details below to see what to change.') +
            (formalityConclusion === 'neutral' ? INCOMPLETE_NOTE : ''),
          text: safeTruncate(formalityOutputText)
        }
      }
    },
    {
      label: 'check-run "OpenWrt Makefiles"',
      payload: {
        name: 'FormalityCheck / OpenWrt Makefiles',
        head_sha: headSha,
        status: 'completed',
        conclusion: makefileConclusion,
        output: {
          title: makefilePassed
            ? (makefileConclusion === 'neutral' ? 'OpenWrt Makefiles: Partially checked' : 'OpenWrt Makefiles: Passed')
            : 'OpenWrt Makefiles: Failed',
          summary: (makefilePassed
            ? 'The changed package files follow the OpenWrt packaging guidelines.'
            : 'Some package files need fixing — open the details below to see what to change.') +
            (makefileConclusion === 'neutral' ? INCOMPLETE_NOTE : ''),
          text: safeTruncate(makefileOutputText)
        }
      }
    },
    {
      label: 'check-run "Code Patches"',
      payload: {
        name: 'FormalityCheck / Code Patches',
        head_sha: headSha,
        status: 'completed',
        conclusion: patchesConclusion,
        output: {
          title: patchesPassed
            ? (patchesConclusion === 'neutral'
                ? 'Code Patches: Partially checked'
                : (patchesWarned ? 'Code Patches: Passed with warnings' : 'Code Patches: Passed'))
            : 'Code Patches: Failed',
          summary: (patchesPassed
            ? (patchesWarned
                ? 'No patch file blocks this pull request, but some carry warnings — open the details below to see what they are.'
                : (patchesConclusion === 'neutral'
                    ? 'No problems were found in the patch files that could be read.'
                    : patchesCleanSummary))
            : patchesFailedSummary) +
            (patchesConclusion === 'neutral' ? INCOMPLETE_NOTE : ''),
          text: safeTruncate(patchesText)
        }
      }
    }
  ];
}

export function enqueueCheckRuns(
  ctx: PullRequestContext,
  report: AggregatedReport,
  queue: GitHubWriteQueue
): void {
  const { repoFullname, headSha, client } = ctx;
  const checkRunsUrl = `https://api.github.com/repos/${repoFullname}/check-runs`;
  const runs = buildCheckRunPayloads(report, headSha);

  for (const { label, payload } of runs) {
    queue.enqueue(label, () => client.trackedApiCall(checkRunsUrl, 'POST', payload), { isCritical: true });
  }
}
