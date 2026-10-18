import { parseAndValidateConfig } from '../types/config.ts';
import { graphqlBatchFetchFiles, graphqlFetchRepoLabels } from '../github.js';
import {
  handleIssueLabeller,
  applyIssueLabelling,
  parseIssueLabellerYaml,
  DEFAULT_ISSUE_LABELLER_CONFIG
} from '../issue-labeller.js';
import { isIssuesPayload, type IssuesEventPayload } from '../types/github.ts';
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

  const subrequestBudget: SubrequestBudget = {
    limit: parseInt(env?.SUBREQUEST_BUDGET_LIMIT || '50', 10),
    reserve: parseInt(env?.SUBREQUEST_RESERVE_HEADROOM || '15', 10),
    used: tokenMintAttempts
  };
  const onCall = (_attempt = 1): boolean => {
    if (subrequestBudget.limit - subrequestBudget.used <= 0) {
      return false;
    }
    subrequestBudget.used++;
    return true;
  };

  const payload = data;
  const defaultBranch = payload.repository?.default_branch || "main";

  onCall();
  const configFiles = await graphqlBatchFetchFiles(token, [
    { key: 'config', repoFullname, ref: defaultBranch, path: '.github/formalities.json' },
    { key: 'labeller', repoFullname, ref: defaultBranch, path: '.github/issue-labeller.yml' }
  ]);
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

  const labelling = await handleIssueLabeller(payload, token, labellerConfig, repoFullname);
  const currentIssueLabels = new Set((payload.issue.labels || []).map(l => (typeof l === "string" ? l : l.name).toLowerCase()));

  const needsLabelCreation = labelling.labelsToAdd.some((l: string) => !currentIssueLabels.has(l.toLowerCase()));
  const existingLabels = needsLabelCreation
    ? await (async () => {
        onCall();
        return graphqlFetchRepoLabels(token, repoFullname)
          .catch(err => { console.warn(`Repository label listing failed, continuing without it: ${err.message}`); return null; });
      })()
    : new Set();
  try {
    await applyIssueLabelling(labelling, token, repoFullname, payload.issue.number, existingLabels, currentIssueLabels, onCall, appId);
    return new Response(`Success: Processed issue labeller for issue #${payload.issue.number}`, { status: 200 });
  } catch (err: any) {
    console.error(`Error applying issue labelling for issue #${payload.issue.number}: ${err.message}`);
    return new Response(`Error: Failed to apply issue labelling: ${err.message}`, { status: 502 });
  }
}
