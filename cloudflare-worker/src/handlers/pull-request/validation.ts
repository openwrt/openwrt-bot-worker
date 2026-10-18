import {
  validateFormalities,
  validateMakefileContext,
  validateEmbeddedPatches,
  validatePkgReleaseBumps,
  validatePkgHashes,
  validateUciConfigs,
  MISSING_BUMP_ERROR
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
    commitsCount,
    fileBatchLoader,
    getCommentsScanWithRetry,
    isMaintainerUser,
    branchCheckError,
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
  const unreadPatchNotes = new Set<string>();

  if (configError) {
    const configWarning = `\`.github/formalities.json\` in this repository could not be read (${configError}), so every check ran with its default setting instead of the configured one. Fix the file on the default branch — this pull request is not the cause.`;
    formalityOutputText += `⚠️ Warning: ${configWarning}\n\n`;
    allPrWarnings.push(`**Repository Configuration**:\n- ⚠️ ${configWarning}`);
  }

  if (commitScanCapped) {
    const cappedWarning = `Commit scan is capped at 300 commits for API safety. This PR has ${commitsCount} commits, so only the first 300 commit messages were audited.`;
    formalityOutputText += `⚠️ Warning: ${cappedWarning}\n\n`;
    allPrWarnings.push(`**Commit Audit Scope**:\n- ⚠️ ${cappedWarning}`);
  }

  if (branchCheckError) {
    allFormalityErrors.push(branchCheckError);
  }
  formalityOutputText += branchCheckOutputText;

  const safeUci = (promise: Promise<any>): Promise<{ successes: string[]; errors: string[]; warnings: string[]; incomplete?: boolean }> =>
    promise.then((res: any) => ({
      successes: res?.successes || [],
      errors: res?.errors || [],
      warnings: res?.warnings || [],
      incomplete: Boolean(res?.incomplete)
    })).catch((err: any) => ({
      successes: [],
      errors: [],
      warnings: [`Could not complete UCI config validation because of an error fetching file content: ${err?.message || err}`],
      incomplete: true
    }));

  const safeMakefile = (promiseOrVal: any): Promise<{ successes: string[]; errors: string[]; warnings: string[]; incomplete?: boolean }> =>
    Promise.resolve(promiseOrVal).then((res: any) => ({
      successes: res?.successes || [],
      errors: res?.errors || [],
      warnings: res?.warnings || [],
      incomplete: Boolean(res?.incomplete)
    })).catch((err: any) => ({
      successes: [],
      errors: [],
      warnings: [`Could not complete Makefile validation because of an error fetching file content: ${err?.message || err}`],
      incomplete: true
    }));

  const safePatches = (promise: Promise<any>): Promise<{ successes: string[]; errors: string[]; warnings: string[]; skipped: string[]; incomplete?: boolean }> =>
    promise.catch((err: any) => ({
      successes: [],
      errors: [],
      warnings: [`Could not complete embedded patch validation because of an error fetching file content: ${err?.message || err}`],
      skipped: [],
      incomplete: true
    }));

  let makefileChecksIncomplete = false;

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
      patches: safePatches(validateEmbeddedPatches(item.commitPatch, config, fetchFileContent)),
      upstreamPatches: hasUpstream ? safePatches(validateEmbeddedPatches(item.upstreamPatch, config, fetchUpstream)) : null
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
  const touchesMakefilesOrPackages = changedFiles.some(f =>
    f === 'Makefile' || f.endsWith('/Makefile') || f.startsWith('package/') || f.startsWith('feeds/')
  );

  const nonMergeCommitsCount = ctx.commits.filter((c: any) => (c.parents || []).length <= 1).length;
  const targetCommits = (ctx.commits || []).filter((c: any) => (c.parents || []).length <= 1 && c.changed_files !== 0);
  const expectedCount = targetCommits.length > 0 ? targetCommits.length : nonMergeCommitsCount;

  if (usePrWidePatch && prPatch && touchesMakefilesOrPackages && expectedCount > 1) {
    if (splitMap.size < expectedCount || prWideEnvelopeMatches.length < expectedCount || splitMap.size < Math.min(prWideEnvelopeMatches.length, nonMergeCommitsCount)) {
      makefileChecksIncomplete = true;
      const warnMsg = `Could not safely verify commit boundaries or coverage in PR-wide patch series (${splitMap.size}/${expectedCount} commits mapped)`;
      allPrWarnings.push(`**Pull Request Overall Diff**:\n- ⚠️ ${warnMsg}`);
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
    if (prWideEnvelopeMatches.length > 1) {
      releaseDetails = ctx.commits.map((c: any) => ({
        commitPatch: splitMap.get(c.sha) || null,
        fullCommit: c
      }));
    } else {
      releaseDetails = [{ commitPatch: prPatch }];
    }
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
        warnings: [`Could not complete package release audit because of an error fetching file content: ${e.message}`],
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
        warnings: [`Could not complete package hash audit because of an error fetching file content: ${e.message}`],
        findings: [] as string[],
        incomplete: true
      };
    });

  for (const [commitIndex, item] of commitDetails.entries()) {
    const { sha, html_url, fullCommit } = item;
    const commitMsgLines = (fullCommit.commit.message || '').split("\n");
    const commitSubject = commitMsgLines[0].trim();

    const reportFormality = await validateFormalities(fullCommit, config);
    formalityOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
    reportFormality.successes.forEach((s: string) => { formalityOutputText += `  ${s}\n`; });

    if (reportFormality.warnings.length > 0) {
      const commentWarnings = reportFormality.warnings.filter((w: string) => 
        !w.includes("No reference link (e.g.") && 
        !w.includes("Commit is unsigned or") &&
        !w.includes("Subject line exceeds soft limit")
      );
      if (commentWarnings.length > 0) {
        allPrWarnings.push(`**Commit [${sha.slice(0, 7)}](${html_url})**:\n` + commentWarnings.map((w: string) => `- ⚠️ ${w}`).join("\n"));
      }
      reportFormality.warnings.forEach((w: string) => { formalityOutputText += `  ⚠️ Warning: ${w}\n`; });
    }

    if (reportFormality.errors.length > 0) {
      allFormalityErrors.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportFormality.errors.join("\n"));
      reportFormality.errors.forEach((err: string) => { formalityOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
    }

    if (isBackportPr) {
      if (!CHERRY_PICK_MARKER.test(fullCommit.commit.message || '')) {
        const isMaintainer = await ctx.isAuthorMaintainer(ctx.bodyRequestsCherryPickBypass);
        const scanResult = await getCommentsScanWithRetry() || { hasBranchBypassComment: false, hasCherryPickBypassComment: false, existingCommentId: null };
        const bypassCherryPickCheck = scanResult.hasCherryPickBypassComment || (ctx.bodyRequestsCherryPickBypass && isMaintainer);

        if (bypassCherryPickCheck) {
          formalityOutputText += "  ⚠️ Commit to stable branch bypasses cherry-pick requirement via override command\n";
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
          formalityOutputText += "  ⚠️ Backport diff deviates from upstream commit. Running validations on deviations only.\n";
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
        const allWarnings = [
          ...(reportMakefile.warnings || []),
          ...(reportUci.warnings || [])
        ];
        if (allWarnings.length > 0) {
          allPrWarnings.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + allWarnings.map((w: string) => `- ⚠️ ${w.replace(/^- /, '')}`).join("\n"));
          allWarnings.forEach((w: string) => { makefileOutputText += `  ⚠️ Warning: ${w.replace(/^- /, '')}\n`; });
        }
        if (reportMakefile.errors.length > 0 || reportUci.errors.length > 0) {
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
          reportPatches.successes.push("✅ Filtered out embedded patch issues already present in upstream commit");
        }

        patchesOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
        reportPatches.successes.forEach((s: string) => { patchesOutputText += `  ${s}\n`; });
        for (const note of reportPatches.skipped) { unreadPatchNotes.add(note); patchesOutputText += `  ${note}\n`; }
        if (reportPatches.warnings && reportPatches.warnings.length > 0) {
          allPrWarnings.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportPatches.warnings.map((w: string) => `- ⚠️ ${w.replace(/^- /, '')}`).join("\n"));
          reportPatches.warnings.forEach((w: string) => { patchesOutputText += `  ⚠️ Warning: ${w.replace(/^- /, '')}\n`; });
        }
        if (reportPatches.errors.length > 0) {
          const isPatchWarning = config.check_patch_headers === 'warning';
          if (isPatchWarning) {
            allPrWarnings.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportPatches.errors.map((e: string) => `- ⚠️ ${e}`).join("\n"));
            reportPatches.errors.forEach((err: string) => { patchesOutputText += `  ⚠️ Warning: ${err.replace(/^- /, '')}\n`; });
          } else {
            allPatchesErrors.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportPatches.errors.join("\n"));
            reportPatches.errors.forEach((err: string) => { patchesOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
          }
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
      ...(reportMakefile.warnings || []),
      ...(reportUci.warnings || [])
    ];
    if (allPrWideWarnings.length > 0) {
      allPrWarnings.push(`**Pull Request Overall Diff**:\n` + allPrWideWarnings.join("\n"));
      allPrWideWarnings.forEach((w: string) => { makefileOutputText += `  ⚠️ Warning: ${w.replace(/^- /, '')}\n`; });
    }
    if (reportMakefile.errors.length > 0 || reportUci.errors.length > 0) {
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
    if (reportPatches.warnings && reportPatches.warnings.length > 0) {
      allPrWarnings.push(`**Pull Request Overall Diff**:\n` + reportPatches.warnings.map((w: string) => `- ⚠️ ${w.replace(/^- /, '')}`).join("\n"));
      reportPatches.warnings.forEach((w: string) => { patchesOutputText += `  ⚠️ Warning: ${w.replace(/^- /, '')}\n`; });
    }
    if (reportPatches.errors.length > 0) {
      const isPatchWarning = config.check_patch_headers === 'warning';
      if (isPatchWarning) {
        allPrWarnings.push(`**Pull Request Overall Diff**:\n` + reportPatches.errors.map((e: string) => `- ⚠️ ${e}`).join("\n"));
        reportPatches.errors.forEach((err: string) => { patchesOutputText += `  ⚠️ Warning: ${err.replace(/^- /, '')}\n`; });
      } else {
        allPatchesErrors.push(`**Pull Request Overall Diff**:\n` + reportPatches.errors.join("\n"));
        reportPatches.errors.forEach((err: string) => { patchesOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
      }
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

  if (reportRelease.successes.length > 0 || reportRelease.errors.length > 0 || (reportRelease.warnings && reportRelease.warnings.length > 0)) {
    makefileOutputText += `#### Package Release Audit:\n`;
    reportRelease.successes.forEach(s => { makefileOutputText += `  ${s}\n`; });
    if (reportRelease.warnings && reportRelease.warnings.length > 0) {
      reportRelease.warnings.forEach(w => {
        makefileOutputText += `  ⚠️ Warning: ${w}\n`;
        allPrWarnings.push(`**Package Release Audit**:\n- ⚠️ ${w}`);
      });
    }
    if (reportRelease.errors.length > 0) {
      const isWarning = config.check_pkg_release === 'warning';
      const bullet = isWarning ? '- ⚠️ ' : '- ';
      const blocks: string[] = [];
      const packages: string[] = [];
      const others: string[] = [];

      for (const err of reportRelease.errors) {
        const match = err.match(MISSING_BUMP_ERROR);
        if (match) {
          packages.push(match[1]);
        } else {
          others.push(err);
        }
      }

      if (packages.length > 0) {
        blocks.push(`${bullet}Content changed in these packages, but without a \`PKG_RELEASE\` or version bump:\n` +
          packages.map(p => `  - \`${p}\``).join("\n") +
          `\n\n  Increment \`PKG_RELEASE\` by 1 (or bump \`PKG_VERSION\`/\`PKG_SOURCE_DATE\` and reset \`PKG_RELEASE\` to 1) so users receive the update.`);
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
        makefileOutputText += `${mark}Content changed in these packages, but without a \`PKG_RELEASE\` or version bump: ${packages.join(', ')}\n`;
        makefileOutputText += `${mark}Increment \`PKG_RELEASE\` by 1 (or bump \`PKG_VERSION\`/\`PKG_SOURCE_DATE\` and reset \`PKG_RELEASE\` to 1) so users receive the update.\n`;
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
    ...reportHashes.warnings.map(w => `- ${w}`),
    ...(config.check_pkg_hash === 'error' ? [] : reportHashes.findings)
  ];
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
    unreadPatchNotes
  };
}
