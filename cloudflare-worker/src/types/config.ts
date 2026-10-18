import { DEFAULT_CONFIG } from '../config.js';

export interface FormalitiesConfig {
  check_branch?: boolean;
  check_merge_commits?: boolean;
  check_noreply_email?: boolean;
  check_signoff?: boolean;
  check_signature?: boolean;
  allow_autosquash?: boolean;
  allow_revert?: boolean;
  enable_comments?: boolean;
  show_force_push_tip?: boolean;
  max_subject_len_soft?: number;
  max_subject_len_hard?: number;
  max_body_line_len?: number;

  // Description Quality Warnings
  warn_duplicate_body?: boolean;
  warn_generic_subjects?: boolean;
  warn_imperative_mood?: boolean;
  require_release_notes?: boolean;
  require_body?: boolean;
  check_openwrt_spelling?: boolean;

  // Makefile Check features
  check_pkg_version?: boolean;
  check_binary_files?: boolean | 'warning' | 'error' | 'disabled';
  check_crlf?: boolean;
  check_trailing_newline?: boolean | 'warning' | 'error' | 'disabled';
  add_package_label?: boolean;
  drop_package_label?: boolean;
  branch_labeling?: boolean;
  check_openwrt_meta?: boolean | string[];
  check_spdx_license?: boolean;
  check_init_scripts?: boolean;
  check_conffiles?: boolean;
  check_uci_config?: boolean | 'disabled';
  check_dts_checklist?: false | 'warning' | 'error' | 'disabled';
  check_space_after_assignment?: boolean;
  check_missing_colon?: boolean;
  check_makefile_indentation?: boolean;
  check_pkg_name_reuse?: boolean;
  check_buildbot_default?: boolean | 'warning' | 'error' | 'disabled';

  // Patches Check features
  check_patch_headers?: boolean | 'warning' | 'error' | 'disabled';
  check_patch_refresh?: boolean | 'warning' | 'error' | 'disabled';

  // Package Release Check features
  check_pkg_release?: boolean | 'warning' | 'error' | 'disabled';

  // Package Hash Check features
  check_pkg_hash?: false | 'warning' | 'error' | 'disabled';

  // Package Source Pin Check features
  check_pkg_source_pin?: false | 'warning' | 'error' | 'disabled';

  // New Package on a Release Branch Check features
  check_new_package_on_stable?: boolean | 'warning' | 'error' | 'disabled';

  // Identity / Account linking Check features
  require_linked_github_account?: boolean | 'warning' | 'error' | 'disabled';

  // Labeler features
  enable_labeler_yml?: boolean;
  enable_issue_labeller?: boolean;

  // Stale PR cleanup
  enable_stale_bot?: boolean;
  stale_ignored_users?: string[];

  [key: string]: unknown;
}

const BOOLEAN_FIELDS = new Set([
  'check_branch',
  'check_merge_commits',
  'check_noreply_email',
  'check_signoff',
  'check_signature',
  'allow_autosquash',
  'allow_revert',
  'enable_comments',
  'show_force_push_tip',
  'warn_duplicate_body',
  'warn_generic_subjects',
  'warn_imperative_mood',
  'require_release_notes',
  'require_body',
  'check_openwrt_spelling',
  'check_pkg_version',
  'check_crlf',
  'add_package_label',
  'drop_package_label',
  'branch_labeling',
  'check_spdx_license',
  'check_init_scripts',
  'check_conffiles',
  'check_space_after_assignment',
  'check_missing_colon',
  'check_makefile_indentation',
  'check_pkg_name_reuse',
  'enable_labeler_yml',
  'enable_issue_labeller',
  'enable_stale_bot'
]);

const NUMBER_FIELDS = new Set([
  'max_subject_len_soft',
  'max_subject_len_hard',
  'max_body_line_len'
]);

const ALLOWED_VALUES_BY_FIELD: Record<string, Set<unknown>> = {
  check_binary_files: new Set([true, false, 'warning', 'error', 'disabled']),
  check_trailing_newline: new Set([true, false, 'warning', 'error', 'disabled']),
  require_linked_github_account: new Set([true, false, 'warning', 'error', 'disabled']),
  check_uci_config: new Set([true, false, 'disabled']),
  check_dts_checklist: new Set([false, 'warning', 'error', 'disabled']),
  check_buildbot_default: new Set([true, false, 'warning', 'error', 'disabled']),
  check_patch_headers: new Set([true, false, 'warning', 'error', 'disabled']),
  check_patch_refresh: new Set([true, false, 'warning', 'error', 'disabled']),
  check_pkg_release: new Set([true, false, 'warning', 'error', 'disabled']),
  check_pkg_hash: new Set([false, 'warning', 'error', 'disabled']),
  check_pkg_source_pin: new Set([false, 'warning', 'error', 'disabled']),
  check_new_package_on_stable: new Set([true, false, 'warning', 'error', 'disabled'])
};

