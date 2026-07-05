import { githubApiCall } from './github.js';
import { generateJWT, getInstallationToken } from './crypto.js';
import { LABEL_GUIDELINES } from './config.js';

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
    
    let installations = [];
    let installationsUrl = 'https://api.github.com/app/installations?per_page=100';
    while (installationsUrl) {
      const resInstallations = await githubApiCall(installationsUrl, jwt);
      if (resInstallations.code === 403 || resInstallations.code === 429) {
        const remaining = resInstallations.headers?.get('x-ratelimit-remaining');
        if (remaining === '0') {
          console.error('[Stale Bot] GitHub API rate limit reached fetching installations. Exiting gracefully.');
          return;
        }
        console.error(`[Stale Bot] Rate limit or abuse limit hit fetching installations (HTTP ${resInstallations.code}). Exiting gracefully.`);
        return;
      }
      if (resInstallations.code !== 200) {
        console.error(`[Stale Bot] Failed to fetch installations: ${resInstallations.raw}`);
        break;
      }
      const list = resInstallations.data || [];
      installations = installations.concat(list);

      const linkHeader = resInstallations.headers?.get('link');
      installationsUrl = null;
      if (linkHeader) {
        const links = parseLinkHeader(linkHeader);
        if (links.next) {
          installationsUrl = links.next;
        }
      }
    }

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
      let repositories = [];
      let reposUrl = 'https://api.github.com/installation/repositories?per_page=100';
      let skipInstallation = false;
      while (reposUrl) {
        const resRepos = await githubApiCall(reposUrl, token);
        if (resRepos.code === 403 || resRepos.code === 429) {
          const remaining = resRepos.headers?.get('x-ratelimit-remaining');
          if (remaining === '0') {
            console.error('[Stale Bot] GitHub API rate limit reached fetching repositories. Exiting gracefully.');
            return;
          }
          console.warn(`[Stale Bot] HTTP ${resRepos.code} fetching repositories for installation ${installationId}. Skipping this installation.`);
          skipInstallation = true;
          break;
        }
        if (resRepos.code !== 200) {
          console.error(`[Stale Bot] Failed to fetch repositories for installation ID ${installationId}: ${resRepos.raw}`);
          break;
        }
        const list = resRepos.data?.repositories || [];
        repositories = repositories.concat(list);

        const linkHeader = resRepos.headers?.get('link');
        reposUrl = null;
        if (linkHeader) {
          const links = parseLinkHeader(linkHeader);
          if (links.next) {
            reposUrl = links.next;
          }
        }
      }

      if (skipInstallation) {
        continue;
      }

      console.log(`[Stale Bot] Installation has access to ${repositories.length} repositories.`);

      for (const repoObj of repositories) {
        const repo = repoObj.full_name;
        console.log(`[Stale Bot] Scanning repository: ${repo}`);

        try {
          // Fetch repository config from default branch to check if stale bot is disabled
          const configUrl = `https://api.github.com/repos/${repo}/contents/.github/formalities.json`;
          const resConfig = await githubApiCall(configUrl, token, 'GET', null, 'application/vnd.github.raw');
          
          if (resConfig.code === 403 || resConfig.code === 429) {
            const remaining = resConfig.headers?.get('x-ratelimit-remaining');
            if (remaining === '0') {
              console.error('[Stale Bot] GitHub API rate limit reached fetching config. Exiting gracefully.');
              return;
            }
            console.warn(`[Stale Bot] HTTP ${resConfig.code} fetching config for repository: ${repo}. Skipping this repository.`);
            continue;
          }

          // Disabled by default. Only enable if explicitly defined as true.
          let enableStaleBot = false;
          if (resConfig.code === 200) {
            try {
              const repoConfig = JSON.parse(resConfig.raw);
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

          // Fetch repository labels with pagination (optimizing with early breakout)
          let repoLabels = new Set();
          let repoLabelsUrl = `https://api.github.com/repos/${repo}/labels?per_page=100`;
          let skipRepoLabels = false;
          while (repoLabelsUrl) {
            const resRepoLabels = await githubApiCall(repoLabelsUrl, token);
            if (resRepoLabels.code === 403 || resRepoLabels.code === 429) {
              const remaining = resRepoLabels.headers?.get('x-ratelimit-remaining');
              if (remaining === '0') {
                console.error('[Stale Bot] GitHub API rate limit reached fetching repository labels. Exiting gracefully.');
                return;
              }
              console.warn(`[Stale Bot] HTTP ${resRepoLabels.code} fetching labels for repository ${repo}. Skipping this repository.`);
              skipRepoLabels = true;
              break;
            }
            if (resRepoLabels.code !== 200) {
              console.error(`[Stale Bot] Failed to fetch repository labels for ${repo} (HTTP ${resRepoLabels.code}): ${resRepoLabels.raw}`);
              skipRepoLabels = true;
              break;
            }
            const list = resRepoLabels.data || [];
            list.forEach(l => repoLabels.add(l.name.toLowerCase()));

            // Optimizing: break out early if stale label exists
            if (repoLabels.has('stale')) {
              break;
            }

            const linkHeader = resRepoLabels.headers?.get('link');
            repoLabelsUrl = null;
            if (linkHeader) {
              const links = parseLinkHeader(linkHeader);
              if (links.next) {
                repoLabelsUrl = links.next;
              }
            }
          }

          if (skipRepoLabels) {
            continue;
          }

          // 4. Query issues API for open PRs with guidelines label OR stale label
          let prMap = new Map();

          // Query 1: Open issues with guidelines label
          let issuesUrl1 = `https://api.github.com/repos/${repo}/issues?state=open&labels=${encodeURIComponent(LABEL_GUIDELINES)}&per_page=100`;
          while (issuesUrl1) {
            const resIssues1 = await githubApiCall(issuesUrl1, token);
            if (resIssues1.code === 403 || resIssues1.code === 429) {
              const remaining = resIssues1.headers?.get('x-ratelimit-remaining');
              if (remaining === '0') {
                console.error('[Stale Bot] GitHub API rate limit reached querying issues. Exiting gracefully.');
                return;
              }
              console.error(`[Stale Bot] Rate limit or abuse limit hit querying issues (HTTP ${resIssues1.code}). Exiting gracefully.`);
              return;
            }
            if (resIssues1.code !== 200) {
              console.error(`[Stale Bot] Issues query failed for ${repo} with code ${resIssues1.code}: ${resIssues1.raw}`);
              break;
            }
            const items = resIssues1.data || [];
            items.forEach(item => {
              if (item.pull_request) {
                prMap.set(item.number, item);
              }
            });

            const linkHeader = resIssues1.headers?.get('link');
            issuesUrl1 = null;
            if (linkHeader) {
              const links = parseLinkHeader(linkHeader);
              if (links.next) {
                issuesUrl1 = links.next;
              }
            }
          }

          // Query 2: Open issues with stale label
          let issuesUrl2 = `https://api.github.com/repos/${repo}/issues?state=open&labels=stale&per_page=100`;
          while (issuesUrl2) {
            const resIssues2 = await githubApiCall(issuesUrl2, token);
            if (resIssues2.code === 403 || resIssues2.code === 429) {
              const remaining = resIssues2.headers?.get('x-ratelimit-remaining');
              if (remaining === '0') {
                console.error('[Stale Bot] GitHub API rate limit reached querying issues. Exiting gracefully.');
                return;
              }
              console.error(`[Stale Bot] Rate limit or abuse limit hit querying issues (HTTP ${resIssues2.code}). Exiting gracefully.`);
              return;
            }
            if (resIssues2.code !== 200) {
              console.error(`[Stale Bot] Issues query failed for ${repo} with code ${resIssues2.code}: ${resIssues2.raw}`);
              break;
            }
            const items = resIssues2.data || [];
            items.forEach(item => {
              if (item.pull_request) {
                prMap.set(item.number, item);
              }
            });

            const linkHeader = resIssues2.headers?.get('link');
            issuesUrl2 = null;
            if (linkHeader) {
              const links = parseLinkHeader(linkHeader);
              if (links.next) {
                issuesUrl2 = links.next;
              }
            }
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
              // If it already has the stale label, fetch events to check when the stale label was added
              let events = [];
              let eventsUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/events?per_page=100`;
              let skipPr = false;
              while (eventsUrl) {
                const resEvents = await githubApiCall(eventsUrl, token);
                if (resEvents.code === 403 || resEvents.code === 429) {
                  const remaining = resEvents.headers?.get('x-ratelimit-remaining');
                  if (remaining === '0') {
                    console.error('[Stale Bot] GitHub API rate limit reached fetching events. Exiting gracefully.');
                    return;
                  }
                  console.warn(`[Stale Bot] HTTP ${resEvents.code} fetching events for PR #${prNumber}. Skipping this PR.`);
                  skipPr = true;
                  break;
                }
                if (resEvents.code !== 200) {
                  console.error(`[Stale Bot] Failed to fetch events for PR #${prNumber} (HTTP ${resEvents.code}): ${resEvents.raw}`);
                  skipPr = true;
                  break;
                }
                const list = resEvents.data || [];
                events = events.concat(list);

                const linkHeader = resEvents.headers?.get('link');
                eventsUrl = null;
                if (linkHeader) {
                  const links = parseLinkHeader(linkHeader);
                  if (links.next) {
                    eventsUrl = links.next;
                  }
                }
              }

              if (skipPr) {
                continue;
              }

              const staleLabeledEvent = events
                .filter(e => e.event === 'labeled' && e.label?.name === 'stale')
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

              let labeledAt = null;
              if (staleLabeledEvent) {
                labeledAt = new Date(staleLabeledEvent.created_at);
              }

              if (labeledAt) {
                // If there has been activity since the stale label was applied (buffer to ignore bot's own label/comment update)
                if (updatedAt.getTime() > labeledAt.getTime() + 60 * 1000) {
                  console.log(`[Stale Bot] PR #${prNumber} is active again (activity detected after stale labeling). Removing stale label.`);
                  const labelUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/labels/stale`;
                  await githubApiCall(labelUrl, token, 'DELETE');
                } else if (labeledAt < staleThresholdDate) {
                  console.log(`[Stale Bot] Closing stale PR #${prNumber}`);

                  // Post closing comment
                  const commentsUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
                  const commentBody = `This PR was closed because it has been marked stale for 14 days with no activity.`;
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
                const commentBody = `This PR is stale because it has been inactive for 14 days and has the "${LABEL_GUIDELINES}" label.\nIt will be closed if no further activity occurs within 14 days.`;
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
