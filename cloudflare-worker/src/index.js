import { DEFAULT_CONFIG, LABEL_GUIDELINES, LABEL_ADD_PACKAGE, LABEL_DROP_PACKAGE } from './config.js';
import { verifySignature, getInstallationToken } from './crypto.js';
import { githubApiCall, fetchRepositoryConfig } from './github.js';
import { validateFormalities, validateMakefileContext, validateEmbeddedPatches, validatePkgReleaseBumps } from './validators.js';
import { handleScheduled } from './stale.js';

// --- GITHUB COMMENTS SCANNING AND SEARCH ---
async function scanPrComments(repoFullname, prNumber, token) {
  let page = 1;
  let hasBypassComment = false;
  let existingCommentId = null;

  while (true) {
    const url = `https://api.github.com/repos/${repoFullname}/issues/${prNumber}/comments?per_page=100&page=${page}`;
    const res = await githubApiCall(url, token);
    if (res.code !== 200 || !Array.isArray(res.data)) {
      return null;
    }

    for (const c of res.data) {
      if (c.body?.startsWith('## Formality Check:')) {
        existingCommentId = c.id;
      }
      const assoc = (c.author_association || '').toUpperCase();
      const isCommentMaintainer = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(assoc);
      if (isCommentMaintainer && /\[allow[ -]cherry[ -]pick\]/i.test(c.body || '')) {
        hasBypassComment = true;
      }
    }

    if (hasBypassComment && existingCommentId !== null) {
      break;
    }

    if (res.data.length < 100) {
      break;
    }
    page++;
  }

  return { hasBypassComment, existingCommentId };
}

// --- UTILS ---
function safeTruncate(text, limit = 65000) {
  if (!text) return "";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return text;

  const suffix = "\n\n... [Output truncated due to GitHub character limit] ...";
  const suffixBytes = encoder.encode(suffix);
  const maxContentBytes = limit - suffixBytes.length;

  let truncatedBytes = bytes.slice(0, maxContentBytes);
  let truncatedText = decoder.decode(truncatedBytes);
  if (truncatedText.endsWith("\uFFFD")) {
    truncatedText = truncatedText.slice(0, -1);
  }
  return truncatedText + suffix;
}

