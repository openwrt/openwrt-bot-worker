// Default fallback configuration if .github/formalities.json is missing in the repository
export const DEFAULT_CONFIG = {
  check_branch: true,
  check_merge_commits: true,
  check_noreply_email: true,
  check_signoff: true,
  check_signature: true,
  allow_autosquash: true,
  enable_comments: true,
  show_force_push_tip: true,
  max_subject_len_soft: 60,
  max_subject_len_hard: 80,
  max_body_line_len: 100,

  // Description Quality Warnings
  warn_duplicate_body: true,
  warn_generic_subjects: true,
  require_release_notes: true,
  require_body: true,
  check_openwrt_spelling: true,

  // Makefile Check features
  check_pkg_version: true,
  check_crlf: true,
  check_trailing_newline: true,
  add_package_label: true,
  drop_package_label: true,
  branch_labeling: true,
  check_openwrt_meta: true,
  check_conffiles: true,
  check_uci_config: true,

  // Patches Check features
  check_patch_headers: true,

  // Package Release Check features
  check_pkg_release: 'warning',

  // Identity / Account linking Check features
  require_linked_github_account: true,
};

export const LABEL_GUIDELINES = 'not following guidelines';
export const LABEL_ADD_PACKAGE = 'add package';
export const LABEL_DROP_PACKAGE = 'drop package';
