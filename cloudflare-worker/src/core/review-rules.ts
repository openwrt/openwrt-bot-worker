import { globToRegex } from '../labeler.js';

export const REVIEW_RULES_PATH = '.github/llm-review-rules.md';

const RULE_TAG = 'formality-rule';
const RULE_KEYS = new Set(['files', 'added', 'message', 'level']);
const MAX_RULES = 50;
// Literal matching only: a pattern from the file must not be able to run
// past the CPU limit, and neither may a pull request with a huge diff.
const MAX_SCANNED_LINES = 20000;
const MAX_LINE_CHARS = 1000;
const LOCATIONS_SHOWN = 3;
const MBOX_ENVELOPE = /^From [0-9a-f]{40} /;
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;

export interface ReviewRule {
  line: number;
  files: RegExp[];
  added: string[];
  message: string;
  level: 'warning' | 'error';
}

export interface ReviewRuleSet {
  rules: ReviewRule[];
  problems: string[];
}

const closesFence = (line: string, fence: string) =>
  line.length >= fence.length && [...line].every(c => c === fence[0]);

export function parseReviewRules(text: string | null | undefined): ReviewRuleSet {
  const rules: ReviewRule[] = [];
  const problems: string[] = [];
  if (!text) return { rules, problems };
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].trim().match(FENCE);
    if (!open) continue;
    const fence = open[1];
    const at = i + 1;
    // Any other code block is skipped whole, so an example of the syntax
    // inside one is not taken for a rule.
    if (open[2].trim().split(/\s+/)[0] !== RULE_TAG) {
      for (i++; i < lines.length && !closesFence(lines[i].trim(), fence); i++);
      if (i === lines.length) problems.push(`The code block at line ${at} of \`${REVIEW_RULES_PATH}\` is never closed, so no rule after it was checked.`);
      continue;
    }

    const fields: Record<string, string[]> = {};
    const errors: string[] = [];
    let closed = false;
    for (i++; i < lines.length; i++) {
      const line = lines[i].trim();
      if (closesFence(line, fence)) {
        closed = true;
        break;
      }
      if (line === '' || line.startsWith('#')) continue;
      const colon = line.indexOf(':');
      const key = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : '';
      const value = colon > 0 ? line.slice(colon + 1).trim() : '';
      if (!RULE_KEYS.has(key)) {
        errors.push(`line ${i + 1} is not one of files, added, message or level`);
      } else if (value === '') {
        errors.push(`its ${key} on line ${i + 1} is empty`);
      } else {
        (fields[key] ??= []).push(value);
      }
    }

    if (!closed) errors.push('it is never closed');
    if (!fields.files) errors.push('it names no files');
    if (!fields.added) errors.push('it names no added text');
    if (fields.message?.length !== 1) errors.push('it needs exactly one message');
    const level = fields.level?.[0] ?? 'warning';
    if ((fields.level?.length ?? 0) > 1 || (level !== 'warning' && level !== 'error')) {
      errors.push('its level must be warning or error');
    }
    if (errors.length > 0) {
      problems.push(`The rule at line ${at} of \`${REVIEW_RULES_PATH}\` was not checked: ${errors.join(', ')}.`);
      continue;
    }
    if (rules.length === MAX_RULES) {
      problems.push(`Only the first ${MAX_RULES} rules in \`${REVIEW_RULES_PATH}\` were checked.`);
      break;
    }
    rules.push({
      line: at,
      files: fields.files.map(glob => globToRegex(glob)),
      added: fields.added,
      message: fields.message[0],
      level: level as 'warning' | 'error'
    });
  }
  return { rules, problems };
}

function patchPath(header: string): string | null {
  let path = header.replace(/\r$/, '');
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  if (path === '/dev/null') return null;
  return path.startsWith('b/') ? path.slice(2) : path;
}

// The lines a patch adds, read only inside the hunks of its `diff --git`
// sections and counted from each hunk header, so a `+` line in a commit
// message is never taken for code.
function* addedLines(patch: string): Generator<{ path: string; line: number; text: string }> {
  let inFile = false;
  let path: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  for (const raw of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const lead = raw.charCodeAt(0);
      if (lead === 45 /* - */) {
        oldLeft--;
      } else if (lead === 43 /* + */) {
        newLeft--;
        if (path !== null) yield { path, line: newLine, text: raw.slice(1) };
        newLine++;
      } else if (lead !== 92 /* \ */) {
        oldLeft--;
        newLeft--;
        newLine++;
      }
      continue;
    }
    if (raw.startsWith('diff --git ') || MBOX_ENVELOPE.test(raw)) {
      inFile = raw.startsWith('diff --git ');
      path = null;
    } else if (!inFile) {
      continue;
    } else if (raw.startsWith('+++ ')) {
      path = patchPath(raw.slice(4));
    } else {
      const hunk = raw.match(HUNK_HEADER);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLine = Number(hunk[2]);
        newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      }
    }
  }
}

export interface ReviewRuleHit {
  sha: string | null;
  path: string;
  line: number;
}

export interface ReviewRuleMatches {
  applied: Set<ReviewRule>;
  hits: Map<ReviewRule, ReviewRuleHit[]>;
  capped: boolean;
}

