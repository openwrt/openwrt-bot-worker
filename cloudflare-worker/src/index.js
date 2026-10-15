import { verifySignature, getInstallationToken } from './crypto.js';
import { handleScheduled } from './stale.js';
import { isBotUser } from './core/utils.ts';
import { handleIssuesEvent } from './handlers/issues.ts';
import { handlePullRequestEvent } from './handlers/pull-request/index.ts';
import { isPullRequestPayload, isIssueCommentPayload, isIssuesPayload } from './types/github.ts';

// --- WEBHOOK HANDLER ---
async function handleWebhook(request, env) {
  const payloadText = await request.text();
  const signature = request.headers.get("x-hub-signature-256") || "";

  if (!await verifySignature(payloadText, signature, env.WEBHOOK_SECRET)) {
    console.error("Webhook signature verification failed.");
    return new Response("Invalid signature", { status: 403 });
  }

  const data = JSON.parse(payloadText);
  const event = request.headers.get("x-github-event");
  if (event !== "pull_request" && event !== "issue_comment" && event !== "issues") {
    return new Response("Not a pull request or issue comment event", { status: 200 });
  }

  if (event === "issue_comment") {
    if (!isIssueCommentPayload(data)) {
      return new Response("Invalid payload: expected issue_comment event payload with issue and comment objects", { status: 400 });
    }
    if (data.action !== "created") {
      return new Response("Ignored issue comment action", { status: 200 });
    }

    if (!data.issue.pull_request) {
      return new Response("Comment is not on a pull request", { status: 200 });
    }

    if (isBotUser(data.comment.user)) {
      return new Response("Ignored non-maintainer issue comment", { status: 200 });
    }
  } else if (event === "issues") {
    if (!isIssuesPayload(data)) {
      return new Response("Invalid payload: expected issues event payload with issue object", { status: 400 });
    }
    const action = data.action || '';
    if (!['opened', 'edited', 'reopened'].includes(action)) {
      return new Response("Ignored issues action", { status: 200 });
    }
    if (action === 'edited' && !data.changes?.body) {
      return new Response("Issue edit did not change the body", { status: 200 });
    }
  } else {
    if (!isPullRequestPayload(data)) {
      return new Response("Invalid payload: expected pull_request event payload with pull_request object", { status: 400 });
    }
    const action = data.action || '';
    if (!['opened', 'synchronize', 'reopened', 'edited'].includes(action)) {
      return new Response("Ignored pull request action", { status: 200 });
    }
    if (action === 'edited' && !data.changes?.base && !data.changes?.body && !data.changes?.title) {
      return new Response("Pull request edit changed neither the title, base branch nor the description", { status: 200 });
    }
  }

  const installationId = data.installation?.id;
  if (!installationId) {
    console.error("Webhook processing failed: Missing installation ID in payload.");
    return new Response("Missing installation ID", { status: 400 });
  }

  const appId = Number(env.APP_ID) || null;

  let tokenMintAttempts = 0;
  const token = await getInstallationToken(installationId, env.APP_ID, env.PRIVATE_KEY, () => { tokenMintAttempts++; });
  if (!token) {
    console.error(`Webhook processing failed: Could not generate installation access token for installation ID ${installationId}.`);
    return new Response("Could not generate installation access token", { status: 500 });
  }

  const repoFullname = data.repository?.full_name;
  if (!repoFullname) {
    console.error("Webhook processing failed: Missing repository full name in payload.");
    return new Response("Missing repository", { status: 400 });
  }

  if (event === "issues") {
    return await handleIssuesEvent(data, token, repoFullname, appId, env, tokenMintAttempts);
  }

  return await handlePullRequestEvent(data, event, env, token, repoFullname, appId, tokenMintAttempts);
}

// --- FETCH ENTRYPOINT ---
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/webhook") {
        // GitHub gives up on a delivery after ten seconds, and once the client
        // is gone Cloudflare may cancel whatever is still in flight - the
        // status writes at the end of a long run included. Registering the
        // work keeps it alive for up to thirty seconds past that; the answer
        // still waits for it, so the delivery log keeps showing failures.
        const work = handleWebhook(request, env);
        ctx?.waitUntil?.(work.catch(() => {}));
        return await work;
      }

      return new Response("Invalid Request", { status: 400 });
    } catch (rawError) {
      console.error("Webhook processing failed:", rawError);

      let name = "Error";
      let message;

      if (rawError instanceof Error) {
        name = rawError.name;
        message = rawError.message;
      } else if (rawError && typeof rawError === 'object') {
        name = String(rawError.name || "Error");
        message = String(rawError.message || rawError);
      } else if (rawError !== undefined && rawError !== null) {
        message = String(rawError);
      } else {
        message = "null";
      }

      const errorDetails = {
        name,
        message,
        timestamp: Date.now()
      };
      return new Response(JSON.stringify({
        exception: errorDetails,
        message: errorDetails.message
      }, null, 2), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  }
};
