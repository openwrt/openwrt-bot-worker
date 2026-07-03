# OpenWrt PR Gatekeeper

A modern GitHub App webhook engine running on **Cloudflare Workers** that automates Pull Request validations, styling constraints, OpenWrt build recipe (Makefile) checks, downstream patches testing, and timeline triage.

## Features Matrix

The validation engine splits checks into three distinct asynchronous status streams grouped natively under the GitHub App interface:

### 1. Formalities Check
Focuses on Git history hygiene, developer metadata constraints, and layout standards:

*   **Branch Target Enforcement:** Ensures pull requests originate from dedicated feature branches, blocking accidental direct PRs from `main`, `master`, or active stable branches.
*   **Stable Branch Backports Enforcement:** Ensures that pull requests targeting active stable/backport branches (e.g., `openwrt-25.12`, `openwrt-24.10`) contain the context line `(cherry picked from commit ...)` in every commit message.

> [!TIP]
> Maintainers (`OWNER`, `MEMBER`, or `COLLABORATOR`) can bypass this check by posting a pull request comment containing `[allow cherry-pick]` (or `[allow-cherry-pick]`). Alternatively, if the PR author is a maintainer, they can also include `[allow cherry-pick]` in the PR description.

*   **Merge Commit Elimination:** Rejects merge commits inside the PR tracking chain to preserve a clean linear history.
*   **Identity Integrity:** Validates author and committer name formats and strictly blocks generic GitHub `noreply.github.com` email addresses.
*   **Linked GitHub Account:** Verifies that the commit author email address is registered and verified on a GitHub account, linking the commit to a valid GitHub username.
*   **Autosquash Compliance:** Automatically bypasses style constraints for development-phase `fixup!` and `squash!` syntax blocks.
*   **Subject String Hygiene:** Enforces `<package name or prefix>: ` prefix headers, checks lowercase starting strings post-prefix, and rejects trailing periods.
*   **Length Constraints:** Implements dual-layered (soft and hard) line width boundaries for both subject lines and description body text blocks.
*   **Signed-off-by Check:** Ensures a consistent, properly structured `Signed-off-by:` declaration is present and matches the original author metadata.
*   **Signature Verification:** Validates cryptographic GPG/SSH commit signatures if present.
*   **Description Quality Warnings:** Inspects message bodies and issues non-blocking warnings for lazy/identical description text mirroring the subject or for completely missing reference links (changelogs/release notes).
*   **Mandatory Description Body:** Rejects commits whose description body is empty or contains only trailers (e.g. `Signed-off-by:`). Every commit must include a meaningful explanation of what the change does and why.

> [!NOTE]
> To keep API/subrequest usage predictable on extreme PRs, commit-message auditing is intentionally capped to the first 300 commits. If a PR exceeds this size, the check output includes an explicit warning about the reduced commit audit scope.

### 2. Makefile Check
Inspects file modification trees targeting OpenWrt build recipes:

*   **PKG_VERSION Sync:** Validates that if a version bump is introduced inside a Makefile, the matching version string exists within the commit subject line context.
*   **Mandatory Metadata (`check_openwrt_meta`):** Enforces the inclusion of `PKG_MAINTAINER`, `PKG_LICENSE`, and `PKG_LICENSE_FILES` variables whenever a new package is introduced (fully configurable list).
*   **Conffiles Tracker:** Mandates the definition of the `Package/.../conffiles` tracking macro whenever configuration file installations (`INSTALL_CONF`) are triggered.
*   **Line Ending Sanitization:** Inspects modifications for Windows-style Carriage Returns (CRLF) to guarantee exclusive UNIX (LF) formatting compliance.
*   **PKG_RELEASE Validation:** Enforces correct release values on package changes: new packages must initialize `PKG_RELEASE` to `1`, version updates must reset `PKG_RELEASE` to `1`, and modifications to package files must be accompanied by a version/release change (customizable level: warning/error/disabled).

### 3. Patches Check
Scans the contribution tree for nested downstream patch targets:

*   **Git-Am Compliance:** Automatically isolates modified `.patch` assets and checks for accurate `From:` and `Subject:` header identifiers to ensure smooth downstream `git am` deployment runs.

---

### Automated Triage & Stale PR Management

*   **`not following guidelines`**: A high-visibility tag automatically attached to the PR if any critical validation check drops a failure blueprint. Clears itself upon a successful push.
*   **`add package` / `drop package`**: Dynamically analyzes unified diff targets to label tracking trees introducing or purging software packages.
*   **Stable Branch Tracking**: Auto-generates matching grey release tags (e.g., `release/24.10`, `release/25.12`) whenever a PR targets an active release backport branch.
*   **Stale PR Cleanup**: A daily scheduled cron task (05:30 UTC) scans all repositories where the App is installed. If explicitly enabled in a repository's configuration (\`"enable_stale_bot": true\`), it marks PRs containing the \`not following guidelines\` label as \`stale\` (with a warning comment) after 14 days of inactivity, and closes them after another 14 days of silence.

