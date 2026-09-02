import { githubApiCall, GRAPHQL_URL } from './github.js';
import { generateJWT } from './crypto.js';
import { LABEL_GUIDELINES, DEFAULT_CONFIG } from './config.js';

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
  if (res.code !== 200 || !res.data?.data?.repository) {
    const errors = res.data?.errors?.map(e => e.message).join('; ');
    console.error(`[Stale Bot] Failed ${label} (HTTP ${res.code}): ${errors || (res.raw || '').trim().slice(0, 200)}`);
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
        items.push({ event: 'commented', created_at: node.createdAt, actor: actorFromGraphql(node.author) });
        break;
      case 'PullRequestReview':
        items.push({ event: 'reviewed', submitted_at: node.submittedAt, user: actorFromGraphql(node.author) });
        break;
      case 'LabeledEvent':
        items.push({ event: 'labeled', created_at: node.createdAt, label: { name: node.label?.name } });
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

  const prs = [];
  let after = null;
  while (true) {
    const res = await githubApiCall(GRAPHQL_URL, token, 'POST', {
      query,
      variables: { owner, name, labels: labelNames, after }
    });
    const outcome = graphqlOutcome(res, `querying pull requests for ${repo}`);
    if (outcome !== 'ok') return { outcome, prs };
    const page = res.data.data.repository.pullRequests;
    for (const node of page?.nodes || []) {
      prs.push({
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
    if (!page?.pageInfo?.hasNextPage) return { outcome: 'ok', prs };
    after = page.pageInfo.endCursor;
  }
}

export async function handleScheduled(env) {
  // Expiration periods:
  // 14 days = 14 * 24 * 60 * 60 * 1000 milliseconds
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const staleThresholdDate = new Date(now - fourteenDaysMs);

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
          let enableStaleBot = false;
          let repoConfig = null;
          if (setup.configText !== null) {
            try {
              repoConfig = JSON.parse(setup.configText);
              if (repoConfig && typeof repoConfig === 'object' && repoConfig.enable_stale_bot === true) {
                enableStaleBot = true;
              }
            } catch (e) {
              console.error(`[Stale Bot] Failed to parse formalities.json for ${repo}`);
            }
          }

          if (!enableStaleBot) {
            console.log(`[Stale Bot] Stale bot is disabled for repository: ${repo}. Skipping.`);
            continue;
          }

          const ignoredUserList = Array.isArray(repoConfig?.stale_ignored_users)
            ? repoConfig.stale_ignored_users
            : DEFAULT_CONFIG.stale_ignored_users;
          const ignoredLogins = new Set(ignoredUserList.map(u => String(u).toLowerCase()));
          let staleLabelExists = setup.staleLabelExists;

          // 4. The open pull requests carrying either label, each with its
          // recent timeline attached. GraphQL reads the label list as "any
          // of", so one query replaces the two REST listings that had to be
          // merged by hand - and the timelines no longer cost one request per
          // pull request.
          const prsResult = await fetchStalePullRequests(token, repo, [LABEL_GUIDELINES, 'stale']);
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
            const hasGuidelinesLabel = pr.labels.some(l => l.name.toLowerCase() === LABEL_GUIDELINES.toLowerCase());

            console.log(`[Stale Bot] Processing PR #${prNumber} (Updated: ${pr.updated_at}, hasStaleLabel: ${hasStaleLabel}, hasGuidelinesLabel: ${hasGuidelinesLabel})`);

            // If it has a stale label but no longer violates guidelines (resolved), remove stale label immediately
            if (hasStaleLabel && !hasGuidelinesLabel) {
              console.log(`[Stale Bot] PR #${prNumber} has stale label but no longer has "${LABEL_GUIDELINES}". Removing stale label.`);
              const labelUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/labels/stale`;
              await githubApiCall(labelUrl, token, 'DELETE');
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
                  await githubApiCall(labelUrl, token, 'DELETE');
                } else if (labeledAt < staleThresholdDate) {
                  console.log(`[Stale Bot] Closing stale PR #${prNumber}`);

                  // Post closing comment
                  const commentsUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
                  const commentBody = `This pull request was closed because it had been marked stale for 14 days with no activity.\n\nIf you would like to continue working on it, fix the reported issues and ask a maintainer to reopen it — or open a new pull request with the updated changes.`;
                  await githubApiCall(commentsUrl, token, 'POST', { body: commentBody });

                  // Close PR
                  const prUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
                  await githubApiCall(prUrl, token, 'PATCH', { state: 'closed' });
                } else {
                  console.log(`[Stale Bot] PR #${prNumber} is stale but close threshold not reached yet (labeled stale on: ${labeledAt}). Skipping.`);
                }
              } else if (pr.timelineTruncated) {
                console.log(`[Stale Bot] PR #${prNumber} has a timeline longer than the fetched window and no stale labelling event in it. Skipping.`);
              } else {
                // Fallback: If stale label is present but no labeling event was found (unlikely), check updatedAt
                if (updatedAt < staleThresholdDate) {
                  console.log(`[Stale Bot] Closing stale PR #${prNumber} (fallback, no event found)`);
                  const prUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
                  await githubApiCall(prUrl, token, 'PATCH', { state: 'closed' });
                } else {
                  console.log(`[Stale Bot] PR #${prNumber} has stale label but no event found and is recently updated. Skipping.`);
                }
              }

            } else {
              // PR does not have the stale label. Mark it stale if it's inactive and violates guidelines.
              if (updatedAt < staleThresholdDate && hasGuidelinesLabel) {
                console.log(`[Stale Bot] Marking PR #${prNumber} as stale`);

                // Ensure "stale" label exists
                if (!staleLabelExists) {
                  const createLabelUrl = `https://api.github.com/repos/${repo}/labels`;
                  await githubApiCall(createLabelUrl, token, 'POST', {
                    name: 'stale',
                    color: '6b7280',
                    description: 'This PR has been marked stale due to inactivity'
                  });
                  staleLabelExists = true;
                }

                // Add "stale" label
                const labelsUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/labels`;
                await githubApiCall(labelsUrl, token, 'POST', { labels: ['stale'] });

                // Post warning comment
                const commentsUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
                const commentBody = `This pull request has been marked stale because it has the "${LABEL_GUIDELINES}" label and has seen no activity for 14 days.\nIt will be closed if nothing happens within another 14 days. Updating your commits to fix the reported issues will remove the stale label automatically.`;
                await githubApiCall(commentsUrl, token, 'POST', { body: commentBody });

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
