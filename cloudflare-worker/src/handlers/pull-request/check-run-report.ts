import { safeTruncate } from '../../core/utils.ts';
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
    unreadPatchNotes
  } = report;

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
            ? (patchesConclusion === 'neutral' ? 'Code Patches: Partially checked' : 'Code Patches: Passed')
            : 'Code Patches: Failed',
          summary: (patchesPassed
            ? (patchesConclusion === 'neutral'
                ? 'No problems were found in the patch files that could be read.'
                : 'All downstream patch files contain correct Git tracking headers.')
            : 'Some patch files are missing the required Git headers — open the details below to see what to change.') +
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