> [!TIP]
> Stale PR cleanup is completely disabled by default. If a repository wants to enable this automated cleanup flow, it must commit a `.github/formalities.json` file in its default branch containing `"enable_stale_bot": true`. 

*   **Clean Timelines**: Drops descriptive, cleanly formatted markdown dashboards into the PR conversation section on failure, automatically editing or removing itself once instructions are followed to keep the timeline clean.
*   **Header Footnote**: PR comments include a dynamic footnote linking directly to this repository's issues page for reporting validation bugs.

---

## Setup & Deployment

The engine is built as a headless JavaScript service hosted on **Cloudflare Workers**. It operates with zero local npm/Node dependencies inside the repository, making it highly secure and maintenance-free.

### 1. GitHub App Configuration

The GitHub App requires the following permissions and event subscriptions:

*   **Repository permissions:**
    *   **Checks:** `Read & write` (to publish validation audit check runs)
    *   **Commit statuses:** `Read & write` (to update commit statuses)
    *   **Pull requests:** `Read & write` (to add review comments and manage triage labels)
    *   **Contents:** `Read-only` (to fetch repository-specific configurations like `.github/formalities.json`)
*   **Event Subscriptions:**
    *   Subscribe to **Pull request** events (triggers on opened, synchronized, and reopened).

### 2. Cloudflare Worker Configuration

1.  Deploy the Worker to your Cloudflare account (managed automatically via the CI/CD pipeline).
2.  In the Cloudflare Dashboard under **Workers & Pages -> Settings -> Variables**, configure the following variables as **Secrets** (encrypted):
    *   **`APP_ID`**: Your GitHub App ID (e.g., `123456`).
    *   **`WEBHOOK_SECRET`**: The secret token used to verify GitHub webhook HMAC-SHA256 signatures.
    *   **`PRIVATE_KEY`**: The complete text of your GitHub App private key PEM file.

> [!IMPORTANT]
> The private key must be in **PKCS#8** format (starting with `-----BEGIN PRIVATE KEY-----`). If your downloaded key starts with `-----BEGIN RSA PRIVATE KEY-----` (PKCS#1), convert it using:
> `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in rsa_key.pem -out pkcs8_key.pem`

### 3. CI/CD Pipeline (GitHub Actions)

The repository includes a GitHub Actions workflow in [`.github/workflows/deploy.yml`](file:///.github/workflows/deploy.yml) that builds and deploys the Worker automatically on every push to `main`:
*   Runs on a lightweight `ubuntu-slim` container.
*   Automatically injects the build commit hash (`DEPLOY_HASH`) and deploy timestamp in Prague timezone (`DEPLOY_DATE`) into the wrangler variables before deployment.
*   To enable deployment, add your **`CLOUDFLARE_API_TOKEN`** (with edit permissions for Workers) as a secret in your GitHub repository's **Settings -> Secrets and variables -> Actions**.

### 4. Repository Level Customization

If individual source repositories wish to tweak defaults or scale back rule restrictions, creators can commit a custom `.github/formalities.json` file inside their repository branch root.

Some configuration keys offer advanced options:
*   `check_openwrt_meta`: Can be `true` (enforces standard `PKG_MAINTAINER`, `PKG_LICENSE`, and `PKG_LICENSE_FILES` for new packages), `false` (disabled), or an array of custom required fields (e.g., `["PKG_MAINTAINER", "PKG_LICENSE"]`).
*   `check_pkg_release`: Can be `"warning"`, `"error"`, or `false` to disable.
*   `enable_stale_bot`: Set to `true` to enable the stale PR bot cleanup for this repository. Defaults to `false` (opt-in).

Here is a comprehensive example containing all available toggle options:

```json
{
  "check_branch": true,
  "check_merge_commits": true,
  "check_noreply_email": true,
  "check_signoff": true,
  "check_signature": true,
  "allow_autosquash": true,
  "enable_comments": true,
  "max_subject_len_soft": 60,
  "max_subject_len_hard": 80,
  "max_body_line_len": 100,
  "warn_duplicate_body": true,
  "warn_generic_subjects": true,
  "require_release_notes": true,
  "require_body": true,
  "check_pkg_version": true,
  "check_crlf": true,
  "add_package_label": true,
  "drop_package_label": true,
  "branch_labeling": true,
  "check_openwrt_meta": true,
  "check_conffiles": true,
  "check_patch_headers": true,
  "check_pkg_release": "warning",
  "require_linked_github_account": true,
  "enable_stale_bot": false
}
```
