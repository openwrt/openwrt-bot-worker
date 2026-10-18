import { parseAndValidateConfig } from '../types/config.ts';
import { graphqlBatchFetchFiles, graphqlFetchRepoLabels } from '../github.js';
import {
  handleIssueLabeller,
  applyIssueLabelling,
  parseIssueLabellerYaml,
  DEFAULT_ISSUE_LABELLER_CONFIG
} from '../issue-labeller.js';
import type { IssuesEventPayload } from '../types/github.ts';

export async function handleIssuesEvent(
  data: IssuesEventPayload,
  token: string,
  repoFullname: string,
  appId: number | null
): Promise<Response> {
  const defaultBranch = data.repository?.default_branch || "main";
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

  const labelling = await handleIssueLabeller(data, token, labellerConfig, repoFullname);
  const currentIssueLabels = new Set(((data.issue?.labels || []) as Array<any>).map(l => (typeof l === "string" ? l : l.name).toLowerCase()));

  const needsLabelCreation = labelling.labelsToAdd.some((l: string) => !currentIssueLabels.has(l.toLowerCase()));
  const existingLabels = needsLabelCreation
    ? await graphqlFetchRepoLabels(token, repoFullname)
        .catch(err => { console.warn(`Repository label listing failed, continuing without it: ${err.message}`); return null; })
    : new Set();
  await applyIssueLabelling(labelling, token, repoFullname, data.issue!.number, existingLabels, currentIssueLabels, null, appId);
  return new Response(`Success: Processed issue labeller for issue #${data.issue!.number}`, { status: 200 });
}
