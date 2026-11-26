import { graphqlBatchFetchFiles, wasAttemptDeclined, MAX_ATTEMPTS } from '../github.js';
import { isOwnAppComment } from '../issue-labeller.js';
import { createGitHubClient } from '../core/github-client.ts';
import { parseEnvInt } from '../core/utils.ts';
import { parseTesterEntries, matchTesters } from '../core/testers.ts';
import type { Env, SubrequestBudget } from '../types/env.ts';

export const TESTER_PING_LABEL = 'RFT';
export const TESTER_PING_MARKER = '<!-- tester-ping -->';
// GitHub's search order.
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
const MAX_FILE_PAGES = 10;
const MAX_COMMENT_PAGES = 10;
// GitHub is reported to notify at most 50 mentions of one comment.
const MAX_MENTIONS = 50;
const MENTION = /@([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})/g;

const reply = (text: string, status = 200) => new Response(text, { status });

// A ping cannot be taken back, so whatever the bot cannot read ends the run
// without one.
export async function handleTesterPing(
  data: any,
  token: string,
  repoFullname: string,
  appId: number | null,
  env?: Env,
  tokenMintAttempts = 0
): Promise<Response> {
  // The reads may use all but the attempts the one comment needs.
  const budget: SubrequestBudget = {
    limit: parseEnvInt(env?.SUBREQUEST_BUDGET_LIMIT, 45),
    reserve: MAX_ATTEMPTS,
    used: tokenMintAttempts
  };
  const outOfBudget = () => reply('Ran out of requests before every file and comment was read, so nobody was pinged');
  const client = createGitHubClient(token, budget);
  const prNumber = data.pull_request.number;
  const api = `https://api.github.com/repos/${repoFullname}`;

  // From the default branch, like the issue labeller, so that a pull request
  // cannot change whom it pings and a release branch needs no copy.
  const defaultBranch = data.repository?.default_branch || 'main';
  const files = await graphqlBatchFetchFiles(token,
    CODEOWNERS_PATHS.map(path => ({ key: path, repoFullname, ref: defaultBranch, path })),
    () => { budget.used++; return true; });
  let source: string | null = null;
  let text: string | null = null;
  for (const path of CODEOWNERS_PATHS) {
    const res = files.get(path);
    if (res?.error || res?.failed) throw new Error(`${path} on ${defaultBranch} of ${repoFullname} could not be read`);
    // The first file that exists is the one GitHub uses, even when empty.
    if (res?.exists) {
      source = path;
      text = res.content || '';
      break;
    }
  }
  if (!source) return reply(`No CODEOWNERS on ${defaultBranch}`);

  const { entries, problems } = parseTesterEntries(text);
  problems.forEach(problem => console.warn(`${source} in ${repoFullname}: ${problem}`));
  if (entries.length === 0) return reply(`No testers in ${source}`);

  const changed: string[] = [];
  let filesCapped = false;
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const res = await client.optionalApiCall<any[]>(`${api}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    if (wasAttemptDeclined(res)) return outOfBudget();
    if (res.code !== 200 || !Array.isArray(res.data)) throw new Error(`Could not list the files of pull request #${prNumber} (HTTP ${res.code})`);
    for (const file of res.data) {
      changed.push(file.filename);
      if (file.previous_filename) changed.push(file.previous_filename);
    }
    if (res.data.length < 100) break;
    if (page === MAX_FILE_PAGES) filesCapped = true;
  }

  const testers = matchTesters(entries, changed);
  for (const login of [data.pull_request.user?.login, data.sender?.login]) {
    if (login) testers.delete(login.toLowerCase());
  }
  if (testers.size === 0) return reply('No testers for the changed files');

  const pinged = new Set<string>();
  for (let page = 1; ; page++) {
    if (page > MAX_COMMENT_PAGES) return reply('Too many comments to tell who was already pinged, so nobody was');
    const res = await client.optionalApiCall<any[]>(`${api}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (wasAttemptDeclined(res)) return outOfBudget();
    if (res.code !== 200 || !Array.isArray(res.data)) throw new Error(`Could not list the comments of pull request #${prNumber} (HTTP ${res.code})`);
    for (const comment of res.data) {
      if (!isOwnAppComment(comment, appId) || !(comment.body || '').includes(TESTER_PING_MARKER)) continue;
      for (const mention of comment.body.matchAll(MENTION)) pinged.add(mention[1].toLowerCase());
    }
    if (res.data.length < 100) break;
  }

  const fresh = [...testers].filter(([key]) => !pinged.has(key)).map(([, login]) => login);
  if (fresh.length === 0) return reply('Every tester was already pinged');
  const mentioned = fresh.slice(0, MAX_MENTIONS);

  let body = `${TESTER_PING_MARKER}\n${mentioned.map(login => `@${login}`).join(' ')}: this pull request is ready for testing. \`${source}\` lists you for the files it changes.`;
  if (filesCapped) body += `\n\nOnly its first ${MAX_FILE_PAGES * 100} files were matched.`;
  if (fresh.length > mentioned.length) body += `\n\n${fresh.length - mentioned.length} more testers were left out to keep this comment to ${MAX_MENTIONS} mentions. Removing the label and adding it again mentions them.`;

  const post = await client.trackedApiCall(`${api}/issues/${prNumber}/comments`, 'POST', { body });
  if (post.code !== 201) throw new Error(`Could not post the tester ping on pull request #${prNumber} (HTTP ${post.code})`);
  return reply(`Success: pinged ${mentioned.length} testers on pull request #${prNumber}`);
}
