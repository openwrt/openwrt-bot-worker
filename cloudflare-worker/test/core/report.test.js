import { describe, test } from 'node:test';
import assert from 'node:assert';
import { aggregateReport } from '../../src/handlers/pull-request/report.ts';

describe('aggregateReport lifecycle phase', () => {
  const createMockContext = ({ budgetSkipCount = 0, fetchFailureCount = null, usedBudget = 10, limit = 50, reserve = 15, commitsCount = 5 } = {}) => ({
    client: {
      budget: { limit, used: usedBudget, reserve }
    },
    fileBatchLoader: {
      getBudgetSkipCount: () => budgetSkipCount,
      ...(fetchFailureCount === null ? {} : { getFetchFailureCount: () => fetchFailureCount })
    },
    commitScanCapped: false,
    commits: new Array(commitsCount).fill({ sha: 'dummy' })
  });

  const createMockPatchesResult = ({
    patchUnavailable = false,
    upstreamComparisonSkips = 0,
    upstreamFetchFailures = 0,
    commitDetailsIncomplete = false
  } = {}) => ({
    usePrWidePatch: false,
    prPatch: null,
    patchUnavailable,
    commitDetails: [],
    upstreamComparisonSkips,
    upstreamFetchFailures,
    commitDetailsIncomplete,
    packageState: { isNewPackage: false, isDroppedPackage: false },
    packageStateKnown: true
  });

  const createMockOutcome = ({
    formalityErrors = [],
    makefileErrors = [],
    patchesErrors = [],
    patchChecksIncomplete = false,
    makefileChecksIncomplete = false,
    formalityChecksIncomplete = false,
    makefileReportedFinding = false,
    patchesReportedFinding = false,
    formalityOutputText = 'Formality OK\n',
    makefileOutputText = 'Makefile OK\n',
    patchesOutputText = 'Patches OK\n'
  } = {}) => ({
    allFormalityErrors: [...formalityErrors],
    allPrWarnings: [],
    allMakefileErrors: [...makefileErrors],
    allPatchesErrors: [...patchesErrors],
    formalityOutputText,
    makefileOutputText,
    patchesOutputText,
    patchesHeading: '## Patches\n',
    patchChecksIncomplete,
    makefileChecksIncomplete,
    formalityChecksIncomplete,
    makefileReportedFinding,
    patchesReportedFinding,
    unreadPatchNotes: new Set()
  });

  test('reports success on all checks when everything passes within budget', () => {
    const ctx = createMockContext();
    const patches = createMockPatchesResult();
    const outcome = createMockOutcome();

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.allPassed, true);
    assert.strictEqual(report.formalityConclusion, 'success');
    assert.strictEqual(report.makefileConclusion, 'success');
    assert.strictEqual(report.patchesConclusion, 'success');
    assert.strictEqual(report.allPrWarnings.length, 0);
  });

  test('marks conclusions as neutral when API budget is exhausted during file lookups', () => {
    const ctx = createMockContext({ budgetSkipCount: 3, usedBudget: 35, limit: 50, reserve: 15 });
    const patches = createMockPatchesResult();
    const outcome = createMockOutcome();

    const report = aggregateReport(ctx, patches, outcome);

    // No hard errors, but deep scans were incomplete due to budget exhaustion
    assert.strictEqual(report.allPassed, true);
    assert.strictEqual(report.formalityConclusion, 'success');
    assert.strictEqual(report.makefileConclusion, 'neutral');
    assert.strictEqual(report.patchesConclusion, 'neutral');

    // Adds coverage warning to warnings and outputs
    assert.ok(report.allPrWarnings.some(w => w.includes('Deep file-content validation skipped for 3 file lookup(s)')));
    assert.match(report.makefileOutputText, /Deep file-content validation skipped for 3 file lookup\(s\)/);
    assert.match(report.patchesOutputText, /Deep file-content validation skipped for 3 file lookup\(s\)/);
  });

  test('marks conclusions as neutral when PR patch is unavailable due to diff size and budget', () => {
    const ctx = createMockContext({ commitsCount: 20 });
    const patches = createMockPatchesResult({ patchUnavailable: true });
    const outcome = createMockOutcome();

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.makefileConclusion, 'neutral');
    assert.strictEqual(report.patchesConclusion, 'neutral');
    assert.ok(report.allPrWarnings.some(w => w.includes('past GitHub\'s diff limits')));
  });

  test('marks formality check neutral when upstream cherry-pick comparison is skipped', () => {
    const ctx = createMockContext();
    const patches = createMockPatchesResult({ upstreamComparisonSkips: 2 });
    const outcome = createMockOutcome();

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.formalityConclusion, 'neutral');
    assert.strictEqual(report.makefileConclusion, 'success');
    assert.strictEqual(report.patchesConclusion, 'success');
    assert.ok(report.allPrWarnings.some(w => w.includes('Upstream comparison skipped for 2 cherry-picked commit(s)')));
  });

  // A file GitHub refused to serve is not a lookup the budget declined, and a
  // run that never read a file must not report it as a pass either.
  test('reports a file the API would not serve as incomplete, in its own words', () => {
    const ctx = createMockContext({ fetchFailureCount: 2 });
    const patches = createMockPatchesResult();
    const outcome = createMockOutcome();

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.makefileConclusion, 'neutral');
    assert.strictEqual(report.patchesConclusion, 'neutral');
    assert.ok(report.allPrWarnings.some(w => w.includes('could not read 2 file(s)')),
      `the warning must name the real reason: ${JSON.stringify(report.allPrWarnings)}`);
    assert.ok(!report.allPrWarnings.some(w => w.includes('PR too large')),
      'a file GitHub refused says nothing about the size of the PR');
  });

  test('leaves the audits that reported themselves incomplete to name their own gaps', () => {
    // The patch audit was handed the failure and already says so; repeating it
    // across the Makefile check would report a gap that audit never had.
    const ctx = createMockContext({ fetchFailureCount: 1 });
    const patches = createMockPatchesResult();
    const outcome = createMockOutcome({ patchChecksIncomplete: true });

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.patchesConclusion, 'neutral');
    assert.strictEqual(report.makefileConclusion, 'success', 'the Makefile audit read everything it needed');
  });

  test('marks formality neutral when an upstream commit could not be fetched', () => {
    const ctx = createMockContext();
    const patches = createMockPatchesResult({ upstreamFetchFailures: 1 });
    const outcome = createMockOutcome();

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.formalityConclusion, 'neutral');
    assert.ok(!report.allPrWarnings.some(w => w.includes('too large')),
      'the commit section already names the upstream commit and its HTTP code');
  });

  test('marks formality neutral when an override could not be looked up', () => {
    const ctx = createMockContext();
    const patches = createMockPatchesResult();
    const outcome = createMockOutcome({ formalityChecksIncomplete: true });

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.allPassed, true);
    assert.strictEqual(report.formalityConclusion, 'neutral');
  });

  test('reports every check as incomplete when no commit could be audited', () => {
    const ctx = createMockContext();
    const patches = createMockPatchesResult({ commitDetailsIncomplete: true });
    const outcome = createMockOutcome();

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.formalityConclusion, 'neutral');
    assert.strictEqual(report.makefileConclusion, 'neutral');
    assert.strictEqual(report.patchesConclusion, 'neutral');
    assert.ok(report.allPrWarnings.some(w => w.includes('could not be read, so no commit was audited')));
  });

  test('prioritizes failure conclusion over neutral when actual errors are detected', () => {
    const ctx = createMockContext({ budgetSkipCount: 2 });
    const patches = createMockPatchesResult();
    const outcome = createMockOutcome({
      formalityErrors: ['Commit subject is too long.'],
      makefileErrors: ['PKG_RELEASE not bumped.']
    });

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.allPassed, false);
    assert.strictEqual(report.formalityConclusion, 'failure');
    assert.strictEqual(report.makefileConclusion, 'failure');
    // Patches check had no errors, but was incomplete due to budget skip, so neutral
    assert.strictEqual(report.patchesConclusion, 'neutral');
  });

  // The two checks are reported separately, so each one's text has to match
  // its own conclusion: a check that concludes success and then says in its
  // body that it is incomplete is the mismatch these flags exist to prevent.
  test('names a refused lookup in the patch audit only, when that audit was handed it', () => {
    const ctx = createMockContext({ fetchFailureCount: 1 });
    const patches = createMockPatchesResult();
    const outcome = createMockOutcome({ patchChecksIncomplete: true });

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.patchesConclusion, 'neutral');
    assert.strictEqual(report.makefileConclusion, 'success', 'the Makefile audit read everything it needed');
    assert.match(report.patchesOutputText, /could not read 1 file\(s\)/);
    assert.doesNotMatch(report.makefileOutputText, /could not read 1 file\(s\)/,
      'a check that concludes success must not say in its own text that it is incomplete');
  });

  test('names a refused lookup in the Makefile audit only, when that audit was handed it', () => {
    const ctx = createMockContext({ fetchFailureCount: 1 });
    const patches = createMockPatchesResult();
    const outcome = createMockOutcome({ makefileChecksIncomplete: true });

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.makefileConclusion, 'neutral');
    assert.strictEqual(report.patchesConclusion, 'success', 'the patch audit read everything it needed');
    assert.match(report.makefileOutputText, /could not read 1 file\(s\)/);
    assert.doesNotMatch(report.patchesOutputText, /could not read 1 file\(s\)/,
      'a check that concludes success must not say in its own text that it is incomplete');
  });

  // Neither audit claimed the failure, so neither can be told it did not have
  // it: both report the gap, which is what keeps it from passing in silence.
  test('names a refused lookup in both audits when neither of them claimed it', () => {
    const ctx = createMockContext({ fetchFailureCount: 1 });
    const patches = createMockPatchesResult();
    const outcome = createMockOutcome();

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.makefileConclusion, 'neutral');
    assert.strictEqual(report.patchesConclusion, 'neutral');
    assert.match(report.makefileOutputText, /could not read 1 file\(s\)/);
    assert.match(report.patchesOutputText, /could not read 1 file\(s\)/);
  });

  // The upstream patch only subtracts: inherited style issues and a release
  // bump already missing on master are filtered back out with it. An audit
  // that found nothing without it would have found nothing with it either.
  test('keeps a clean Makefile check green when an upstream commit could not be fetched', () => {
    const ctx = createMockContext();
    const patches = createMockPatchesResult({ upstreamFetchFailures: 1 });
    const outcome = createMockOutcome();

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.makefileConclusion, 'success');
    assert.doesNotMatch(report.makefileOutputText, /not filtered out/,
      'nothing was reported, so there is no finding the missing filter could belong to');
    // The comparison itself is what did not happen, and that is the formality
    // check's own subject, so that one still reports itself incomplete.
    assert.strictEqual(report.formalityConclusion, 'neutral');
  });

  // With check_patch_headers set to warning a finding is reported as a warning
  // rather than an error, and the upstream patch would have filtered it just
  // the same, so the caveat belongs beside it there too.
  // A formality check that could not finish is explained in the commit's own
  // block, which the cut removes on a long series: the reason has to be above
  // it, or the check is neutral with nothing saying why.
  test('hoists a reason when a formality check could not be completed', () => {
    const ctx = createMockContext();
    const patches = createMockPatchesResult();
    const body = '### Checking PR #7: foo: a long series (Formalities Audit)\n\n' +
      Array.from({ length: 200 }, (_, i) =>
        `#### Commit [abc${i}](url) - foo: commit ${i}:\n  ⚠️ Warning: the cherry-pick scan could not be finished\n${'  ✅ padding line that makes the body long enough to be cut\n'.repeat(6)}\n`
      ).join('');
    const outcome = createMockOutcome({ formalityChecksIncomplete: true, formalityOutputText: body });

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.formalityConclusion, 'neutral');
    const cut = report.formalityOutput ?? report.formalityOutputText;
    assert.match(cut.slice(0, 600), /Some formality checks could not be completed/,
      'the reason sits under the heading, above anything truncation can reach');
  });

  test('names the missing upstream filter beside a finding reported as a warning', () => {
    const ctx = createMockContext();
    const patches = createMockPatchesResult({ upstreamFetchFailures: 1 });
    const outcome = createMockOutcome({
      patchesReportedFinding: true,
      patchesOutputText: '#### Commit [abc1234](url) - mypkg: refresh:\n  ⚠️ Warning: Patch is missing a Subject line\n'
    });

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.patchesConclusion, 'success', 'a warning is not an error');
    assert.match(report.patchesOutputText, /were not filtered out of the findings below/);
    assert.doesNotMatch(report.makefileOutputText, /not filtered out/);
  });

  test('names the missing upstream filter beside the findings it could have removed', () => {
    const ctx = createMockContext();
    const patches = createMockPatchesResult({ upstreamFetchFailures: 2 });
    const outcome = createMockOutcome({ makefileErrors: ['**Package Release Audit**:\n- missing bump'] });

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.makefileConclusion, 'failure');
    assert.match(report.makefileOutputText, /2 upstream commit\(s\) could not be fetched, so issues this backport inherited from them were not filtered out/);
    assert.doesNotMatch(report.patchesOutputText, /not filtered out/,
      'that audit reported no finding the missing filter could belong to');
    assert.ok(report.allPrWarnings.some(w => w.includes('not filtered out of the findings')), report.allPrWarnings.join('\n'));
  });

  // An audit that bailed out reports that in the same indented shape a finding
  // is reported in. There is nothing below the caveat the missing upstream
  // filter could have removed — only the notice saying the audit never ran.
  test('does not caveat an audit that only reported itself incomplete', () => {
    const ctx = createMockContext();
    const patches = createMockPatchesResult({ upstreamFetchFailures: 1 });
    const outcome = createMockOutcome({
      makefileChecksIncomplete: true,
      makefileOutputText: '#### Package Release Audit:\n  ⚠️ Warning: Package release bump audit skipped: PR modifies 18 packages. Batch updates of >15 packages are not automatically audited to prevent hitting API rate/subrequest limits.\n\n'
    });

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.makefileConclusion, 'neutral');
    assert.doesNotMatch(report.makefileOutputText, /not filtered out/,
      'the audit did not run, so it reported no finding to caveat');
    assert.ok(!report.allPrWarnings.some(w => w.includes('not filtered out of the findings')),
      report.allPrWarnings.join('\n'));
  });

  // The mirror of the patch-header case above, on the Makefile side: with
  // check_trailing_newline, check_binary_files or check_buildbot_default set to
  // warning the audit reports its finding as a warning, and the upstream patch
  // would have been compared against it just the same.
  test('names the missing upstream filter beside a Makefile finding reported as a warning', () => {
    const ctx = createMockContext();
    const patches = createMockPatchesResult({ upstreamFetchFailures: 1 });
    const outcome = createMockOutcome({
      makefileReportedFinding: true,
      makefileOutputText: "#### Commit [abc1234](url) - foo: add a helper:\n  ⚠️ Warning: File 'package/utils/foo/files/foo.sh' is missing a trailing newline\n"
    });

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.makefileConclusion, 'success', 'a warning is not an error');
    assert.match(report.makefileOutputText, /were not filtered out of the findings below/);
    assert.doesNotMatch(report.patchesOutputText, /not filtered out/);
  });

  // The formality check reports itself neutral because the comparison is its
  // own subject, and its summary sends the reader to the details. The reason is
  // a line in one commit's block, which a long series pushes past the cut, so
  // the count has to stand above the blocks as well.
  test('explains the formality check neutral above the per-commit blocks', () => {
    const ctx = createMockContext();
    const patches = createMockPatchesResult({ upstreamFetchFailures: 2 });
    const outcome = createMockOutcome({
      formalityOutputText: '### Checking PR #7: foo: backport a fix (Formalities Audit)\n\n#### Commit [abc1234](url) - foo: backport a fix:\n  ⚠️ Could not fetch upstream commit def5678 from GitHub API (HTTP 404)\n\n'
    });

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.formalityConclusion, 'neutral');
    assert.match(report.formalityOutputText,
      /^### Checking PR #7: [^\n]*\n\n⚠️ Warning: 2 upstream commit\(s\) could not be fetched from GitHub, so those backports were not compared with the commits they were taken from\./,
      `the reason has to sit under the heading: ${report.formalityOutputText}`);
    assert.match(report.formalityOutputText, /HTTP 404/,
      'the commit block still names the commit and the code');
  });

  // The flag is per audit and a bail-out is per audit too: one package root the
  // release audit skipped does not stop another commit's Makefile check from
  // reporting a finding the upstream patch would have filtered.
  test('names the missing upstream filter beside a finding an incomplete audit still reported', () => {
    const ctx = createMockContext();
    const patches = createMockPatchesResult({ upstreamFetchFailures: 1 });
    const outcome = createMockOutcome({
      makefileChecksIncomplete: true,
      makefileReportedFinding: true,
      makefileOutputText: '#### Package Release Audit:\n  ⚠️ Warning: Package release bump audit skipped: PR modifies 18 packages. Batch updates of >15 packages are not automatically audited to prevent hitting API rate/subrequest limits.\n\n  ❌ Package `utils/mypkg` is missing a PKG_RELEASE bump\n'
    });

    const report = aggregateReport(ctx, patches, outcome);

    assert.strictEqual(report.makefileConclusion, 'neutral');
    assert.match(report.makefileOutputText, /were not filtered out of the findings below/);
  });
});
