import { describe, test } from 'node:test';
import assert from 'node:assert';
import { aggregateReport } from '../../src/handlers/pull-request/report.ts';

describe('aggregateReport lifecycle phase', () => {
  const createMockContext = ({ budgetSkipCount = 0, usedBudget = 10, limit = 50, reserve = 15, commitsCount = 5 } = {}) => ({
    client: {
      budget: { limit, used: usedBudget, reserve }
    },
    fileBatchLoader: {
      getBudgetSkipCount: () => budgetSkipCount
    },
    commitScanCapped: false,
    commits: new Array(commitsCount).fill({ sha: 'dummy' })
  });

  const createMockPatchesResult = ({ patchUnavailable = false, upstreamComparisonSkips = 0 } = {}) => ({
    usePrWidePatch: false,
    prPatch: null,
    patchUnavailable,
    commitDetails: [],
    upstreamComparisonSkips,
    packageState: { isNewPackage: false, isDroppedPackage: false },
    packageStateKnown: true
  });

  const createMockOutcome = ({ formalityErrors = [], makefileErrors = [], patchesErrors = [] } = {}) => ({
    allFormalityErrors: [...formalityErrors],
    allPrWarnings: [],
    allMakefileErrors: [...makefileErrors],
    allPatchesErrors: [...patchesErrors],
    formalityOutputText: 'Formality OK\n',
    makefileOutputText: 'Makefile OK\n',
    patchesOutputText: 'Patches OK\n',
    patchesHeading: '## Patches\n',
    patchChecksIncomplete: false,
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
});
