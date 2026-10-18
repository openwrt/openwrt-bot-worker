import {
  validateFormalities,
  validateMakefileContext,
  validateEmbeddedPatches,
  collectAddedPatchFiles,
  validatePkgReleaseBumps,
  validatePkgHashes,
  validateUciConfigs,
  groupReleaseErrors,
  getFastPkgRoot,
  MISSING_BUMP_ERROR,
  MISSING_BUMP_SUMMARY,
  MISSING_BUMP_ACTION
} from '../../validators.js';
import {
  getCommitMessageFromPatch,
  getChangedFilesFromPatch,
  splitPrPatchByCommit,
  MBOX_ENVELOPE_PATTERN
} from '../../core/patch-utils.ts';
import { CHERRY_PICK_MARKER } from '../../core/policy.ts';
import type { PullRequestContext } from './context.ts';
import type { ResolvedPatchesResult, CommitDetail } from './patches.ts';

export interface ValidationOutcome {
  allFormalityErrors: string[];
  allPrWarnings: string[];
  allMakefileErrors: string[];
  allPatchesErrors: string[];
  formalityOutputText: string;
  makefileOutputText: string;
  patchesOutputText: string;
  patchesHeading: string;
  patchChecksIncomplete: boolean;
  makefileChecksIncomplete: boolean;
  formalityChecksIncomplete: boolean;
  makefileReportedFinding: boolean;
  patchesReportedFinding: boolean;
  unreadPatchNotes: Set<string>;
}