// --- WEBHOOK HANDLER ---
async function handleWebhook(request, env) {
  const payloadText = await request.text();
  const signature = request.headers.get("x-hub-signature-256") || "";

  if (!await verifySignature(payloadText, signature, env.WEBHOOK_SECRET)) {
    console.error("Webhook signature verification failed.");
    return new Response("Invalid signature", { status: 403 });
  }

  const data = JSON.parse(payloadText);
  const event = request.headers.get("x-github-event");
  if (event !== "pull_request" && event !== "issue_comment") {
    return new Response("Not a pull request or issue comment event", { status: 200 });
  }

  if (event === "issue_comment") {
    if (data.action !== "created") {
      return new Response("Ignored issue comment action", { status: 200 });
    }

    const commentAssoc = (data.comment?.author_association || '').toUpperCase();
    const isCommentMaintainer = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(commentAssoc);
    if (!isCommentMaintainer) {
      return new Response("Ignored non-maintainer issue comment", { status: 200 });
    }

    if (!data.issue?.pull_request) {
      return new Response("Comment is not on a pull request", { status: 200 });
    }
  } else {
    const action = data.action || '';
    if (!['opened', 'synchronize', 'reopened'].includes(action)) {
      return new Response("Ignored pull request action", { status: 200 });
    }
  }

  const installationId = data.installation?.id;
  if (!installationId) {
    console.error("Webhook processing failed: Missing installation ID in payload.");
    return new Response("Missing installation ID", { status: 400 });
  }

  const token = await getInstallationToken(installationId, env.APP_ID, env.PRIVATE_KEY);
  if (!token) {
    console.error(`Webhook processing failed: Could not generate installation access token for installation ID ${installationId}.`);
    return new Response("Could not generate installation access token", { status: 500 });
  }

  if (event === "issue_comment") {
    const repoFullnameFromPayload = data.repository?.full_name;
    const prNumberFromIssue = data.issue?.number;
    if (!repoFullnameFromPayload || !prNumberFromIssue) {
      console.error(`Webhook processing failed: Missing repository (${repoFullnameFromPayload}) or PR number (${prNumberFromIssue}) in issue_comment payload.`);
      return new Response("Missing repository or pull request number", { status: 400 });
    }

    const prUrl = `https://api.github.com/repos/${repoFullnameFromPayload}/pulls/${prNumberFromIssue}`;
    const prRes = await githubApiCall(prUrl, token);
    if (prRes.code !== 200) {
      throw new Error(`Failed to fetch PR details from ${prUrl} (HTTP ${prRes.code})`);
    }
    data.pull_request = prRes.data;
  }

  const IGNORED_USERS = [
    'dependabot[bot]', 'dependabot', 'weblate',
    'github-actions[bot]', 'github-actions',
    'github-copilot[bot]', 'github-advanced-security[bot]'
  ];
  const prAuthor = data.pull_request?.user?.login || 'unknown';
  const senderType = data.pull_request?.user?.type || 'User';

  if (IGNORED_USERS.map(u => u.toLowerCase()).includes(prAuthor.toLowerCase()) || senderType === 'Bot') {
    return new Response(`Success: Ignored PR from bot/system user (@${prAuthor})`, { status: 200 });
  }



  const repoFullname = data.repository.full_name;
  const baseBranch = data.pull_request.base.ref;
  const headBranch = data.pull_request.head.ref;
  const prNumber = data.pull_request.number;
  const prTitle = data.pull_request.title;

  const labelsUrl = `https://api.github.com/repos/${repoFullname}/labels`;
  const commitsUrl = data.pull_request.commits_url;

  const commitsCount = data.pull_request.commits || 1;
  const pages = Math.ceil(commitsCount / 100);
  const commitsPromises = [];
  for (let p = 1; p <= Math.min(pages, 3); p++) {
    commitsPromises.push(githubApiCall(`${commitsUrl}?per_page=100&page=${p}`, token));
  }

  // OPTIMIZATION: Fetch repository config, first page of repository labels, and commits list pages in parallel
  const [CONFIG, firstLabelsRes, ...commitsResList] = await Promise.all([
    fetchRepositoryConfig(data, token, DEFAULT_CONFIG),
    githubApiCall(`${labelsUrl}?per_page=100&page=1`, token),
    ...commitsPromises
  ]);

  if (firstLabelsRes.code !== 200) {
    const cleanRaw = (firstLabelsRes.raw || "").trim().slice(0, 200);
    throw new Error(`GitHub API returned HTTP ${firstLabelsRes.code} when fetching repository labels: ${cleanRaw}`);
  }

  if (!Array.isArray(firstLabelsRes.data)) {
    throw new Error(`Expected repository labels (page 1) to be an array, but received: ${typeof firstLabelsRes.data}`);
  }
  const firstPageLabels = firstLabelsRes.data;
  const allLabels = [...firstPageLabels];
  if (firstPageLabels.length === 100) {
    let page = 2;
    while (true) {
      const res = await githubApiCall(`${labelsUrl}?per_page=100&page=${page}`, token);
      if (res.code !== 200) {
        const cleanRaw = (res.raw || "").trim().slice(0, 200);
        throw new Error(`GitHub API returned HTTP ${res.code} when fetching repository labels (page ${page}): ${cleanRaw}`);
      }
      if (!Array.isArray(res.data)) {
        throw new Error(`Expected repository labels (page ${page}) to be an array, but received: ${typeof res.data}`);
      }
      allLabels.push(...res.data);
      if (res.data.length < 100) {
        break;
      }
      page++;
    }
  }

  const existingLabels = new Set(allLabels.map(l => l.name.toLowerCase()));
  
  let commits = [];
  for (let i = 0; i < commitsResList.length; i++) {
    const res = commitsResList[i];
    if (res.code !== 200) {
      const cleanRaw = (res.raw || "").trim().slice(0, 200);
      throw new Error(`GitHub API returned HTTP ${res.code} when fetching commits list page ${i + 1}: ${cleanRaw}`);
    }
    commits = commits.concat(res.data || []);
  }

  let fetchCommentsPromise = null;
  let fetchCommentsRetried = false;
  const getCommentsScan = () => {
    if (fetchCommentsPromise === null) {
      fetchCommentsPromise = scanPrComments(repoFullname, prNumber, token).catch(() => null);
    }
    return fetchCommentsPromise;
  };

  const getCommentsScanWithRetry = async () => {
    const result = await getCommentsScan();
    if (result !== null || fetchCommentsRetried) {
      return result;
    }
    fetchCommentsRetried = true;
    fetchCommentsPromise = null;
    return getCommentsScan();
  };

  if (CONFIG.enable_comments || /^(stable|openwrt-)/.test(baseBranch)) {
    void getCommentsScan();
  }

  if (!Array.isArray(commits)) {
    throw new Error(`Expected commits list to be an array, but received: ${typeof commits}`);
  }

  const allFormalityErrors = [];
  const allPrWarnings = [];
  const allMakefileErrors = [];
  const allPatchesErrors = [];

  let formalityOutputText = `### Checking PR #${prNumber}: ${prTitle} (Formalities Audit)\n\n`;
  let makefileOutputText = `### Checking PR #${prNumber}: ${prTitle} (Makefile Audit Profile)\n\n`;
  let patchesOutputText = `### Checking PR #${prNumber}: ${prTitle} (Embedded Patches Compliance)\n\n`;

  if (pages > 3) {
    const cappedWarning = `Commit scan is capped at 300 commits for API safety. This PR has ${commitsCount} commits, so only the first 300 commit messages were audited.`;
    formalityOutputText += `⚠️ Warning: ${cappedWarning}\n\n`;
    allPrWarnings.push(`**Commit Audit Scope**:\n- ⚠️ ${cappedWarning}`);
  }

  const state = { isNewPackage: false, isDroppedPackage: false };

  const prBody = data.pull_request.body || '';
  const association = (data.pull_request.author_association || 'NONE').toUpperCase();
  const isMaintainer = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association);

  if (CONFIG.check_branch) {
    if (['master', 'main', 'stable', 'openwrt-25.12', 'openwrt-24.10'].includes(headBranch)) {
      allFormalityErrors.push(`### PR Targeting Violation\n- Pull requests must originate from a dedicated feature branch. Cannot use \`${headBranch}\` directly.`);
      formalityOutputText += `❌ Pull request must originate from a feature branch\n       Reason: Target branch \`${headBranch}\` used as origin.\n\n`;
    } else {
      formalityOutputText += `✅ Pull request originates from a dedicated feature branch (\`${headBranch}\`)\n\n`;
    }
  }

  const usePrWidePatch = commits.length > 15;
  let prPatch = null;

  if (usePrWidePatch) {
    const prPatchUrl = data.pull_request.url;
    const prPatchRes = await githubApiCall(prPatchUrl, token, 'GET', null, 'application/vnd.github.patch');
    if (prPatchRes.code !== 200) {
      const cleanRaw = (prPatchRes.raw || "").trim().slice(0, 200);
      throw new Error(`Failed to fetch overall PR patch (HTTP ${prPatchRes.code}): ${cleanRaw}`);
    }
    prPatch = prPatchRes.raw;
  }

  // OPTIMIZATION: Fetch patches for all commits concurrently using Promise.all (only if usePrWidePatch is false)
  // We reuse the commit metadata (fullCommit) from the commits list response to save 1 subrequest per commit
  const commitDetails = await Promise.all(commits.map(async (commitData) => {
    const commitItemType = (commitData === null)
      ? 'null'
      : (Array.isArray(commitData) ? 'array' : typeof commitData);
    if (!commitData || commitItemType !== 'object') {
      throw new Error(`Expected commit item in PR commits list to be an object, but got: ${commitItemType}`);
    }
    const sha = commitData.sha;
    if (!sha) {
      const cleanResp = JSON.stringify(commitData).slice(0, 200);
      throw new Error(`Commit item is missing 'sha' property. Response: ${cleanResp}`);
    }
    if (!commitData.commit) {
      const cleanResp = JSON.stringify(commitData).slice(0, 200);
      throw new Error(`Commit object is missing '.commit' metadata for SHA ${sha}. Response: ${cleanResp}`);
    }

    let commitPatch = null;
    if (!usePrWidePatch) {
      const detailUrl = `https://api.github.com/repos/${repoFullname}/commits/${sha}`;
      const patchRes = await githubApiCall(detailUrl, token, 'GET', null, 'application/vnd.github.patch');

      if (patchRes.code !== 200) {
        const cleanRaw = (patchRes.raw || "").trim().slice(0, 200);
        throw new Error(`Failed to fetch commit patch for SHA ${sha} (HTTP ${patchRes.code}): ${cleanRaw}`);
      }
      commitPatch = patchRes.raw;
    }

    return {
      sha,
      html_url: commitData.html_url || `https://github.com/${repoFullname}/commit/${sha}`,
      fullCommit: commitData,
      commitPatch
    };
  }));

  // Pre-scan all commit patches to see if this PR introduces or drops any package Makefiles
  if (!usePrWidePatch) {
    for (const item of commitDetails) {
      if (item.commitPatch) {
        if (/^---\s+\/dev\/null\r?\n\+\+\+\s+b\/(?:.*\/)?Makefile\r?$/m.test(item.commitPatch)) {
          state.isNewPackage = true;
        }
        if (/^---\s+a\/(?:.*\/)?Makefile\r?\n\+\+\+\s+\/dev\/null\r?$/m.test(item.commitPatch)) {
          state.isDroppedPackage = true;
        }
      }
    }
  } else {
    if (prPatch) {
      if (/^---\s+\/dev\/null\r?\n\+\+\+\s+b\/(?:.*\/)?Makefile\r?$/m.test(prPatch)) {
        state.isNewPackage = true;
      }
      if (/^---\s+a\/(?:.*\/)?Makefile\r?\n\+\+\+\s+\/dev\/null\r?$/m.test(prPatch)) {
        state.isDroppedPackage = true;
      }
    }
  }

  // RUN CHECKS ON COMMITS
  for (const item of commitDetails) {
    const { sha, html_url, fullCommit, commitPatch } = item;

    const commitMsgLines = (fullCommit.commit.message || '').split("\n");
    const commitSubject = commitMsgLines[0].trim();

    // 1. Formalities
    const reportFormality = await validateFormalities(fullCommit, CONFIG);
    formalityOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
    reportFormality.successes.forEach(s => { formalityOutputText += `  ${s}\n`; });

    if (reportFormality.warnings.length > 0) {
      const commentWarnings = reportFormality.warnings.filter(w => 
        !w.includes("No reference link (e.g.") && 
        !w.includes("Commit is unsigned or") &&
        !w.includes("Subject line exceeds soft limit")
      );
      if (commentWarnings.length > 0) {
        allPrWarnings.push(`**Commit [${sha.slice(0, 7)}](${html_url})**:\n` + commentWarnings.map(w => `- ⚠️ ${w}`).join("\n"));
      }
      reportFormality.warnings.forEach(w => { formalityOutputText += `  ⚠️ Warning: ${w}\n`; });
    }

    if (reportFormality.errors.length > 0) {
      allFormalityErrors.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportFormality.errors.join("\n"));
      reportFormality.errors.forEach(err => { formalityOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
    }

    if (/^(stable|openwrt-)/.test(baseBranch)) {
      if (!(fullCommit.commit.message || '').toLowerCase().includes('cherry picked from')) {
        const scanResult = await getCommentsScanWithRetry() || { hasBypassComment: false, existingCommentId: null };
        const bypassCherryPickCheck = scanResult.hasBypassComment || (isMaintainer && /\[allow[ -]cherry[ -]pick\]/i.test(prBody));

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
      }
    }
    formalityOutputText += "\n";

    // 2. Makefiles
    if (!usePrWidePatch) {
      const reportMakefile = validateMakefileContext(fullCommit, commitPatch, CONFIG, state);
      makefileOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
      reportMakefile.successes.forEach(s => { makefileOutputText += `  ${s}\n`; });
      if (reportMakefile.errors.length > 0) {
        allMakefileErrors.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportMakefile.errors.join("\n"));
        reportMakefile.errors.forEach(err => { makefileOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
      }
      makefileOutputText += "\n";
    }

    // 3. Patches
    if (!usePrWidePatch) {
      const fetchFileContent = async (patchFile) => {
        const url = `https://api.github.com/repos/${repoFullname}/contents/${patchFile}?ref=${sha}`;
        const res = await githubApiCall(url, token, 'GET', null, 'application/vnd.github.raw');
        return res.code === 200 ? res.raw : null;
      };
      const reportPatches = await validateEmbeddedPatches(commitPatch, CONFIG, fetchFileContent);
      patchesOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
      reportPatches.successes.forEach(s => { patchesOutputText += `  ${s}\n`; });
      if (reportPatches.errors.length > 0) {
        allPatchesErrors.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportPatches.errors.join("\n"));
        reportPatches.errors.forEach(err => { patchesOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
      }
      patchesOutputText += "\n";
    }
  }

  if (usePrWidePatch && prPatch) {
    const virtualCommit = {
      commit: {
        message: data.pull_request.title + "\n" + commits.map(c => c.commit.message || '').join("\n")
      }
    };

    // 2. Makefiles (PR-Wide)
    const reportMakefile = validateMakefileContext(virtualCommit, prPatch, CONFIG, state);
    makefileOutputText += `#### Pull Request Overall Diff:\n`;
    reportMakefile.successes.forEach(s => { makefileOutputText += `  ${s}\n`; });
    if (reportMakefile.errors.length > 0) {
      allMakefileErrors.push(`**Pull Request Overall Diff**:\n` + reportMakefile.errors.join("\n"));
      reportMakefile.errors.forEach(err => { makefileOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
    }
    makefileOutputText += "\n";

    // 3. Patches (PR-Wide)
    const fetchFileContent = async (patchFile) => {
      const url = `https://api.github.com/repos/${repoFullname}/contents/${patchFile}?ref=${data.pull_request.head.sha}`;
      const res = await githubApiCall(url, token, 'GET', null, 'application/vnd.github.raw');
      return res.code === 200 ? res.raw : null;
    };
    const reportPatches = await validateEmbeddedPatches(prPatch, CONFIG, fetchFileContent);
    patchesOutputText += `#### Pull Request Overall Diff:\n`;
    reportPatches.successes.forEach(s => { patchesOutputText += `  ${s}\n`; });
    if (reportPatches.errors.length > 0) {
      allPatchesErrors.push(`**Pull Request Overall Diff**:\n` + reportPatches.errors.join("\n"));
      reportPatches.errors.forEach(err => { patchesOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
    }
    patchesOutputText += "\n";
  }

  // 4. Package Release Bumps (PR-wide audit)
  const headSha = data.pull_request.head.sha;
  const baseSha = data.pull_request.base.sha;

  const fetchFileContentAtHead = async (path) => {
    const url = `https://api.github.com/repos/${repoFullname}/contents/${path}?ref=${headSha}`;
    const res = await githubApiCall(url, token, 'GET', null, 'application/vnd.github.raw');
    return res.code === 200 ? res.raw : null;
  };

  const fetchFileContentAtBase = async (path) => {
    const url = `https://api.github.com/repos/${repoFullname}/contents/${path}?ref=${baseSha}`;
    const res = await githubApiCall(url, token, 'GET', null, 'application/vnd.github.raw');
    return res.code === 200 ? res.raw : null;
  };

  const releaseDetails = usePrWidePatch 
    ? [{ commitPatch: prPatch }] 
    : commitDetails;

  const reportRelease = await validatePkgReleaseBumps(releaseDetails, CONFIG, fetchFileContentAtHead, fetchFileContentAtBase);
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
      const isWarning = CONFIG.check_pkg_release === 'warning';
      if (isWarning) {
        allPrWarnings.push(`**Package Release Audit**:\n` + reportRelease.errors.map(e => `- ⚠️ ${e}`).join("\n"));
        reportRelease.errors.forEach(err => { makefileOutputText += `  ⚠️ Warning: ${err}\n`; });
      } else {
        allMakefileErrors.push(`**Package Release Audit**:\n` + reportRelease.errors.map(e => `- ${e}`).join("\n"));
        reportRelease.errors.forEach(err => { makefileOutputText += `  ❌ ${err}\n`; });
      }
    }
    makefileOutputText += "\n";
  }

  const formalityPassed = allFormalityErrors.length === 0;
  const makefilePassed = allMakefileErrors.length === 0;
  const patchesPassed = allPatchesErrors.length === 0;
  const allPassed = formalityPassed && makefilePassed && patchesPassed;

  // OPTIMIZATION: Manage labels in single batch, check existence locally
  const prLabelUrl = `https://api.github.com/repos/${repoFullname}/issues/${prNumber}/labels`;
  const labelsToAdd = [];
  const labelOperations = [];

  async function ensureLabelExists(name, color, description) {
    if (!existingLabels.has(name.toLowerCase())) {
      await githubApiCall(labelsUrl, token, 'POST', { name, color, description });
    }
  }

  const currentPrLabels = new Set((data.pull_request?.labels || []).map(l => l.name.toLowerCase()));

  if (!allPassed) {
    if (!currentPrLabels.has(LABEL_GUIDELINES.toLowerCase())) {
      labelOperations.push(ensureLabelExists(LABEL_GUIDELINES, 'e11d48', 'Pull request does not follow formatting guidelines'));
      labelsToAdd.push(LABEL_GUIDELINES);
    }
  } else {
    // Delete validation failure label if present
    if (currentPrLabels.has(LABEL_GUIDELINES.toLowerCase())) {
      labelOperations.push(githubApiCall(`${prLabelUrl}/${encodeURIComponent(LABEL_GUIDELINES)}`, token, 'DELETE'));
    }
  }

  if (CONFIG.add_package_label && state.isNewPackage && !currentPrLabels.has(LABEL_ADD_PACKAGE.toLowerCase())) {
    labelOperations.push(ensureLabelExists(LABEL_ADD_PACKAGE, '0e7490', 'Introduces a new package Makefile build script'));
    labelsToAdd.push(LABEL_ADD_PACKAGE);
  }

  if (CONFIG.drop_package_label && state.isDroppedPackage && !currentPrLabels.has(LABEL_DROP_PACKAGE.toLowerCase())) {
    labelOperations.push(ensureLabelExists(LABEL_DROP_PACKAGE, '3b82f6', 'Removes an existing package Makefile from the tracking tree'));
    labelsToAdd.push(LABEL_DROP_PACKAGE);
  }

  if (CONFIG.branch_labeling && /^openwrt-\d{2}\.\d{2}$/.test(baseBranch)) {
    const version = baseBranch.split('-')[1];
    const labelName = `release/${version}`;
    if (!currentPrLabels.has(labelName.toLowerCase())) {
      labelOperations.push(ensureLabelExists(labelName, '6b7280', `Pull request targets the stable release branch ${labelName}`));
      labelsToAdd.push(labelName);
    }
  }

  // Pre-create any missing repository labels in parallel
  await Promise.all(labelOperations);

  // Apply all relevant labels to the PR in one API call
  if (labelsToAdd.length > 0) {
    await githubApiCall(prLabelUrl, token, 'POST', { labels: labelsToAdd });
  }

  // PR Comment Management
  const commentPromises = [];
  if (CONFIG.enable_comments) {
    const scanResult = await getCommentsScanWithRetry();
    const fetchSucceeded = scanResult !== null;

    if (fetchSucceeded) {
      const commentsUrl = `https://api.github.com/repos/${repoFullname}/issues/${prNumber}/comments`;
      const existingCommentId = scanResult.existingCommentId;

      if (!allPassed || allPrWarnings.length > 0) {
        const titleStatus = !allPassed ? "Failed" : "Suggestions Available";
        let commentBody = `## Formality Check: ${titleStatus}\n\n`;
        commentBody += "We completed the verification flow. Please review the formatting overview logs below.\n\n";

        if (!allPassed) {
          commentBody += "### 🛑 CRITICAL ERRORS\n";
          
          if (!formalityPassed) {
            allFormalityErrors.forEach(errorBlock => {
              commentBody += "> " + errorBlock.replace(/\n/g, "\n> ") + "\n>\n";
            });
          }
          if (!makefilePassed) {
            allMakefileErrors.forEach(errorBlock => {
              commentBody += "> " + errorBlock.replace(/\n/g, "\n> ") + "\n>\n";
            });
          }
          if (!patchesPassed) {
            allPatchesErrors.forEach(errorBlock => {
              commentBody += "> " + errorBlock.replace(/\n/g, "\n> ") + "\n>\n";
            });
          }
        }

        if (allPrWarnings.length > 0) {
          commentBody += "### ⚠️ STYLISTIC WARNINGS & SUGGESTIONS\n";
          allPrWarnings.forEach(warnBlock => {
            commentBody += "> " + warnBlock.replace(/\n/g, "\n> ") + "\n>\n";
          });
        }

        // Add feedback link & version footer
        let footerMd = `\n\n---\n<sub>Something broken? Consider [reporting an issue](https://github.com/openwrt/openwrt-bot-worker/issues/new).</sub>`;

        if (env.DEPLOY_HASH && env.DEPLOY_HASH !== 'unknown') {
          const shortHash = env.DEPLOY_HASH.slice(0, 7);
          let versionInfo = `Running version [\`${shortHash}\`](https://github.com/openwrt/openwrt-bot-worker/commit/${env.DEPLOY_HASH})`;
          if (env.DEPLOY_DATE && env.DEPLOY_DATE !== 'unknown') {
            versionInfo += ` deployed on ${env.DEPLOY_DATE}`;
          }
          footerMd += `<br><sub>_${versionInfo}_</sub>`;
        }

        commentBody += footerMd;

        if (existingCommentId) {
          commentPromises.push(githubApiCall(`https://api.github.com/repos/${repoFullname}/issues/comments/${existingCommentId}`, token, 'PATCH', { body: safeTruncate(commentBody) }));
        } else {
          commentPromises.push(githubApiCall(commentsUrl, token, 'POST', { body: safeTruncate(commentBody) }));
        }
      } else {
        if (existingCommentId) {
          commentPromises.push(githubApiCall(`https://api.github.com/repos/${repoFullname}/issues/comments/${existingCommentId}`, token, 'DELETE'));
        }
      }
    }
  }

  // Publish Status to Checks API
  const checkRunsUrl = `https://api.github.com/repos/${repoFullname}/check-runs`;

  const checkRunsPromises = [
    githubApiCall(checkRunsUrl, token, 'POST', {
      name: 'FormalityCheck / Git & Commits', head_sha: headSha, status: 'completed',
      conclusion: formalityPassed ? 'success' : 'failure',
      output: {
        title: formalityPassed ? 'Git & Commits: Passed' : 'Git & Commits: Failed',
        summary: formalityPassed ? 'Git formatting rules and structural boundaries validated successfully.' : 'Structural presentation issues detected.',
        text: safeTruncate(formalityOutputText)
      }
    }),
    githubApiCall(checkRunsUrl, token, 'POST', {
      name: 'FormalityCheck / OpenWrt Makefiles', head_sha: headSha, status: 'completed',
      conclusion: makefilePassed ? 'success' : 'failure',
      output: {
        title: makefilePassed ? 'OpenWrt Makefiles: Passed' : 'OpenWrt Makefiles: Failed',
        summary: makefilePassed ? 'OpenWrt package guidelines and version criteria verified successfully.' : 'Discovered file validation issues in the changed tracking tree.',
        text: safeTruncate(makefileOutputText)
      }
    }),
    githubApiCall(checkRunsUrl, token, 'POST', {
      name: 'FormalityCheck / Code Patches', head_sha: headSha, status: 'completed',
      conclusion: patchesPassed ? 'success' : 'failure',
      output: {
        title: patchesPassed ? 'Code Patches: Passed' : 'Code Patches: Failed',
        summary: patchesPassed ? 'All downstream patch files contain correct Git tracking headers.' : 'Discovered malformed downstream patch objects.',
        text: safeTruncate(patchesOutputText)
      }
    })
  ];

  // OPTIMIZATION: Wait for comments, check runs, and PR labeling updates to publish concurrently
  await Promise.all([...commentPromises, ...checkRunsPromises]);

  return new Response(`Success: Processed check runs for PR #${prNumber}`, { status: 200 });
}

// --- FETCH ENTRYPOINT ---
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/webhook") {
        return await handleWebhook(request, env);
      }

      return new Response("Invalid Request", { status: 400 });
    } catch (rawError) {
      console.error("Webhook processing failed:", rawError);
      let error;
      if (rawError instanceof Error) {
        error = rawError;
      } else {
        const msg = rawError && typeof rawError === 'object' && rawError.message
          ? String(rawError.message)
          : String(rawError);
        error = new Error(msg);
        if (rawError && typeof rawError === 'object') {
          error.name = rawError.name || error.name;
          error.stack = rawError.stack || error.stack;
        }
      }

      const errorDetails = {
        name: error.name || "Error",
        message: error.message || String(error),
        timestamp: Date.now()
      };
      return new Response(JSON.stringify({
        exception: errorDetails,
        message: errorDetails.message
      }, null, 2), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  }
};
