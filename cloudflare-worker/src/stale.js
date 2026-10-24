import { githubApiCall, GRAPHQL_URL } from './github.js';
import { generateJWT } from './crypto.js';
import { DEFAULT_CONFIG } from './config.js';

// Bot accounts cannot rescue a stale PR: the app's own comments, other GitHub
// Apps and *[bot] accounts are recognized by shape, and automation that runs
// on a plain User account (an AI reviewer like openwrt-ai) is named in
// `stale_ignored_users`. Only pushes and people count as activity.
function isIgnoredActor(user, ignoredLogins) {
  const login = (user?.login || '').toLowerCase();
  if (!login) return true;
  if (user.type === 'Bot' || login.endsWith('[bot]')) return true;
  return ignoredLogins.has(login);
}

// Whether anyone able to move the PR forward acted after the stale label was
// applied: pushed or force-pushed commits, commented, reviewed or reopened.
// The bare updated_at timestamp cannot answer this - any bot comment bumps
// it, and one automated review per cycle used to reset the close countdown
// forever (openwrt/packages#29094).
export function hasRealActivitySince(timeline, labeledAt, ignoredLogins) {
  const labeledTime = labeledAt.getTime();
  for (const item of timeline) {
    let when = null;
    let actor = null;
    // A pushed commit carries no actor of its own and is author work by
    // definition; every other event has to name who did it, so a missing or
    // deleted account there is not evidence of anyone being active.
    let actorRequired = true;
    switch (item.event) {
      case 'committed':
        when = item.committer?.date || item.author?.date;
        actorRequired = false;
        break;
      case 'head_ref_force_pushed':
      case 'reopened':
        when = item.created_at;
        actor = item.actor;
        break;
      case 'commented':
        when = item.created_at;
        actor = item.actor || item.user;
        break;
      case 'reviewed':
        when = item.submitted_at;
        actor = item.user;
        break;
      default:
        continue;
    }
    if (!when || new Date(when).getTime() <= labeledTime) continue;
    if (actorRequired && isIgnoredActor(actor, ignoredLogins)) continue;
    return true;
  }
  return false;
}

function parseLinkHeader(header) {
  if (!header) return {};
  const links = {};
  const parts = header.split(',');
  for (const part of parts) {
    const match = part.trim().match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      const url = match[1];
      if (url.startsWith('https://api.github.com/')) {
        links[match[2]] = url;
      }
    }
  }
  return links;
}

// Walks a paginated GitHub listing, following Link headers, and returns
// { items, outcome }:
//   'ok'      – every page arrived (or `stop` ended the walk early)
//   'fatal'   – 403/429 with the rate limit exhausted; the whole scan
//               should wind down, whatever it is doing
//   'limited' – 403/429 short of exhaustion (e.g. abuse detection); the
//               caller skips its current unit of work
//   'failed'  – any other non-200; the caller decides whether the items
//               collected so far are still worth acting on
// `pick` extracts the item array from a page payload, `stop(items)` may end
// the walk once the caller already has what it needs.
async function paginateAll(startUrl, token, label, { pick = (data) => data, stop = null } = {}) {
  const items = [];
  let url = startUrl;
  while (url) {
    const res = await githubApiCall(url, token);
    if (res.code === 403 || res.code === 429) {
      if (res.headers?.get('x-ratelimit-remaining') === '0') {
        console.error(`[Stale Bot] GitHub API rate limit reached ${label}. Exiting gracefully.`);
        return { items, outcome: 'fatal' };
      }
      console.warn(`[Stale Bot] HTTP ${res.code} ${label}.`);
      return { items, outcome: 'limited' };
    }
    if (res.code !== 200) {
      console.error(`[Stale Bot] Failed ${label} (HTTP ${res.code}): ${res.raw}`);
      return { items, outcome: 'failed' };
    }
    items.push(...(pick(res.data) || []));
    if (stop && stop(items)) {
      return { items, outcome: 'ok' };
    }
    url = parseLinkHeader(res.headers?.get('link')).next || null;
  }
  return { items, outcome: 'ok' };
}

