// Issue Labeller — validates issue forms and applies labels based on a
// declarative .github/issue-labeller.yml configuration file (same spirit
// as labeler.yml for PRs: label name → list of conditions).
//
// Schema:
//   _trigger_label: "to-triage"        # label required to start processing
//   _invalid_label: "invalid"          # label added when validation fails
//   _remove_labels: ["to-triage"]      # labels always removed after processing
//   _invalid_comment: "Invalid {field} reported. `{value}`"  # comment template
//
//   "release/{major}.{minor}":         # label template ({vars} from field value)
//     - field: "release"               # form field name (normalized)
//       format: '^\d+\.\d+'            # regex the value must match
//       exists: "tag:v{value}"         # existence check (tag/path/commit)
//
//   "Official Image":
//     - field: "image_kind"
//       contains: "official"           # case-insensitive substring
//
//   "Supported Device":
//     - field: "device"
//       not_empty: true                # field must be non-empty
//
// Template variables extracted from field values:
//   {value}    – full trimmed value
//   {segment0}, {segment1}, ... – slash-separated parts
//   {major}, {minor}, {patch}  – dot-separated parts (first three)
//   {hash}     – trailing hex string (7-40 chars) after last '-'

import { githubApiCall, graphqlCheckExistence, ensureLabelExists } from './github.js';

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
      const value = currentLines.join('\n').trim();
      fields[currentKey] = value === '_No response_' ? '' : value;
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
  }
  return normalized;
}

