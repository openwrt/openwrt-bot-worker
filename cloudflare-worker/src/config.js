// Default fallback configuration if .github/formalities.json is missing in the repository
export const DEFAULT_CONFIG = {
  check_branch: true,
  check_merge_commits: true,
  check_noreply_email: true,
  check_signoff: true,
  check_signature: true,
  allow_autosquash: true,
  allow_revert: true,
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
  check_spdx_license: true,
  check_init_scripts: true,
  check_conffiles: true,
  check_uci_config: true,
  check_space_after_assignment: true,
  check_missing_colon: true,
  check_makefile_indentation: true,
  check_pkg_name_reuse: true,

  // Patches Check features
  check_patch_headers: true,

  // Package Release Check features
  check_pkg_release: 'warning',

  // Identity / Account linking Check features
  require_linked_github_account: true,

  // Labeler features
  enable_labeler_yml: false,
  enable_issue_labeller: false,

  // Stale bot: machine accounts whose comments and reviews must not reset the
  // stale countdown. GitHub Apps and *[bot] accounts are always ignored by
  // shape; automation running on a plain User account (an AI reviewer such as
  // openwrt-ai) is indistinguishable from a person and has to be named here.
  stale_ignored_users: ['openwrt-ai'],
};

export const LABEL_GUIDELINES = 'not following guidelines';
export const LABEL_ADD_PACKAGE = 'add package';
export const LABEL_DROP_PACKAGE = 'drop package';

// Default wording for everything the issue labeller says. The text is English
// and the hints name OpenWrt's own commands, which suits openwrt/openwrt and
// nothing else in particular: a feed or a fork will want its own. Each entry
// names the .github/issue-labeller.yml key that replaces it, so rewording or
// translating any of this is a config change, not a code change.
export const ISSUE_LABELLER_MESSAGES = {
  // _invalid_comment_header
  invalidHeader: 'Thank you for reporting this issue! Some required form fields could not be validated:',

  // _invalid_comment_footer
  invalidFooter: 'Please fix these by **editing the issue description** (not by replying in a comment) — this check re-runs on every edit and clears the label by itself once every field validates.',

  // _valid_comment — posted when an edit fixes a previously invalid form
  valid: 'Thank you! Every form field validates now — this issue is ready for triage.',

  // _no_form_comment — posted when the reporter bypassed the issue template
  noForm: 'Thank you for reporting this! This issue was opened without the bug report ' +
    'form, so it is missing what a maintainer needs to act on it — the OpenWrt ' +
    'version, release, target/subtarget and device at minimum.\n\n' +
    'Please open a new issue using the **Bug report** template and fill it in, ' +
    'or edit this one to add those details. If this is a question about ' +
    'configuration or a package request rather than a bug, the ' +
    '[forum](https://forum.openwrt.org/) will get you a far quicker answer than ' +
    'the issue tracker will.',

  // Per-field fallback when a rule's condition carries no `hint:` of its own.
  // Keyed by the normalized form field name.
  hints: {
    release: 'Run `. /etc/openwrt_release && echo $DISTRIB_RELEASE` on the device and paste that value alone — `24.10.0`, `24.10-SNAPSHOT` or `SNAPSHOT`, without the word "OpenWrt" and without the image file name',
    target: 'Run `. /etc/openwrt_release && echo $DISTRIB_TARGET` on the device and paste that line — it is `target/subtarget`, e.g. `ath79/generic` or `ramips/mt7621`. The image file name is not a target, and the model name belongs in the Device field',
    version: 'Run `. /etc/openwrt_release && echo $DISTRIB_REVISION` on the device and paste that revision, e.g. `r28945-24a9f1c224`'
  }
};