// Classifies a GraphQL answer the same way paginateAll classifies a REST one,
// so the scan winds down on an exhausted rate limit and skips one repository
// on anything else.
function graphqlOutcome(res, label) {
  if (res.code === 403 || res.code === 429) {
    if (res.headers?.get('x-ratelimit-remaining') === '0') {
      console.error(`[Stale Bot] GitHub API rate limit reached ${label}. Exiting gracefully.`);
      return 'fatal';
    }
    console.warn(`[Stale Bot] HTTP ${res.code} ${label}.`);
    return 'limited';
  }
  // GraphQL answers a partly failed query with HTTP 200, the fields it could
  // resolve and an `errors` list for the rest. A pull request whose timeline
  // is among the missing pieces would look like one with no history at all,
  // and the fallback below could close it on that - so any error at all means
  // this repository is skipped this round.
  const errors = Array.isArray(res.data?.errors) ? res.data.errors : [];
  if (res.code !== 200 || !res.data?.data?.repository || errors.length > 0) {
    const detail = errors.map(e => e.message).join('; ');
    console.error(`[Stale Bot] Failed ${label} (HTTP ${res.code}): ${detail || (res.raw || '').trim().slice(0, 200)}`);
    return 'failed';
  }
  return 'ok';
}

// Everything needed to decide whether this repository is scanned at all: its
// configuration file and whether the `stale` label already exists. Asking for
// the one label by name replaces walking the repository's whole label list.
async function fetchStaleRepoSetup(token, repo) {
  const slashIndex = repo.indexOf('/');
  const query = `query($owner: String!, $name: String!, $cfgExpr: String!) {
  repository(owner: $owner, name: $name) {
    cfg: object(expression: $cfgExpr) { ... on Blob { text } }
    staleLabel: label(name: "stale") { name }
  }
}`;
  const res = await githubApiCall(GRAPHQL_URL, token, 'POST', {
    query,
    variables: {
      owner: repo.slice(0, slashIndex),
      name: repo.slice(slashIndex + 1),
      cfgExpr: 'HEAD:.github/formalities.json'
    }
  });
  const outcome = graphqlOutcome(res, `fetching setup for repository ${repo}`);
  if (outcome !== 'ok') return { outcome };
  const repository = res.data.data.repository;
  return {
    outcome,
    configText: typeof repository.cfg?.text === 'string' ? repository.cfg.text : null,
    staleLabelExists: repository.staleLabel !== null && repository.staleLabel !== undefined
  };
}

// GraphQL timeline items carry their own shapes; hasRealActivitySince reads the
// REST ones, so translate rather than teach it a second vocabulary. An author
// that is a GitHub App arrives with __typename "Bot", which is exactly what the
// bot-account rule looks for.
function actorFromGraphql(actor) {
  if (!actor) return null;
  return { login: actor.login, type: actor.__typename === 'Bot' ? 'Bot' : 'User' };
}

function timelineFromGraphql(nodes) {
  const items = [];
  for (const node of nodes || []) {
    switch (node.__typename) {
      case 'PullRequestCommit':
        items.push({ event: 'committed', committer: { date: node.commit?.committedDate }, author: { date: node.commit?.authoredDate } });
        break;
      case 'HeadRefForcePushedEvent':
        items.push({ event: 'head_ref_force_pushed', created_at: node.createdAt, actor: actorFromGraphql(node.actor) });
        break;
      case 'ReopenedEvent':
        items.push({ event: 'reopened', created_at: node.createdAt, actor: actorFromGraphql(node.actor) });
        break;
      case 'IssueComment':
        items.push({ event: 'commented', created_at: node.createdAt, actor: actorFromGraphql(node.author), own: node.viewerDidAuthor === true, body: node.body });
        break;
      case 'PullRequestReview':
        items.push({ event: 'reviewed', submitted_at: node.submittedAt, user: actorFromGraphql(node.author) });
        break;
      case 'LabeledEvent':
        items.push({ event: 'labeled', created_at: node.createdAt, label: { name: node.label?.name } });
        break;
      case 'UnlabeledEvent':
        items.push({ event: 'unlabeled', created_at: node.createdAt, label: { name: node.label?.name } });
        break;
      default:
        break;
    }
  }
  return items;
}

// The open pull requests carrying either label, each with the recent slice of
// its timeline. GraphQL treats the label list as "any of", which the REST
// issues listing cannot do - it ANDs them - and the timeline travels along
// instead of costing one request per pull request.
const STALE_TIMELINE_WINDOW = 100;