const STRING_ARRAY_FIELDS = new Set([
  'stale_ignored_users'
]);

export function parseAndValidateConfig(rawConfigText: string | null): {
  config: FormalitiesConfig;
  error: string | null;
  // `true` when only the fields named in `error` fell back to their defaults
  // and the rest of the file is in `config`; `false` when the file could not
  // be read at all and every setting is a default.
  partial: boolean;
} {
  let config: FormalitiesConfig = { ...(DEFAULT_CONFIG as FormalitiesConfig) };
  let error: string | null = null;
  let partial = false;

  if (!rawConfigText) {
    return { config, error, partial };
  }

  try {
    const parsed = JSON.parse(rawConfigText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      error = `it does not contain a JSON object (got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed})`;
      return { config, error, partial };
    }

    const fieldErrors: string[] = [];
    // Every field that passed. One unusable setting is no reason to throw away
    // the ones beside it: discarding the file wholesale silently turns options
    // the repository did configure back to their defaults, which reads as the
    // bot ignoring the configuration rather than as one typo.
    // Null-prototype, so a field literally named `__proto__` is kept as an
    // ordinary key the way spreading the parsed object kept it.
    const accepted: Record<string, unknown> = Object.create(null);

    for (const [key, val] of Object.entries(parsed)) {
      const before = fieldErrors.length;
      if (val === null || val === undefined) {
        fieldErrors.push(`field "${key}" must not be null`);
        continue;
      }
      if (BOOLEAN_FIELDS.has(key)) {
        if (typeof val !== 'boolean') {
          fieldErrors.push(`field "${key}" must be a boolean (got ${typeof val})`);
        }
      } else if (NUMBER_FIELDS.has(key)) {
        if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val) || val < 0) {
          fieldErrors.push(`field "${key}" must be a non-negative integer (got ${val})`);
        }
      } else if (key === 'check_openwrt_meta') {
        const isValid =
          typeof val === 'boolean' ||
          (Array.isArray(val) && val.length > 0 && val.every(item => typeof item === 'string' && /^[A-Za-z0-9_-]+$/.test(item.trim())));
        if (!isValid) {
          fieldErrors.push(`field "check_openwrt_meta" must be a boolean or an array of valid Makefile variable names (got ${JSON.stringify(val)})`);
        }
      } else if (Object.hasOwn(ALLOWED_VALUES_BY_FIELD, key)) {
        const allowed = ALLOWED_VALUES_BY_FIELD[key];
        if (!allowed.has(val)) {
          const allowedStr = Array.from(allowed).map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(', ');
          fieldErrors.push(`field "${key}" must be one of [${allowedStr}] (got ${JSON.stringify(val)})`);
        }
      } else if (STRING_ARRAY_FIELDS.has(key)) {
        if (!Array.isArray(val) || !val.every(item => typeof item === 'string')) {
          fieldErrors.push(`field "${key}" must be an array of strings`);
        }
      }
      // Unknown fields are tolerated for forward/backward compatibility
      if (fieldErrors.length === before) {
        accepted[key] = val;
      }
    }

    const softLen = typeof accepted.max_subject_len_soft === 'number'
      ? accepted.max_subject_len_soft
      : (config.max_subject_len_soft ?? 50);
    const hardLen = typeof accepted.max_subject_len_hard === 'number'
      ? accepted.max_subject_len_hard
      : (config.max_subject_len_hard ?? 72);
    if (softLen > hardLen) {
      // Neither limit can be honoured on its own here, so the pair goes back
      // to the defaults together.
      fieldErrors.push(`max_subject_len_soft (${softLen}) must not be greater than max_subject_len_hard (${hardLen})`);
      delete accepted.max_subject_len_soft;
      delete accepted.max_subject_len_hard;
    }

    config = { ...(DEFAULT_CONFIG as FormalitiesConfig), ...accepted };

    if (fieldErrors.length > 0) {
      error = fieldErrors.join('; ');
      partial = true;
    }
  } catch (e: any) {
    error = e.message;
  }

  return { config, error, partial };
}
