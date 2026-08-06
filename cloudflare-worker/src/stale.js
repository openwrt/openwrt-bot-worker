import { githubApiCall } from './github.js';
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
          // Fetch repository config from default branch to check if stale bot is disabled
          const configUrl = `https://api.github.com/repos/${repo}/contents/.github/formalities.json`;
          const resConfig = await githubApiCall(configUrl, token, 'GET', null, 'application/vnd.github.raw');

          if (resConfig.code === 403 || resConfig.code === 429) {
            if (resConfig.headers?.get('x-ratelimit-remaining') === '0') {
              console.error('[Stale Bot] GitHub API rate limit reached fetching config. Exiting gracefully.');
              return;
            }
            console.warn(`[Stale Bot] HTTP ${resConfig.code} fetching config for repository: ${repo}. Skipping this repository.`);
            continue;
          }

          // Disabled by default. Only enable if explicitly defined as true.
          let enableStaleBot = false;
          let repoConfig = null;
          if (resConfig.code === 200) {
            try {
              repoConfig = JSON.parse(resConfig.raw);
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

          // Fetch repository labels, stopping early once the stale label shows up
          const labelsResult = await paginateAll(
            `https://api.github.com/repos/${repo}/labels?per_page=100`, token,
            `fetching labels for repository ${repo}`,
            { stop: (items) => items.some(l => l.name.toLowerCase() === 'stale') });
          if (labelsResult.outcome === 'fatal') {
            return;
          }
          if (labelsResult.outcome !== 'ok') {
            console.warn(`[Stale Bot] Skipping repository ${repo}.`);
            continue;
          }
          const repoLabels = new Set(labelsResult.items.map(l => l.name.toLowerCase()));

          // 4. Query issues API for open PRs with guidelines label OR stale label.
          // The REST issues listing treats multiple labels as AND, so the OR
          // needs one query per label, deduplicated by PR number.
          const prMap = new Map();
          let skipRepoIssues = false;
          for (const labelName of [LABEL_GUIDELINES, 'stale']) {
            const issuesResult = await paginateAll(
              `https://api.github.com/repos/${repo}/issues?state=open&labels=${encodeURIComponent(labelName)}&per_page=100`,
              token, `querying issues for ${repo}`);
            if (issuesResult.outcome === 'fatal') {
              return;
            }
            if (issuesResult.outcome === 'limited') {
              skipRepoIssues = true;
              break;
            }
            for (const item of issuesResult.items) {
              if (item.pull_request) {
                prMap.set(item.number, item);
              }
            }
          }
          if (skipRepoIssues) {
            console.warn(`[Stale Bot] Skipping repository ${repo}.`);
            continue;
          }

          const prs = Array.from(prMap.values());
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
              // The timeline carries both when the stale label was applied and
              // who did what since - unlike the plain events listing, it also
              // contains comments, reviews and commits with their actors.
              const timelineResult = await paginateAll(
                `https://api.github.com/repos/${repo}/issues/${prNumber}/timeline?per_page=100`, token,
                `fetching timeline for PR #${prNumber}`);
              if (timelineResult.outcome === 'fatal') {
                return;
              }
              if (timelineResult.outcome !== 'ok') {
                console.warn(`[Stale Bot] Skipping PR #${prNumber}.`);
                continue;
              }

              const staleLabeledEvent = timelineResult.items
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
                if (hasRealActivitySince(timelineResult.items, labeledAt, ignoredLogins)) {
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
                if (!repoLabels.has('stale')) {
                  const createLabelUrl = `https://api.github.com/repos/${repo}/labels`;
                  await githubApiCall(createLabelUrl, token, 'POST', {
                    name: 'stale',
                    color: '6b7280',
                    description: 'This PR has been marked stale due to inactivity'
                  });
                  repoLabels.add('stale');
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