async function fetchStalePullRequests(token, repo, labelNames) {
  const slashIndex = repo.indexOf('/');
  const owner = repo.slice(0, slashIndex);
  const name = repo.slice(slashIndex + 1);
  const query = `query($owner: String!, $name: String!, $labels: [String!], $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, labels: $labels, first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        updatedAt
        labels(first: 50) { nodes { name } }
        timelineItems(last: ${STALE_TIMELINE_WINDOW}, itemTypes: [LABELED_EVENT, ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, REOPENED_EVENT]) {
          totalCount
          nodes {
            __typename
            ... on LabeledEvent { createdAt label { name } }
            ... on IssueComment { createdAt author { login __typename } }
            ... on PullRequestReview { submittedAt author { login __typename } }
            ... on PullRequestCommit { commit { committedDate authoredDate } }
            ... on HeadRefForcePushedEvent { createdAt actor { login __typename } }
            ... on ReopenedEvent { createdAt actor { login __typename } }
          }
        }
      }
    }
  }
}`;

  const { outcome, items } = await fetchLabelledWithTimeline(
    token, query, { owner, name, labels: labelNames }, 'pullRequests',
    `querying pull requests for ${repo}`);
  return { outcome, prs: items };
}

// Walks one labelled connection (pullRequests or issues) page by page.
async function fetchLabelledWithTimeline(token, query, variables, connection, label) {
  const items = [];
  let after = null;
  while (true) {
    const res = await githubApiCall(GRAPHQL_URL, token, 'POST', {
      query,
      variables: { ...variables, after }
    });
    const outcome = graphqlOutcome(res, label);
    if (outcome !== 'ok') return { outcome, items };
    const page = res.data.data.repository[connection];
    for (const node of page?.nodes || []) {
      items.push({
        number: node.number,
        updated_at: node.updatedAt,
        labels: (node.labels?.nodes || []).map(l => ({ name: l.name })),
        timeline: timelineFromGraphql(node.timelineItems?.nodes),
        // True when the window did not reach back far enough to hold the whole
        // history, which is what makes a missing stale-labelling event
        // inconclusive rather than proof that there was none.
        timelineTruncated: (node.timelineItems?.totalCount || 0) > STALE_TIMELINE_WINDOW
      });
    }
    if (!page?.pageInfo?.hasNextPage) return { outcome: 'ok', items };
    after = page.pageInfo.endCursor;
  }
}

