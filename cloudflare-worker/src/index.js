import { DEFAULT_CONFIG, LABEL_GUIDELINES, LABEL_ADD_PACKAGE, LABEL_DROP_PACKAGE } from './config.js';
import { verifySignature, getInstallationToken } from './crypto.js';
import { githubApiCall, fetchRepositoryConfig } from './github.js';
import { validateFormalities, validateMakefileContext, validateEmbeddedPatches } from './validators.js';

// --- WEBHOOK HANDLER ---
async function handleWebhook(request, env) {
  const payloadText = await request.text();
  const signature = request.headers.get("x-hub-signature-256") || "";

  if (!await verifySignature(payloadText, signature, env.WEBHOOK_SECRET)) {
    return new Response("Invalid signature", { status: 403 });
  }

  const data = JSON.parse(payloadText);
  if (request.headers.get("x-github-event") !== "pull_request") {
    return new Response("Not a pull request event", { status: 200 });
  }

  const action = data.action || '';
  if (!['opened', 'synchronize', 'reopened'].includes(action)) {
    return new Response("Ignored pull request action", { status: 200 });
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

  const installationId = data.installation?.id;
  if (!installationId) {
    return new Response("Missing installation ID", { status: 400 });
  }

  const token = await getInstallationToken(installationId, env.APP_ID, env.PRIVATE_KEY);
  if (!token) {
    return new Response("Could not generate installation access token", { status: 500 });
  }

  const repoFullname = data.repository.full_name;
  const baseBranch = data.pull_request.base.ref;
  const headBranch = data.pull_request.head.ref;
  const prNumber = data.pull_request.number;
  const prTitle = data.pull_request.title;

  const labelsUrl = `https://api.github.com/repos/${repoFullname}/labels`;
  const commitsUrl = data.pull_request.commits_url;

  // OPTIMIZATION: Fetch repository config, repository labels, and commits list in parallel
  const [CONFIG, existingLabelsRes, commitsRes] = await Promise.all([
    fetchRepositoryConfig(data, token, DEFAULT_CONFIG),
    githubApiCall(labelsUrl, token),
    githubApiCall(commitsUrl, token)
  ]);

  const existingLabels = new Set((existingLabelsRes.data || []).map(l => l.name));
  const commits = commitsRes.data || [];

  const allFormalityErrors = [];
  const allPrWarnings = [];
  const allMakefileErrors = [];
  const allPatchesErrors = [];

  let formalityOutputText = `### Checking PR #${prNumber}: ${prTitle} (Formalities Audit)\n\n`;
  let makefileOutputText = `### Checking PR #${prNumber}: ${prTitle} (Makefile Audit Profile)\n\n`;
  let patchesOutputText = `### Checking PR #${prNumber}: ${prTitle} (Embedded Patches Compliance)\n\n`;

  const state = { isNewPackage: false, isDroppedPackage: false };

  if (CONFIG.check_branch) {
    if (['master', 'main', 'stable', 'openwrt-25.12', 'openwrt-24.10'].includes(headBranch)) {
      allFormalityErrors.push(`### PR Targeting Violation\n- Pull requests must originate from a dedicated feature branch. Cannot use \`${headBranch}\` directly.`);
      formalityOutputText += `❌ Pull request must originate from a feature branch\n       Reason: Target branch \`${headBranch}\` used as origin.\n\n`;
    } else {
      formalityOutputText += `✅ Pull request originates from a dedicated feature branch (\`${headBranch}\`)\n\n`;
    }
  }

  // OPTIMIZATION: Fetch details and patches for all commits concurrently using Promise.all
  const commitDetails = await Promise.all(commits.map(async (commitData) => {
    const sha = commitData.sha;
    const detailUrl = `https://api.github.com/repos/${repoFullname}/commits/${sha}`;
    const [detailRes, patchRes] = await Promise.all([
      githubApiCall(detailUrl, token),
      githubApiCall(detailUrl, token, 'GET', null, 'application/vnd.github.patch')
    ]);
    return {
      sha,
      html_url: commitData.html_url || `https://github.com/repos/${repoFullname}/commit/${sha}`,
      fullCommit: detailRes.data,
      commitPatch: patchRes.raw
    };
  }));

  // RUN CHECKS ON COMMITS
  for (const item of commitDetails) {
    const { sha, html_url, fullCommit, commitPatch } = item;
    if (!fullCommit) continue;

    const commitMsgLines = (fullCommit.commit.message || '').split("\n");
    const commitSubject = commitMsgLines[0].trim();

    // 1. Formalities
    const reportFormality = validateFormalities(fullCommit, CONFIG);
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
        allFormalityErrors.push(`**Commit [${sha.slice(0, 7)}](${html_url})**:\n- Backports targeting stable branch (${baseBranch}) must contain the context line: '(cherry picked from commit ...)'`);
        formalityOutputText += "  ❌ Commit to stable branch must be marked as cherry-picked\n";
      } else {
        formalityOutputText += "  ✅ Commit explicitly specifies cherry-pick origin context\n";
      }
    }
    formalityOutputText += "\n";

    // 2. Makefiles
    const reportMakefile = validateMakefileContext(fullCommit, commitPatch, CONFIG, state);
    makefileOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
    reportMakefile.successes.forEach(s => { makefileOutputText += `  ${s}\n`; });
    if (reportMakefile.errors.length > 0) {
      allMakefileErrors.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportMakefile.errors.join("\n"));
      reportMakefile.errors.forEach(err => { makefileOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
    }
    makefileOutputText += "\n";

    // 3. Patches
    const reportPatches = validateEmbeddedPatches(commitPatch, CONFIG);
    patchesOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
    reportPatches.successes.forEach(s => { patchesOutputText += `  ${s}\n`; });
    if (reportPatches.errors.length > 0) {
      allPatchesErrors.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportPatches.errors.join("\n"));
      reportPatches.errors.forEach(err => { patchesOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
    }
    patchesOutputText += "\n";
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
    if (!existingLabels.has(name)) {
      await githubApiCall(labelsUrl, token, 'POST', { name, color, description });
    }
  }

  if (!allPassed) {
    labelOperations.push(ensureLabelExists(LABEL_GUIDELINES, 'e11d48', 'Pull request does not follow formatting guidelines'));
    labelsToAdd.push(LABEL_GUIDELINES);
  } else {
    // Delete validation failure label if present
    labelOperations.push(githubApiCall(`${prLabelUrl}/${encodeURIComponent(LABEL_GUIDELINES)}`, token, 'DELETE'));
  }

  if (CONFIG.add_package_label && state.isNewPackage) {
    labelOperations.push(ensureLabelExists(LABEL_ADD_PACKAGE, '0e7490', 'Introduces a new package Makefile build script'));
    labelsToAdd.push(LABEL_ADD_PACKAGE);
  }

  if (CONFIG.drop_package_label && state.isDroppedPackage) {
    labelOperations.push(ensureLabelExists(LABEL_DROP_PACKAGE, '3b82f6', 'Removes an existing package Makefile from the tracking tree'));
    labelsToAdd.push(LABEL_DROP_PACKAGE);
  }

  if (CONFIG.branch_labeling && /^openwrt-\d{2}\.\d{2}$/.test(baseBranch)) {
    labelOperations.push(ensureLabelExists(baseBranch, '6b7280', `Pull request targets the stable release branch ${baseBranch}`));
    labelsToAdd.push(baseBranch);
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
    const commentsUrl = `https://api.github.com/repos/${repoFullname}/issues/${prNumber}/comments`;
    const resComments = await githubApiCall(commentsUrl, token);
    const commentsList = resComments.data || [];

    let existingCommentId = null;
    commentsList.forEach(c => {
      if (c.body?.startsWith('## Formality Check:')) {
        existingCommentId = c.id;
      }
    });

    if (!formalityPassed || allPrWarnings.length > 0) {
      const titleStatus = !formalityPassed ? "Failed" : "Suggestions Available";
      let commentBody = `## Formality Check: ${titleStatus}\n\n`;
      commentBody += "We completed the verification flow. Please review the formatting overview logs below.\n\n";

      if (!formalityPassed) {
        commentBody += "### 🛑 CRITICAL ERRORS\n";
        allFormalityErrors.forEach(errorBlock => {
          commentBody += "> " + errorBlock.replace(/\n/g, "\n> ") + "\n>\n";
        });
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
        commentPromises.push(githubApiCall(`https://api.github.com/repos/${repoFullname}/issues/comments/${existingCommentId}`, token, 'PATCH', { body: commentBody }));
      } else {
        commentPromises.push(githubApiCall(commentsUrl, token, 'POST', { body: commentBody }));
      }
    } else {
      if (existingCommentId) {
        commentPromises.push(githubApiCall(`https://api.github.com/repos/${repoFullname}/issues/comments/${existingCommentId}`, token, 'DELETE'));
      }
    }
  }

  // Publish Status to Checks API
  const checkRunsUrl = `https://api.github.com/repos/${repoFullname}/check-runs`;
  const headSha = data.pull_request.head.sha;

  const checkRunsPromises = [
    githubApiCall(checkRunsUrl, token, 'POST', {
      name: 'FormalityCheck / Git & Commits', head_sha: headSha, status: 'completed',
      conclusion: formalityPassed ? 'success' : 'failure',
      output: {
        title: formalityPassed ? 'Git & Commits: Passed' : 'Git & Commits: Failed',
        summary: formalityPassed ? 'Git formatting rules and structural boundaries validated successfully.' : 'Structural presentation issues detected.',
        text: formalityOutputText
      }
    }),
    githubApiCall(checkRunsUrl, token, 'POST', {
      name: 'FormalityCheck / OpenWrt Makefiles', head_sha: headSha, status: 'completed',
      conclusion: makefilePassed ? 'success' : 'failure',
      output: {
        title: makefilePassed ? 'OpenWrt Makefiles: Passed' : 'OpenWrt Makefiles: Failed',
        summary: makefilePassed ? 'OpenWrt package guidelines and version criteria verified successfully.' : 'Discovered file validation issues in the changed tracking tree.',
        text: makefileOutputText
      }
    }),
    githubApiCall(checkRunsUrl, token, 'POST', {
      name: 'FormalityCheck / Code Patches', head_sha: headSha, status: 'completed',
      conclusion: patchesPassed ? 'success' : 'failure',
      output: {
        title: patchesPassed ? 'Code Patches: Passed' : 'Code Patches: Failed',
        summary: patchesPassed ? 'All downstream patch files contain correct Git tracking headers.' : 'Discovered malformed downstream patch objects.',
        text: patchesOutputText
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
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    return new Response("Invalid Request", { status: 400 });
  }
};
