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
}

export function aggregateReport(
  ctx: PullRequestContext,
  patchesResult: ResolvedPatchesResult,
  validationOutcome: ValidationOutcome
): AggregatedReport {
  const { client, fileBatchLoader, commitScanCapped, commits } = ctx;
  const { patchUnavailable, upstreamComparisonSkips } = patchesResult;
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
    unreadPatchNotes
  } = validationOutcome;

  let finalMakefileOutput = makefileOutputText;
  let finalPatchesOutput = patchesOutputText;
  let finalFormalityOutput = formalityOutputText;

  const budgetSkipCount = fileBatchLoader.getBudgetSkipCount();
  const fetchFailureCount = fileBatchLoader.getFetchFailureCount ? fileBatchLoader.getFetchFailureCount() : 0;
  if (patchUnavailable) {
    const patchWarning = `GitHub did not serve this pull request's patch (it is past GitHub's diff limits), and fetching each of its ${commits.length} commits would not fit the API request budget, so the Makefile, configuration and patch-header checks could not run.`;
    allPrWarnings.push(`**Validation Coverage**:\n- ⚠️ ${patchWarning}`);
    finalMakefileOutput += `⚠️ Warning: ${patchWarning}\n\n`;
    finalPatchesOutput += `⚠️ Warning: ${patchWarning}\n\n`;
  }

  if (budgetSkipCount > 0) {
    const budgetWarning = `Deep file-content validation skipped for ${budgetSkipCount} file lookup(s): PR too large for the available API subrequest budget (used ${client.budget.used}/${client.budget.limit}, ${client.budget.reserve} reserved for status reporting). Some patch header, UCI config, or package-release checks may be incomplete.`;
    allPrWarnings.push(`**Validation Coverage**:\n- ⚠️ ${budgetWarning}`);
    finalMakefileOutput += `⚠️ Warning: ${budgetWarning}\n\n`;
    finalPatchesOutput += `⚠️ Warning: ${budgetWarning}\n\n`;
  }

  if (upstreamComparisonSkips > 0) {
    const upstreamWarning = `Upstream comparison skipped for ${upstreamComparisonSkips} cherry-picked commit(s): this PR is too large for the available API request budget. Those commits were fully validated as regular changes instead of being matched against their upstream originals.`;
    allPrWarnings.push(`**Validation Coverage**:\n- ⚠️ ${upstreamWarning}`);
    finalFormalityOutput += `⚠️ Warning: ${upstreamWarning}\n\n`;
  }

  const formalityPassed = allFormalityErrors.length === 0;
  const makefilePassed = allMakefileErrors.length === 0;
  const patchesPassed = allPatchesErrors.length === 0;
  const allPassed = formalityPassed && makefilePassed && patchesPassed;

  const formalityIncomplete = upstreamComparisonSkips > 0 || commitScanCapped;
  const deepScanIncomplete = budgetSkipCount > 0 || patchUnavailable;
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
    unreadPatchNotes
  };
}
