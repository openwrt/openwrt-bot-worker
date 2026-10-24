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
  warn_imperative_mood: true,
  require_release_notes: true,
  require_body: true,
  check_openwrt_spelling: true,

  // Whether the subject prefix names anything the commit changes. 'warning'
  // by default: a prefix naming the package a change is for, not the file it
  // edits, is legitimate and looks exactly like a typo; about half of what it
  // reported in the merged history was the first kind.
  check_subject_scope: 'warning',
  // Prefixes that name no directory, always accepted by the check above.
  subject_scope_prefixes: ['lint', 'css', 'housekeeping', 'meta', 'wiki', 'npm', 'vscode',
    'editor', 'devcontainer', 'i18n', 'docs', 'treewide', 'tree-wide'],

  // Makefile Check features
  check_pkg_version: true,
  check_binary_files: true,
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
  // 'warning' by default: the wiki asks rather than requires ("consider
  // adding"), and every finding measured in 8 months was on a merged commit.
  check_dts_checklist: 'warning',
  check_space_after_assignment: true,
  check_missing_colon: true,
  check_makefile_indentation: true,
  check_pkg_name_reuse: true,
  check_buildbot_default: 'warning',

  // Patches Check features
  check_patch_headers: true,
  // 'warning' by default: the rule is openwrt/packages' CONTRIBUTING.md, and
  // openwrt/openwrt, which has none, merges upstream-format patches.
  check_patch_refresh: 'warning',

  // Package Release Check features
  check_pkg_release: 'warning',

  // Package Hash Check features. 'warning' by default: whether a version
  // change really means the source archive changed is an inference, not a
  // fact the bot can establish. A checksum the download step cannot use at
  // all is reported as an error at either level while the audit is on.
  check_pkg_hash: 'warning',

  // Package Source Pin Check features. 'warning' by default: the date and
  // revision shapes come from the package policies alone, and the build
  // system accepts every value this check reports.
  check_pkg_source_pin: 'warning',

  // New package on a release branch. 'warning' by default: openwrt/packages'
  // ban is overruled in practice (12 new packages merged into openwrt-24.10
  // as backports), and openwrt/openwrt has no such rule in the repository.
  check_new_package_on_stable: 'warning',

  // Identity / Account linking Check features
  require_linked_github_account: true,

  // Labeler features
  enable_labeler_yml: false,
  enable_issue_labeller: false,

  // Stale cleanup, read by the scheduled scan (see stale.js). One rule per
  // kind: an open item carrying one of `labels` and idle for
  // `days_until_stale` days is marked `stale` with a comment, and closed
  // `days_until_close` days later unless someone acts and `close` is set.
  // `dry_run` only logs what the scan would do. An issue is asked once, and
  // at most `max_per_run` issues are marked per scan, so turning it on does
  // not post on a whole backlog at once. `ignored_users` names machine
  // accounts whose comments and reviews never reset the countdown: GitHub
  // Apps and *[bot] accounts are ignored by shape, but automation running on
  // a plain User account (an AI reviewer such as openwrt-ai) is
  // indistinguishable from a person and has to be named here. The older
  // `enable_stale_bot` and `stale_ignored_users` keys still apply when the
  // block leaves `pull_requests.enabled` and `ignored_users` out.
  stale_bot: {
    ignored_users: ['openwrt-ai'],
    pull_requests: {
      enabled: false,
      labels: ['not following guidelines'],
      days_until_stale: 14,
      days_until_close: 14,
      close: true,
      dry_run: false
    },
    issues: {
      enabled: false,
      labels: [],
      days_until_stale: 14,
      days_until_close: 14,
      close: false,
      dry_run: false,
      max_per_run: 10
    }
  },
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
