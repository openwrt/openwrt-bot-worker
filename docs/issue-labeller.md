# Issue labeller

With `enable_issue_labeller` on, the bot reads `.github/issue-labeller.yml` from the repository's default branch and checks the fields of issue forms. Each top-level key is a label, followed by conditions that must all match for the label to apply. Without the file the bot uses its built-in rules, `DEFAULT_ISSUE_LABELLER_CONFIG` in [`cloudflare-worker/src/issue-labeller.js`](../cloudflare-worker/src/issue-labeller.js), which label the release, the target, the image kind and the device much as the example below does.

## Conditions

*   `field`: the form field to read, by name, case-insensitive.
*   `format`: a regular expression the value must match. A value that does not match gets the `invalid` label and a comment.
*   `exists`: a tag or path that must exist, such as `"tag:v{value}"` or `"path:target/linux/{segment0}"`.
*   `contains`: a case-insensitive substring.
*   `not_empty`: the field must not be empty.
*   `hint`: what the reporter should do when the check fails, shown in the comment. Write it as an instruction.

A label name and `exists` can use parts of the matched value: `{value}` is all of it, `{segment0}`, `{segment1}` are its slash-separated parts (`ramips/mt7621`), `{major}`, `{minor}`, `{patch}` its dot-separated parts (`24.10.0`) and `{hash}` the hex string after its last `-` (`r28945-24a9f1c224`).

A label can also set `_color` (default `ededed`) and `_description`, used when the bot creates it.

## Settings

*   `_trigger_label`: the label an issue needs before the bot reads it (default `to-triage`).
*   `_invalid_label`: the label for a form that fails (default `invalid`).
*   `_remove_labels`: labels removed once the form was read (default `["to-triage"]`).
*   `_invalid_comment_header` and `_invalid_comment_footer`: the text above and below the list of failed fields.
*   `_valid_comment`: posted when an edit fixes the form.
*   `_require_form`: also read issues without the trigger label, and flag those written without the issue template (default `false`). Issues by `OWNER`, `MEMBER` and `COLLABORATOR` are left alone.
*   `_no_form_comment`: posted to issues written without the template.

The default texts are `ISSUE_LABELLER_MESSAGES` in [`cloudflare-worker/src/config.js`](../cloudflare-worker/src/config.js).

## Edits

The bot reads the form again whenever the issue is edited, until it passes. It keeps a single comment and edits it. When the form passes, the `invalid` label goes and the comment is replaced with `_valid_comment`. Labels for fields that passed stay when another field fails.

## Example

```yaml
_trigger_label: "to-triage"
_invalid_label: "invalid"
_remove_labels: ["to-triage"]

"release/{major}.{minor}":
  _color: "6b7280"
  _description: "OpenWrt release version reported"
  - field: "release"
    format: '^\d+\.\d+\.\d+(-rc\d+)*$|^\d+\.\d+-SNAPSHOT$'
    exists: "tag:v{value}"

"target/{segment0}":
  _color: "0e7490"
  _description: "Hardware target reported"
  - field: "target"
    format: '^[a-zA-Z0-9]+/[a-zA-Z0-9]+$'
    exists: "path:target/linux/{segment0}/{segment1}"
    hint: "Run `. /etc/openwrt_release && echo $DISTRIB_TARGET` on the device and paste that line, for example `ramips/mt7621`"

"Official Image":
  - field: "image_kind"
    contains: "official"

"Self Built Image":
  - field: "image_kind"
    contains: "self"

"Supported Device":
  - field: "device"
    not_empty: true
```
