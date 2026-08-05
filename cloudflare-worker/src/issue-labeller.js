// Issue Labeller — validates issue forms and applies labels based on a
// declarative .github/issue-labeller.yml configuration file (same spirit
// as labeler.yml for PRs: label name → list of conditions).
//
// Schema:
//   _trigger_label: "to-triage"        # label required to start processing
//   _invalid_label: "invalid"          # label added when validation fails
//   _remove_labels: ["to-triage"]      # labels always removed after processing
//   _invalid_comment: "Invalid {field} reported. `{value}`"  # comment template
//   _valid_comment: "..."              # posted when an edit fixes the form
//   _require_form: true                # also process issues without the trigger
//                                      # label, and flag ones that skipped the
//                                      # template entirely (maintainers exempt)
//   _no_form_comment: "..."            # what to say to those
//
//   "release/{major}.{minor}":         # label template ({vars} from field value)
//     - field: "release"               # form field name (normalized)
//       format: '^\d+\.\d+\.\d+$'      # regex the value must match
//       exists: "tag:v{value}"         # existence check (tag/path/commit)
//     - field: "release"               # further list items are alternatives (OR,
//       format: '^\d+\.\d+-SNAPSHOT$'  # like labeler.yml): the label applies when
//                                      # any single item matches; all checks inside
//                                      # one item must pass (AND)
//       hint: "Run `...` and paste"    # what the reporter should do about it —
//                                      # replaces the built-in per-field hint in
//                                      # the invalid-form comment
//
//   "Official Image":
//     - field: "image_kind"
//       contains: "official"           # case-insensitive substring
//
//   "Supported Device":
//     - field: "device"
//       not_empty: true                # field must be non-empty
//
// Validation is aggregated per form field: a field is reported invalid only
// when some format/exists check failed on it and no rule matched it at all,
// so alternative rules for the same field never invalidate each other.
//
// Template variables extracted from field values:
//   {value}    – full trimmed value
//   {segment0}, {segment1}, ... – slash-separated parts
//   {major}, {minor}, {patch}  – dot-separated parts (first three); a dash
//                                suffix after a numeric part is dropped, so
//                                24.10-SNAPSHOT yields major 24, minor 10
//   {hash}     – trailing hex string (7-40 chars) after last '-'

import { githubApiCall, graphqlCheckExistence, ensureLabelExists } from './github.js';
import { ISSUE_LABELLER_MESSAGES } from './config.js';

// --- ISSUE FORM PARSER ---
// Parses GitHub issue form markdown body into key-value pairs.
// Issue forms render as structured markdown with "### Field Name" headers
// followed by the user's answer (or "_No response_" for empty fields).
export function parseIssueForm(body) {
  if (!body) return {};
  const fields = {};
  const lines = body.split('\n');
  let currentKey = null;
  let currentLines = [];

  const flush = () => {
    if (currentKey !== null) {
      let value = currentLines.join('\n').trim();
      if (value === '_No response_') {
        value = '';
      } else {
        // Strip markdown code fences (``` or `) from form field values (resolves issue #31)
        if (value.startsWith('```')) {
          value = value.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '').trim();
        }
        if (value.startsWith('`') && value.endsWith('`') && value.length >= 2) {
          value = value.slice(1, -1).trim();
        }
      }
      fields[currentKey] = value;
    }
  };

  for (const line of lines) {
    const headerMatch = line.match(/^###\s+(\S.*)$/);
    if (headerMatch) {
      flush();
      currentKey = headerMatch[1].trim();
      currentLines = [];
    } else if (currentKey !== null) {
      currentLines.push(line);
    }
  }
  flush();

  return fields;
}

