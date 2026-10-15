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
  check_binary_files?: boolean;
  check_crlf?: boolean;
  check_trailing_newline?: boolean;
  add_package_label?: boolean;
  drop_package_label?: boolean;
  branch_labeling?: boolean;
  check_openwrt_meta?: boolean;
  check_spdx_license?: boolean;
  check_init_scripts?: boolean;
  check_conffiles?: boolean;
  check_uci_config?: boolean;
  check_space_after_assignment?: boolean;
  check_missing_colon?: boolean;
  check_makefile_indentation?: boolean;
  check_pkg_name_reuse?: boolean;
  check_buildbot_default?: boolean | 'warning' | string;

  // Patches Check features
  check_patch_headers?: boolean | 'warning' | string;

  // Package Release Check features
  check_pkg_release?: boolean | 'warning' | string;

  // Package Hash Check features
  check_pkg_hash?: boolean | 'warning' | 'error' | string;

  // Identity / Account linking Check features
  require_linked_github_account?: boolean;

  // Labeler features
  enable_labeler_yml?: boolean;
  enable_issue_labeller?: boolean;

  // Stale PR cleanup
  enable_stale_bot?: boolean;
  stale_ignored_users?: string[];

  [key: string]: unknown;
}

export function parseAndValidateConfig(rawConfigText: string | null): {
  config: FormalitiesConfig;
  error: string | null;
} {
  let config: FormalitiesConfig = { ...DEFAULT_CONFIG };
  let error: string | null = null;

  if (!rawConfigText) {
    return { config, error };
  }

  try {
    const parsed = JSON.parse(rawConfigText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = { ...DEFAULT_CONFIG, ...parsed };
    } else {
      error = `it does not contain a JSON object (got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed})`;
    }
  } catch (e: any) {
    error = e.message;
  }

  return { config, error };
}