// Open issues carrying any of the given labels, least recently updated first,
// each with the recent slice of its timeline.
async function fetchStaleIssues(token, repo, labelNames) {
  const slashIndex = repo.indexOf('/');
  const query = `query($owner: String!, $name: String!, $labels: [String!], $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, labels: $labels, first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        updatedAt
        labels(first: 50) { nodes { name } }
        timelineItems(last: ${STALE_TIMELINE_WINDOW}, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, ISSUE_COMMENT, REOPENED_EVENT]) {
          totalCount
          nodes {
            __typename
            ... on LabeledEvent { createdAt label { name } }
            ... on UnlabeledEvent { createdAt label { name } }
            ... on IssueComment { createdAt viewerDidAuthor body author { login __typename } }
            ... on ReopenedEvent { createdAt actor { login __typename } }
          }
        }
      }
    }
  }
}`;
  return fetchLabelledWithTimeline(token, query,
    { owner: repo.slice(0, slashIndex), name: repo.slice(slashIndex + 1), labels: labelNames },
    'issues', `querying issues for ${repo}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The `stale_bot` block of a repository configuration, one rule per kind with
// every value checked and defaulted. The keys that came before the block,
// `enable_stale_bot` and `stale_ignored_users`, still switch on the pull
// request rule and name the ignored accounts when the block leaves them out.
export function staleRules(repoConfig) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const cfg = isObject(repoConfig) ? repoConfig : {};
  const block = isObject(cfg.stale_bot) ? cfg.stale_bot : {};
  const defaults = DEFAULT_CONFIG.stale_bot;
  const strings = (v) => Array.isArray(v) ? v.map(String) : null;

  const rule = (kind, legacyEnabled) => {
    const own = isObject(block[kind]) ? block[kind] : {};
    const def = defaults[kind];
    const days = (key) => Number.isInteger(own[key]) && own[key] > 0 ? own[key] : def[key];
    const flag = (key) => typeof own[key] === 'boolean' ? own[key] : def[key];
    const result = {
      enabled: typeof own.enabled === 'boolean' ? own.enabled : legacyEnabled === true,
      labels: strings(own.labels) ?? def.labels,
      days_until_stale: days('days_until_stale'),
      days_until_close: days('days_until_close'),
      close: flag('close'),
      dry_run: flag('dry_run')
    };
    if ('max_per_run' in def) {
      result.max_per_run = Number.isInteger(own.max_per_run) && own.max_per_run >= 0 ? own.max_per_run : def.max_per_run;
    }
    return result;
  };

  return {
    ignored_users: strings(block.ignored_users) ?? strings(cfg.stale_ignored_users) ?? defaults.ignored_users,
    pull_requests: rule('pull_requests', cfg.enable_stale_bot),
    issues: rule('issues', false)
  };
}

// One write, or under `dry_run` only its log line. Answers whether GitHub
// took it; removing a label that is already gone counts as taken.
async function staleWrite(token, rule, method, url, payload = null) {
  if (rule.dry_run) {
    console.log(`[Stale Bot] Dry run, not sent: ${method} ${url}`);
    return true;
  }
  const res = await githubApiCall(url, token, method, payload);
  if ((res.code >= 200 && res.code < 300) || (method === 'DELETE' && res.code === 404)) {
    return true;
  }
  console.error(`[Stale Bot] ${method} ${url} failed (HTTP ${res.code}): ${(res.raw || '').trim().slice(0, 200)}`);
  return false;
}

async function ensureStaleLabel(token, repo, rule, state) {
  if (state.staleLabelExists) return true;
  const ok = await staleWrite(token, rule, 'POST', `https://api.github.com/repos/${repo}/labels`, {
    name: 'stale',
    color: '6b7280',
    description: 'Marked stale due to inactivity'
  });
  if (ok) state.staleLabelExists = true;
  return ok;
}

// Hidden markers in the bot's own issue comments. They let a scan tell what an
// earlier one already posted, so a write that failed halfway is finished
// rather than repeated.
const ISSUE_MARKED = '<!-- stale-bot:marked -->';
const ISSUE_CLOSED = '<!-- stale-bot:closed -->';

const eventTime = (e) => new Date(e.created_at).getTime();
const latestTime = (items) => items.length ? Math.max(...items.map(eventTime)) : null;

