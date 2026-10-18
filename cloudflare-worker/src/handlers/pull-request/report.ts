import type { PullRequestContext } from './context.ts';
import type { ResolvedPatchesResult } from './patches.ts';
import type { ValidationOutcome } from './validation.ts';

export interface AggregatedReport {
  allPassed: boolean;
  isValidationIncomplete: boolean;
  formalityPassed: boolean;
  makefilePassed: boolean;
  patchesPassed: boolean;
  formalityConclusion: 'success' | 'failure' | 'neutral';
  makefileConclusion: 'success' | 'failure' | 'neutral';
  patchesConclusion: 'success' | 'failure' | 'neutral';
  allFormalityErrors: string[];
  allMakefileErrors: string[];
  allPatchesErrors: string[];
  allPrWarnings: string[];
  formalityOutputText: string;
  makefileOutputText: string;
  patchesOutputText: string;
  patchesHeading: string;
  unreadPatchNotes: Set<string>;
  // Whether the patch audit reported a finding. With the check still passing
  // it was reported as a warning, which the check-run title has to say.
  patchesReportedFinding: boolean;
  // Which patch rules this repository has on: a summary that names the Git
  // headers must not appear when the header rule never ran.
  patchRules: { headers: boolean; refresh: boolean };
}

export function aggregateReport(
  ctx: PullRequestContext,
  patchesResult: ResolvedPatchesResult,
  validationOutcome: ValidationOutcome
): AggregatedReport {
  const { client, fileBatchLoader, commitScanCapped, commits } = ctx;
  const { patchUnavailable, upstreamComparisonSkips, upstreamFetchFailures, commitDetailsIncomplete } = patchesResult;
  const {
    allFormalityErrors,
    allPrWarnings,
    allMakefileErrors,
    allPatchesErrors,
    formalityOutputText,
    makefileOutputText,
    patchesOutputText,
    patchesHeading,
    patchChecksIncomplete,
    makefileChecksIncomplete,
    formalityChecksIncomplete,
    makefileReportedFinding,
    patchesReportedFinding,
    unreadPatchNotes
  } = validationOutcome;

  // GitHub cuts a check's details at a fixed length, and a large pull request
  // fills them with per-commit blocks well past it. A note appended after
  // those blocks is the first thing the cut takes, including the one the
  // summary sends the reader to look for, so the notes are collected here and
  // go in under the heading instead - above the blocks and the findings.
  const formalityNotes: string[] = [];
  const makefileNotes: string[] = [];
  const patchesNotes: string[] = [];
  const hoistNotes = (body: string, notes: string[]): string => {
    if (notes.length === 0) return body;
    const block = notes.map(n => `⚠️ Warning: ${n}\n\n`).join('');
    // The patch audit's body is handed its heading separately, so there is
    // none here to go under and the notes open it.
    const headingEnd = body.startsWith('### ') ? body.indexOf('\n\n') : -1;
    return headingEnd === -1
      ? `${block}${body}`
      : `${body.slice(0, headingEnd + 2)}${block}${body.slice(headingEnd + 2)}`;
  };

  const budgetSkipCount = fileBatchLoader.getBudgetSkipCount();
  const fetchFailureCount = fileBatchLoader.getFetchFailureCount ? fileBatchLoader.getFetchFailureCount() : 0;
  if (patchUnavailable) {
    const patchWarning = `GitHub did not serve this pull request's patch (it is past GitHub's diff limits), and fetching each of its ${commits.length} commits would not fit the API request budget, so the Makefile, configuration and patch-header checks could not run.`;
    allPrWarnings.push(`**Validation Coverage**:\n- ⚠️ ${patchWarning}`);
    makefileNotes.push(patchWarning);
    patchesNotes.push(patchWarning);
  }

  if (budgetSkipCount > 0) {
    const budgetWarning = `Deep file-content validation skipped for ${budgetSkipCount} file lookup(s): PR too large for the available API subrequest budget (used ${client.budget.used}/${client.budget.limit}, ${client.budget.reserve} reserved for status reporting). Some patch header, UCI config, or package-release checks may be incomplete.`;
    allPrWarnings.push(`**Validation Coverage**:\n- ⚠️ ${budgetWarning}`);
    makefileNotes.push(budgetWarning);
    patchesNotes.push(budgetWarning);
  }

  // A file GitHub would not serve is not a lookup the budget never allowed:
  // calling it "PR too large" sends the contributor after a problem that is
  // not theirs, and saying nothing at all reports an audit that never ran as
  // a pass. Each audit that was handed the failure reports itself incomplete
  // through its own flag, which is more precise than this count can be; the
  // count is what keeps the failure from passing in silence when none did.
  const unattributedFetchFailure = fetchFailureCount > 0 &&
    !makefileChecksIncomplete && !patchChecksIncomplete;
  if (fetchFailureCount > 0) {
    const fetchWarning = `Deep file-content validation could not read ${fetchFailureCount} file(s): GitHub did not serve the content. Some patch header, UCI config, or package-release checks are incomplete for this pull request, and re-running the checks may well succeed.`;
    allPrWarnings.push(`**Validation Coverage**:\n- ⚠️ ${fetchWarning}`);
    // One refused lookup normally leaves one of the two audits incomplete, so
    // the warning belongs in that audit's own text. The other one read
    // everything it needed and concludes success, and a successful check whose
    // body says it is incomplete is exactly what these flags exist to prevent.
    if (makefileChecksIncomplete || unattributedFetchFailure) {
      makefileNotes.push(fetchWarning);
    }
    if (patchChecksIncomplete || unattributedFetchFailure) {
      patchesNotes.push(fetchWarning);
    }
  }

  // Findings are reported after the upstream patch has filtered out whatever
  // the backport inherited. Without that patch nothing was filtered, so a
  // finding below may belong to the commit this one was taken from, and the
  // audit that reports it says so rather than leaving it to be guessed. A
  // finding is one whether it is reported as an error or, with the check
  // configured to warn, as a warning, so each audit says whether it reported
  // one: the gaps it hit travel beside its findings as notices, and an audit
  // that only says it could not run has nothing below to caveat.
  if (upstreamFetchFailures > 0) {
    // The comparison itself is what did not happen, so the formality check
    // reports itself neutral whatever the audits found, and its summary sends
    // the reader to the details. The reason lives in the commit's own block,
    // which a long series pushes past the cut, so the count goes up here too.
    formalityNotes.push(`${upstreamFetchFailures} upstream commit(s) could not be fetched from GitHub, so those backports were not compared with the commits they were taken from. Each commit's own section below names the commit and what GitHub answered.`);
    const makefileFinding = allMakefileErrors.length > 0 || makefileReportedFinding;
    const patchesFinding = allPatchesErrors.length > 0 || patchesReportedFinding;
    if (makefileFinding || patchesFinding) {
      const unfilteredWarning = `${upstreamFetchFailures} upstream commit(s) could not be fetched, so issues this backport inherited from them were not filtered out of the findings below.`;
      allPrWarnings.push(`**Validation Coverage**:\n- ⚠️ ${unfilteredWarning}`);
      if (makefileFinding) makefileNotes.push(unfilteredWarning);
      if (patchesFinding) patchesNotes.push(unfilteredWarning);
    }
  }

  if (upstreamComparisonSkips > 0) {
    const upstreamWarning = `Upstream comparison skipped for ${upstreamComparisonSkips} cherry-picked commit(s): this PR is too large for the available API request budget. Those commits were fully validated as regular changes instead of being matched against their upstream originals.`;
    allPrWarnings.push(`**Validation Coverage**:\n- ⚠️ ${upstreamWarning}`);
    formalityNotes.push(upstreamWarning);
  }

  if (commitDetailsIncomplete) {
    const commitsWarning = `This pull request's commits could not be read, so no commit was audited. Nothing here is a verdict on them.`;
    allPrWarnings.push(`**Validation Coverage**:\n- ⚠️ ${commitsWarning}`);
    formalityNotes.push(commitsWarning);
  }

  // A formality gap whose only record is the commit's own block - a check that
  // could not finish, a cherry-pick scan that failed - is explained below the
  // cut on a long series, leaving the check neutral with nothing above it to
  // say why. One sentence goes up, unless a note already named the gap.
  if (formalityChecksIncomplete && formalityNotes.length === 0) {
    const incompleteWarning = `Some formality checks could not be completed for this pull request, so this is what could be verified rather than a verdict on the rest. The commit sections below name what was missing.`;
    allPrWarnings.push(`**Validation Coverage**:\n- ⚠️ ${incompleteWarning}`);
    formalityNotes.push(incompleteWarning);
  }

  const finalFormalityOutput = hoistNotes(formalityOutputText, formalityNotes);
  const finalMakefileOutput = hoistNotes(makefileOutputText, makefileNotes);
  const finalPatchesOutput = hoistNotes(patchesOutputText, patchesNotes);

  const formalityPassed = allFormalityErrors.length === 0;
  const makefilePassed = allMakefileErrors.length === 0;
  const patchesPassed = allPatchesErrors.length === 0;
  const allPassed = formalityPassed && makefilePassed && patchesPassed;

  const formalityIncomplete = upstreamComparisonSkips > 0 || upstreamFetchFailures > 0 ||
    commitScanCapped || Boolean(formalityChecksIncomplete) || Boolean(commitDetailsIncomplete);
  const deepScanIncomplete = budgetSkipCount > 0 || unattributedFetchFailure || patchUnavailable ||
    Boolean(commitDetailsIncomplete);
  // An upstream commit GitHub would not serve is not a gap in these two
  // audits: the upstream patch only ever filters findings back out (inherited
  // style issues, a release bump already missing on master), so without it
  // they ran stricter, not shorter. A clean pass stays a pass; what a finding
  // reported under it needs is the caveat above, not a neutral verdict.
  const makefileIncomplete = deepScanIncomplete || makefileChecksIncomplete;
  const patchesIncomplete = deepScanIncomplete || patchChecksIncomplete;
  const isValidationIncomplete = formalityIncomplete || makefileIncomplete || patchesIncomplete;

  const conclusionFor = (passed: boolean, incomplete: boolean): 'success' | 'failure' | 'neutral' =>
    (!passed ? 'failure' : (incomplete ? 'neutral' : 'success'));

  const formalityConclusion = conclusionFor(formalityPassed, formalityIncomplete);
  const makefileConclusion = conclusionFor(makefilePassed, makefileIncomplete);
  const patchesConclusion = conclusionFor(patchesPassed, patchesIncomplete);

  return {
    allPassed,
    isValidationIncomplete,
    formalityPassed,
    makefilePassed,
    patchesPassed,
    formalityConclusion,
    makefileConclusion,
    patchesConclusion,
    allFormalityErrors,
    allMakefileErrors,
    allPatchesErrors,
    allPrWarnings,
    formalityOutputText: finalFormalityOutput,
    makefileOutputText: finalMakefileOutput,
    patchesOutputText: finalPatchesOutput,
    patchesHeading,
    unreadPatchNotes,
    patchesReportedFinding,
    patchRules: {
      headers: ctx.config?.check_patch_headers !== false && ctx.config?.check_patch_headers !== 'disabled',
      refresh: ctx.config?.check_patch_refresh !== false && ctx.config?.check_patch_refresh !== 'disabled'
    }
  };
}
