import { DEFAULT_CONFIG, LABEL_GUIDELINES, LABEL_ADD_PACKAGE, LABEL_DROP_PACKAGE } from './config.js';
import { parseYaml, getLabelsForChangedFiles, getAllChangedFiles } from './labeler.js';
import { verifySignature, getInstallationToken } from './crypto.js';
import { githubApiCall, graphqlBatchFetchFiles, graphqlFetchRepoLabels, graphqlFetchRepoSetup, ensureLabelExists, fetchUserRepoPermission } from './github.js';
import { validateFormalities, validateMakefileContext, validateEmbeddedPatches, validatePkgReleaseBumps, validateUciConfigs, groupReleaseErrors, MISSING_BUMP_ERROR, MISSING_BUMP_SUMMARY, MISSING_BUMP_ACTION } from './validators.js';
import { handleScheduled } from './stale.js';
import { handleIssueLabeller, applyIssueLabelling, parseIssueLabellerYaml, isOwnAppComment, DEFAULT_ISSUE_LABELLER_CONFIG } from './issue-labeller.js';

// --- GITHUB COMMENTS SCANNING AND SEARCH ---
// Head branches that must not be used as the origin of a pull request. The
// release branches are matched by shape (openwrt-24.10, openwrt-25.12, ...)
// so a new release does not need a code change here.
const PROTECTED_HEAD_BRANCH_NAMES = ['master', 'main', 'stable'];
function isProtectedHeadBranch(branch) {
  return PROTECTED_HEAD_BRANCH_NAMES.includes(branch) || /^openwrt-\d{2}\.\d{2}$/.test(branch);
}

// author_association values that identify a maintainer on their own. Anything
// else needs the repository permission lookup (see createMaintainerResolver).
const MAINTAINER_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

// Override commands, recognized both in the PR description and in comments.
const ALLOW_BRANCH_PATTERN = /\[allow[ -]branch\]/i;
const ALLOW_CHERRY_PICK_PATTERN = /\[allow[ -]cherry[ -]pick\]/i;

// `git cherry-pick -x` records the origin as `(cherry picked from commit
// <sha>)`; hand-written messages sometimes hyphenate the words. Both count,
// but the sha must be present - prose like "cherry picked from master"
// identifies no commit to compare against. One pattern serves the backport
// formality check and the upstream lookup, so a marker the lookup understands
// can never fail the formality check again.
const CHERRY_PICK_MARKER = /cherry[ -]picked from commit ([0-9a-fA-F]{7,40})/i;

// Bots never act as maintainers here, whatever access they hold on the
// repository: this app's own formality reports quote the override commands
// back at the PR, so honoring a bot comment would let it re-trigger itself.
function isBotUser(user) {
  const login = user?.login;
  return user?.type === 'Bot' || (!!login && login.toLowerCase().endsWith('[bot]'));
}

// GitHub reports author_association CONTRIBUTOR (or NONE) for maintainers who
// keep their organization membership private, which would lock them out of the
// override commands. Fall back to the repository permission they actually hold.
// Answers are memoized per request: the same login shows up as PR author and as
// comment author, and every lookup costs a subrequest.
function createMaintainerResolver(repoFullname, token, subrequestBudget) {
  const cache = new Map();
  let budgetWarned = false;

  return async function isMaintainerUser(user, association) {
    if (isBotUser(user)) {
      return false;
    }
    if (MAINTAINER_ASSOCIATIONS.includes((association || '').toUpperCase())) {
      return true;
    }
    // Nothing left to ask about: the fallback is keyed on the login.
    const login = user?.login;
    if (!login) {
      return false;
    }
    // GitHub logins are case-insensitive, and the same user can reach us with
    // different casing across payloads, so memoize on a normalized key. The
    // lookup itself keeps the login as written.
    const cacheKey = login.toLowerCase();
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }
    // Leave the reserve untouched so the terminal writes (labels, PR comment,
    // check-runs) at the end of the handler always have headroom left.
    if (subrequestBudget.limit - subrequestBudget.reserve - subrequestBudget.used <= 0) {
      if (!budgetWarned) {
        budgetWarned = true;
        console.warn(`Subrequest budget exhausted (used ${subrequestBudget.used}/${subrequestBudget.limit}, ${subrequestBudget.reserve} reserved): permission lookups skipped, maintainers outside the organization are treated as contributors.`);
      }
      return false;
    }
    // Cache the pending promise, not the result, so concurrent questions about
    // the same login share a single lookup.
    const pending = fetchUserRepoPermission(repoFullname, login, token, () => { subrequestBudget.used++; })
      .then(hasWriteAccess => {
        // A failed lookup is not evidence of missing access, so it must not
        // stick: drop it and let a later question about the same login retry.
        if (hasWriteAccess === null) {
          cache.delete(cacheKey);
          return false;
        }
        return hasWriteAccess;
      });
    cache.set(cacheKey, pending);
    return pending;
  };
}

// Parses an env var as an integer, falling back to `fallback` only when the
// value is unset/unparseable — unlike `parseInt(x, 10) || fallback`, this
// correctly honors an explicitly configured 0 instead of treating it the
// same as "not set".
function parseEnvInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