// Issues reported against a release that no longer gets updates, imported
// from an old tracker or flagged invalid rarely get another look. An issue
// carrying one of the rule's labels is asked once whether the problem still
// happens, marked stale, and closed later unless a person replies. A reply
// keeps it open for good: the label that made it a candidate usually stays,
// so asking again would repeat forever.
//
// Every decision reads the issue's timeline, so an issue whose timeline is
// longer than the fetched window is left alone, and any write GitHub refuses
// ends the pass for this repository. The comment goes out before the label
// and before the close, so the next scan finds it and only completes the
// step that failed.
async function scanStaleIssues(token, repo, rule, ignoredLogins, state, now) {
  if (rule.labels.length === 0) return 'ok';
  const staleBefore = new Date(now - rule.days_until_stale * DAY_MS);
  const closeBefore = new Date(now - rule.days_until_close * DAY_MS);

  const result = await fetchStaleIssues(token, repo, [...rule.labels, 'stale']);
  if (result.outcome !== 'ok') return result.outcome;

  const triggerSet = new Set(rule.labels.map(l => l.toLowerCase()));
  let notices = 0;
  for (const issue of result.items) {
    const n = issue.number;
    const issueUrl = `https://api.github.com/repos/${repo}/issues/${n}`;
    if (issue.timelineTruncated) {
      console.log(`[Stale Bot] Issue #${n} has a timeline longer than the fetched window. Skipping.`);
      continue;
    }
    const hasStaleLabel = issue.labels.some(l => l.name.toLowerCase() === 'stale');
    const trigger = issue.labels.find(l => triggerSet.has(l.name.toLowerCase()))?.name;
    const ownNotice = (marker) => latestTime(issue.timeline.filter(e => e.event === 'commented' && e.own && e.body?.includes(marker)));
    const staleEvents = (event) => issue.timeline.filter(e => e.event === event && e.label?.name?.toLowerCase() === 'stale');
    const markedAt = ownNotice(ISSUE_MARKED);
    const labeledAt = latestTime(staleEvents('labeled'));

    if (markedAt === null) {
      // Never asked. A stale label without the bot's notice was set by hand
      // and is not the bot's to act on.
      if (hasStaleLabel || !trigger || notices >= rule.max_per_run) continue;
      if (new Date(issue.updated_at) >= staleBefore) continue;
      notices++;
      console.log(`[Stale Bot] Marking issue #${n} as stale`);
      const closing = rule.close ? ` Otherwise this issue will be closed in ${rule.days_until_close} days.` : '';
      if (!await staleWrite(token, rule, 'POST', `${issueUrl}/comments`, {
        body: `This issue has been marked stale because it has the "${trigger}" label and has seen no activity for ${rule.days_until_stale} days.\nIf the problem still happens on a supported release or a snapshot, comment with the version you tested and the stale label will be removed.${closing}\n\n${ISSUE_MARKED}`
      })) return 'failed';
      if (!await ensureStaleLabel(token, repo, rule, state)) return 'failed';
      if (!await staleWrite(token, rule, 'POST', `${issueUrl}/labels`, { labels: ['stale'] })) return 'failed';
      continue;
    }

    // The label belongs to this cycle when it was applied after the notice
    // and not removed since.
    const ours = labeledAt !== null && labeledAt >= markedAt &&
      !staleEvents('unlabeled').some(e => eventTime(e) >= markedAt && eventTime(e) <= labeledAt);

    if (!hasStaleLabel) {
      // Asked before. Without a stale label applied after the notice, the
      // labelling failed and is completed now; otherwise the label was
      // removed after a reply and the issue is not asked again.
      if (labeledAt !== null && labeledAt >= markedAt) continue;
      if (!trigger) continue;
      console.log(`[Stale Bot] Issue #${n} has the stale notice but not the label. Adding it.`);
      if (!await ensureStaleLabel(token, repo, rule, state)) return 'failed';
      if (!await staleWrite(token, rule, 'POST', `${issueUrl}/labels`, { labels: ['stale'] })) return 'failed';
      continue;
    }
    if (!ours) continue;

    if (!trigger || hasRealActivitySince(issue.timeline, new Date(labeledAt), ignoredLogins)) {
      console.log(`[Stale Bot] Issue #${n} is no longer stale. Removing stale label.`);
      if (!await staleWrite(token, rule, 'DELETE', `${issueUrl}/labels/stale`)) return 'failed';
      continue;
    }
    if (!rule.close || labeledAt >= closeBefore.getTime()) continue;

    console.log(`[Stale Bot] Closing stale issue #${n}`);
    const closedAt = ownNotice(ISSUE_CLOSED);
    if (closedAt === null || closedAt < labeledAt) {
      if (!await staleWrite(token, rule, 'POST', `${issueUrl}/comments`, {
        body: `This issue was closed because it had been marked stale for ${rule.days_until_close} days with no reply.\n\nIf the problem still happens on a supported release or a snapshot, comment with the version you tested and ask a maintainer to reopen it.\n\n${ISSUE_CLOSED}`
      })) return 'failed';
    }
    if (!await staleWrite(token, rule, 'PATCH', issueUrl, { state: 'closed', state_reason: 'not_planned' })) return 'failed';
  }
  return 'ok';
}
export async function handleScheduled(env) {
  const now = Date.now();

  try {
    console.log('[Stale Bot] Starting daily stale PR verification scan...');

    // 1. Generate App JWT to list all installations
    const jwt = await generateJWT(env.APP_ID, env.PRIVATE_KEY);

    const installationsResult = await paginateAll(
      'https://api.github.com/app/installations?per_page=100', jwt, 'fetching installations');
    if (installationsResult.outcome === 'fatal' || installationsResult.outcome === 'limited') {
      return;
    }
    const installations = installationsResult.items;

    console.log(`[Stale Bot] Found ${installations.length} active GitHub App installations.`);

    for (const inst of installations) {
      const installationId = inst.id;
      const accountLogin = inst.account?.login || 'unknown';
      console.log(`[Stale Bot] Scanning installation ID ${installationId} (${accountLogin})...`);

      // 2. Get access token for this installation (reuse the app JWT to avoid re-signing per installation)
      const tokenRes = await githubApiCall(`https://api.github.com/app/installations/${installationId}/access_tokens`, jwt, 'POST');
      const token = tokenRes.data?.token || null;
      if (!token) {
        console.error(`[Stale Bot] Could not retrieve token for installation ID ${installationId}`);
        continue;
      }

      // 3. List all repositories accessible by this installation
      const reposResult = await paginateAll(
        'https://api.github.com/installation/repositories?per_page=100', token,
        `fetching repositories for installation ${installationId}`,
        { pick: (data) => data?.repositories });
      if (reposResult.outcome === 'fatal') {
        return;
      }
      if (reposResult.outcome === 'limited') {
        continue;
      }
      const repositories = reposResult.items;

      console.log(`[Stale Bot] Installation has access to ${repositories.length} repositories.`);

      for (const repoObj of repositories) {
        const repo = repoObj.full_name;
        console.log(`[Stale Bot] Scanning repository: ${repo}`);

        try {
          // One query answers both questions that decide whether this
          // repository is scanned: what its configuration says, and whether
          // the `stale` label exists.
          const setup = await fetchStaleRepoSetup(token, repo);
          if (setup.outcome === 'fatal') {
            return;
          }
          if (setup.outcome !== 'ok') {
            console.warn(`[Stale Bot] Skipping repository ${repo}.`);
            continue;
          }

          // Disabled by default. Only enable if explicitly defined as true.
          let repoConfig = null;
          if (setup.configText !== null) {
            try {
              repoConfig = JSON.parse(setup.configText);
            } catch (e) {
              console.error(`[Stale Bot] Failed to parse formalities.json for ${repo}`);
            }
          }

          const rules = staleRules(repoConfig);
          const prRule = rules.pull_requests;
          if (!rules.issues.enabled && !(prRule.enabled && prRule.labels.length > 0)) {
            console.log(`[Stale Bot] Stale bot is disabled for repository: ${repo}. Skipping.`);
            continue;
          }

          const ignoredLogins = new Set(rules.ignored_users.map(u => u.toLowerCase()));
          const labelState = { staleLabelExists: setup.staleLabelExists };

          if (rules.issues.enabled) {
            const issueOutcome = await scanStaleIssues(token, repo, rules.issues, ignoredLogins, labelState, now);
            if (issueOutcome === 'fatal') {
              return;
            }
            if (issueOutcome !== 'ok') {
              console.warn(`[Stale Bot] Skipping issues of repository ${repo}.`);
            }
          }
          if (!prRule.enabled || prRule.labels.length === 0) {
            continue;
          }
          const staleThresholdDate = new Date(now - prRule.days_until_stale * DAY_MS);
          const closeThresholdDate = new Date(now - prRule.days_until_close * DAY_MS);
          const candidateLabels = new Set(prRule.labels.map(l => l.toLowerCase()));

          // 4. The open pull requests carrying either label, each with its
          // recent timeline attached. GraphQL reads the label list as "any
          // of", so one query replaces the two REST listings that had to be
          // merged by hand - and the timelines no longer cost one request per
          // pull request.
          const prsResult = await fetchStalePullRequests(token, repo, [...prRule.labels, 'stale']);
          if (prsResult.outcome === 'fatal') {
            return;
          }
          if (prsResult.outcome !== 'ok') {
            console.warn(`[Stale Bot] Skipping repository ${repo}.`);
            continue;
          }

          const prs = prsResult.prs;
          console.log(`[Stale Bot] Found ${prs.length} open PRs to verify in ${repo}`);

          for (const pr of prs) {
            const prNumber = pr.number;
            const updatedAt = new Date(pr.updated_at);
            const hasStaleLabel = pr.labels.some(l => l.name.toLowerCase() === 'stale');
            const trigger = pr.labels.find(l => candidateLabels.has(l.name.toLowerCase()))?.name;

            console.log(`[Stale Bot] Processing PR #${prNumber} (Updated: ${pr.updated_at}, hasStaleLabel: ${hasStaleLabel}, candidate label: ${trigger || 'none'})`);

            // If it has a stale label but no longer carries a candidate label (resolved), remove stale label immediately
            if (hasStaleLabel && !trigger) {
              console.log(`[Stale Bot] PR #${prNumber} has stale label but none of ${prRule.labels.join(', ')}. Removing stale label.`);
              const labelUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/labels/stale`;
              await staleWrite(token, prRule, 'DELETE', labelUrl);
              continue;
            }

            if (hasStaleLabel) {
              // The timeline arrived with the listing above. It carries both
              // when the stale label was applied and who did what since -
              // unlike the plain events listing, it also contains comments,
              // reviews and commits with their actors.
              const staleLabeledEvent = pr.timeline
                .filter(e => e.event === 'labeled' && e.label?.name === 'stale')
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

              let labeledAt = null;
              if (staleLabeledEvent) {
                labeledAt = new Date(staleLabeledEvent.created_at);
              }

              if (labeledAt) {
                // Only contributor activity clears the label: pushes, or
                // comments/reviews from someone who is not a bot. Anything a
                // bot posts after the labeling must not restart the cycle.
                if (hasRealActivitySince(pr.timeline, labeledAt, ignoredLogins)) {
                  console.log(`[Stale Bot] PR #${prNumber} is active again (contributor activity after stale labeling). Removing stale label.`);
                  const labelUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/labels/stale`;
                  await staleWrite(token, prRule, 'DELETE', labelUrl);
                } else if (prRule.close && labeledAt < closeThresholdDate) {
                  console.log(`[Stale Bot] Closing stale PR #${prNumber}`);

                  // Post closing comment
                  const commentsUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
                  const commentBody = `This pull request was closed because it had been marked stale for ${prRule.days_until_close} days with no activity.\n\nIf you would like to continue working on it, fix the reported issues and ask a maintainer to reopen it — or open a new pull request with the updated changes.`;
                  await staleWrite(token, prRule, 'POST', commentsUrl, { body: commentBody });

                  // Close PR
                  const prUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
                  await staleWrite(token, prRule, 'PATCH', prUrl, { state: 'closed' });
                } else {
                  console.log(`[Stale Bot] PR #${prNumber} is stale but close threshold not reached yet (labeled stale on: ${labeledAt}). Skipping.`);
                }
              } else if (pr.timelineTruncated) {
                console.log(`[Stale Bot] PR #${prNumber} has a timeline longer than the fetched window and no stale labelling event in it. Skipping.`);
              } else {
                // Fallback: If stale label is present but no labeling event was found (unlikely), check updatedAt
                if (prRule.close && updatedAt < closeThresholdDate) {
                  console.log(`[Stale Bot] Closing stale PR #${prNumber} (fallback, no event found)`);
                  const prUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
                  await staleWrite(token, prRule, 'PATCH', prUrl, { state: 'closed' });
                } else {
                  console.log(`[Stale Bot] PR #${prNumber} has stale label but no event found and is recently updated. Skipping.`);
                }
              }

            } else {
              // PR does not have the stale label. Mark it stale if it's inactive and violates guidelines.
              if (updatedAt < staleThresholdDate && trigger) {
                console.log(`[Stale Bot] Marking PR #${prNumber} as stale`);

                // Ensure "stale" label exists
                await ensureStaleLabel(token, repo, prRule, labelState);

                // Add "stale" label
                const labelsUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/labels`;
                await staleWrite(token, prRule, 'POST', labelsUrl, { labels: ['stale'] });

                // Post warning comment
                const commentsUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
                const closing = prRule.close ? `It will be closed if nothing happens within another ${prRule.days_until_close} days. ` : '';
                const commentBody = `This pull request has been marked stale because it has the "${trigger}" label and has seen no activity for ${prRule.days_until_stale} days.\n${closing}Updating your commits to fix the reported issues will remove the stale label automatically.`;
                await staleWrite(token, prRule, 'POST', commentsUrl, { body: commentBody });

              } else {
                console.log(`[Stale Bot] PR #${prNumber} is active or not guidelines-violating. Skipping.`);
              }
            }
          }
        } catch (repoErr) {
          console.error(`[Stale Bot] Error scanning repository ${repo}:`, repoErr);
        }
      }
    }
  } catch (err) {
    console.error('[Stale Bot] Global error in scheduled scan execution:', err);
  }
}
