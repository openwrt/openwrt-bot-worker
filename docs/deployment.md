# Deployment

## GitHub App

Repository permissions:

*   **Checks**: read and write, to publish the check runs.
*   **Pull requests**: read and write, for the comment and the labels.
*   **Issues**: read and write, to label and comment on issues. GitHub also requires it for the `issues` and `issue_comment` events.
*   **Contents**: read-only, to read `.github/formalities.json` and the other configuration files.
*   **Metadata**: read-only, which every App needs.

Event subscriptions:

*   **Pull request**: opened, synchronized, reopened, and edited when the title, body or base branch changed.
*   **Issue comment**: created, for the overrides and for re-running the checks.
*   **Issues**: opened, reopened, and edited when the body changed, for the issue labeller.

The maintainer check calls `GET /repos/{owner}/{repo}/collaborators/{username}/permission`. GitHub decides whether an installation may call it, so verify it on a real installation.

## Cloudflare Worker

The deployment pipeline deploys the Worker. In the Cloudflare dashboard, under **Workers & Pages → Settings → Variables**, add these as secrets:

*   `APP_ID`: the GitHub App ID.
*   `WEBHOOK_SECRET`: the secret that signs the webhooks.
*   `PRIVATE_KEY`: the App's private key in PKCS#8 form (`-----BEGIN PRIVATE KEY-----`). Convert a PKCS#1 key (`-----BEGIN RSA PRIVATE KEY-----`) first:

    ```sh
    openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in rsa_key.pem -out pkcs8_key.pem
    ```

## Deployment pipeline

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) deploys every push to `main` once the tests and a dry-run build pass, one deployment at a time. It records the commit hash and the deploy time in `DEPLOY_HASH` and `DEPLOY_DATE`. It needs a `CLOUDFLARE_API_TOKEN` secret with permission to edit Workers, under **Settings → Secrets and variables → Actions**.
