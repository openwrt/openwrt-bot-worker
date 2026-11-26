# Repository rules

A repository can add its own checks to `.github/llm-review-rules.md`, the file its LLM reviewer reads. A rule is a fenced block tagged `formality-rule`, next to the text that explains it:

````markdown
```formality-rule
files: target/linux/**/*.dts*
added: mediatek,mtd-eeprom
message: Read the EEPROM through an nvmem cell, `nvmem-cells` with `nvmem-cell-names = "eeprom"`, instead of `mediatek,mtd-eeprom`.
```
````

*   `files` is a path glob, as in `.github/labeler.yml`. Repeat the key for more globs.
*   `added` is text that a line the commit adds must contain. Repeat it for alternatives.
*   `message` says what to do instead.
*   `level` is `warning`, the default, or `error`, which fails the check run.

The text is compared as written, case included. The bot reads the file from the branch the pull request targets and reports in the OpenWrt Makefiles check run. Merges, reverts and verbatim backports are not checked, and a backport is not held to the lines its upstream commit added too. A block the bot cannot read is named in the check run, and at most 50 rules are checked.