// Normalize field names to lowercase snake_case keys for reliable lookup.
export function normalizeFields(fields) {
  const normalized = {};
  for (const [key, value] of Object.entries(fields)) {
    const normKey = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    normalized[normKey] = value;

    if (normKey.startsWith('openwrt_')) {
      const shortKey = normKey.slice(8);
      if (!normalized[shortKey]) normalized[shortKey] = value;
    }
    if (normKey === 'openwrt_target_subtarget' || normKey === 'target_subtarget') {
      if (!normalized['target']) normalized['target'] = value;
    }
  }
  return normalized;
}

// --- YAML PARSER FOR ISSUE-LABELLER.YML ---
// Parses the declarative config format. Handles:
//   - Top-level key: value (strings, booleans, inline arrays, block scalars)
//   - Top-level "label": followed by a list of condition objects
//   - Condition objects: "- field: x" followed by indented "key: value" lines
export function parseIssueLabellerYaml(yamlText) {
  if (!yamlText) return null;
  const lines = yamlText.split('\n');
  const config = { meta: {}, rules: [] };
  let currentLabel = null;
  let currentConditions = null;
  let currentCondition = null;
  let currentLabelMeta = null;

  const parseValue = (raw) => {
    let v = raw.trim();
    // Inline array: ["a", "b"]
    if (v.startsWith('[') && v.endsWith(']')) {
      return v.slice(1, -1).split(',').map(s => {
        s = s.trim();
        if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
          s = s.slice(1, -1);
        }
        return s;
      });
    }
    // Quoted string
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    // Boolean
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  };

  // Block scalars ("key: >-" / "key: |") — hints and comment templates are
  // sentences, and a sentence on one line is unreadable in a config file.
  const blockIndicator = (raw) => {
    const m = raw.trim().match(/^([|>])([-+]?)\d*$/);
    return m ? { style: m[1], chomp: m[2] } : null;
  };

  let block = null; // { style, chomp, keyIndent, indent, lines, assign }

  const flushBlock = () => {
    if (!block) return;
    while (block.lines.length && block.lines[block.lines.length - 1] === '') block.lines.pop();
    let value;
    if (block.style === '|') {
      value = block.lines.join('\n');
    } else {
      // Folded: a blank line is a paragraph break, everything else joins with a space.
      value = block.lines.reduce((acc, l, i) => {
        if (i === 0) return l;
        if (l === '') return `${acc}\n`;
        return acc.endsWith('\n') ? acc + l : `${acc} ${l}`;
      }, '');
    }
    if (block.chomp === '+') value += '\n';
    block.assign(value);
    block = null;
  };

  const startBlock = (indicator, keyIndent, assign) => {
    block = { ...indicator, keyIndent, indent: null, lines: [], assign };
  };

  for (let line of lines) {
    // Inside a block scalar every line is literal text, comments included, so
    // this runs before comment stripping. Dedenting ends the block.
    if (block) {
      if (line.trim() === '') {
        if (block.indent !== null) block.lines.push('');
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (block.indent === null) {
        if (indent > block.keyIndent) {
          block.indent = indent;
          block.lines.push(line.slice(indent));
          continue;
        }
      } else if (indent >= block.indent) {
        block.lines.push(line.slice(block.indent));
        continue;
      }
      flushBlock();
    }

    // Strip comments (only full-line or after unquoted content)
    const commentIdx = line.indexOf('#');
    if (commentIdx !== -1) {
      // Don't strip if # is inside quotes
      const before = line.slice(0, commentIdx);
      const singleQuotes = (before.match(/'/g) || []).length;
      const doubleQuotes = (before.match(/"/g) || []).length;
      if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) {
        line = before;
      }
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    const lineIndent = line.length - line.trimStart().length;

    // List item start: "- key: value" (new condition in current label's list)
    if (trimmed.startsWith('- ') && currentLabel !== null) {
      // Flush previous condition
      if (currentCondition) currentConditions.push(currentCondition);
      currentCondition = {};
      const kvMatch = trimmed.slice(2).match(/^([^:]+):\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        const cond = currentCondition;
        const indicator = blockIndicator(kvMatch[2]);
        if (indicator) startBlock(indicator, lineIndent, (v) => { cond[key] = v; });
        else cond[key] = parseValue(kvMatch[2]);
      }
      continue;
    }

    // Indented key: value (continuation of current condition OR label-level metadata)
    if (line.startsWith('  ') && currentLabel !== null && !trimmed.startsWith('-')) {
      const kvMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        const indicator = blockIndicator(kvMatch[2]);
        // Underscore-prefixed keys at label level are metadata (_color, _description)
        if (key.startsWith('_')) {
          if (!currentLabelMeta) currentLabelMeta = {};
          const target = currentLabelMeta;
          if (indicator) startBlock(indicator, lineIndent, (v) => { target[key] = v; });
          else target[key] = parseValue(kvMatch[2]);
        } else if (currentCondition) {
          const cond = currentCondition;
          if (indicator) startBlock(indicator, lineIndent, (v) => { cond[key] = v; });
          else cond[key] = parseValue(kvMatch[2]);
        }
      }
      continue;
    }

    // Top-level key (no indentation)
    if (!line.startsWith(' ') && !line.startsWith('-')) {
      // Flush previous label
      if (currentLabel !== null) {
        if (currentCondition) currentConditions.push(currentCondition);
        config.rules.push({ label: currentLabel, conditions: currentConditions, meta: currentLabelMeta });
        currentLabel = null;
        currentConditions = null;
        currentCondition = null;
        currentLabelMeta = null;
      }

      const kvMatch = line.match(/^([^:]+):\s*(.*)$/);
      if (!kvMatch) continue;
      const key = kvMatch[1].trim().replace(/^["']|["']$/g, '');
      const rawVal = kvMatch[2].trim();
      const indicator = blockIndicator(rawVal);

      if (indicator) {
        // A block scalar is a multi-line string, never a list of conditions
        startBlock(indicator, lineIndent, (v) => { config.meta[key] = v; });
      } else if (rawVal === '') {
        // This key has a block value (list of conditions) → it's a label rule
        currentLabel = key;
        currentConditions = [];
        currentCondition = null;
      } else {
        // Simple key: value → meta config
        config.meta[key] = parseValue(rawVal);
      }
    }
  }
  flushBlock();

  // Flush last label
  if (currentLabel !== null) {
    if (currentCondition) currentConditions.push(currentCondition);
    config.rules.push({ label: currentLabel, conditions: currentConditions, meta: currentLabelMeta });
  }

  return config;
}

// --- TEMPLATE VARIABLE EXTRACTION ---
// Extracts template variables from a field value for label interpolation.
export function extractTemplateVars(value) {
  const vars = { value };
  // Slash-separated segments: target/subtarget → {segment0}, {segment1}
  const segments = value.split('/');
  segments.forEach((seg, i) => { vars[`segment${i}`] = seg; });
  // Dot-separated parts: 24.10.0 → {major}, {minor}, {patch}
  // A dash-suffix after a numeric part is dropped (24.10-SNAPSHOT → minor 10)
  const dots = value.split('.').map(p => {
    const m = p.match(/^(\d+)-/);
    return m ? m[1] : p;
  });
  if (dots[0] !== undefined) vars.major = dots[0];
  if (dots[1] !== undefined) vars.minor = dots[1];
  if (dots[2] !== undefined) vars.patch = dots[2];
  // Trailing hash after last '-': r28945-24a9f1c224 → {hash}
  const hashMatch = value.match(/-([0-9a-fA-F]{7,40})$/);
  if (hashMatch) vars.hash = hashMatch[1];
  return vars;
}

// Interpolates {var} placeholders in a template string.
function interpolate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] !== undefined ? vars[key] : '');
}

// --- DEFAULT CONFIG (fallback when .github/issue-labeller.yml is absent) ---
export const DEFAULT_ISSUE_LABELLER_CONFIG = {
  meta: {
    _trigger_label: 'to-triage',
    _invalid_label: 'invalid',
    _remove_labels: ['to-triage'],
    _invalid_comment: 'Invalid {field} reported. `{value}`'
  },
  rules: [
    {
      // Concrete releases (24.10.0, 25.12.0-rc5) must have a matching Git tag;
      // stable-branch snapshots (24.10-SNAPSHOT) are format-only — OpenWrt
      // does not tag snapshot builds.
      label: 'release/{major}.{minor}',
      conditions: [
        { field: 'release', format: '^\\d+\\.\\d+\\.\\d+(-rc\\d+)*$', exists: 'tag:v{value}' },
        { field: 'release', format: '^\\d+\\.\\d+-SNAPSHOT$' }
      ]
    },
    {
      label: 'SNAPSHOT',
      conditions: [{ field: 'release', format: '^SNAPSHOT$' }]
    },
    {
      label: 'target/{segment0}',
      conditions: [{ field: 'target', format: '^[a-zA-Z0-9]+/[a-zA-Z0-9]+$', exists: 'path:target/linux/{segment0}/{segment1}' }]
    },
    {
      label: 'Official Image',
      conditions: [{ field: 'image_kind', contains: 'official' }]
    },
    {
      label: 'Self Built Image',
      conditions: [{ field: 'image_kind', contains: 'self' }]
    },
    {
      label: 'Supported Device',
      conditions: [{ field: 'device', not_empty: true }]
    }
  ]
};

// --- MAIN HANDLER ---
// Processes an opened, edited or reopened issue event using the declarative
// config. Returns { labelsToAdd, labelsToRemove, comments, resolvedComment }.
export async function handleIssueLabeller(data, token, config, repoFullname) {
  const result = { labelsToAdd: [], labelsToRemove: [], comments: [], resolvedComment: null, legacyHeader: null, labelMeta: {} };

  const issue = data.issue;
  if (!issue) return result;

  const meta = config.meta || {};
  const triggerLabel = (meta._trigger_label || 'to-triage').toLowerCase();
  const invalidLabel = meta._invalid_label || 'invalid';
  const removeLabels = meta._remove_labels || ['to-triage'];

  const issueLabels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name));
  const issueLabelsLower = new Set(issueLabels.map(l => l.toLowerCase()));

  // The trigger label starts processing, but it is also one of _remove_labels:
  // after the first run it is gone, so an issue already flagged invalid has to
  // re-enter on its own label. That is what keeps an edited report supervised
  // until it is clean.
  //
  // _require_form widens the gate to every issue, which covers the two ways a
  // report escapes the label: a blank issue (the template never ran, so no
  // label) and a form-shaped report that arrived without the template's labels
  // anyway.
  const requireForm = meta._require_form === true;
  const wasFlagged = issueLabelsLower.has(invalidLabel.toLowerCase());
  if (!issueLabelsLower.has(triggerLabel) && !wasFlagged && !requireForm) return result;

  // Deployments before the marker existed left unmarked comments on live
  // issues. Hand the header down so applyIssueLabelling can recognise one and
  // adopt it rather than posting a second comment beside it. Set before any
  // verdict below, so every path that can comment gets the same treatment.
  result.legacyHeader = meta._invalid_comment_header !== undefined
    ? meta._invalid_comment_header
    : ISSUE_LABELLER_MESSAGES.invalidHeader;

  // Parse the issue form body
  const fields = normalizeFields(parseIssueForm(issue.body));

  // No "### " sections at all means the reporter bypassed the template. Chasing
  // that is opt-in and never aimed at the project's own people: maintainers file
  // free-form tracking issues on purpose, and a bot nagging them is pure noise.
  if (Object.keys(fields).length === 0) {
    if (!requireForm) return result;
    const privileged = ['OWNER', 'MEMBER', 'COLLABORATOR'];
    if (privileged.includes(issue.author_association)) return result;

    result.labelsToAdd.push(invalidLabel);
    result.comments.push(meta._no_form_comment !== undefined
      ? meta._no_form_comment
      : ISSUE_LABELLER_MESSAGES.noForm);
    // This is a verdict, not a skipped run, so the trigger label is spent like
    // on any other outcome. Leaving it behind would queue the issue for a
    // triage pass that has already happened, and the invalid label is what
    // brings the report back here once it is edited.
    result.labelsToRemove.push(...removeLabels);
    return result;
  }

  // Evaluate each rule. A rule's conditions list is a set of alternatives
  // (OR, like labeler.yml): the rule matches when any single condition object
  // matches, and every check inside one condition object must pass (AND).
  const probes = []; // GraphQL existence checks to batch
  const ruleEvals = []; // { rule, alts: [{ cond, fieldKey, value, vars, softFail, hardFail, probeKey }] }

  (config.rules || []).forEach((rule, ruleIdx) => {
    const alts = (rule.conditions || []).map((cond, condIdx) => {
      const fieldKey = (cond.field || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const value = fields[fieldKey] || '';
      const vars = extractTemplateVars(value);
      // softFail: condition doesn't match but says nothing about validity;
      // hardFail: a non-empty value failed a format check → invalid candidate
      const alt = { cond, fieldKey, value, vars, softFail: false, hardFail: false, probeKey: null };

      // not_empty check
      if (cond.not_empty && !value) {
        alt.softFail = true;
        return alt;
      }

      // contains check (case-insensitive substring)
      if (cond.contains && !value.toLowerCase().includes(String(cond.contains).toLowerCase())) {
        alt.softFail = true;
        return alt;
      }

      // format check (regex)
      if (cond.format) {
        let regex = null;
        try { regex = new RegExp(cond.format); } catch { /* broken pattern in config */ }
        if (!value || !regex) {
          alt.softFail = true;
          return alt;
        }
        if (!regex.test(value)) {
          alt.hardFail = true;
          return alt;
        }
      }

      // exists check (deferred to GraphQL batch)
      if (cond.exists && value) {
        const existsTemplate = String(cond.exists);
        const colonIdx = existsTemplate.indexOf(':');
        const checkType = colonIdx !== -1 ? existsTemplate.slice(0, colonIdx) : 'path';
        const checkPath = interpolate(colonIdx !== -1 ? existsTemplate.slice(colonIdx + 1) : existsTemplate, vars);
        alt.probeKey = `p${ruleIdx}_${condIdx}`;
        probes.push({ key: alt.probeKey, type: checkType === 'tag' ? 'tag' : 'path', value: checkPath });
      }
      return alt;
    });
    ruleEvals.push({ rule, alts });
  });

  // Execute all existence checks in one GraphQL call
  let existenceResults = new Map();
  if (probes.length > 0) {
    existenceResults = await graphqlCheckExistence(token, repoFullname, 'HEAD', probes);
  }

  // Resolve rule matches and aggregate validation per form field: a field is
  // invalid only when some format/exists check failed on it and no rule
  // matched it, so alternative rules for one field never invalidate each other.
  const fieldStatus = new Map(); // fieldKey → { matched, failures: [{ field, value, hint }] }
  const statusFor = (key) => {
    if (!fieldStatus.has(key)) fieldStatus.set(key, { matched: false, failures: [] });
    return fieldStatus.get(key);
  };

  for (const { rule, alts } of ruleEvals) {
    let matchedAlt = null;
    for (const alt of alts) {
      if (alt.softFail) continue;
      if (alt.hardFail || (alt.probeKey && !existenceResults.get(alt.probeKey))) {
        statusFor(alt.fieldKey).failures.push({ field: alt.cond.field || alt.fieldKey, value: alt.value, hint: alt.cond.hint });
        continue;
      }
      if (!matchedAlt) matchedAlt = alt;
    }
    if (!matchedAlt) continue;

    statusFor(matchedAlt.fieldKey).matched = true;
    const labelName = interpolate(rule.label, matchedAlt.vars);
    if (labelName && !labelName.includes('{') && !result.labelsToAdd.includes(labelName)) {
      result.labelsToAdd.push(labelName);
      if (rule.meta) {
        result.labelMeta[labelName] = { color: rule.meta._color, description: rule.meta._description };
      }
    }
  }

  const invalidFields = [];
  for (const status of fieldStatus.values()) {
    if (status.matched || status.failures.length === 0) continue;
    // One entry per field; prefer a failure that carries a config-provided hint
    invalidFields.push(status.failures.find(f => f.hint) || status.failures[0]);
  }
  const hasInvalid = invalidFields.length > 0;

  const header = result.legacyHeader;

  // If any validation failed, add invalid label and format a clear Call To Action
  // comment. Labels that did validate are kept: a report with a good target and
  // a mistyped release is still a report about that target.
  if (hasInvalid) {
    result.labelsToAdd.push(invalidLabel);

    // A reporter who mistyped a field needs the command that produces the right
    // value, not a restatement of the grammar. Config `hint:` overrides these.
    const defaultHints = ISSUE_LABELLER_MESSAGES.hints;

    const footer = meta._invalid_comment_footer !== undefined
      ? meta._invalid_comment_footer
      : ISSUE_LABELLER_MESSAGES.invalidFooter;

    const lines = [];
    if (header) lines.push(header, '');

    for (const inv of invalidFields) {
      const fieldName = inv.field || 'field';
      const val = inv.value ? `\`${inv.value}\`` : '_empty_';
      const hint = inv.hint || defaultHints[fieldName.toLowerCase()] || '';

      if (hint) {
        lines.push(`- **${fieldName}**: Invalid value ${val} — *${hint}*`);
      } else {
        lines.push(`- **${fieldName}**: Invalid value ${val}`);
      }
    }

    if (footer) lines.push('', footer);

    result.comments.push(lines.join('\n'));
  } else if (wasFlagged) {
    // The report was fixed by an edit: drop the label and say so, so the
    // reporter knows the ball is no longer in their court.
    result.labelsToRemove.push(invalidLabel);
    result.resolvedComment = meta._valid_comment !== undefined
      ? meta._valid_comment
      : ISSUE_LABELLER_MESSAGES.valid;
  }

  // Remove triage/type labels
  for (const rl of removeLabels) {
    result.labelsToRemove.push(rl);
  }

  // Remove the issue type label the template applied (the first one that is
  // neither the trigger nor the generic "bug"). Only on the first run: by the
  // time an edit re-triggers this, the remaining labels are the bot's own and
  // whatever a maintainer added by hand, and neither is ours to strip.
  if (issueLabelsLower.has(triggerLabel)) {
    const issueType = issueLabels.find(l => {
      const lower = l.toLowerCase();
      // The invalid label is never the type: on an issue that carries both it
      // and the trigger — a maintainer re-triaging a flagged report — removing
      // it would cut the thread that brings the report back here on the next
      // edit.
      return lower !== triggerLabel && lower !== 'bug' && lower !== invalidLabel.toLowerCase();
    });
    if (issueType) result.labelsToRemove.push(issueType);
  }

  return result;
}

// An HTML comment renders as nothing and survives edits, so it is a stable
// handle for finding our own comment again without storing state anywhere.
export const ISSUE_LABELLER_MARKER = '<!-- issue-labeller -->';

// Comments this app posts come back with its numeric id in
// performed_via_github_app, which no other account — bot or human — can
// carry. Whenever our own app id is known the match requires it, so a
// comment another bot planted (whose field names that bot's app, or is
// absent) is never adopted. Only when the id is not configured does this
// fall back to "written by some bot", which still keeps humans (and their
// quotes of our marker) out.
export function isOwnAppComment(comment, appId) {
  if (appId != null) {
    return comment.performed_via_github_app?.id === appId;
  }
  const login = comment.user?.login || '';
  return comment.user?.type === 'Bot' || login.toLowerCase().endsWith('[bot]');
}

// 1000 comments deep is far past the point where one more bot comment is the
// thread's problem.
const MAX_COMMENT_PAGES = 10;

// Applies the labelling result via GitHub REST API (mutations are still REST).
// `appId` (the numeric GitHub App id) pins comment adoption to this app's own
// comments; without it the match falls back to bot-authored comments only.
export async function applyIssueLabelling(result, token, repoFullname, issueNumber, existingLabels, currentIssueLabels, onCall, appId = null) {
  const issueLabelUrl = `https://api.github.com/repos/${repoFullname}/issues/${issueNumber}/labels`;
  const currentLabels = currentIssueLabels || new Set();

  // One marker-tagged comment per issue, edited in place on every re-run, so a
  // reporter who fixes the form in three edits gets one comment, not four.
  const pending = result.comments[0] || result.resolvedComment;
  if (pending) {
    const body = `${pending}\n\n${ISSUE_LABELLER_MARKER}`;

    // Page until the marker turns up. It is not reliably the oldest comment:
    // with _require_form the first complaint can land on an issue that has been
    // open and discussed for months. Missing it would post a second one, so
    // walk the pages — most issues are a single call, and the cap only stops a
    // pathological thread from eating the subrequest budget.
    //
    // Comments this bot left before the marker existed carry no marker, so they
    // are matched on the header text instead and adopted: patching one writes
    // the marker into it, and every run after this finds it the normal way.
    let marked = null;
    let legacy = null;
    for (let page = 1; page <= MAX_COMMENT_PAGES && !marked; page++) {
      onCall?.();
      const listed = await githubApiCall(
        `https://api.github.com/repos/${repoFullname}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
        token
      );
      if (listed.code !== 200) break;
      const batch = listed.data || [];
      // Only a comment this app wrote itself qualifies: a user quoting the
      // raw markdown of our comment copies the marker along, and another bot
      // can paste it too — neither comment is ours to edit.
      marked = batch.find(c => isOwnAppComment(c, appId) && (c.body || '').includes(ISSUE_LABELLER_MARKER));
      if (!legacy && result.legacyHeader) {
        legacy = batch.find(c => isOwnAppComment(c, appId) && (c.body || '').includes(result.legacyHeader));
      }
      if (batch.length < 100) break;
    }
    const mine = marked || legacy;

    if (mine) {
      if (mine.body !== body) {
        onCall?.();
        await githubApiCall(
          `https://api.github.com/repos/${repoFullname}/issues/comments/${mine.id}`,
          token, 'PATCH', { body }
        );
      }
    } else if (result.comments[0]) {
      // Nothing to acknowledge on an issue we never complained about.
      onCall?.();
      await githubApiCall(
        `https://api.github.com/repos/${repoFullname}/issues/${issueNumber}/comments`,
        token, 'POST', { body }
      );
    }
  }

  // Remove labels (ignore 404 if label wasn't applied)
  for (const label of result.labelsToRemove) {
    if (currentLabels.has(label.toLowerCase())) {
      onCall?.();
      await githubApiCall(
        `${issueLabelUrl}/${encodeURIComponent(label)}`,
        token, 'DELETE', null, 'application/vnd.github+json', { silent: true }
      );
    }
  }

  // Filter to labels not already on the issue
  const toAdd = result.labelsToAdd.filter(l => !currentLabels.has(l.toLowerCase()));
  if (toAdd.length === 0) return;

  // Ensure labels exist in the repository (create missing ones in parallel)
  const labelMeta = result.labelMeta || {};
  await Promise.all(toAdd.map(label => {
    const meta = labelMeta[label] || {};
    return ensureLabelExists(token, repoFullname, label, meta.color, meta.description, existingLabels, onCall);
  }));

  // Add labels to the issue in one API call
  onCall?.();
  await githubApiCall(issueLabelUrl, token, 'POST', { labels: toAdd });
}