export async function runValidations(
  ctx: PullRequestContext,
  patchesResult: ResolvedPatchesResult
): Promise<ValidationOutcome> {
  const {
    prNumber,
    prTitle,
    baseBranch,
    headSha,
    baseSha,
    isBackportPr,
    repoFullname,
    config,
    configError,
    commitScanCapped,
    commitsPagingCapped,
    commitsCount,
    fileBatchLoader,
    getCommentsScanWithRetry,
    branchCheckError,
    branchCheckWarning,
    branchCheckOutputText
  } = ctx;

  const {
    usePrWidePatch,
    prPatch,
    commitDetails,
    packageState
  } = patchesResult;

  const allFormalityErrors: string[] = [];
  const allPrWarnings: string[] = [];
  const allMakefileErrors: string[] = [];
  const allPatchesErrors: string[] = [];

  let formalityOutputText = `### Checking PR #${prNumber}: ${prTitle} (Formalities Audit)\n\n`;
  let makefileOutputText = `### Checking PR #${prNumber}: ${prTitle} (Makefile Audit)\n\n`;
  const patchesHeading = `### Checking PR #${prNumber}: ${prTitle} (Embedded Patches Compliance)\n\n`;
  let patchesOutputText = '';

  let patchChecksIncomplete = false;
  let formalityChecksIncomplete = false;
  const unreadPatchNotes = new Set<string>();

  if (configError) {
    const configWarning = ctx.configPartial
      ? `Some settings in \`.github/formalities.json\` in this repository could not be read (${configError}), so those settings ran with their default value instead of the configured one. Every other setting in the file was used. Fix the file on the default branch — this pull request is not the cause.`
      : `\`.github/formalities.json\` in this repository could not be read (${configError}), so every check ran with its default setting instead of the configured one. Fix the file on the default branch — this pull request is not the cause.`;
    formalityOutputText += `⚠️ Warning: ${configWarning}\n\n`;
    allPrWarnings.push(`**Repository Configuration**:\n- ⚠️ ${configWarning}`);
  }

  if (commitScanCapped) {
    // The same shortfall, two causes: pages this run did not ask for, or
    // commit records GitHub counted and then would not serve. Naming the cap
    // for the second one tells a two-commit pull request it has over 300.
    const scanned = ctx.commits.length;
    const cappedWarning = commitsPagingCapped
      ? `Commit scan is capped at 300 commits for API safety. This PR has ${commitsCount} commits, so only the first 300 commit messages were audited.`
      : `GitHub counted ${commitsCount} commits for this pull request but served the records of ${scanned}, so ${commitsCount - scanned} commit message(s) were not audited. Re-running the checks may well succeed.`;
    formalityOutputText += `⚠️ Warning: ${cappedWarning}\n\n`;
    allPrWarnings.push(`**Commit Audit Scope**:\n- ⚠️ ${cappedWarning}`);
  }

  if (branchCheckError) {
    allFormalityErrors.push(branchCheckError);
  }
  // The targeting rule could not be settled because the override it can be
  // waved through with was unreadable: unchecked, not failed.
  if (branchCheckWarning) {
    formalityChecksIncomplete = true;
    allPrWarnings.push(`**PR Targeting**:\n- ⚠️ ${branchCheckWarning}`);
  }
  formalityOutputText += branchCheckOutputText;

  // The commit-message audit is pure, but it reads fields off a payload this
  // code did not build, and one throw here is a webhook that answers 500 with
  // no check-runs on the pull request at all.
  const safeFormalities = (fullCommit: any): Promise<{ successes: string[]; errors: string[]; warnings: string[]; notices: string[]; incomplete: boolean }> =>
    Promise.resolve()
      .then(() => validateFormalities(fullCommit, config))
      .then((res: any) => ({
        successes: res?.successes || [],
        errors: res?.errors || [],
        warnings: res?.warnings || [],
        notices: [],
        incomplete: false
      }))
      .catch((err: any) => ({
        successes: [],
        errors: [],
        warnings: [],
        notices: [`Could not complete the commit message audit: ${err?.message || err}`],
        incomplete: true
      }));

  const safeUci = (promise: Promise<any>): Promise<{ successes: string[]; errors: string[]; notices: string[]; incomplete?: boolean }> =>
    promise.then((res: any) => ({
      successes: res?.successes || [],
      errors: res?.errors || [],
      notices: res?.notices || [],
      incomplete: Boolean(res?.incomplete)
    })).catch((err: any) => ({
      successes: [],
      errors: [],
      notices: [`Could not complete UCI config validation because of an error fetching file content: ${err?.message || err}`],
      incomplete: true
    }));

  const safeMakefile = (promiseOrVal: any): Promise<{ successes: string[]; errors: string[]; warnings: string[]; notices: string[]; incomplete?: boolean }> =>
    Promise.resolve(promiseOrVal).then((res: any) => ({
      successes: res?.successes || [],
      errors: res?.errors || [],
      warnings: res?.warnings || [],
      notices: res?.notices || [],
      incomplete: Boolean(res?.incomplete)
    })).catch((err: any) => ({
      successes: [],
      errors: [],
      warnings: [],
      notices: [`Could not complete Makefile validation because of an error fetching file content: ${err?.message || err}`],
      incomplete: true
    }));

  const safePatches = (promise: Promise<any>): Promise<{ successes: string[]; errors: string[]; warnings: string[]; notices?: string[]; skipped: string[]; incomplete?: boolean }> =>
    promise.catch((err: any) => ({
      successes: [],
      errors: [],
      warnings: [],
      notices: [`Could not complete embedded patch validation because of an error fetching file content: ${err?.message || err}`],
      skipped: [],
      incomplete: true
    }));

  let makefileChecksIncomplete = false;

  // A config GitHub would not serve is not a repository without one: every
  // check in this run read DEFAULT_CONFIG, so none of the three audits can
  // report a verdict on rules this repository may have written differently -
  // or switched off. All three say so in their own body: a check that reports
  // neutral with silent details sends the reader looking for a reason that is
  // not there. The labeler rules are reported the same way: labels they would
  // have added are missing, which is not the same as having none.
  if (ctx.configUnread) {
    const unreadWarning = `\`.github/formalities.json\` in this repository could not be read (the setup query came back with a partial error), so every check ran with its default setting instead of the configured one. What follows is what could be verified, not a verdict on the rest. Re-running the checks may well succeed.`;
    formalityOutputText += `⚠️ Warning: ${unreadWarning}\n\n`;
    makefileOutputText += `⚠️ Warning: ${unreadWarning}\n\n`;
    patchesOutputText += `⚠️ Warning: ${unreadWarning}\n\n`;
    allPrWarnings.push(`**Repository Configuration**:\n- ⚠️ ${unreadWarning}`);
    formalityChecksIncomplete = true;
    makefileChecksIncomplete = true;
    patchChecksIncomplete = true;
  }
  // A repository that switched the labeler off derives no label from the file
  // either way, so it is not told the file was unreadable - unless whether it
  // switched it off is itself what could not be read.
  if (ctx.labelerUnread && (config.enable_labeler_yml || ctx.configUnread)) {
    const labelerWarning = `\`.github/labeler.yml\` in this repository could not be read, so no label was derived from it. This is not a repository without labeler rules: labels they would have added may be missing from this pull request.`;
    allPrWarnings.push(`**Repository Configuration**:\n- ⚠️ ${labelerWarning}`);
  }

  // Whether an audit found anything is recorded here, where it is rendered,
  // rather than read back out of the markdown: only a finding can have been
  // inherited from an upstream commit, and the caveat the report puts above
  // these bodies belongs over findings only. The audits keep the two apart
  // themselves - a gap that stopped a check travels in `notices`, so whatever
  // is left in `warnings` is a finding the configuration asked to be reported
  // as one. Reading `incomplete` instead used to miss the result that carried
  // both: a downgraded finding and a lookup that failed.
  let makefileReportedFinding = false;
  let patchesReportedFinding = false;
  const findingInWarnings = (res: { warnings?: string[] }): boolean =>
    (res.warnings || []).length > 0;

  // A patch file another commit of the series added is still one this pull
  // request added, and a commit's own diff does not show that. Built on first
  // use: most pull requests touch no patch file that lacks a header.
  let addedInSeries: Set<string> | null = null;
  const isAddedByPullRequest = (path: string): boolean => {
    addedInSeries ??= collectAddedPatchFiles(commitDetails.flatMap((item: CommitDetail) =>
      item.commitPatch ? item.commitPatch.split(/^diff\s+--git\s+/m) : []));
    return addedInSeries.has(path);
  };

  // Start all per-commit, PR-wide, release, and hash validations in the same
  // synchronous tick so FileBatchLoader coalesces every file lookup into a
  // single batched GraphQL query.
  const deepChecks = commitDetails.map((item: CommitDetail) => {
    if (usePrWidePatch || item.isVerbatim) return null;
    const fetchFileContent = (path: string) => fileBatchLoader.fetchFileContentCached(path, item.sha);
    const fetchUpstream = (path: string) => item.upstreamSha ? fileBatchLoader.fetchFileContentCached(path, item.upstreamSha) : Promise.resolve(null);
    const hasUpstream = isBackportPr && item.upstreamPatch;
    const upstreamCommit = hasUpstream ? { commit: { message: getCommitMessageFromPatch(item.upstreamPatch) } } : null;
    return {
      makefile: safeMakefile(validateMakefileContext(item.fullCommit, item.commitPatch, config, packageState, repoFullname, fetchFileContent)),
      upstreamMakefile: hasUpstream ? safeMakefile(validateMakefileContext(upstreamCommit, item.upstreamPatch, config, { isNewPackage: false, isDroppedPackage: false }, repoFullname, fetchUpstream)) : null,
      uci: safeUci(validateUciConfigs(item.commitPatch, config, fetchFileContent)),
      upstreamUci: hasUpstream ? safeUci(validateUciConfigs(item.upstreamPatch, config, fetchUpstream)) : null,
      // The upstream audit is asked the same question about the same paths,
      // so a finding it shares reads the same and the filter below drops it.
      patches: safePatches(validateEmbeddedPatches(item.commitPatch, config, fetchFileContent, undefined, isAddedByPullRequest)),
      upstreamPatches: hasUpstream ? safePatches(validateEmbeddedPatches(item.upstreamPatch, config, fetchUpstream, undefined, isAddedByPullRequest)) : null
    };
  });

  const envelope = new RegExp(MBOX_ENVELOPE_PATTERN.source, MBOX_ENVELOPE_PATTERN.flags);
  const prWideEnvelopeMatches = (usePrWidePatch && prPatch) ? [...prPatch.matchAll(envelope)] : [];
  const splitMap = (usePrWidePatch && prPatch)
    ? (patchesResult.splitCommitPatches && patchesResult.splitCommitPatches.size > 0
        ? patchesResult.splitCommitPatches
        : (prWideEnvelopeMatches.length > 0 ? splitPrPatchByCommit(prPatch, ctx.commits) : new Map<string, string>()))
    : new Map<string, string>();

  const changedFiles = (usePrWidePatch && prPatch) ? getChangedFilesFromPatch(prPatch) : [];
  // The prefixes cover the openwrt tree. A feed in openwrt/packages layout
  // keeps its packages at <category>/<name>/... instead, which only the
  // resolver the package audits themselves use recognises; a string from it is
  // a package root it is sure of, so the series there is audited under the
  // same warning rather than silently degraded.
  const touchesMakefilesOrPackages = changedFiles.some(f =>
    f === 'Makefile' || f.endsWith('/Makefile') || f.startsWith('package/') || f.startsWith('feeds/') ||
    typeof getFastPkgRoot(f) === 'string'
  );

  const nonMergeCommitsCount = ctx.commits.filter((c: any) => (c.parents || []).length <= 1).length;
  const targetCommits = (ctx.commits || []).filter((c: any) => (c.parents || []).length <= 1 && c.changed_files !== 0);
  const expectedCount = targetCommits.length > 0 ? targetCommits.length : nonMergeCommitsCount;

  if (usePrWidePatch && prPatch && touchesMakefilesOrPackages && expectedCount > 1) {
    // An envelope left out because the commit GitHub says changed no files
    // carries no diff is explained, not unverified: the map only ever holds a
    // commit whose part matched its file count, so a target commit missing
    // from it is what the first clause already reports.
    if (splitMap.size < expectedCount || prWideEnvelopeMatches.length < expectedCount) {
      makefileChecksIncomplete = true;
      const warnMsg = `Could not safely verify commit boundaries or coverage in PR-wide patch series (${splitMap.size}/${expectedCount} commits mapped)`;
      allPrWarnings.push(`**Pull Request Overall Diff**:\n- ⚠️ ${warnMsg}`);
      // This is what leaves the Makefile audit incomplete, so its own body
      // says so: the check reports itself neutral, and a reader of it would
      // otherwise find the reason only in the pull request comment.
      makefileOutputText += `⚠️ Warning: ${warnMsg}\n\n`;
    }
  }

  const prWideChecks = (usePrWidePatch && prPatch) ? (() => {
    const commitsWithPatches = ctx.commits.map((c: any) => {
      let patch = splitMap.get(c.sha) || null;
      if (!patch && ctx.commits.length === 1) {
        patch = prPatch;
      }
      return {
        ...c,
        commitPatch: patch || (c.commitPatch ?? null)
      };
    });
    const virtualCommit = {
      isPrWidePatch: true,
      commits: commitsWithPatches,
      commit: {
        message: prTitle + "\n" + ctx.commits.map((c: any) => c.commit.message || '').join("\n")
      }
    };
    const fetchFileContent = (path: string) => fileBatchLoader.fetchFileContentCached(path, ctx.headSha);
    const isMissingAtHead = (path: string) => fileBatchLoader.isFileMissing(path, ctx.headSha);
    return {
      makefile: safeMakefile(validateMakefileContext(virtualCommit, prPatch, config, packageState, repoFullname, fetchFileContent)),
      uci: safeUci(validateUciConfigs(prPatch, config, fetchFileContent)),
      patches: safePatches(validateEmbeddedPatches(prPatch, config, fetchFileContent, isMissingAtHead))
    };
  })() : null;

  let releaseDetails: any[] = [];
  if (usePrWidePatch && prPatch) {
    // Per-commit entries only when the split really covered the series. With a
    // partial map every entry carries a null patch, so the audit would read an
    // empty diff, and passing the whole patch instead lets the validators run
    // their own mbox split, which is what reports an unsplittable series as
    // incomplete rather than as a pass.
    const splitCoversSeries = prWideEnvelopeMatches.length > 1 && targetCommits.length > 0 &&
      targetCommits.every((c: any) => splitMap.has(c.sha));
    releaseDetails = splitCoversSeries
      ? ctx.commits.map((c: any) => ({ commitPatch: splitMap.get(c.sha) || null, fullCommit: c }))
      : [{ commitPatch: prPatch }];
  } else if (usePrWidePatch) {
    releaseDetails = [{ commitPatch: prPatch }];
  } else {
    releaseDetails = commitDetails.filter(item => (item.fullCommit?.parents || []).length <= 1);
  }

  if (isBackportPr) {
    releaseDetails = releaseDetails.filter((item: any) => !item.isVerbatim);
  }

  const fetchFileContentAtHead = (path: string) => fileBatchLoader.fetchFileContentCached(path, headSha);
  const fetchFileContentAtBase = (path: string) => fileBatchLoader.fetchFileContentCached(path, baseSha);

  const releasePromise = validatePkgReleaseBumps(releaseDetails, config, fetchFileContentAtHead, fetchFileContentAtBase)
    .catch((e: any) => {
      console.error(`Failed to audit package release bumps: ${e.message}`);
      return {
        successes: [] as string[],
        errors: [] as string[],
        notices: [`Could not complete package release audit because of an error fetching file content: ${e.message}`],
        notes: [] as string[],
        incomplete: true
      };
    });

  const hashesPromise = validatePkgHashes(releaseDetails, config, fetchFileContentAtHead, fetchFileContentAtBase)
    .catch((e: any) => {
      console.error(`Failed to audit package hashes: ${e.message}`);
      return {
        successes: [] as string[],
        errors: [] as string[],
        warnings: [] as string[],
        notices: [`Could not complete package hash audit because of an error fetching file content: ${e.message}`],
        findings: [] as string[],
        incomplete: true
      };
    });

  for (const [commitIndex, item] of commitDetails.entries()) {
    const { sha, html_url, fullCommit } = item;
    const commitMsgLines = (fullCommit?.commit?.message || '').split("\n");
    const commitSubject = commitMsgLines[0].trim();

    const reportFormality = await safeFormalities(fullCommit);
    if (reportFormality.incomplete) formalityChecksIncomplete = true;
    formalityOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
    reportFormality.successes.forEach((s: string) => { formalityOutputText += `  ${s}\n`; });

    if (reportFormality.warnings.length > 0 || reportFormality.notices.length > 0) {
      // The three wordings left out are style advice the pull request comment
      // would only repeat; a gap is reported there whatever it says.
      const commentWarnings = [
        ...reportFormality.notices,
        ...reportFormality.warnings.filter((w: string) =>
          !w.includes("No reference link (e.g.") &&
          !w.includes("Commit is unsigned or") &&
          !w.includes("Subject line exceeds soft limit")
        )
      ];
      if (commentWarnings.length > 0) {
        allPrWarnings.push(`**Commit [${sha.slice(0, 7)}](${html_url})**:\n` + commentWarnings.map((w: string) => `- ⚠️ ${w}`).join("\n"));
      }
      [...reportFormality.notices, ...reportFormality.warnings].forEach((w: string) => { formalityOutputText += `  ⚠️ Warning: ${w}\n`; });
    }

    if (reportFormality.errors.length > 0) {
      allFormalityErrors.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportFormality.errors.join("\n"));
      reportFormality.errors.forEach((err: string) => { formalityOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
    }

    if (isBackportPr) {
      if (!CHERRY_PICK_MARKER.test(fullCommit?.commit?.message || '')) {
        const isMaintainer = await ctx.isAuthorMaintainer(ctx.bodyRequestsCherryPickBypass);
        const scanResult = await getCommentsScanWithRetry();
        const bypassCherryPickCheck = scanResult.hasCherryPickBypassComment || (ctx.bodyRequestsCherryPickBypass && isMaintainer === true);
        // The override is there, and whether its author may give it could not
        // be established: not honoured, and not absent either.
        const overrideUnverified = scanResult.cherryPickOverrideUnverified ||
          (ctx.bodyRequestsCherryPickBypass && isMaintainer === null);

        if (bypassCherryPickCheck) {
          formalityOutputText += "  ⚠️ Commit to stable branch bypasses cherry-pick requirement via override command\n";
        } else if (scanResult.incomplete || overrideUnverified) {
          // Same as the branch rule above: the comment that waves this commit
          // through may be sitting in the part of the thread that could not be
          // read, or its author's write access could not be checked, so the
          // missing marker is reported as unchecked.
          formalityChecksIncomplete = true;
          const scanWarning = scanResult.incomplete
            ? `The comment thread could not be read in full, so an \`[allow cherry-pick]\` override may have been missed. The missing cherry-pick marker was left unchecked rather than reported as a failure.`
            : `An \`[allow cherry-pick]\` override was left by a user whose write access could not be verified, so the override was not honoured. The missing cherry-pick marker was left unchecked rather than reported as a failure.`;
          formalityOutputText += `  ⚠️ ${scanWarning}\n`;
          allPrWarnings.push(`**Commit [${sha.slice(0, 7)}](${html_url})**:\n- ⚠️ ${scanWarning}`);
        } else {
          let errorMsg = `**Commit [${sha.slice(0, 7)}](${html_url})**:\n- Backports targeting stable branch (${baseBranch}) must contain the context line: '(cherry picked from commit ...)'`;
          if (isMaintainer) {
            errorMsg += ` (Use \`[allow cherry-pick]\` in PR description or comment to override this check)`;
          } else {
            errorMsg += ` (A maintainer can override this check by commenting \`[allow cherry-pick]\` on this PR)`;
          }
          allFormalityErrors.push(errorMsg);
          formalityOutputText += "  ❌ Commit to stable branch must be marked as cherry-picked\n";
        }
      } else {
        formalityOutputText += "  ✅ Commit explicitly specifies cherry-pick origin context\n";
        if (item.isVerbatim) {
          formalityOutputText += "  ✅ Backport matches upstream commit verbatim. Skipping style and packaging validations.\n";
        } else if (item.upstreamFetchError) {
          formalityOutputText += `  ⚠️ ${item.upstreamFetchError}\n`;
          allPrWarnings.push(`**Commit [${sha.slice(0, 7)}](${html_url})**:\n- ⚠️ ${item.upstreamFetchError}`);
        } else if (item.upstreamSha) {
          // In PR-wide mode the commit has no patch of its own, so no diff was
          // compared: the upstream patch is fetched for the release-bump
          // filter, and the whole pull request patch is what the audits read.
          formalityOutputText += usePrWidePatch
            ? "  ⚠️ Upstream commit fetched, but this pull request is audited as one diff, so the backport was not compared with it commit by commit.\n"
            : "  ⚠️ Backport diff deviates from upstream commit. Running validations on deviations only.\n";
        }
      }
    }
    formalityOutputText += "\n";

    if (!usePrWidePatch) {
      if (item.isVerbatim) {
        makefileOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
        makefileOutputText += "  ✅ Backport matches upstream commit verbatim. Skipping style and packaging validations.\n\n";
      } else {
        const reportMakefile = await deepChecks[commitIndex]!.makefile;
        if (reportMakefile.incomplete) makefileChecksIncomplete = true;
        if (deepChecks[commitIndex]!.upstreamMakefile) {
          const reportUpstreamMakefile = await deepChecks[commitIndex]!.upstreamMakefile;
          if (reportUpstreamMakefile.incomplete) makefileChecksIncomplete = true;
          // Findings only. A gap is this run failing to read this commit's
          // files, not something the backport inherited, and dropping it
          // because the upstream read failed the same way left the check
          // neutral with nothing in its body saying why.
          reportMakefile.errors = reportMakefile.errors.filter((err: string) => !reportUpstreamMakefile.errors.includes(err));
          reportMakefile.warnings = reportMakefile.warnings.filter((warn: string) => !reportUpstreamMakefile.warnings.includes(warn));
          reportMakefile.successes.push("✅ Filtered out style/packaging issues already present in upstream commit");
        }

        const reportUci = await deepChecks[commitIndex]!.uci;
        if (reportUci.incomplete) makefileChecksIncomplete = true;
        if (deepChecks[commitIndex]!.upstreamUci) {
          const reportUpstreamUci = await deepChecks[commitIndex]!.upstreamUci;
          if (reportUpstreamUci.incomplete) makefileChecksIncomplete = true;
          reportUci.errors = reportUci.errors.filter((err: string) => !reportUpstreamUci.errors.includes(err));
          reportUci.successes.push("✅ Filtered out configuration format issues already present in upstream commit");
        }

        makefileOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
        reportMakefile.successes.forEach((s: string) => { makefileOutputText += `  ${s}\n`; });
        reportUci.successes.forEach((s: string) => { makefileOutputText += `  ${s}\n`; });
        // Per audit, gaps before findings: a check that could not finish is
        // the context for whatever the rest of the block reports.
        const allWarnings = [
          ...(reportMakefile.notices || []),
          ...(reportMakefile.warnings || []),
          ...(reportUci.notices || [])
        ];
        if (allWarnings.length > 0) {
          allPrWarnings.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + allWarnings.map((w: string) => `- ⚠️ ${w.replace(/^- /, '')}`).join("\n"));
          allWarnings.forEach((w: string) => { makefileOutputText += `  ⚠️ Warning: ${w.replace(/^- /, '')}\n`; });
        }
        // The warnings read here are the ones left after the upstream filter
        // above. The UCI audit has no warnings channel of its own, so the
        // Makefile audit is the only one that can report a finding this way.
        if (findingInWarnings(reportMakefile)) makefileReportedFinding = true;
        if (reportMakefile.errors.length > 0 || reportUci.errors.length > 0) {
          makefileReportedFinding = true;
          const combinedErrors = [...reportMakefile.errors, ...reportUci.errors];
          allMakefileErrors.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + combinedErrors.join("\n"));
          combinedErrors.forEach((err: string) => { makefileOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
        }
        makefileOutputText += "\n";
      }
    }

    if (!usePrWidePatch) {
      if (item.isVerbatim) {
        patchesOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
        patchesOutputText += "  ✅ Backport matches upstream commit verbatim. Skipping style and packaging validations.\n\n";
      } else {
        const reportPatches = await deepChecks[commitIndex]!.patches;
        if (reportPatches.incomplete) patchChecksIncomplete = true;

        if (deepChecks[commitIndex]!.upstreamPatches) {
          const reportUpstreamPatches = await deepChecks[commitIndex]!.upstreamPatches;
          if (reportUpstreamPatches.incomplete) patchChecksIncomplete = true;
          reportPatches.errors = reportPatches.errors.filter((err: string) => !reportUpstreamPatches.errors.includes(err));
          reportPatches.warnings = reportPatches.warnings.filter((warn: string) => !reportUpstreamPatches.warnings.includes(warn));
          reportPatches.successes.push("✅ Filtered out embedded patch issues already present in upstream commit");
        }

        patchesOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
        reportPatches.successes.forEach((s: string) => { patchesOutputText += `  ${s}\n`; });
        for (const note of reportPatches.skipped) { unreadPatchNotes.add(note); patchesOutputText += `  ${note}\n`; }
        if (reportPatches.notices && reportPatches.notices.length > 0) {
          allPrWarnings.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportPatches.notices.map((w: string) => `- ⚠️ ${w.replace(/^- /, '')}`).join("\n"));
          reportPatches.notices.forEach((w: string) => { patchesOutputText += `  ⚠️ Warning: ${w.replace(/^- /, '')}\n`; });
        }
        // An older patch file the commit edits is a finding that does not fail,
        // and with the check set to warn so is every other one. They go out as
        // one block under the commit, each line once.
        const isPatchWarning = config.check_patch_headers === 'warning';
        const nonBlocking = [
          ...(findingInWarnings(reportPatches) ? reportPatches.warnings : []),
          ...(isPatchWarning ? reportPatches.errors : [])
        ].map((w: string) => w.replace(/^- /, ''));
        if (nonBlocking.length > 0) {
          patchesReportedFinding = true;
          allPrWarnings.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + nonBlocking.map((w: string) => `- ⚠️ ${w}`).join("\n"));
          nonBlocking.forEach((w: string) => { patchesOutputText += `  ⚠️ Warning: ${w}\n`; });
        }
        if (reportPatches.errors.length > 0 && !isPatchWarning) {
          patchesReportedFinding = true;
          allPatchesErrors.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportPatches.errors.join("\n"));
          reportPatches.errors.forEach((err: string) => { patchesOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
        }
        patchesOutputText += "\n";
      }
    }
  }

  if (prWideChecks) {
    const reportMakefile = await prWideChecks.makefile;
    if (reportMakefile.incomplete) makefileChecksIncomplete = true;
    const reportUci = await prWideChecks.uci;
    if (reportUci.incomplete) makefileChecksIncomplete = true;

    makefileOutputText += `#### Pull Request Overall Diff:\n`;
    reportMakefile.successes.forEach((s: string) => { makefileOutputText += `  ${s}\n`; });
    reportUci.successes.forEach((s: string) => { makefileOutputText += `  ${s}\n`; });
    const allPrWideWarnings = [
      ...(reportMakefile.notices || []),
      ...(reportMakefile.warnings || []),
      ...(reportUci.notices || [])
    ];
    if (allPrWideWarnings.length > 0) {
      allPrWarnings.push(`**Pull Request Overall Diff**:\n` + allPrWideWarnings.join("\n"));
      allPrWideWarnings.forEach((w: string) => { makefileOutputText += `  ⚠️ Warning: ${w.replace(/^- /, '')}\n`; });
    }
    if (findingInWarnings(reportMakefile)) makefileReportedFinding = true;
    if (reportMakefile.errors.length > 0 || reportUci.errors.length > 0) {
      makefileReportedFinding = true;
      const combinedErrors = [...reportMakefile.errors, ...reportUci.errors];
      allMakefileErrors.push(`**Pull Request Overall Diff**:\n` + combinedErrors.join("\n"));
      combinedErrors.forEach((err: string) => { makefileOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
    }
    makefileOutputText += "\n";

    const reportPatches = await prWideChecks.patches;
    if (reportPatches.incomplete) patchChecksIncomplete = true;
    patchesOutputText += `#### Pull Request Overall Diff:\n`;
    reportPatches.successes.forEach((s: string) => { patchesOutputText += `  ${s}\n`; });
    for (const note of reportPatches.skipped) { unreadPatchNotes.add(note); patchesOutputText += `  ${note}\n`; }
    if (reportPatches.notices && reportPatches.notices.length > 0) {
      allPrWarnings.push(`**Pull Request Overall Diff**:\n` + reportPatches.notices.map((w: string) => `- ⚠️ ${w.replace(/^- /, '')}`).join("\n"));
      reportPatches.notices.forEach((w: string) => { patchesOutputText += `  ⚠️ Warning: ${w.replace(/^- /, '')}\n`; });
    }
    const isPatchWarning = config.check_patch_headers === 'warning';
    const nonBlocking = [
      ...(findingInWarnings(reportPatches) ? reportPatches.warnings : []),
      ...(isPatchWarning ? reportPatches.errors : [])
    ].map((w: string) => w.replace(/^- /, ''));
    if (nonBlocking.length > 0) {
      patchesReportedFinding = true;
      allPrWarnings.push(`**Pull Request Overall Diff**:\n` + nonBlocking.map((w: string) => `- ⚠️ ${w}`).join("\n"));
      nonBlocking.forEach((w: string) => { patchesOutputText += `  ⚠️ Warning: ${w}\n`; });
    }
    if (reportPatches.errors.length > 0 && !isPatchWarning) {
      patchesReportedFinding = true;
      allPatchesErrors.push(`**Pull Request Overall Diff**:\n` + reportPatches.errors.join("\n"));
      reportPatches.errors.forEach((err: string) => { patchesOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
    }
    patchesOutputText += "\n";
  }

  const reportRelease = await releasePromise;
  if ((reportRelease as any).incomplete) makefileChecksIncomplete = true;

  if (isBackportPr && reportRelease.errors.length > 0) {
    reportRelease.errors = reportRelease.errors.filter(err => {
      const match = err.match(MISSING_BUMP_ERROR);
      if (match) {
        const pkgRoot = match[1];
        const preExisting = commitDetails.some(item => {
          if (!item.upstreamPatch) return false;
          const files = getChangedFilesFromPatch(item.upstreamPatch);
          const modifiesPkg = files.some(file => file.startsWith(pkgRoot + '/'));
          if (!modifiesPkg) return false;

          const patch = item.upstreamPatch;
          const hasBump = [
            /^\+\s*PKG_VERSION\s*(?::=|=)/m,
            /^\+\s*PKG_RELEASE\s*(?::=|=)/m,
            /^\+\s*PKG_SOURCE_VERSION\s*(?::=|=)/m,
            /^\+\s*PKG_SOURCE_DATE\s*(?::=|=)/m
          ].some(regex => regex.test(patch));

          return !hasBump;
        });
        if (preExisting) {
          reportRelease.successes.push(`✅ Package \`${pkgRoot}\` release audit: skipped warning/error for pre-existing lack of release bump on master`);
          return false;
        }
      }
      return true;
    });
  }

  if (reportRelease.successes.length > 0 || reportRelease.errors.length > 0 || (reportRelease.notices && reportRelease.notices.length > 0)) {
    makefileOutputText += `#### Package Release Audit:\n`;
    reportRelease.successes.forEach(s => { makefileOutputText += `  ${s}\n`; });
    if (reportRelease.notices && reportRelease.notices.length > 0) {
      reportRelease.notices.forEach(w => {
        makefileOutputText += `  ⚠️ Warning: ${w}\n`;
        allPrWarnings.push(`**Package Release Audit**:\n- ⚠️ ${w}`);
      });
    }
    if (reportRelease.errors.length > 0) {
      makefileReportedFinding = true;
      const isWarning = config.check_pkg_release === 'warning';
      const bullet = isWarning ? '- ⚠️ ' : '- ';
      const blocks: string[] = [];
      const { packages, others } = groupReleaseErrors(reportRelease.errors);

      if (packages.length > 0) {
        blocks.push(`${bullet}${MISSING_BUMP_SUMMARY}\n` +
          packages.map(p => `  - \`${p}\``).join("\n") +
          `\n\n  ${MISSING_BUMP_ACTION}`);
      }
      blocks.push(...others.map(e => `${bullet}${e}`));
      const notes = reportRelease.notes.map(n => `\n\n${n}`).join("");
      const body = `**Package Release Audit**:\n` + blocks.join("\n") + notes;

      if (isWarning) {
        allPrWarnings.push(body);
      } else {
        allMakefileErrors.push(body);
      }

      const mark = isWarning ? '  ⚠️ Warning: ' : '  ❌ ';
      if (packages.length > 0) {
        makefileOutputText += `${mark}${MISSING_BUMP_SUMMARY} ${packages.join(', ')}\n`;
        makefileOutputText += `${mark}${MISSING_BUMP_ACTION}\n`;
      }
      others.forEach(err => { makefileOutputText += `${mark}${err}\n`; });
      reportRelease.notes.forEach(n => { makefileOutputText += `  ℹ️ ${n}\n`; });
    }
    makefileOutputText += "\n";
  }

  const reportHashes = await hashesPromise;
  if ((reportHashes as any).incomplete) makefileChecksIncomplete = true;
  const hashErrors = [...reportHashes.errors, ...(config.check_pkg_hash === 'error' ? reportHashes.findings : [])];
  const hashWarnings = [
    ...(reportHashes.notices || []).map(n => `- ${n}`),
    ...reportHashes.warnings.map(w => `- ${w}`),
    ...(config.check_pkg_hash === 'error' ? [] : reportHashes.findings)
  ];
  // A hash finding is reported as an error or, with the check set to warn, as
  // a warning, and either way it is a finding: `findings` is the heuristic
  // half, and `warnings` what the build system itself only warns about - a
  // checksum turned off or left an MD5. The gaps are in `notices`.
  if (hashErrors.length > 0 || (reportHashes.findings || []).length > 0 ||
    findingInWarnings(reportHashes as any)) makefileReportedFinding = true;
  if (reportHashes.successes.length > 0 || hashErrors.length > 0 || hashWarnings.length > 0) {
    makefileOutputText += `#### Package Hash Audit:\n`;
    reportHashes.successes.forEach(s => { makefileOutputText += `  ${s}\n`; });
    if (hashWarnings.length > 0) {
      allPrWarnings.push(`**Package Hash Audit**:\n` + hashWarnings.map(w => `- ⚠️ ${w.replace(/^- /, '')}`).join("\n"));
      hashWarnings.forEach(w => { makefileOutputText += `  ⚠️ Warning: ${w.replace(/^- /, '')}\n`; });
    }
    if (hashErrors.length > 0) {
      allMakefileErrors.push(`**Package Hash Audit**:\n` + hashErrors.join("\n"));
      hashErrors.forEach(err => { makefileOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
    }
    makefileOutputText += "\n";
  }

  return {
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
  };
}
