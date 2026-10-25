# Checks

Each rule reports into one of the three check runs. A finding is an error, which fails the check run, unless the rule is marked as a warning. The key in brackets switches the rule off or, for a graded rule, sets its level (see [configuration](configuration.md)).

## Git & Commits

*   **Source branch** (`check_branch`): a pull request opened from `main`, `master` or a release branch.
*   **Cherry-pick marker** (`check_cherry_pick`): a commit on a release branch without the `(cherry picked from commit ...)` line. A commit that has it is compared with its upstream commit at every level.
*   **New package on a release branch** (`check_new_package_on_stable`, warning): an added package the default branch has never carried. New packages land on the default branch first.
*   **Merge commits** (`check_merge_commits`): a merge commit in the pull request.
*   **Identity**: an author or committer name that is not a full name, and an author or committer address at `noreply.github.com` (`check_noreply_email`).
*   **Linked account** (`require_linked_github_account`): an author address that belongs to no GitHub account.
*   **Subject**: a missing `<package>: ` prefix, a capital letter after it, a trailing period or a missing blank line before the body.
*   **Subject scope** (`check_subject_scope`, warning): a prefix that names nothing the commit changes, such as `hostapd:` on a commit that only touches dropbear.
*   **Length** (`max_subject_len_soft`, `max_subject_len_hard`, `max_body_line_len`): a subject over the soft limit is a warning, over the hard limit an error. A body line over the limit is an error, unless it is a URL, quoted output or a word that cannot be broken.
*   **Sign-off** (`check_signoff`): a missing `Signed-off-by:` line, or one that does not match the author.
*   **Body** (`require_body`): a commit with no description besides its trailers.
*   **Signature** (`check_signature`, warning): a commit that is unsigned or whose signature GitHub could not verify.
*   **Description** (warnings): a body that repeats the subject (`warn_duplicate_body`), a generic subject such as "minor update" (`warn_generic_subjects`), a body without any link (`require_release_notes`), a subject that starts with a past tense or -ing verb (`warn_imperative_mood`) and "OpenWRT" or "Openwrt" for "OpenWrt" (`check_openwrt_spelling`).

The style rules skip `fixup!` and `squash!` commits (`allow_autosquash`). A revert keeps the subject `git revert` gives it and may restore an older `PKG_VERSION` and `PKG_RELEASE` (`allow_revert`), as long as its body names the reverted commit.

GitHub lists at most 250 commits of a pull request. The check run says so when commits were left out.

## OpenWrt Makefiles

*   **Version in subject** (`check_pkg_version`): a new `PKG_VERSION` that the commit subject does not mention.
*   **Metadata** (`check_openwrt_meta`): a new package without `PKG_MAINTAINER`, `PKG_LICENSE` or `PKG_LICENSE_FILES`. A LuCI package needs only `PKG_LICENSE`. A package built on `u-boot.mk`, `trusted-firmware-a.mk` or `optee-os.mk` needs only `PKG_MAINTAINER`.
*   **SPDX license** (`check_spdx_license`, warning): a `PKG_LICENSE` that is not an SPDX identifier, with the identifier to use where one exists.
*   **Init scripts** (`check_init_scripts`, warning): a new init script without `#!/bin/sh /etc/rc.common` or a `START=` priority.
*   **Conffiles** (`check_conffiles`): a file installed into `/etc` with `INSTALL_CONF`, or into `/etc/config`, that the package's conffiles list leaves out, and a malformed conffiles entry.
*   **UCI files** (`check_uci_config`): a file installed into `/etc/config` that is not valid UCI.
*   **Line endings** (`check_crlf`): CRLF line endings.
*   **Trailing newline** (`check_trailing_newline`): a file that does not end with a newline.
*   **Binary files** (`check_binary_files`): a file git treats as binary. Deleting one is always allowed.
*   **PKG_RELEASE** (`check_pkg_release`, warning): a new package whose `PKG_RELEASE` is not 1, a version update that does not reset it to 1 and a package change with neither a version nor a release bump. Packages built on `u-boot.mk`, `trusted-firmware-a.mk`, `optee-os.mk` or `luci.mk` never use `PKG_RELEASE` and are not asked for one.
*   **PKG_HASH** (`check_pkg_hash`, warning): a version change that keeps the old checksum, and a new package without one. A checksum the build cannot use is always an error.
*   **Source pin** (`check_pkg_source_pin`, warning): a `PKG_SOURCE_DATE` that is not a `YYYY-MM-DD` date, and a `PKG_SOURCE_VERSION` that is a branch name or an abbreviated hash.
*   **DTS checklist** (`check_dts_checklist`, warning): an added device tree without an SPDX header, with a redundant `default-state = "off"` on a GPIO LED or with the old `label = "color:function"` LED naming.
*   **Makefile style**: a space after `:=` (`check_space_after_assignment`), `=` where `:=` belongs (`check_missing_colon`), wrong indentation (`check_makefile_indentation`) and `$(PKG_NAME)` in a `define`, `call` or `eval` (`check_pkg_name_reuse`).
*   **Dead package variables**: a per-package variable such as `TITLE` or `DEPENDS` set at the top level, where the build system ignores it.
*   **Buildbot default** (`check_buildbot_default`, warning): a feed package that adds itself to buildbot images through `DEFAULT`. Not checked in openwrt/openwrt.

## Code Patches

*   **Headers** (`check_patch_headers`): a patch without the `From <hash>` line, `From:` or `Subject:` that `git format-patch` writes. Editing an older patch that already lacks them is a warning.
*   **Refresh** (`check_patch_refresh`, warning): a patch that `make package/<name>/refresh` did not write.

## Partially checked

A check run that found nothing but could not inspect everything, because the pull request was too large for the API budget, reports the neutral conclusion *Partially checked* instead of a pass. It does not block merging. A check run that found problems still fails.

## Overrides

A maintainer allows a pull request from a protected branch with a comment containing `[allow branch]`, and a commit without the cherry-pick marker with `[allow cherry-pick]`. A maintainer who opens the pull request can put the same text in its description instead. Comments by maintainers also re-run the checks.

A maintainer is a user whose association with the repository is `OWNER`, `MEMBER` or `COLLABORATOR`, or who has write, maintain or admin access. When GitHub cannot be asked, the override is not used and the rule it would have waived reports *Partially checked* instead of failing.

## Labels

*   `not following guidelines` while a check run fails.
*   `add package` and `drop package` while the pull request adds or removes a package (`add_package_label`, `drop_package_label`).
*   `release/XX.YY` while it targets a release branch (`branch_labeling`).
*   Labels from `.github/labeler.yml`, which are only ever added (`enable_labeler_yml`, off by default).
*   `stale` on a pull request labelled `not following guidelines` after 14 days without activity from its contributors. It is closed 14 days later (`enable_stale_bot`, off by default). Comments by apps, bots and the accounts in `stale_ignored_users` do not count as activity.
*   Labels for issue reports from `.github/issue-labeller.yml` (`enable_issue_labeller`, off by default), see [issue labeller](issue-labeller.md).
