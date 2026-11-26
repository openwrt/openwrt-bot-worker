# Tester ping

Adding the `RFT` label to an open pull request mentions the testers listed for the files it changes. The list lives in `CODEOWNERS` on the default branch, in comments that GitHub ignores:

```
# rft: /target/linux/mediatek/ @alice @bob
# rft: /target/linux/mediatek/dts/*bpi-r3* @carol
/package/network/services/dropbear/ @owner # rft: @dave
```

*   A comment line `# rft: <pattern> @login ...` names testers for a pattern. GitHub does not read it, so it requests no review and changes no ownership. Text after another `#` is a note, such as the boards a tester has. A repository without a `CODEOWNERS` file can start with only such lines.
*   `# rft: @login ...` after an owner line adds testers for that line's pattern. Do not add it to a pattern with no owner, which GitHub reads as clearing ownership.
*   Patterns follow the `CODEOWNERS` syntax. Unlike owners, testers add up: everyone whose pattern matches a changed file is mentioned, not only the last match.

The bot leaves out the author of the pull request and whoever added the label, and it mentions nobody twice on the same pull request. One comment mentions at most 50 testers. There is no configuration key, so a repository opts in by listing testers.
