// Tester ping: adding the trigger label (RFT by default) to a PR mentions
// the testers listed in .github/testers for the labels on that PR.

import { githubApiCall } from './github.js';
import { isOwnAppComment } from './issue-labeller.js';

export const TESTER_PING_MARKER = '<!-- tester-ping -->';
export const TESTERS_PATH = '.github/testers';

// GitHub login rules: letters, numbers and single hyphens, max 39 chars.
// This also keeps out team slugs like org/team.
const LOGIN_PATTERN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;

const MAX_COMMENT_PAGES = 10;

// Parse the testers file for the labels on a PR. Format is a label, then one
// or more logins, # starts a comment:
//
//   target/x86 alice bob  # x86/64: APU2
//
// Some labels have spaces in them (core packages) so we can't just split on
// the first space. Match each line against all repo labels, longest first,
// then keep it only if the PR has that label. Matching on the PR labels alone
// means 'core packages carol' on a PR labeled 'core' would ping @packages.
// Labels are case-insensitive like on GitHub.
//
// repoLabels is the lowercased set from graphqlFetchRepoLabels.
// Returns { testers: Map<label, Map<lowercased login, login>>, invalid: [] }.
export function parseTesters(text, prLabels, repoLabels = new Set()) {
  const testers = new Map();
  const invalid = [];
  if (!text) return { testers, invalid };

  // lowercased label -> label as spelled on the PR
  const onPr = new Map(prLabels.map(l => [l.toLowerCase(), l]));
  const known = [...new Set([...repoLabels, ...onPr.keys()])]
    .sort((a, b) => b.length - a.length);

  for (const raw of text.split('\n')) {
    const hashIndex = raw.indexOf('#');
    const line = (hashIndex === -1 ? raw : raw.slice(0, hashIndex)).trim();
    if (!line) continue;

    const lower = line.toLowerCase();
    const match = known.find(l => lower.startsWith(l) && /\s/.test(line[l.length] || ''));
    if (!match || !onPr.has(match)) continue;
    const label = onPr.get(match);

    for (const word of line.slice(match.length).trim().split(/\s+/)) {
      const login = word.replace(/^@/, '');
      if (!LOGIN_PATTERN.test(login)) {
        invalid.push({ label, login: word });
        continue;
      }
      if (!testers.has(label)) testers.set(label, new Map());
      testers.get(label).set(login.toLowerCase(), login);
    }
  }

  return { testers, invalid };
}

// Logins (lowercased) already pinged by an earlier comment from this app.
// Only look at the @mentions at the end of each '- label: @a @b' line so
// nothing inside a label gets picked up.
export function previouslyPinged(comments, appId) {
  const pinged = new Set();
  for (const c of comments) {
    if (!isOwnAppComment(c, appId) || !(c.body || '').includes(TESTER_PING_MARKER)) continue;
    for (const line of c.body.split('\n')) {
      const list = line.startsWith('- ') && line.match(/:((?:\s+@[A-Za-z0-9-]+)+)\s*$/);
      if (!list) continue;
      for (const m of list[1].matchAll(/@([A-Za-z0-9-]+)/g)) {
        pinged.add(m[1].toLowerCase());
      }
    }
  }
  return pinged;
}

// Put the label in a code span so any markdown or @mention in it shows up
// as plain text.
function codeSpan(text) {
  const longestRun = Math.max(0, ...(text.match(/`+/g) || []).map(r => r.length));
  const fence = '`'.repeat(longestRun + 1);
  return longestRun ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

// Build the comment, minus anyone in skip (lowercased logins). Someone listed
// under more than one label only shows up under the first one. Returns null
// if there is nobody left to ping.
export function buildTesterPingComment(testers, skip) {
  const seen = new Set(skip);
  const lines = [];
  for (const [label, logins] of [...testers].sort(([a], [b]) => a.localeCompare(b))) {
    const fresh = [...logins].filter(([key]) => !seen.has(key));
    if (!fresh.length) continue;
    for (const [key] of fresh) seen.add(key);
    lines.push(`- ${codeSpan(label)}: ${fresh.map(([, login]) => '@' + login).join(' ')}`);
  }

  if (!lines.length) return null;

  return [
    'Testing requested. If you have a device on one of these targets, please build this PR, run it and report back here.',
    '',
    ...lines,
    '',
    `To opt in or out, edit \`${TESTERS_PATH}\`.`,
    '',
    TESTER_PING_MARKER
  ].join('\n');
}

// Post the ping for a labeled pull_request event. testersText is the testers
// file from the default branch, repoLabels is the lowercased repo label set
// (see parseTesters). Testers only get pinged once per PR, so re-adding the
// label only picks up labels added since then. The PR author is skipped.
export async function handleTesterPing(data, token, repoFullname, testersText, repoLabels, appId = null, onCall) {
  const pr = data.pull_request;
  const prLabels = (pr.labels || []).map(l => (typeof l === 'string' ? l : l.name));

  const { testers, invalid } = parseTesters(testersText, prLabels, repoLabels);
  for (const { label, login } of invalid) {
    console.warn(`${TESTERS_PATH} in ${repoFullname}: ignoring invalid login '${login}' for ${label}`);
  }
  if (!testers.size) return 'No testers listed for the labels on this pull request';

  const comments = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    onCall?.();
    const listed = await githubApiCall(
      `https://api.github.com/repos/${repoFullname}/issues/${pr.number}/comments?per_page=100&page=${page}`,
      token
    );
    // Can't tell who was already pinged without the old comments, so bail
    // instead of pinging people twice.
    if (listed.code !== 200) {
      throw new Error(`Failed to list comments on #${pr.number} (HTTP ${listed.code})`);
    }
    const batch = listed.data || [];
    comments.push(...batch);
    if (batch.length < 100) break;
  }

  const skip = previouslyPinged(comments, appId);
  if (pr.user?.login) skip.add(pr.user.login.toLowerCase());

  const body = buildTesterPingComment(testers, skip);
  if (!body) return 'Every listed tester was pinged already';

  onCall?.();
  const posted = await githubApiCall(
    `https://api.github.com/repos/${repoFullname}/issues/${pr.number}/comments`,
    token, 'POST', { body }
  );
  if (posted.code !== 201) {
    throw new Error(`Failed to post tester ping on #${pr.number} (HTTP ${posted.code})`);
  }
  return `Pinged testers on #${pr.number}`;
}