// --- YAML PARSER FOR ISSUE-LABELLER.YML ---
// Parses the declarative config format. Handles:
//   - Top-level key: value (strings, booleans, inline arrays)
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

  for (let line of lines) {
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

    // List item start: "- key: value" (new condition in current label's list)
    if (trimmed.startsWith('- ') && currentLabel !== null) {
      // Flush previous condition
      if (currentCondition) currentConditions.push(currentCondition);
      currentCondition = {};
      const kvMatch = trimmed.slice(2).match(/^([^:]+):\s*(.*)$/);
      if (kvMatch) {
        currentCondition[kvMatch[1].trim()] = parseValue(kvMatch[2]);
      }
      continue;
    }

    // Indented key: value (continuation of current condition OR label-level metadata)
    if (line.startsWith('  ') && currentLabel !== null && !trimmed.startsWith('-')) {
      const kvMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        // Underscore-prefixed keys at label level are metadata (_color, _description)
        if (key.startsWith('_')) {
          if (!currentLabelMeta) currentLabelMeta = {};
          currentLabelMeta[key] = parseValue(kvMatch[2]);
        } else if (currentCondition) {
          currentCondition[key] = parseValue(kvMatch[2]);
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

      if (rawVal === '' || rawVal === '|' || rawVal === '>') {
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
  const dots = value.split('.');
  if (dots[0] !== undefined) vars.major = dots[0];
  if (dots[1] !== undefined) vars.minor = dots[1];
  if (dots[2] !== undefined) vars.patch = dots[2];
  // Trailing hash after last '-': r28945-24a9f1c224 → {hash}
  const hashMatch = value.match(/-([0-9a-f]{7,40})$/);
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
      label: 'release/{major}.{minor}',
      conditions: [{ field: 'release', format: '^\\d+\\.\\d+\\.\\d+(-rc\\d+)*$|^\\d+\\.\\d+-SNAPSHOT$', exists: 'tag:v{value}' }]
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
// Processes an opened issue event using the declarative config.
// Returns { labelsToAdd, labelsToRemove, comments }.
export async function handleIssueLabeller(data, token, config, repoFullname) {
  const result = { labelsToAdd: [], labelsToRemove: [], comments: [], labelMeta: {} };

  const issue = data.issue;
  if (!issue) return result;

  const meta = config.meta || {};
  const triggerLabel = (meta._trigger_label || 'to-triage').toLowerCase();
  const invalidLabel = meta._invalid_label || 'invalid';
  const removeLabels = meta._remove_labels || ['to-triage'];
  const invalidCommentTpl = meta._invalid_comment || 'Invalid {field} reported. `{value}`';

  const issueLabels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name));
  const issueLabelsLower = new Set(issueLabels.map(l => l.toLowerCase()));

  // Only process issues with the trigger label
  if (!issueLabelsLower.has(triggerLabel)) return result;

  // Determine issue type from labels (first label that isn't trigger or generic "bug")
  let issueType = null;
  for (const label of issueLabels) {
    const lower = label.toLowerCase();
    if (lower === triggerLabel || lower === 'bug') continue;
    issueType = label;
    break;
  }

  // Parse the issue form body
  const fields = normalizeFields(parseIssueForm(issue.body));

  // Evaluate each rule
  const probes = []; // GraphQL existence checks to batch
  const ruleResults = []; // { label, matched, invalid, field, value }

  for (const rule of (config.rules || [])) {
    let matched = true;
    let invalid = false;
    let fieldValue = '';
    let ruleField = '';
    let vars = {};

    for (const cond of rule.conditions) {
      const fieldName = (cond.field || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const value = fields[fieldName] || '';
      fieldValue = value;
      ruleField = cond.field || fieldName;
      vars = extractTemplateVars(value);

      // not_empty check
      if (cond.not_empty) {
        if (!value) { matched = false; break; }
        continue;
      }

      // contains check (case-insensitive substring)
      if (cond.contains) {
        if (!value.toLowerCase().includes(String(cond.contains).toLowerCase())) {
          matched = false; break;
        }
        continue;
      }

      // format check (regex)
      if (cond.format) {
        if (!value) { matched = false; break; }
        let regex;
        try { regex = new RegExp(cond.format); } catch { matched = false; break; }
        if (!regex.test(value)) { invalid = true; matched = false; break; }
      }

      // exists check (deferred to GraphQL batch)
      if (cond.exists && value) {
        const existsTemplate = String(cond.exists);
        const colonIdx = existsTemplate.indexOf(':');
        const checkType = colonIdx !== -1 ? existsTemplate.slice(0, colonIdx) : 'path';
        const checkPath = colonIdx !== -1 ? interpolate(existsTemplate.slice(colonIdx + 1), vars) : interpolate(existsTemplate, vars);
        const probeKey = `${rule.label}::${fieldName}`;
        probes.push({ key: probeKey, type: checkType === 'tag' ? 'tag' : 'path', value: checkPath });
        // Store probe reference for later evaluation
        if (!cond._probeKey) cond._probeKey = probeKey;
      }
    }

    ruleResults.push({ label: rule.label, matched, invalid, field: ruleField, value: fieldValue, vars, conditions: rule.conditions, ruleMeta: rule.meta });
  }

  // Execute all existence checks in one GraphQL call
  let existenceResults = new Map();
  if (probes.length > 0) {
    // Determine ref: try to find a release ref from field values, fallback to HEAD
    const ref = 'HEAD';
    existenceResults = await graphqlCheckExistence(token, repoFullname, ref, probes);
  }

  // Evaluate existence results and build final labels
  let hasInvalid = false;
  const invalidFields = [];

  for (const rr of ruleResults) {
    if (rr.invalid) {
      hasInvalid = true;
      invalidFields.push({ field: rr.field, value: rr.value });
      continue;
    }
    if (!rr.matched) continue;

    // Check existence probes for this rule
    let existsOk = true;
    for (const cond of rr.conditions) {
      if (cond._probeKey) {
        if (!existenceResults.get(cond._probeKey)) {
          existsOk = false;
          break;
        }
      }
    }

    if (!existsOk) {
      hasInvalid = true;
      invalidFields.push({ field: rr.field, value: rr.value });
      continue;
    }

    // Interpolate label template
    const labelName = interpolate(rr.label, rr.vars);
    if (labelName && !labelName.includes('{')) {
      result.labelsToAdd.push(labelName);
      if (rr.ruleMeta) {
        result.labelMeta[labelName] = { color: rr.ruleMeta._color, description: rr.ruleMeta._description };
      }
    }
  }

  // If any validation failed, add invalid label and comments
  if (hasInvalid) {
    result.labelsToAdd = [invalidLabel];
    for (const inv of invalidFields) {
      const comment = invalidCommentTpl
        .replace(/\{field\}/g, inv.field)
        .replace(/\{value\}/g, inv.value);
      result.comments.push(comment);
    }
  }

  // Remove triage/type labels
  for (const rl of removeLabels) {
    result.labelsToRemove.push(rl);
  }
  if (issueType) {
    result.labelsToRemove.push(issueType);
  }

  return result;
}

// Applies the labelling result via GitHub REST API (mutations are still REST).
export async function applyIssueLabelling(result, token, repoFullname, issueNumber, existingLabels, currentIssueLabels, onCall) {
  const issueLabelUrl = `https://api.github.com/repos/${repoFullname}/issues/${issueNumber}/labels`;
  const currentLabels = currentIssueLabels || new Set();

  // Post comments
  for (const comment of result.comments) {
    onCall?.();
    await githubApiCall(
      `https://api.github.com/repos/${repoFullname}/issues/${issueNumber}/comments`,
      token, 'POST', { body: comment }
    );
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