async function scanPrComments(repoFullname, prNumber, token, onCall, isMaintainerUser, appId) {
  let page = 1;
  let hasCherryPickBypassComment = false;
  let hasBranchBypassComment = false;
  let existingCommentId = null;

  while (true) {
    const url = `https://api.github.com/repos/${repoFullname}/issues/${prNumber}/comments?per_page=100&page=${page}`;
    onCall?.();
    const res = await githubApiCall(url, token);
    if (res.code !== 200 || !Array.isArray(res.data)) {
      return null;
    }

    for (const c of res.data) {
      // Only adopt a comment this app wrote itself: matching on the header text
      // alone would let anyone — another bot included — plant a comment this
      // bot then edits or deletes (see isOwnAppComment).
      if (isOwnAppComment(c, appId) && c.body?.startsWith('## Formality Check:')) {
        existingCommentId = c.id;
      }
      const body = c.body || '';
      const hasCherryPickPattern = ALLOW_CHERRY_PICK_PATTERN.test(body);
      const hasBranchPattern = ALLOW_BRANCH_PATTERN.test(body);

      // Only comments that actually carry an override command are worth
      // resolving: for anyone outside the org that costs an extra subrequest.
      if ((hasCherryPickPattern || hasBranchPattern) && await isMaintainerUser(c.user, c.author_association)) {
        if (hasCherryPickPattern) hasCherryPickBypassComment = true;
        if (hasBranchPattern) hasBranchBypassComment = true;
      }
    }

    if (hasCherryPickBypassComment && hasBranchBypassComment && existingCommentId !== null) {
      break;
    }

    if (res.data.length < 100) {
      break;
    }
    page++;
  }

  return { hasCherryPickBypassComment, hasBranchBypassComment, existingCommentId };
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

// --- UTILS FOR BACKPORTS ---
function getDiffFromPatch(patchText) {
  if (!patchText) return '';
  const idx = patchText.indexOf('diff --git ');
  return idx === -1 ? '' : patchText.slice(idx);
}

function normalizeDiff(diffText) {
  return (diffText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function getCommitMessageFromPatch(patch) {
  if (!patch) return '';
  const lines = patch.split('\n');
  let subject = '';
  const bodyLines = [];
  let foundSubject = false;
  let inBody = false;
  
  for (const line of lines) {
    if (line.startsWith('Subject: ')) {
      subject = line.slice(9).replace(/^\[PATCH\]\s*/i, '');
      foundSubject = true;
      inBody = true;
      continue;
    }
    if (foundSubject) {
      if (line.startsWith('---')) {
        break;
      }
      if (inBody) {
        bodyLines.push(line);
      }
    }
  }
  return (subject + '\n' + bodyLines.join('\n')).trim();
}

function getChangedFilesFromPatch(patch) {
  if (!patch) return [];
  const files = [];
  const lines = patch.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      files.push(line.slice(6).trim().replace(/\r$/, ''));
    }
  }
  return files;
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
  if (event !== "pull_request" && event !== "issue_comment" && event !== "issues") {
    return new Response("Not a pull request or issue comment event", { status: 200 });
  }

  if (event === "issue_comment") {
    if (data.action !== "created") {
      return new Response("Ignored issue comment action", { status: 200 });
    }

    if (!data.issue?.pull_request) {
      return new Response("Comment is not on a pull request", { status: 200 });
    }

    // Drop bot comments before minting an installation token: they can never
    // be a maintainer action (see isBotUser), and on a busy repository they
    // are the bulk of the comment traffic.
    if (isBotUser(data.comment?.user)) {
      return new Response("Ignored non-maintainer issue comment", { status: 200 });
    }
  } else if (event === "issues") {
    // "edited" matters here: the triage comment tells the reporter what to fix,
    // and the fix arrives as an edit of the issue body. Re-running on it is what
    // lets the comment and the invalid label clear themselves.
    const action = data.action || '';
    if (!['opened', 'edited', 'reopened'].includes(action)) {
      return new Response("Ignored issues action", { status: 200 });
    }
    // The labeller reads form fields out of the issue body, so an edit that
    // did not touch the body (title fixups are the common case) cannot change
    // any verdict. Skipping here saves every API call, token minting included.
    if (action === 'edited' && !data.changes?.body) {
      return new Response("Issue edit did not change the body", { status: 200 });
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

  // The app's own numeric id, used to recognize comments this app posted
  // (REST returns it as performed_via_github_app.id on each comment).
  const appId = Number(env.APP_ID) || null;

  const token = await getInstallationToken(installationId, env.APP_ID, env.PRIVATE_KEY);
  if (!token) {
    console.error(`Webhook processing failed: Could not generate installation access token for installation ID ${installationId}.`);
    return new Response("Could not generate installation access token", { status: 500 });
  }

  const repoFullname = data.repository?.full_name;
  if (!repoFullname) {
    console.error("Webhook processing failed: Missing repository full name in payload.");
    return new Response("Missing repository", { status: 400 });
  }

  // --- ISSUES EVENT: Issue Labeller ---
  if (event === "issues") {
    // Both config files live in the same repo at the same ref, so one batched
    // GraphQL query fetches them together instead of two REST round trips.
    const defaultBranch = data.repository.default_branch || "main";
    const configFiles = await graphqlBatchFetchFiles(token, [
      { key: 'config', repoFullname, ref: defaultBranch, path: '.github/formalities.json' },
      { key: 'labeller', repoFullname, ref: defaultBranch, path: '.github/issue-labeller.yml' }
    ]);
    const configRes = configFiles.get('config');
    if (configRes?.error) {
      throw new Error(`Failed to fetch repository config for issue labeller: ${configRes.error.message}`);
    }
    let issueConfig = DEFAULT_CONFIG;
    if (configRes?.content) {
      try {
        const repoConfig = JSON.parse(configRes.content);
        if (repoConfig && typeof repoConfig === 'object') {
          issueConfig = { ...DEFAULT_CONFIG, ...repoConfig };
        }
      } catch (e) { /* malformed config file falls back to the defaults */ }
    }
    if (!issueConfig.enable_issue_labeller) {
      return new Response("Issue labeller disabled for this repository", { status: 200 });
    }

    const labellerFile = configFiles.get('labeller');
    const labellerConfig = (labellerFile && !labellerFile.error && labellerFile.content)
      ? (parseIssueLabellerYaml(labellerFile.content) || DEFAULT_ISSUE_LABELLER_CONFIG)
      : DEFAULT_ISSUE_LABELLER_CONFIG;

    const labelling = await handleIssueLabeller(data, token, labellerConfig, repoFullname);
    const currentIssueLabels = new Set((data.issue.labels || []).map(l => (typeof l === "string" ? l : l.name).toLowerCase()));

    // The repository label listing exists only to know which labels must be
    // created first. Most events end with nothing to add (already-triaged
    // issues, title edits, unmatched forms), so fetch the listing only when a
    // label actually needs to go on — and labelling must survive the listing
    // failing, so fall back to blind creates (see ensureLabelExists) then.
    const needsLabelCreation = labelling.labelsToAdd.some(l => !currentIssueLabels.has(l.toLowerCase()));
    const existingLabels = needsLabelCreation
      ? await graphqlFetchRepoLabels(token, repoFullname)
          .catch(err => { console.warn(`Repository label listing failed, continuing without it: ${err.message}`); return null; })
      : new Set();
    await applyIssueLabelling(labelling, token, repoFullname, data.issue.number, existingLabels, currentIssueLabels, null, appId);
    return new Response(`Success: Processed issue labeller for issue #${data.issue.number}`, { status: 200 });
  }


  // Cloudflare Workers cap outgoing fetch() calls per invocation (50 on Free,
  // 1000 on Paid). Large PRs (e.g. kernel bumps touching hundreds of patch
  // files) can burn through that budget on file-content lookups alone,
  // starving the essential terminal writes (check-runs, PR comment) at the
  // end of this handler — which is a silent total failure, not a degraded
  // one. `subrequestBudget` tracks logical GitHub API calls made so far;
  // `reserve` keeps enough headroom for those terminal writes to always run.
  // This under-counts slightly (it doesn't count retry attempts inside
  // githubApiCall's own internal 3x retry loop), which is why `limit`
  // defaults a few requests under the Free plan's actual ceiling.
  const subrequestBudget = {
    limit: parseEnvInt(env.SUBREQUEST_BUDGET_LIMIT, 45),
    reserve: parseEnvInt(env.SUBREQUEST_RESERVE_HEADROOM, 15),
    used: 0
  };
  const trackedApiCall = (...args) => {
    subrequestBudget.used++;
    return githubApiCall(...args);
  };

  const isMaintainerUser = createMaintainerResolver(repoFullname, token, subrequestBudget);

  if (event === "issue_comment") {
    const prNumberFromIssue = data.issue?.number;
    if (!prNumberFromIssue) {
      console.error("Webhook processing failed: Missing pull request number in issue_comment payload.");
      return new Response("Missing pull request number", { status: 400 });
    }

    // Settle the commenter before anything else: comments from everyone else
    // are dropped here, so they never pay for the pull request lookup below.
    if (!await isMaintainerUser(data.comment?.user, data.comment?.author_association)) {
      return new Response("Ignored non-maintainer issue comment", { status: 200 });
    }

    const prUrl = `https://api.github.com/repos/${repoFullname}/pulls/${prNumberFromIssue}`;
    const prRes = await trackedApiCall(prUrl, token);
    if (prRes.code !== 200) {
      throw new Error(`Failed to fetch PR details from ${prUrl} (HTTP ${prRes.code})`);
    }
    // Nothing about a closed pull request can be fixed by re-validating it:
    // a merged one is already in the history, and a rejected one is not going
    // anywhere. `pull_request` events for these never reach us (the action
    // filter above only lets opened/synchronize/reopened through), but a
    // comment on an old thread would otherwise re-run the whole audit and
    // repost check-runs against a commit nobody is working on.
    if (prRes.data?.state === 'closed') {
      return new Response(`Ignored comment on ${prRes.data.merged ? 'merged' : 'closed'} pull request #${prNumberFromIssue}`, { status: 200 });
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



  const baseBranch = data.pull_request.base.ref;
  const headBranch = data.pull_request.head.ref;
  const prNumber = data.pull_request.number;
  const prTitle = data.pull_request.title;
  const isBackportPr = /^(stable|openwrt-)/.test(baseBranch) || /^\[\d{2}\.\d{2}\]/.test(prTitle || '');

  const fileCache = new Map();
  // Tracks where each ref is resolvable: 'base' means the base repo serves the
  // ref, so a null (not-found) result for a path there is authoritative — the
  // fork holds the identical tree for that commit, and probing the fork too
  // would only burn a second subrequest to confirm the same absence (this
  // matters for speculative Makefile probes in findPkgRoot). 'fork' means the
  // base repo cannot resolve the ref at all, so lookups skip the base repo
  // entirely.
  const refSource = new Map();
  // The base branch tip is by definition resolvable in the base repo.
  if (data.pull_request.base?.sha) {
    refSource.set(data.pull_request.base.sha, 'base');
  }

  // Batching loader for file content: rather than firing one REST Contents-
  // API call per (path, ref) — which is what blows through Cloudflare's
  // per-invocation subrequest cap on PRs touching hundreds of files — calls
  // are queued and flushed together on the next microtask tick via a single
  // batched GraphQL query (see graphqlBatchFetchFiles in github.js). This is
  // a classic DataLoader pattern: as long as callers fire off multiple
  // fetchFileContentCached(...) calls without awaiting each one first (e.g.
  // via Promise.all), they land in the same queue and go out together.
  const pendingQueue = new Map(); // key -> { key, path, ref, resolve, reject }
  let flushScheduled = false;
  const GRAPHQL_CHUNK_SIZE = parseEnvInt(env.GRAPHQL_CHUNK_SIZE, 50);
  // Counts (path, ref) lookups that came back empty purely because the
  // subrequest budget ran out before they could be queried — surfaced later
  // as one friendly PR-facing warning instead of silently under-reporting.
  let budgetSkipCount = 0;
  // Same idea for the per-commit upstream lookups on backport PRs: counted
  // here, reported once, never allowed to starve the terminal writes.
  let upstreamComparisonSkips = 0;

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushQueue().catch(err => console.error(`Unexpected error flushing file content queue: ${err.message}`));
    });
  }

  async function flushQueue() {
    flushScheduled = false;
    if (pendingQueue.size === 0) return;
    const batch = [...pendingQueue.values()];
    pendingQueue.clear();

    // Whatever goes wrong below, every queued promise must settle: the batch
    // is already detached from pendingQueue, so an exception escaping this
    // function would leave callers awaiting forever. Rejecting an
    // already-settled item is a no-op, so the catch is safe to apply broadly.
    try {
      await flushBatch(batch);
    } catch (err) {
      for (const item of batch) item.reject(err);
    }
  }

  async function flushBatch(batch) {
    const headRepoFullname = data.pull_request?.head?.repo?.full_name;
    const hasForkRepo = headRepoFullname && headRepoFullname !== repoFullname;

    // Build probes: a ref whose resolvability is already known needs only
    // one probe (base-only or fork-only); a ref that's still unknown is
    // proactively probed in base AND fork within the same batched query —
    // replacing the old reactive fetch -> 404 -> retry-under-fork pattern
    // with a single round trip.
    const probes = [];
    const itemProbeKeys = new Map(); // item.key -> { baseKey, forkKey }
    const unknownRefs = new Set();
    for (const item of batch) {
      const source = refSource.get(item.ref);
      const keys = { baseKey: null, forkKey: null };
      if (!hasForkRepo || source === 'base') {
        keys.baseKey = `${item.key}|b`;
        probes.push({ key: keys.baseKey, repoFullname, ref: item.ref, path: item.path });
      } else if (source === 'fork') {
        keys.forkKey = `${item.key}|f`;
        probes.push({ key: keys.forkKey, repoFullname: headRepoFullname, ref: item.ref, path: item.path });
      } else {
        unknownRefs.add(item.ref);
        keys.baseKey = `${item.key}|b`;
        keys.forkKey = `${item.key}|f`;
        probes.push({ key: keys.baseKey, repoFullname, ref: item.ref, path: item.path });
        probes.push({ key: keys.forkKey, repoFullname: headRepoFullname, ref: item.ref, path: item.path });
      }
      itemProbeKeys.set(item.key, keys);
    }

    // For each still-unknown ref, piggyback a pair of ref-existence probes
    // (bare-ref expression, no path) into the same batched query. A null
    // file lookup can't distinguish "path missing at this ref" from "repo
    // doesn't know this ref at all", so a flush where every speculative
    // lookup misses (common when findPkgRoot walks up the directory tree)
    // would otherwise leave the ref unknown forever — and every subsequent
    // flush would keep dual-probing base and fork, doubling alias usage.
    // The leading NUL is written as the \u0000 escape, never as a raw byte:
    // one of those turns the whole file binary to grep, linters and editors.
    // It keeps these keys collision-free from item keys, which are
    // '<sha>:<path>|b' shaped.
    const refProbeKeys = new Map(); // ref -> { baseKey, forkKey }
    if (hasForkRepo) {
      for (const ref of unknownRefs) {
        const keys = { baseKey: `\u0000ref:${ref}|b`, forkKey: `\u0000ref:${ref}|f` };
        probes.push({ key: keys.baseKey, repoFullname, ref, path: null });
        probes.push({ key: keys.forkKey, repoFullname: headRepoFullname, ref, path: null });
        refProbeKeys.set(ref, keys);
      }
    }

    // Chunk to stay under the per-query alias cap, and check the shared
    // subrequest budget before firing each chunk so the guaranteed terminal
    // writes (labels, PR comment, check-runs) always keep enough headroom.
    const resultsByProbeKey = new Map();
    const fires = [];
    for (let i = 0; i < probes.length; i += GRAPHQL_CHUNK_SIZE) {
      const chunk = probes.slice(i, i + GRAPHQL_CHUNK_SIZE);
      const available = subrequestBudget.limit - subrequestBudget.reserve - subrequestBudget.used;
      if (available <= 0) {
        for (const p of chunk) resultsByProbeKey.set(p.key, { content: null, skipped: true });
        continue;
      }
      subrequestBudget.used++;
      fires.push(
        graphqlBatchFetchFiles(token, chunk)
          .then(map => { for (const [k, v] of map) resultsByProbeKey.set(k, v); })
          .catch(err => { for (const p of chunk) resultsByProbeKey.set(p.key, { error: err }); })
      );
    }
    await Promise.all(fires);

    // Settle ref resolvability from the ref-existence probes first, so
    // subsequent flushes probe only the repo that actually serves each ref.
    for (const [ref, keys] of refProbeKeys) {
      if (refSource.has(ref)) continue;
      const baseRef = resultsByProbeKey.get(keys.baseKey);
      const forkRef = resultsByProbeKey.get(keys.forkKey);
      if (baseRef && !baseRef.error && baseRef.exists) {
        refSource.set(ref, 'base');
      } else if (baseRef && !baseRef.error && !baseRef.skipped && forkRef && !forkRef.error && forkRef.exists) {
        // Base answered cleanly that it cannot resolve the ref, and the
        // fork can — authoritative, unlike inferring from file misses.
        refSource.set(ref, 'fork');
        console.warn(`Ref ${ref} only resolves under head repo ${headRepoFullname}; subsequent file lookups at this ref will go straight to the fork.`);
      }
    }

    for (const item of batch) {
      const keys = itemProbeKeys.get(item.key);
      const baseRes = keys.baseKey ? resultsByProbeKey.get(keys.baseKey) : null;
      const forkRes = keys.forkKey ? resultsByProbeKey.get(keys.forkKey) : null;
      const baseOk = baseRes && !baseRes.error;
      const forkOk = forkRes && !forkRes.error;

      if (baseOk && baseRes.content !== null) {
        if (!refSource.has(item.ref)) refSource.set(item.ref, 'base');
        item.resolve(baseRes.content);
      } else if (baseOk && baseRes.exists) {
        // The path exists in the base repo but has no readable text (binary
        // or oversized blob). That's an authoritative answer — the fork
        // holds the identical tree for this ref — and it also proves the
        // base repo resolves the ref.
        if (!refSource.has(item.ref)) refSource.set(item.ref, 'base');
        item.resolve(null);
      } else if (forkOk && forkRes.content !== null) {
        // Base resolved cleanly (200-equivalent) but had nothing at this
        // path/ref, while the fork does — the base repo simply cannot
        // resolve this ref (identical trees otherwise). A budget-skipped
        // base probe is not a clean miss, so it must not feed this
        // inference.
        if (baseOk && !baseRes.skipped && !refSource.has(item.ref)) {
          refSource.set(item.ref, 'fork');
          console.warn(`Ref ${item.ref} only resolves under head repo ${headRepoFullname}; subsequent file lookups at this ref will go straight to the fork.`);
        }
        item.resolve(forkRes.content);
      } else if (baseOk || forkOk) {
        // Every source we probed responded cleanly, and none had the file —
        // a genuine "not found", not a transport error.
        if (baseRes?.skipped || forkRes?.skipped) budgetSkipCount++;
        item.resolve(null);
      } else {
        const err = (forkRes && forkRes.error) || (baseRes && baseRes.error) ||
          new Error(`Failed to fetch file content for '${item.path}' at ref ${item.ref}: no data returned from GraphQL batch`);
        item.reject(err);
      }
    }
  }

  const fetchFileContentCached = (path, ref) => {
    const key = `${ref}:${path}`;
    if (!fileCache.has(key)) {
      fileCache.set(key, new Promise((resolve, reject) => {
        pendingQueue.set(key, { key, path, ref, resolve, reject });
        scheduleFlush();
      }));
    }
    return fileCache.get(key);
  };

  const commitsUrl = data.pull_request.commits_url;

  const commitsCount = data.pull_request.commits || 1;
  const pages = Math.ceil(commitsCount / 100);
  const commitsPromises = [];
  for (let p = 1; p <= Math.min(pages, 3); p++) {
    commitsPromises.push(trackedApiCall(`${commitsUrl}?per_page=100&page=${p}`, token));
  }

  // OPTIMIZATION: One GraphQL query covers the repository config, the
  // labeler config and the repository labels together (they used to be three
  // separate requests), and it runs in parallel with the commits list pages.
  // Every label page past the first counts against the budget too.
  const [setup, ...commitsResList] = await Promise.all([
    graphqlFetchRepoSetup(token, repoFullname, baseBranch, '.github/formalities.json', '.github/labeler.yml',
      () => { subrequestBudget.used++; }),
    ...commitsPromises
  ]);

  // A missing or malformed formalities.json falls back to the defaults, the
  // same way the REST 404 used to.
  let CONFIG = DEFAULT_CONFIG;
  if (setup.configText) {
    try {
      const repoConfig = JSON.parse(setup.configText);
      if (repoConfig && typeof repoConfig === 'object') {
        CONFIG = { ...DEFAULT_CONFIG, ...repoConfig };
      }
    } catch (e) { /* malformed config file falls back to the defaults */ }
  }
  // A run without the label listing still validates and reports; label
  // creation then works blindly (see ensureLabelExists).
  const existingLabels = setup.labels;
  const labelerText = setup.labelerText;

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
      fetchCommentsPromise = scanPrComments(repoFullname, prNumber, token, () => { subrequestBudget.used++; }, isMaintainerUser, appId).catch(() => null);
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

  // Prefetch the comment scan only when something downstream will need it:
  // comment management, cherry-pick bypass lookups on backport PRs, or the
  // branch-check bypass when the head branch actually violates the rule.
  const branchCheckViolated = CONFIG.check_branch && isProtectedHeadBranch(headBranch);
  if (CONFIG.enable_comments || isBackportPr || branchCheckViolated) {
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
  let makefileOutputText = `### Checking PR #${prNumber}: ${prTitle} (Makefile Audit)\n\n`;
  let patchesOutputText = `### Checking PR #${prNumber}: ${prTitle} (Embedded Patches Compliance)\n\n`;

  if (pages > 3) {
    const cappedWarning = `Commit scan is capped at 300 commits for API safety. This PR has ${commitsCount} commits, so only the first 300 commit messages were audited.`;
    formalityOutputText += `⚠️ Warning: ${cappedWarning}\n\n`;
    allPrWarnings.push(`**Commit Audit Scope**:\n- ⚠️ ${cappedWarning}`);
  }

  const state = { isNewPackage: false, isDroppedPackage: false };

  const prBody = data.pull_request.body || '';
  const association = (data.pull_request.author_association || 'NONE').toUpperCase();
  const bodyRequestsBranchBypass = ALLOW_BRANCH_PATTERN.test(prBody);
  const bodyRequestsCherryPickBypass = ALLOW_CHERRY_PICK_PATTERN.test(prBody);
  // Resolved on demand, like the comment scan above: for an outside
  // contributor the answer costs a subrequest (see createMaintainerResolver),
  // so it is only worth asking when the description actually carries an
  // override. Without one the association alone decides, which at most picks
  // the wording of the hint printed with the failure.
  const isPrAuthorMaintainer = (bodyRequestsBypass) => bodyRequestsBypass
    ? isMaintainerUser(data.pull_request.user, association)
    : MAINTAINER_ASSOCIATIONS.includes(association);

  if (CONFIG.check_branch) {
    if (isProtectedHeadBranch(headBranch)) {
      const isMaintainer = await isPrAuthorMaintainer(bodyRequestsBranchBypass);
      const scanResult = await getCommentsScanWithRetry() || { hasBranchBypassComment: false, existingCommentId: null };
      const bypassBranchCheck = scanResult.hasBranchBypassComment || (bodyRequestsBranchBypass && isMaintainer);

      if (bypassBranchCheck) {
        formalityOutputText += `⚠️ Pull request originates from protected branch \`${headBranch}\` but was allowed via override command\n\n`;
      } else {
        let errorMsg = `### PR Targeting Violation\n- Pull requests must originate from a dedicated feature branch. Cannot use \`${headBranch}\` directly.`;
        if (isMaintainer) {
          errorMsg += ` (Use \`[allow branch]\` in PR description or comment to override this check)`;
        } else {
          errorMsg += ` (A maintainer can override this check by commenting \`[allow branch]\` on this PR)`;
        }
        allFormalityErrors.push(errorMsg);
        formalityOutputText += `❌ Pull request must originate from a feature branch\n       Reason: Target branch \`${headBranch}\` used as origin.\n\n`;
      }
    } else {
      formalityOutputText += `✅ Pull request originates from a dedicated feature branch (\`${headBranch}\`)\n\n`;
    }
  }

  let usePrWidePatch = commits.length > 15;
  let prPatch = null;

  const fetchPrWidePatch = async () => {
    const prPatchUrl = data.pull_request.url;
    const prPatchRes = await trackedApiCall(prPatchUrl, token, 'GET', null, 'application/vnd.github.patch');
    if (prPatchRes.code !== 200) {
      const cleanRaw = (prPatchRes.raw || "").trim().slice(0, 200);
      throw new Error(`Failed to fetch overall PR patch (HTTP ${prPatchRes.code}): ${cleanRaw}`);
    }
    return prPatchRes.raw;
  };

  if (usePrWidePatch) {
    prPatch = await fetchPrWidePatch();
  }

  const mapCommitData = async (commitData, fetchPatch) => {
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
    if (fetchPatch) {
      const detailUrl = `https://api.github.com/repos/${repoFullname}/commits/${sha}`;
      let patchRes = await trackedApiCall(detailUrl, token, 'GET', null, 'application/vnd.github.patch');
      if (patchRes.code === 200 && !refSource.has(sha)) {
        // The base repo resolves this SHA, so later /contents/ lookups at this
        // ref never need the fork fallback.
        refSource.set(sha, 'base');
      }

      // 422 can occur for force-pushed / rebased commits that have been
      // replaced by a newer commit with a different SHA. Fall through to
      // the fork fallback below (the head repo will have the canonical SHA).
      const headRepoFullname = data.pull_request.head.repo?.full_name;
      if ((patchRes.code === 404 || patchRes.code === 422) && headRepoFullname && headRepoFullname !== repoFullname) {
        console.warn(`Commit ${sha} not found in base repo ${repoFullname} (HTTP ${patchRes.code}). Retrying fetch from head repo ${headRepoFullname}...`);
        const forkDetailUrl = `https://api.github.com/repos/${headRepoFullname}/commits/${sha}`;
        // Use silent: true so 404/422 on the fork is not logged as an error
        // (the fork may not have the commit either if it was force-pushed).
        patchRes = await trackedApiCall(forkDetailUrl, token, 'GET', null, 'application/vnd.github.patch', { silent: true });
        if (patchRes.code === 200 && !refSource.has(sha)) {
          refSource.set(sha, 'fork');
        }
      }

      if (patchRes.code !== 200) {
        const cleanRaw = (patchRes.raw || "").trim().slice(0, 200);
        throw new Error(`Failed to fetch commit patch for SHA ${sha} (HTTP ${patchRes.code}): ${cleanRaw}`);
      }
      commitPatch = patchRes.raw;
    }

    let isVerbatim = false;
    let upstreamPatch = null;
    let upstreamSha = null;
    let upstreamFetchError = null;

    if (isBackportPr) {
      const commitMsg = commitData.commit?.message || '';
      const match = commitMsg.match(CHERRY_PICK_MARKER);
      // One upstream lookup per cherry-picked commit, and a backport PR can
      // carry hundreds of them — unchecked, this alone blows through
      // Cloudflare's subrequest cap and kills the terminal writes at the end
      // of the handler. A skipped comparison only means the commit is
      // validated as a regular change instead of being waved through as a
      // verbatim backport, so degrading here is strictly safe.
      if (match && subrequestBudget.limit - subrequestBudget.reserve - subrequestBudget.used <= 0) {
        upstreamComparisonSkips++;
      } else if (match) {
        upstreamSha = match[1];
        const upstreamUrl = `https://api.github.com/repos/${repoFullname}/commits/${upstreamSha}`;
        const upstreamRes = await trackedApiCall(upstreamUrl, token, 'GET', null, 'application/vnd.github.patch');
        if (upstreamRes.code === 200) {
          // The base repo just served this commit, so later file lookups at
          // this ref (upstream-diff filtering on backports) never need the
          // fork fallback probes.
          if (!refSource.has(upstreamSha)) {
            refSource.set(upstreamSha, 'base');
          }
          upstreamPatch = upstreamRes.raw;
          if (commitPatch) {
            isVerbatim = normalizeDiff(getDiffFromPatch(commitPatch)) === normalizeDiff(getDiffFromPatch(upstreamPatch));
          }
        } else {
          upstreamFetchError = `Could not fetch upstream commit ${upstreamSha.slice(0, 7)} from GitHub API (HTTP ${upstreamRes.code})`;
        }
      }
    }

    return {
      sha,
      html_url: commitData.html_url || `https://github.com/${repoFullname}/commit/${sha}`,
      fullCommit: commitData,
      commitPatch,
      isVerbatim,
      upstreamPatch,
      upstreamSha,
      upstreamFetchError
    };
  };

  let commitDetails = [];
  if (!usePrWidePatch) {
    try {
      commitDetails = await Promise.all(commits.map(commitData => mapCommitData(commitData, true)));
    } catch (e) {
      console.warn(`Failed to fetch individual commit patches, falling back to PR-wide patch: ${e.message}`);
      usePrWidePatch = true;
      prPatch = await fetchPrWidePatch();
    }
  }

  if (usePrWidePatch) {
    commitDetails = await Promise.all(commits.map(commitData => mapCommitData(commitData, false)));
  }

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

    if (isBackportPr) {
      if (!CHERRY_PICK_MARKER.test(fullCommit.commit.message || '')) {
        const isMaintainer = await isPrAuthorMaintainer(bodyRequestsCherryPickBypass);
        const scanResult = await getCommentsScanWithRetry() || { hasCherryPickBypassComment: false, existingCommentId: null };
        const bypassCherryPickCheck = scanResult.hasCherryPickBypassComment || (bodyRequestsCherryPickBypass && isMaintainer);

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

    // 2. Makefiles
    if (!usePrWidePatch) {
      if (item.isVerbatim) {
        makefileOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
        makefileOutputText += "  ✅ Backport matches upstream commit verbatim. Skipping style and packaging validations.\n\n";
      } else {
        const fetchFileContent = (path) => fetchFileContentCached(path, sha);

        const reportMakefile = validateMakefileContext(fullCommit, commitPatch, CONFIG, state);
        if (isBackportPr && item.upstreamPatch) {
          const upstreamCommit = { commit: { message: getCommitMessageFromPatch(item.upstreamPatch) } };
          const reportUpstreamMakefile = validateMakefileContext(upstreamCommit, item.upstreamPatch, CONFIG, { isNewPackage: false, isDroppedPackage: false });
          reportMakefile.errors = reportMakefile.errors.filter(err => !reportUpstreamMakefile.errors.includes(err));
          reportMakefile.warnings = reportMakefile.warnings.filter(warn => !reportUpstreamMakefile.warnings.includes(warn));
          reportMakefile.successes.push("✅ Filtered out style/packaging issues already present in upstream commit");
        }

        const reportUci = await validateUciConfigs(commitPatch, CONFIG, fetchFileContent);
        if (isBackportPr && item.upstreamPatch) {
          const fetchFileContentForUpstream = (path) => fetchFileContentCached(path, item.upstreamSha);
          const reportUpstreamUci = await validateUciConfigs(item.upstreamPatch, CONFIG, fetchFileContentForUpstream);
          reportUci.errors = reportUci.errors.filter(err => !reportUpstreamUci.errors.includes(err));
          reportUci.successes.push("✅ Filtered out configuration format issues already present in upstream commit");
        }

        makefileOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
        reportMakefile.successes.forEach(s => { makefileOutputText += `  ${s}\n`; });
        reportUci.successes.forEach(s => { makefileOutputText += `  ${s}\n`; });
        if (reportMakefile.warnings && reportMakefile.warnings.length > 0) {
          allPrWarnings.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportMakefile.warnings.join("\n"));
          reportMakefile.warnings.forEach(w => { makefileOutputText += `  ⚠️ Warning: ${w.replace(/^- /, '')}\n`; });
        }
        if (reportMakefile.errors.length > 0 || reportUci.errors.length > 0) {
          const combinedErrors = [...reportMakefile.errors, ...reportUci.errors];
          allMakefileErrors.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + combinedErrors.join("\n"));
          combinedErrors.forEach(err => { makefileOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
        }
        makefileOutputText += "\n";
      }
    }

    // 3. Patches
    if (!usePrWidePatch) {
      if (item.isVerbatim) {
        patchesOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
        patchesOutputText += "  ✅ Backport matches upstream commit verbatim. Skipping style and packaging validations.\n\n";
      } else {
        const fetchFileContent = (patchFile) => fetchFileContentCached(patchFile, sha);
        const reportPatches = await validateEmbeddedPatches(commitPatch, CONFIG, fetchFileContent);
        
        if (isBackportPr && item.upstreamPatch) {
          const fetchFileContentForUpstream = (patchFile) => fetchFileContentCached(patchFile, item.upstreamSha);
          const reportUpstreamPatches = await validateEmbeddedPatches(item.upstreamPatch, CONFIG, fetchFileContentForUpstream);
          reportPatches.errors = reportPatches.errors.filter(err => !reportUpstreamPatches.errors.includes(err));
          reportPatches.successes.push("✅ Filtered out embedded patch issues already present in upstream commit");
        }

        patchesOutputText += `#### Commit [${sha.slice(0, 7)}](${html_url}) - ${commitSubject}:\n`;
        reportPatches.successes.forEach(s => { patchesOutputText += `  ${s}\n`; });
        if (reportPatches.errors.length > 0) {
          const isPatchWarning = CONFIG.check_patch_headers === 'warning';
          if (isPatchWarning) {
            allPrWarnings.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportPatches.errors.map(e => `- ⚠️ ${e}`).join("\n"));
            reportPatches.errors.forEach(err => { patchesOutputText += `  ⚠️ Warning: ${err.replace(/^- /, '')}\n`; });
          } else {
            allPatchesErrors.push(`**Commit [${sha.slice(0, 7)}](${html_url})** - *${commitSubject}*:\n` + reportPatches.errors.join("\n"));
            reportPatches.errors.forEach(err => { patchesOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
          }
        }
        patchesOutputText += "\n";
      }
    }
  }

  if (usePrWidePatch && prPatch) {
    const virtualCommit = {
      commit: {
        message: data.pull_request.title + "\n" + commits.map(c => c.commit.message || '').join("\n")
      }
    };

    // 2. Makefiles (PR-Wide)
    const fetchFileContent = (path) => fetchFileContentCached(path, data.pull_request.head.sha);

    const reportMakefile = validateMakefileContext(virtualCommit, prPatch, CONFIG, state);
    const reportUci = await validateUciConfigs(prPatch, CONFIG, fetchFileContent);

    makefileOutputText += `#### Pull Request Overall Diff:\n`;
    reportMakefile.successes.forEach(s => { makefileOutputText += `  ${s}\n`; });
    reportUci.successes.forEach(s => { makefileOutputText += `  ${s}\n`; });
    if (reportMakefile.warnings && reportMakefile.warnings.length > 0) {
      allPrWarnings.push(`**Pull Request Overall Diff**:\n` + reportMakefile.warnings.join("\n"));
      reportMakefile.warnings.forEach(w => { makefileOutputText += `  ⚠️ Warning: ${w.replace(/^- /, '')}\n`; });
    }
    if (reportMakefile.errors.length > 0 || reportUci.errors.length > 0) {
      const combinedErrors = [...reportMakefile.errors, ...reportUci.errors];
      allMakefileErrors.push(`**Pull Request Overall Diff**:\n` + combinedErrors.join("\n"));
      combinedErrors.forEach(err => { makefileOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
    }
    makefileOutputText += "\n";

    // 3. Patches (PR-Wide)
    const reportPatches = await validateEmbeddedPatches(prPatch, CONFIG, fetchFileContent);
    patchesOutputText += `#### Pull Request Overall Diff:\n`;
    reportPatches.successes.forEach(s => { patchesOutputText += `  ${s}\n`; });
    if (reportPatches.errors.length > 0) {
      const isPatchWarning = CONFIG.check_patch_headers === 'warning';
      if (isPatchWarning) {
        allPrWarnings.push(`**Pull Request Overall Diff**:\n` + reportPatches.errors.map(e => `- ⚠️ ${e}`).join("\n"));
        reportPatches.errors.forEach(err => { patchesOutputText += `  ⚠️ Warning: ${err.replace(/^- /, '')}\n`; });
      } else {
        allPatchesErrors.push(`**Pull Request Overall Diff**:\n` + reportPatches.errors.join("\n"));
        reportPatches.errors.forEach(err => { patchesOutputText += `  ❌ ${err.replace(/^- /, '')}\n`; });
      }
    }
    patchesOutputText += "\n";
  }

  // 4. Package Release Bumps (PR-wide audit)
  const headSha = data.pull_request.head.sha;
  const baseSha = data.pull_request.base.sha;

  const fetchFileContentAtHead = (path) => fetchFileContentCached(path, headSha);
  const fetchFileContentAtBase = (path) => fetchFileContentCached(path, baseSha);

  let releaseDetails = usePrWidePatch 
    ? [{ commitPatch: prPatch }] 
    : commitDetails.filter(item => (item.fullCommit?.parents || []).length <= 1);

  if (isBackportPr) {
    releaseDetails = releaseDetails.filter(item => !item.isVerbatim);
  }

  let reportRelease = { successes: [], errors: [], warnings: [], notes: [] };
  try {
    reportRelease = await validatePkgReleaseBumps(releaseDetails, CONFIG, fetchFileContentAtHead, fetchFileContentAtBase);
  } catch (e) {
    console.error(`Failed to audit package release bumps: ${e.message}`);
    reportRelease.warnings = [`Could not complete package release audit because of an error fetching file content: ${e.message}`];
  }
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

          const hasBump = [
            /^\+\s*PKG_VERSION\s*(?::=|=)/m,
            /^\+\s*PKG_RELEASE\s*(?::=|=)/m,
            /^\+\s*PKG_SOURCE_VERSION\s*(?::=|=)/m,
            /^\+\s*PKG_SOURCE_DATE\s*(?::=|=)/m
          ].some(regex => regex.test(item.upstreamPatch));

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
      const isWarning = CONFIG.check_pkg_release === 'warning';
      // The packages missing a bump are one finding that happens to name
      // several packages, not one finding per package. State it once and list
      // them, then the advice that qualifies it — also once.
      const { packages, others } = groupReleaseErrors(reportRelease.errors);
      const bullet = isWarning ? '- ⚠️ ' : '- ';
      const blocks = [];
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

  // If the subrequest budget ran out before every file-content lookup could
  // be made, some deep validation (patch headers, UCI configs, package
  // release bumps) may be incomplete for this PR — surface that plainly
  // rather than silently under-reporting. This never blocks the terminal
  // writes below (labels, comment, check-runs), which is the whole point:
  // a PR too large to fully audit still gets a clear status instead of no
  // response at all.
  if (budgetSkipCount > 0) {
    const budgetWarning = `Deep file-content validation skipped for ${budgetSkipCount} file lookup(s): PR too large for the available API subrequest budget (used ${subrequestBudget.used}/${subrequestBudget.limit}, ${subrequestBudget.reserve} reserved for status reporting). Some patch header, UCI config, or package-release checks may be incomplete.`;
    allPrWarnings.push(`**Validation Coverage**:\n- ⚠️ ${budgetWarning}`);
    makefileOutputText += `⚠️ Warning: ${budgetWarning}\n\n`;
    patchesOutputText += `⚠️ Warning: ${budgetWarning}\n\n`;
  }

  if (upstreamComparisonSkips > 0) {
    const upstreamWarning = `Upstream comparison skipped for ${upstreamComparisonSkips} cherry-picked commit(s): this PR is too large for the available API request budget. Those commits were fully validated as regular changes instead of being matched against their upstream originals.`;
    allPrWarnings.push(`**Validation Coverage**:\n- ⚠️ ${upstreamWarning}`);
    formalityOutputText += `⚠️ Warning: ${upstreamWarning}\n\n`;
  }

  const formalityPassed = allFormalityErrors.length === 0;
  const makefilePassed = allMakefileErrors.length === 0;
  const patchesPassed = allPatchesErrors.length === 0;
  const allPassed = formalityPassed && makefilePassed && patchesPassed;

  // OPTIMIZATION: Manage labels in single batch, check existence locally
  const prLabelUrl = `https://api.github.com/repos/${repoFullname}/issues/${prNumber}/labels`;
  const labelsToAdd = [];
  const labelOperations = [];

  async function ensureLabel(name, color, description) {
    await ensureLabelExists(token, repoFullname, name, color, description, existingLabels, () => { subrequestBudget.used++; });
  }

  const currentPrLabels = new Set((data.pull_request?.labels || []).map(l => l.name.toLowerCase()));

  // New commits or a reopen are contributor activity: drop the stale marker
  // right away instead of waiting for the nightly scan to notice it.
  if ((data.action === 'synchronize' || data.action === 'reopened') && currentPrLabels.has('stale')) {
    labelOperations.push(trackedApiCall(`${prLabelUrl}/stale`, token, 'DELETE'));
  }

  if (!allPassed) {
    if (!currentPrLabels.has(LABEL_GUIDELINES.toLowerCase())) {
      labelOperations.push(ensureLabel(LABEL_GUIDELINES, 'e11d48', 'Pull request does not follow formatting guidelines'));
      labelsToAdd.push(LABEL_GUIDELINES);
    }
  } else {
    // Delete validation failure label if present
    if (currentPrLabels.has(LABEL_GUIDELINES.toLowerCase())) {
      labelOperations.push(trackedApiCall(`${prLabelUrl}/${encodeURIComponent(LABEL_GUIDELINES)}`, token, 'DELETE'));
    }
  }

  if (CONFIG.add_package_label && state.isNewPackage && !currentPrLabels.has(LABEL_ADD_PACKAGE.toLowerCase())) {
    labelOperations.push(ensureLabel(LABEL_ADD_PACKAGE, '0e7490', 'Introduces a new package Makefile build script'));
    labelsToAdd.push(LABEL_ADD_PACKAGE);
  }

  if (CONFIG.drop_package_label && state.isDroppedPackage && !currentPrLabels.has(LABEL_DROP_PACKAGE.toLowerCase())) {
    labelOperations.push(ensureLabel(LABEL_DROP_PACKAGE, '3b82f6', 'Removes an existing package Makefile from the tracking tree'));
    labelsToAdd.push(LABEL_DROP_PACKAGE);
  }

  if (CONFIG.branch_labeling && /^openwrt-\d{2}\.\d{2}$/.test(baseBranch)) {
    const version = baseBranch.split('-')[1];
    const labelName = `release/${version}`;
    if (!currentPrLabels.has(labelName.toLowerCase())) {
      labelOperations.push(ensureLabel(labelName, '6b7280', `Pull request targets the stable release branch ${labelName}`));
      labelsToAdd.push(labelName);
    }
  }

  if (CONFIG.enable_labeler_yml && labelerText) {
    let changedFiles = [];
    if (usePrWidePatch) {
      changedFiles = getAllChangedFiles(prPatch);
    } else {
      const filesSet = new Set();
      for (const item of commitDetails) {
        if (item.commitPatch) {
          const files = getAllChangedFiles(item.commitPatch);
          for (const f of files) {
            filesSet.add(f);
          }
        }
      }
      changedFiles = Array.from(filesSet);
    }

    try {
      const parsedLabeler = parseYaml(labelerText);
      const matchedLabels = getLabelsForChangedFiles(changedFiles, parsedLabeler);
      for (const label of matchedLabels) {
        if (!currentPrLabels.has(label.toLowerCase())) {
          labelOperations.push(ensureLabel(label, 'bfd4f2', ''));
          labelsToAdd.push(label);
        }
      }
    } catch (e) {
      console.error(`Failed to parse or process labeler.yml: ${e.message}`);
    }
  }

  // Pre-create any missing repository labels in parallel
  await Promise.all(labelOperations);

  // Apply all relevant labels to the PR in one API call
  if (labelsToAdd.length > 0) {
    await trackedApiCall(prLabelUrl, token, 'POST', { labels: labelsToAdd });
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
        commentBody += "We checked this pull request against the contribution guidelines. Here is what needs your attention:\n\n";

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

        if (!allPassed && CONFIG.show_force_push_tip) {
          commentBody += "\n> [!TIP]\n";
          commentBody += "> **Do not close this pull request** to make corrections. Instead, modify your existing commits (e.g. `git commit --amend`) and update the branch using `git push --force-with-lease --force-if-includes`. The checks will re-run automatically.\n\n";
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
          commentPromises.push(trackedApiCall(`https://api.github.com/repos/${repoFullname}/issues/comments/${existingCommentId}`, token, 'PATCH', { body: safeTruncate(commentBody) }));
        } else {
          commentPromises.push(trackedApiCall(commentsUrl, token, 'POST', { body: safeTruncate(commentBody) }));
        }
      } else {
        if (existingCommentId) {
          commentPromises.push(trackedApiCall(`https://api.github.com/repos/${repoFullname}/issues/comments/${existingCommentId}`, token, 'DELETE'));
        }
      }
    }
  }

  // Publish Status to Checks API
  const checkRunsUrl = `https://api.github.com/repos/${repoFullname}/check-runs`;

  const checkRunsPromises = [
    trackedApiCall(checkRunsUrl, token, 'POST', {
      name: 'FormalityCheck / Git & Commits', head_sha: headSha, status: 'completed',
      conclusion: formalityPassed ? 'success' : 'failure',
      output: {
        title: formalityPassed ? 'Git & Commits: Passed' : 'Git & Commits: Failed',
        summary: formalityPassed ? 'All commits follow the commit message guidelines.' : 'Some commits do not follow the commit message guidelines — open the details below to see what to change.',
        text: safeTruncate(formalityOutputText)
      }
    }),
    trackedApiCall(checkRunsUrl, token, 'POST', {
      name: 'FormalityCheck / OpenWrt Makefiles', head_sha: headSha, status: 'completed',
      conclusion: makefilePassed ? 'success' : 'failure',
      output: {
        title: makefilePassed ? 'OpenWrt Makefiles: Passed' : 'OpenWrt Makefiles: Failed',
        summary: makefilePassed ? 'The changed package files follow the OpenWrt packaging guidelines.' : 'Some package files need fixing — open the details below to see what to change.',
        text: safeTruncate(makefileOutputText)
      }
    }),
    trackedApiCall(checkRunsUrl, token, 'POST', {
      name: 'FormalityCheck / Code Patches', head_sha: headSha, status: 'completed',
      conclusion: patchesPassed ? 'success' : 'failure',
      output: {
        title: patchesPassed ? 'Code Patches: Passed' : 'Code Patches: Failed',
        summary: patchesPassed ? 'All downstream patch files contain correct Git tracking headers.' : 'Some patch files are missing the required Git headers — open the details below to see what to change.',
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

      let name = "Error";
      let message;

      if (rawError instanceof Error) {
        name = rawError.name;
        message = rawError.message;
      } else if (rawError && typeof rawError === 'object') {
        name = String(rawError.name || "Error");
        message = String(rawError.message || rawError);
      } else if (rawError !== undefined && rawError !== null) {
        message = String(rawError);
      } else {
        message = "null";
      }

      const errorDetails = {
        name,
        message,
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
