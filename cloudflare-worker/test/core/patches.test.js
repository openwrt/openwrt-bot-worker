import { describe, test } from 'node:test';
import assert from 'node:assert';
import { resolvePatchesAndCommits } from '../../src/handlers/pull-request/patches.ts';

describe('resolvePatchesAndCommits lifecycle phase', () => {
  const createMockContext = ({
    commitsCount = 20,
    availableBudget = 35,
    reserve = 15,
    prPatchResponse = null,
    commitPatchResponse = { code: 200, raw: 'diff --git a/foo b/foo\n' }
  } = {}) => {
    const commits = [];
    for (let i = 0; i < commitsCount; i++) {
      commits.push({
        sha: `sha_${i}`,
        html_url: `https://github.com/test/repo/commit/sha_${i}`,
        commit: { message: `commit ${i}` }
      });
    }

    const limit = 50;
    const used = limit - availableBudget;

    return {
      commits,
      client: {
        budget: { limit, used, reserve },
        hasHeadroom: () => (limit - reserve - used) > 0,
        trackedApiCall: async (url) => {
          if (url.includes('/commits/')) {
            return commitPatchResponse;
          }
          return { code: 200, data: null };
        },
        optionalApiCall: async (url) => {
          if (url.includes('/commits/')) {
            return commitPatchResponse;
          }
          return { code: 200, data: null };
        }
      },
      fileBatchLoader: {
        getRefSource: () => undefined,
        hasRefSource: () => false,
        setRefSource: () => {}
      },
      isBackportPr: false,
      repoFullname: 'openwrt/openwrt',
      prData: { url: 'https://api.github.com/repos/openwrt/openwrt/pulls/100' },
      startPrPatchFetch: async () => prPatchResponse
    };
  };

  test('uses PR-wide patch when commits > 15 and PR patch fetch succeeds', async () => {
    const prPatchText = 'diff --git a/pkg/Makefile b/pkg/Makefile\n--- a/pkg/Makefile\n+++ b/pkg/Makefile\n';
    const ctx = createMockContext({
      commitsCount: 18,
      prPatchResponse: { code: 200, raw: prPatchText, data: null, headers: { get: () => null } }
    });

    const result = await resolvePatchesAndCommits(ctx);

    assert.strictEqual(result.usePrWidePatch, true);
    assert.strictEqual(result.prPatch, prPatchText);
    assert.strictEqual(result.patchUnavailable, false);
  });

  test('falls back to commit-by-commit fetching when PR-wide patch is unavailable and budget allows', async () => {
    const ctx = createMockContext({
      commitsCount: 16,
      availableBudget: 35, // 35 available - 15 reserve = 20 remaining >= 16 commits
      prPatchResponse: { code: 404, raw: 'Not Found', data: null, headers: { get: () => null } }
    });

    const result = await resolvePatchesAndCommits(ctx);

    assert.strictEqual(result.usePrWidePatch, false);
    assert.strictEqual(result.patchUnavailable, false);
    assert.strictEqual(result.commitDetails.length, 16);
  });

  test('marks patchUnavailable when PR-wide patch is unavailable and budget is insufficient for individual commits', async () => {
    const ctx = createMockContext({
      commitsCount: 25,
      availableBudget: 25, // 25 available - 15 reserve = 10 remaining < 25 commits
      prPatchResponse: { code: 404, raw: 'Not Found', data: null, headers: { get: () => null } }
    });

    const result = await resolvePatchesAndCommits(ctx);

    assert.strictEqual(result.usePrWidePatch, true);
    assert.strictEqual(result.patchUnavailable, true);
    assert.strictEqual(result.prPatch, null);
  });

  test('marks patchUnavailable when PR-wide patch is unavailable and budget is insufficient for small PR (<= 15 commits)', async () => {
    const ctx = createMockContext({
      commitsCount: 5,
      availableBudget: 17, // 17 available - 15 reserve = 2 remaining < 5 commits
      prPatchResponse: { code: 404, raw: 'Not Found', data: null, headers: { get: () => null } }
    });

    const result = await resolvePatchesAndCommits(ctx);

    assert.strictEqual(result.usePrWidePatch, true);
    assert.strictEqual(result.patchUnavailable, true);
    assert.strictEqual(result.prPatch, null);
  });

  test('falls back to PR patch when individual commit patch fetch fails due to budget or network error', async () => {
    const prPatchText = 'diff --git a/pkg/Makefile b/pkg/Makefile\n--- a/pkg/Makefile\n+++ b/pkg/Makefile\n';
    const ctx = createMockContext({
      commitsCount: 3,
      availableBudget: 25,
      prPatchResponse: { code: 200, raw: prPatchText, data: null, headers: { get: () => null } },
      commitPatchResponse: { code: 500, raw: 'Server Error' }
    });

    const result = await resolvePatchesAndCommits(ctx);

    assert.strictEqual(result.usePrWidePatch, true);
    assert.strictEqual(result.patchUnavailable, false);
    assert.strictEqual(result.prPatch, prPatchText);
  });

  // A comparison GitHub refused is not a comparison the budget never allowed:
  // the second is what "PR too large" describes, and only that one belongs in
  // the skip count the coverage warning is written from.
  test('counts a refused upstream fetch as a fetch failure, not as a budget skip', async () => {
    const ctx = createMockContext({ commitsCount: 1 });
    ctx.isBackportPr = true;
    ctx.commits = [{
      sha: '1234567890123456789012345678901234567890',
      html_url: 'https://github.com/test/repo/commit/1234567890123456789012345678901234567890',
      commit: { message: 'foo: backport fix\n\n(cherry picked from commit 0987654321098765432109876543210987654321)' }
    }];
    ctx.client.optionalApiCall = async (url) => {
      if (url.includes('/commits/0987654321098765432109876543210987654321')) {
        return { code: 404, raw: 'Not Found' };
      }
      return { code: 200, raw: 'diff --git a/foo b/foo\n' };
    };

    const result = await resolvePatchesAndCommits(ctx);
    assert.strictEqual(result.upstreamFetchFailures, 1);
    assert.strictEqual(result.upstreamComparisonSkips, 0, 'a 404 says nothing about this PR being too large');
    assert.ok(result.commitDetails[0].upstreamFetchError.includes('HTTP 404'));
  });

  // In PR-wide mode no commit has a patch of its own, but the upstream diff is
  // what the release-bump filter needs to tell a downstream omission from one
  // the backport inherited.
  test('fetches the upstream commit in PR-wide mode, where no commit patch exists', async () => {
    const upstreamDiff = 'diff --git a/utils/foo/Makefile b/utils/foo/Makefile\n--- a/utils/foo/Makefile\n+++ b/utils/foo/Makefile\n@@ -1 +1 @@\n-a\n+b\n';
    const ctx = createMockContext({
      commitsCount: 16,
      prPatchResponse: { code: 200, raw: 'diff --git a/README.md b/README.md\n', data: null, headers: { get: () => null } }
    });
    ctx.isBackportPr = true;
    ctx.commits = Array.from({ length: 16 }, (_, i) => ({
      sha: String(i).padStart(40, 'a'),
      html_url: `https://github.com/test/repo/commit/${i}`,
      parents: [{ sha: 'parent' }],
      commit: { message: `foo: change ${i}\n\n(cherry picked from commit ${String(i).padStart(40, 'b')})` }
    }));
    // The upstream shas are the b-padded ones, the commits' own the a-padded.
    ctx.client.optionalApiCall = async (url) => (/\/commits\/b/.test(url)
      ? { code: 200, raw: upstreamDiff }
      : { code: 404, raw: 'Not Found' });

    const result = await resolvePatchesAndCommits(ctx);

    assert.strictEqual(result.usePrWidePatch, true);
    assert.strictEqual(result.commitDetails[0].upstreamPatch, upstreamDiff,
      'the upstream patch is what the release audit filters against');
    assert.strictEqual(result.commitDetails[0].isVerbatim, false,
      'without a commit patch there is nothing to call verbatim');
    assert.strictEqual(result.upstreamComparisonSkips, 0);
  });

  test('counts a skipped upstream comparison once when the per-commit pass falls back', async () => {
    const ctx = createMockContext({
      commitsCount: 3,
      availableBudget: 35,
      prPatchResponse: { code: 200, raw: 'diff --git a/README.md b/README.md\n', data: null, headers: { get: () => null } }
    });
    ctx.isBackportPr = true;
    ctx.commits = ['a', 'b', 'c'].map((letter, i) => ({
      sha: letter.repeat(40),
      html_url: `https://github.com/test/repo/commit/${letter}`,
      parents: [{ sha: 'parent' }],
      commit: { message: `foo: change ${i}\n\n(cherry picked from commit ${'f'.repeat(39)}${i})` }
    }));
    ctx.client.optionalApiCall = async (url) => {
      // The third commit's own patch is refused, which is what sends the run
      // back to the PR-wide patch after two commits were already mapped.
      if (/\/commits\/c+$/.test(url)) return { code: 500, raw: 'Server Error' };
      if (/\/commits\/f+\d$/.test(url)) return { code: 503, raw: 'upstream hiccup' };
      return { code: 200, raw: 'diff --git a/foo b/foo\n' };
    };

    const result = await resolvePatchesAndCommits(ctx);

    assert.strictEqual(result.usePrWidePatch, true, 'the run fell back to the PR-wide patch');
    assert.strictEqual(result.upstreamFetchFailures, 3,
      'three commits, three failed comparisons - the abandoned pass must not be billed again');
    assert.strictEqual(result.upstreamComparisonSkips, 0,
      'none of them was skipped for want of budget, so none belongs in the "PR too large" count');
  });

  // canFetchCommits budgets one request per commit. A fork PR whose commits
  // miss in the base repo wants two, and the second must not come out of the
  // reserve the closing check-run writes are kept for.
  test('does not retry a commit against the fork once only the reserve is left', async () => {
    // Room for exactly the five commit patches the pre-check budgets for.
    const limit = 20;
    const reserve = 15;
    const budget = { limit, used: 0, reserve };
    const attempted = [];
    const ctx = createMockContext({ commitsCount: 5 });
    ctx.prData = {
      url: 'https://api.github.com/repos/openwrt/openwrt/pulls/100',
      head: { repo: { full_name: 'contributor/openwrt' } }
    };
    ctx.client = {
      budget,
      hasHeadroom: () => budget.limit - budget.reserve - budget.used > 0,
      optionalApiCall: async (url) => {
        attempted.push(url);
        budget.used++;
        return url.includes('contributor/openwrt')
          ? { code: 200, raw: 'diff --git a/foo b/foo\n' }
          : { code: 404, raw: 'Not Found' };
      },
      trackedApiCall: async () => ({ code: 200, data: null })
    };

    await resolvePatchesAndCommits(ctx);

    assert.ok(budget.used <= limit - reserve,
      `the run spent ${budget.used} of ${limit} requests, past the ${reserve} kept in reserve: ${attempted.length} lookups`);
  });

  test('answers with an incomplete audit, not a rejection, when PR-wide commit details cannot be built', async () => {
    const ctx = createMockContext({
      commitsCount: 16,
      prPatchResponse: { code: 200, raw: 'diff --git a/README.md b/README.md\n', data: null, headers: { get: () => null } }
    });
    // A commit the GraphQL setup served without its metadata. Letting the
    // throw out answers the webhook 500, with no check-runs at all.
    ctx.commits = [...ctx.commits.slice(0, 15), { sha: 'deadbeef', html_url: 'https://example.invalid' }];

    const result = await resolvePatchesAndCommits(ctx);

    assert.strictEqual(result.commitDetailsIncomplete, true);
    assert.deepStrictEqual(result.commitDetails, []);
  });

  // The per-commit pass cannot be called back once one of its commits throws:
  // the others keep resolving, and a comparison they fail afterwards belongs
  // to nothing the run reports. Only the pass whose commits are used counts.
  test('counts upstream comparisons per pass, not across the one it abandoned', async () => {
    const ctx = createMockContext({
      commitsCount: 2,
      availableBudget: 35,
      prPatchResponse: { code: 200, raw: 'diff --git a/README.md b/README.md\n', data: null, headers: { get: () => null } }
    });
    ctx.isBackportPr = true;
    ctx.commits = ['a', 'c'].map((letter, i) => ({
      sha: letter.repeat(40),
      html_url: `https://github.com/test/repo/commit/${letter}`,
      parents: [{ sha: 'parent' }],
      commit: { message: `foo: change ${i}\n\n(cherry picked from commit ${'f'.repeat(39)}${i})` }
    }));

    // The first upstream lookup is held until the PR-wide pass has asked for
    // its own, so the abandoned pass answers while that pass is still running
    // - exactly the in-flight commit whose count must not be billed.
    let releaseHeld;
    const held = new Promise(resolve => { releaseHeld = resolve; });
    let upstreamCalls = 0;
    ctx.client.optionalApiCall = async (url) => {
      // The second commit's own patch is refused, which is what sends the run
      // back to the PR-wide patch.
      if (/\/commits\/c+$/.test(url)) return { code: 500, raw: 'Server Error' };
      if (/\/commits\/f+\d$/.test(url)) {
        upstreamCalls++;
        if (upstreamCalls === 1) {
          await held;
          return { code: 503, raw: 'upstream hiccup' };
        }
        releaseHeld();
        await new Promise(resolve => setTimeout(resolve, 5));
        return { code: 503, raw: 'upstream hiccup' };
      }
      return { code: 200, raw: 'diff --git a/foo b/foo\n' };
    };

    const result = await resolvePatchesAndCommits(ctx);

    assert.strictEqual(result.usePrWidePatch, true, 'the run fell back to the PR-wide patch');
    assert.strictEqual(result.upstreamFetchFailures, 2,
      'two commits, two failed comparisons: a commit of the abandoned pass must not add a third');
    assert.strictEqual(result.upstreamComparisonSkips, 0);
  });

  // A declined attempt and a request GitHub refused arrive as the same HTTP code
  // here, and only the sentinel body tells them apart. Reporting the first as the
  // second blames GitHub for a lookup the budget held back, and - where the
  // report has a dedicated channel for it - claims a comparison was attempted.
  describe('an attempt the budget declined', () => {
    const DECLINED = () => ({
      code: 599,
      data: null,
      raw: 'Request not made: the caller declined the attempt',
      headers: { get: () => null }
    });

    const backportContext = (overrides = {}) => ({
      commits: [{
        sha: 'a'.repeat(40),
        html_url: 'https://github.com/openwrt/openwrt/commit/aaa',
        parents: [{ sha: 'parent' }],
        commit: { message: `foo: backport fix\n\n(cherry picked from commit ${'f'.repeat(40)})` }
      }],
      client: {
        budget: { limit: 50, used: 10, reserve: 15 },
        hasHeadroom: () => true,
        trackedApiCall: async () => ({ code: 200, raw: 'diff --git a/foo b/foo\n' }),
        optionalApiCall: async () => ({ code: 200, raw: 'diff --git a/foo b/foo\n' })
      },
      fileBatchLoader: { getRefSource: () => undefined, hasRefSource: () => false, setRefSource: () => {} },
      isBackportPr: true,
      repoFullname: 'openwrt/openwrt',
      prData: { url: 'https://api.github.com/repos/openwrt/openwrt/pulls/100' },
      startPrPatchFetch: async () => ({ code: 200, raw: 'diff --git a/foo b/foo\n', data: null, headers: { get: () => null } }),
      ...overrides
    });

    test('counts a refused upstream lookup as a skipped comparison, not as an upstream GitHub would not serve', async () => {
      const ctx = backportContext();
      let upstreamCalls = 0;
      ctx.client.optionalApiCall = async (url) => {
        if (/\/commits\/f+$/.test(url)) { upstreamCalls++; return DECLINED(); }
        return { code: 200, raw: 'diff --git a/foo b/foo\n' };
      };

      const result = await resolvePatchesAndCommits(ctx);

      assert.strictEqual(upstreamCalls, 1, 'the lookup was dispatched and declined inside the client');
      assert.strictEqual(result.upstreamComparisonSkips, 1, 'a declined attempt is a skipped comparison');
      assert.strictEqual(result.upstreamFetchFailures, 0, 'nothing GitHub did can be reported here');
      assert.strictEqual(result.commitDetails[0].upstreamFetchError, null);
      assert.strictEqual(result.commitDetails[0].upstreamPatch, null);
      // A comparison that never happened must not leave the sha behind: the
      // commit's own block would otherwise say the backport deviates from an
      // upstream commit nobody read.
      assert.strictEqual(result.commitDetails[0].upstreamSha, null);
      assert.strictEqual(result.commitDetails[0].isVerbatim, false);
    });

    // A single commit has no PR-wide patch behind it, so its patch is the only
    // diff the audit will ever see: declining that attempt loses every content
    // check and reports a pass for files nobody read. It is charged, not
    // declined - which is what the fallback already did, one request later.
    test('spends a charged attempt on the one patch the audit cannot do without', async () => {
      const ctx = backportContext({ isBackportPr: false, startPrPatchFetch: async () => null });
      const asked = [];
      ctx.client.budget = { limit: 15, used: 2, reserve: 15 };
      ctx.client.hasHeadroom = () => false;
      ctx.client.optionalApiCall = async (url) => { asked.push(['optional', url]); return DECLINED(); };
      ctx.client.trackedApiCall = async (url) => { asked.push(['tracked', url]); return { code: 200, raw: 'diff --git a/foo b/foo\n' }; };

      const result = await resolvePatchesAndCommits(ctx);

      assert.deepStrictEqual(asked.map(([kind]) => kind), ['tracked'],
        'one tracked request, and no second one through the fallback');
      assert.strictEqual(result.usePrWidePatch, false);
      assert.strictEqual(result.patchUnavailable, false);
      assert.strictEqual(result.commitDetails[0].commitPatch, 'diff --git a/foo b/foo\n');
    });

    test('still reports a genuinely unfetchable upstream commit as a fetch failure', async () => {
      const ctx = backportContext();
      ctx.client.optionalApiCall = async (url) => {
        if (/\/commits\/f+$/.test(url)) return { code: 404, raw: 'Not Found' };
        return { code: 200, raw: 'diff --git a/foo b/foo\n' };
      };

      const result = await resolvePatchesAndCommits(ctx);

      assert.strictEqual(result.upstreamFetchFailures, 1);
      assert.strictEqual(result.upstreamComparisonSkips, 0);
      assert.match(result.commitDetails[0].upstreamFetchError, /HTTP 404/);
      assert.strictEqual(result.commitDetails[0].upstreamSha, 'f'.repeat(40));
    });

    test('names the budget, not GitHub, when a commit patch is the attempt declined', async () => {
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => { warnings.push(args.join(' ')); };
      let result;
      try {
        const ctx = backportContext({
          isBackportPr: false,
          // Two commits and no PR-wide patch, so the run goes commit by commit
          // and has nothing to fall back on but "could not run".
          commits: [0, 1].map(i => ({
            sha: String(i).repeat(40),
            html_url: `https://github.com/openwrt/openwrt/commit/${i}`,
            parents: [{ sha: 'parent' }],
            commit: { message: `foo: change ${i}` }
          })),
          startPrPatchFetch: async () => ({ code: 404, raw: 'Not Found', data: null, headers: { get: () => null } })
        });
        ctx.client.optionalApiCall = async () => DECLINED();

        result = await resolvePatchesAndCommits(ctx);
      } finally {
        console.warn = originalWarn;
      }

      // The pass is abandoned either way: a commit left without a patch reads
      // downstream as a commit that changed no text file, which would report a
      // pass for an audit that never ran.
      assert.strictEqual(result.usePrWidePatch, true);
      assert.strictEqual(result.patchUnavailable, true, 'the audits report themselves unable to run');
      const fallback = warnings.find(w => w.includes('falling back to PR-wide patch'));
      assert.ok(fallback, 'the fallback is logged');
      assert.match(fallback, /no request budget left/);
      assert.doesNotMatch(fallback, /HTTP 599/, 'a declined attempt is not an answer GitHub sent');
    });

    test('keeps the base repository answer when the fork fallback is the attempt declined', async () => {
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => { warnings.push(args.join(' ')); };
      let result;
      try {
        const ctx = backportContext({
          isBackportPr: false,
          commits: [0, 1].map(i => ({
            sha: String(i).repeat(40),
            html_url: `https://github.com/openwrt/openwrt/commit/${i}`,
            parents: [{ sha: 'parent' }],
            commit: { message: `foo: change ${i}` }
          })),
          prData: {
            url: 'https://api.github.com/repos/openwrt/openwrt/pulls/100',
            head: { repo: { full_name: 'contributor/openwrt' } }
          },
          startPrPatchFetch: async () => ({ code: 404, raw: 'Not Found', data: null, headers: { get: () => null } })
        });
        ctx.client.optionalApiCall = async (url) => (
          url.includes('contributor/openwrt') ? DECLINED() : { code: 404, raw: 'No commit found for SHA' }
        );

        result = await resolvePatchesAndCommits(ctx);
      } finally {
        console.warn = originalWarn;
      }

      assert.strictEqual(result.patchUnavailable, true);
      assert.ok(warnings.some(w => /Fork fallback for commit .* not attempted/.test(w)),
        'the unchecked fork is said out loud');
      const fallback = warnings.find(w => w.includes('falling back to PR-wide patch'));
      assert.match(fallback, /HTTP 404/, 'the base repository did answer, and that answer is what is reported');
    });
  });
});
