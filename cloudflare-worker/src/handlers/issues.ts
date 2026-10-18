import { parseAndValidateConfig } from '../types/config.ts';
import { graphqlBatchFetchFiles, graphqlFetchRepoLabels } from '../github.js';
import {
  handleIssueLabeller,
  applyIssueLabelling,
  parseIssueLabellerYaml,
  DEFAULT_ISSUE_LABELLER_CONFIG
} from '../issue-labeller.js';
import { isIssuesPayload, type IssuesEventPayload } from '../types/github.ts';
import { createGitHubClient } from '../core/github-client.ts';
import { parseEnvInt } from '../core/utils.ts';
import type { Env, SubrequestBudget } from '../types/env.ts';

export async function handleIssuesEvent(
  data: unknown,
  token: string,
  repoFullname: string,
  appId: number | null,
  env?: Env,
  tokenMintAttempts = 0
): Promise<Response> {
  if (!isIssuesPayload(data)) {
    return new Response("Invalid payload: expected issues event payload with issue object", { status: 400 });
  }

  // An issues event spends the same per-invocation subrequest budget as a
  // pull request one, so it uses the same shape: parseEnvInt keeps a
  // malformed value from poisoning the counter with NaN, the ceiling is the
  // one wrangler.toml configures, and `reserve` stays untouched by the
  // lookups so the labelling writes at the end always have room.
  const subrequestBudget: SubrequestBudget = {
    limit: parseEnvInt(env?.SUBREQUEST_BUDGET_LIMIT, 45),
    reserve: parseEnvInt(env?.SUBREQUEST_RESERVE_HEADROOM, 15),
    used: tokenMintAttempts
  };
  const client = createGitHubClient(token, subrequestBudget);
  // Counts an outgoing request without ever declining it: the config query
  // and the labelling writes have to go out, and the label listing and the
  // existence query take no attempt counter of their own, so their one
  // request is charged where it is made.
  const countAttempt = (): boolean => { subrequestBudget.used++; return true; };

  const payload = data;
  const defaultBranch = payload.repository?.default_branch || "main";

  const configFiles = await graphqlBatchFetchFiles(token, [
    { key: 'config', repoFullname, ref: defaultBranch, path: '.github/formalities.json' },
    { key: 'labeller', repoFullname, ref: defaultBranch, path: '.github/issue-labeller.yml' }
  ], countAttempt);
  const configRes = configFiles.get('config');
  if (configRes?.error) {
    throw new Error(`Failed to fetch repository config for issue labeller: ${configRes.error.message}`);
  }

  const { config: issueConfig, error: configError } = parseAndValidateConfig(configRes?.content ?? null);
  if (configError) {
    console.warn(`Repository config .github/formalities.json in ${repoFullname} could not be parsed, falling back to the defaults: ${configError}`);
  }

  if (!issueConfig.enable_issue_labeller) {
    return new Response("Issue labeller disabled for this repository", { status: 200 });
  }

  const labellerFile = configFiles.get('labeller');
  const labellerConfig = (labellerFile && !labellerFile.error && labellerFile.content)
    ? (parseIssueLabellerYaml(labellerFile.content) || DEFAULT_ISSUE_LABELLER_CONFIG)
    : DEFAULT_ISSUE_LABELLER_CONFIG;

  // Labelling is this handler's own job, so the read that decides the labels
  // shares the fate of the writes that apply them: 502, the code this worker
  // answers a GitHub-side failure with, rather than the 500 the entrypoint
  // gives an unexpected one. Nothing in the read throws today; the scope is
  // what keeps a future lookup failure from reading as a worker bug.
  try {
    const labelling = await handleIssueLabeller(payload, token, labellerConfig, repoFullname, countAttempt);
    const currentIssueLabels = new Set((payload.issue.labels || []).map(l => (typeof l === "string" ? l : l.name).toLowerCase()));

    const needsLabelCreation = labelling.labelsToAdd.some((l: string) => !currentIssueLabels.has(l.toLowerCase()));
    const existingLabels = needsLabelCreation
      ? await graphqlFetchRepoLabels(token, repoFullname, countAttempt)
          .catch(err => { console.warn(`Repository label listing failed, continuing without it: ${err.message}`); return null; })
      : new Set();
    await applyIssueLabelling(labelling, token, repoFullname, payload.issue.number, existingLabels, currentIssueLabels, countAttempt, appId, {
      onOptionalAttempt: client.countOptionalAttempt,
      hasHeadroom: client.hasHeadroom
    });
    return new Response(`Success: Processed issue labeller for issue #${payload.issue.number}`, { status: 200 });
  } catch (err: any) {
    console.error(`Error labelling issue #${payload.issue.number}: ${err.message}`);
    return new Response(`Error: Failed to apply issue labelling: ${err.message}`, { status: 502 });
  }
}
