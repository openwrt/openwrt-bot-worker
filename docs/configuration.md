# Configuration

A repository changes the defaults with a `.github/formalities.json` file on its default branch. Keys it leaves out keep their defaults, and unknown keys are ignored. A key with a value the bot does not accept keeps its default, and the check runs name it.

```json
{
  "check_pkg_release": "error",
  "check_subject_scope": false,
  "enable_stale_bot": true
}
```

A graded rule takes a level:

*   `"error"` or `true` fails the check run.
*   `"warning"` reports the finding without failing.
*   `"disabled"` or `false` switches the rule off.

What each rule reports is in [checks](checks.md).

| Key | Values | Default | Controls |
|---|---|---|---|
| `check_branch` | boolean | `true` | Source branch |
| `check_cherry_pick` | level | `true` | Cherry-pick marker |
| `check_merge_commits` | boolean | `true` | Merge commits |
| `check_noreply_email` | boolean | `true` | `noreply.github.com` addresses |
| `check_signoff` | boolean | `true` | Sign-off |
| `check_signature` | boolean | `true` | Signature warning |
| `allow_autosquash` | boolean | `true` | Style rules skip `fixup!` and `squash!` commits |
| `allow_revert` | boolean | `true` | Reverts keep their subject and restored versions |
| `enable_comments` | boolean | `true` | Comment that lists the findings |
| `show_force_push_tip` | boolean | `true` | Force-push tip in that comment |
| `max_subject_len_soft` | number | `60` | Subject length that warns |
| `max_subject_len_hard` | number | `80` | Subject length that fails |
| `max_body_line_len` | number | `100` | Body line length that fails |
| `warn_duplicate_body` | boolean | `true` | Body that repeats the subject |
| `warn_generic_subjects` | boolean | `true` | Generic subject |
| `warn_imperative_mood` | boolean | `true` | Subject in the past tense |
| `require_release_notes` | boolean | `true` | Body without a link |
| `require_body` | boolean | `true` | Empty body |
| `check_openwrt_spelling` | boolean | `true` | Spelling of "OpenWrt" |
| `check_subject_scope` | level | `"warning"` | Subject scope |
| `subject_scope_prefixes` | list of strings | see below | Prefixes the subject scope rule always accepts |
| `check_pkg_version` | boolean | `true` | Version in subject |
| `check_binary_files` | level | `true` | Binary files |
| `check_crlf` | boolean | `true` | Line endings |
| `check_trailing_newline` | level | `true` | Trailing newline |
| `add_package_label` | boolean | `true` | `add package` label |
| `drop_package_label` | boolean | `true` | `drop package` label |
| `branch_labeling` | boolean | `true` | `release/XX.YY` labels |
| `check_openwrt_meta` | boolean or list of variable names | `true` | Metadata. A list sets the required variables, for example `["PKG_MAINTAINER", "PKG_LICENSE"]` |
| `check_spdx_license` | boolean | `true` | SPDX license |
| `check_init_scripts` | boolean | `true` | Init scripts |
| `check_conffiles` | boolean | `true` | Conffiles |
| `check_uci_config` | `true`, `false` or `"disabled"` | `true` | UCI files |
| `check_dts_checklist` | level, not `true` | `"warning"` | DTS checklist |
| `check_space_after_assignment` | boolean | `true` | Space after `:=` |
| `check_missing_colon` | boolean | `true` | `=` where `:=` belongs |
| `check_makefile_indentation` | boolean | `true` | Makefile indentation |
| `check_pkg_name_reuse` | boolean | `true` | `$(PKG_NAME)` in `define`, `call` or `eval` |
| `check_buildbot_default` | level | `"warning"` | Buildbot default |
| `check_patch_headers` | level | `true` | Patch headers |
| `check_patch_refresh` | level | `"warning"` | Patch refresh |
| `check_pkg_release` | level | `"warning"` | `PKG_RELEASE` |
| `check_pkg_hash` | level, not `true` | `"warning"` | `PKG_HASH` |
| `check_pkg_source_pin` | level, not `true` | `"warning"` | Source pin |
| `check_new_package_on_stable` | level | `"warning"` | New package on a release branch |
| `require_linked_github_account` | level | `true` | Linked account |
| `enable_labeler_yml` | boolean | `false` | Labels from `.github/labeler.yml` |
| `enable_issue_labeller` | boolean | `false` | [Issue labeller](issue-labeller.md) |
| `enable_stale_bot` | boolean | `false` | Stale pull request cleanup |
| `stale_ignored_users` | list of strings | `["openwrt-ai"]` | Accounts whose activity does not keep a pull request from going stale |

`subject_scope_prefixes` defaults to `lint`, `css`, `housekeeping`, `meta`, `wiki`, `npm`, `vscode`, `editor`, `devcontainer`, `i18n`, `docs`, `treewide` and `tree-wide`. A repository's own habitual prefixes belong there, rather than switching the rule off.
