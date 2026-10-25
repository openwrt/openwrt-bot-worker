# OpenWrt PR Gatekeeper

A GitHub App on Cloudflare Workers that checks pull requests to the OpenWrt repositories against the project's contribution rules and keeps their labels up to date.

## What it does

Every pull request gets three check runs:

*   **Git & Commits** checks the source branch, commit subjects and bodies, sign-offs, author identity and, on release branches, the cherry-pick marker.
*   **OpenWrt Makefiles** checks package metadata, `PKG_RELEASE`, `PKG_HASH`, conffiles, UCI files and Makefile style.
*   **Code Patches** checks that downstream patches carry `git format-patch` headers and come from the refresh target.

A failing check run also gets a comment on the pull request that lists what to fix, and the `not following guidelines` label. A check run that could not inspect everything reports *Partially checked* instead of a pass.

The bot also labels pull requests that add or drop a package or target a release branch. A repository can turn on labels from `.github/labeler.yml`, issue form validation and the cleanup of stale pull requests.

*   [docs/checks.md](docs/checks.md) lists every rule, the labels and the maintainer overrides.
*   [docs/configuration.md](docs/configuration.md) lists every key of `.github/formalities.json`.
*   [docs/issue-labeller.md](docs/issue-labeller.md) describes `.github/issue-labeller.yml`.
*   [docs/deployment.md](docs/deployment.md) sets up the GitHub App, the Worker and the deployment pipeline.

## Development

```sh
cd cloudflare-worker
npm ci
npm test
npm run typecheck
```

The Worker has no production dependencies. `cloudflare-worker/src/spdx-licenses.js` is generated: run `node scripts/update-spdx-data.mjs` to update it to a newer SPDX release.