// `inherited` is the upstream commit of a backport. A line it added as well
// is the backport carrying it over, so it is not reported. Lines are counted,
// so a copy the backport adds on top of it still is.
export function matchReviewRules(
  rules: ReviewRule[],
  commits: Array<{ sha: string | null; patch: string; inherited?: string | null }>
): ReviewRuleMatches {
  const applied = new Set<ReviewRule>();
  const hits = new Map<ReviewRule, ReviewRuleHit[]>();
  const rulesByPath = new Map<string, ReviewRule[]>();
  const rulesFor = (path: string) => {
    let list = rulesByPath.get(path);
    if (!list) rulesByPath.set(path, list = rules.filter(rule => rule.files.some(re => re.test(path))));
    return list;
  };
  let scanned = 0;
  const scan = (text: string) => text.length <= MAX_LINE_CHARS && ++scanned <= MAX_SCANNED_LINES;

  for (const { sha, patch, inherited } of commits) {
    const carried = new Map<string, number>();
    for (const { path, text } of inherited ? addedLines(inherited) : []) {
      if (rulesFor(path).length === 0 || !scan(text)) continue;
      const key = `${path}\n${text}`;
      carried.set(key, (carried.get(key) || 0) + 1);
    }
    for (const { path, line, text } of addedLines(patch)) {
      const fileRules = rulesFor(path);
      if (fileRules.length === 0) continue;
      fileRules.forEach(rule => applied.add(rule));
      if (text.length > MAX_LINE_CHARS) continue;
      if (++scanned > MAX_SCANNED_LINES) return { applied, hits, capped: true };
      const key = `${path}\n${text}`;
      const left = carried.get(key) || 0;
      if (left > 0) {
        carried.set(key, left - 1);
        continue;
      }
      for (const rule of fileRules) {
        if (!rule.added.some(s => text.includes(s))) continue;
        let list = hits.get(rule);
        if (!list) hits.set(rule, list = []);
        list.push({ sha, path, line });
      }
    }
    if (scanned > MAX_SCANNED_LINES) return { applied, hits, capped: true };
  }
  return { applied, hits, capped: false };
}

export interface ReviewRuleDetail {
  sha: string | null;
  commitPatch: string | null;
  upstreamPatch?: string | null;
  skip?: boolean;
}

export interface ReviewRuleReport {
  errors: string[];
  warnings: string[];
  notices: string[];
  successes: string[];
  incomplete: boolean;
}

function locationText(hit: ReviewRuleHit, repoFullname: string): string {
  if (!hit.sha) return `'${hit.path}' line ${hit.line}`;
  const url = `https://github.com/${repoFullname}/blob/${hit.sha}/${hit.path.split('/').map(encodeURIComponent).join('/')}#L${hit.line}`;
  return `[${hit.path}:${hit.line}](${url})`;
}

export function validateReviewRules(
  details: ReviewRuleDetail[],
  ruleSet: ReviewRuleSet,
  repoFullname: string,
  ref: string
): ReviewRuleReport {
  const report: ReviewRuleReport = { errors: [], warnings: [], notices: [], successes: [], incomplete: false };
  if (ruleSet.rules.length === 0) return report;

  const items = details.filter(item => !item.skip);
  const unread = items.filter(item => !item.commitPatch);
  if (unread.length > 0) {
    report.notices.push(`The repository rules were not checked against ${unread.length} commit${unread.length === 1 ? '' : 's'} whose diff could not be read.`);
    report.incomplete = true;
  }

  const { applied, hits, capped } = matchReviewRules(
    ruleSet.rules,
    items.filter(item => item.commitPatch).map(item => ({ sha: item.sha, patch: item.commitPatch as string, inherited: item.upstreamPatch }))
  );
  if (capped) {
    report.notices.push(`The repository rules were checked against the first ${MAX_SCANNED_LINES} added lines only.`);
    report.incomplete = true;
  }

  const rulesUrl = `https://github.com/${repoFullname}/blob/${ref.split('/').map(encodeURIComponent).join('/')}/${REVIEW_RULES_PATH}`;
  for (const [rule, list] of hits) {
    const shown = list.slice(0, LOCATIONS_SHOWN).map(hit => locationText(hit, repoFullname)).join(', ');
    const more = list.length > LOCATIONS_SHOWN ? ` and ${list.length - LOCATIONS_SHOWN} more` : '';
    const text = `- ${rule.message} Found in ${shown}${more}. See [the rule](${rulesUrl}#L${rule.line}).`;
    (rule.level === 'error' ? report.errors : report.warnings).push(text);
  }
  if (applied.size > 0 && hits.size === 0 && !report.incomplete) {
    const rules = applied.size === 1 ? 'the repository rule that applies' : `the ${applied.size} repository rules that apply`;
    report.successes.push(`✅ No added line breaks ${rules} to the changed files`);
  }
  return report;
}

// Whether a rule can apply to any of these files, so that a diff the run
// could not split is only a gap when a rule would have read it.
export const reviewRulesCover = (ruleSet: ReviewRuleSet, files: string[]) =>
  files.some(file => ruleSet.rules.some(rule => rule.files.some(re => re.test(file))));
