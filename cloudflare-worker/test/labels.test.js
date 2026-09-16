import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import worker from '../src/index.js';
import { calculateHmac, graphqlLabelsHandler } from './github-mocks.js';

// Package and release labels describe what a pull request contains, so the bot
// takes them off again once that no longer holds.
describe('Derived label cleanup', () => {
  let originalFetch;
  let fetchMock;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) =>
      (fetchMock ? fetchMock(url, options) : new Response(JSON.stringify({}), { status: 200 }));
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  // Runs one webhook on a pull request that already carries the given labels,
  // and reports which labels the run took off. `live` is how the pull request
  // looks when the run reads it again, by default the same as the payload.
  async function labelsRemovedFor({ labels, baseRef = 'main', patch, config = {}, patchStatus = 200, mergeOnly = false, posted = null, labeler = null, live = {} }) {
    const payload = JSON.stringify({
      action: 'synchronize',
      pull_request: {
        number: 123, title: 'mypkg: update to 1.2.3', body: 'Update',
        labels: labels.map(name => ({ name })),
        base: { ref: baseRef, sha: 'basesha' }, head: { ref: 'feature-branch', sha: 'headsha' },
        user: { login: 'johndoe', type: 'User' },
        commits_url: 'https://api.github.com/repos/test/repo/pulls/123/commits',
        url: 'https://api.github.com/repos/test/repo/pulls/123'
      },
      installation: { id: 456 }, repository: { full_name: 'test/repo' }
    });
    const secret = 'mysecret';
    const signature = await calculateHmac(secret, payload);
    const removed = [];

    fetchMock = async (url, options) => {
      const method = options?.method || 'GET';
      if (url.includes('/access_tokens')) return new Response(JSON.stringify({ token: 'mocktoken' }), { status: 200 });
      if (url.includes('/formalities.json')) {
        return new Response(JSON.stringify({ check_branch: false, enable_comments: false, require_linked_github_account: false, require_body: false, check_uci_config: false, check_pkg_release: false, ...config }), { status: 200 });
      }
      if (labeler !== null && url.includes('/labeler.yml')) return new Response(labeler, { status: 200 });
      { const lr = graphqlLabelsHandler(url, options, labels); if (lr) return lr; }
      if (url === 'https://api.github.com/repos/test/repo/pulls/123' && options?.headers?.Accept !== 'application/vnd.github.patch') {
        return new Response(JSON.stringify({
          labels: (live.labels ?? labels).map(name => ({ name })),
          head: { sha: live.headSha ?? 'headsha' }, base: { ref: live.baseRef ?? baseRef }, body: live.body ?? 'Update'
        }), { status: live.status ?? 200 });
      }
      if (url.includes('/pulls/123/commits')) {
        return new Response(JSON.stringify([{
          sha: 'sha123', html_url: 'https://github.com/test/repo/commit/sha123',
          // A merge commit has two parents and is given no patch of its own.
          parents: mergeOnly ? [{ sha: 'p1' }, { sha: 'p2' }] : [{ sha: 'p1' }],
          commit: { message: 'mypkg: update to 1.2.3\n\nA description of the change.\n\nSigned-off-by: John Doe <john@doe.com>', author: { name: 'John Doe', email: 'john@doe.com' }, committer: { name: 'John Doe', email: 'john@doe.com' } }
        }]), { status: 200 });
      }
      if (url.match(/\/repos\/test\/repo\/commits\/sha123/)) return new Response(patchStatus === 200 ? patch : 'unavailable', { status: patchStatus });
      if (url.includes('/issues/123/labels/') && method === 'DELETE') {
        removed.push(decodeURIComponent(url.split('/labels/')[1]));
        return new Response('[]', { status: 200 });
      }
      if (url.endsWith('/issues/123/labels') && method === 'POST' && posted) {
        posted.push(...JSON.parse(options.body).labels);
        return new Response('[]', { status: 200 });
      }
      if (url.includes('/issues/123/comments')) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({}), { status: 201 });
    };

    const originalImportKey = crypto.subtle.importKey;
    crypto.subtle.importKey = async (format, keyData, algorithm, extractable, keyUsages) =>
      algorithm.name === 'RSASSA-PKCS1-v1_5' ? { type: 'private', extractable: false, algorithm, usages: keyUsages }
        : originalImportKey.call(crypto.subtle, format, keyData, algorithm, extractable, keyUsages);
    const originalSign = crypto.subtle.sign;
    crypto.subtle.sign = async (algorithm, key, data) =>
      algorithm === 'RSASSA-PKCS1-v1_5' ? new ArrayBuffer(256) : originalSign.call(crypto.subtle, algorithm, key, data);

    try {
      const response = await worker.fetch(new Request('http://localhost/webhook', {
        method: 'POST', body: payload,
        headers: { 'x-hub-signature-256': signature, 'x-github-event': 'pull_request' }
      }), { WEBHOOK_SECRET: secret, APP_ID: '12345', PRIVATE_KEY: 'YW55Y29udGVudA==' }, {});
      assert.strictEqual(response.status, 200, await response.text());
      return removed;
    } finally {
      crypto.subtle.importKey = originalImportKey;
      crypto.subtle.sign = originalSign;
      fetchMock = null;
    }
  }

  const plainPatch = 'diff --git a/README b/README\n--- a/README\n+++ b/README\n@@ -1 +1 @@\n-a\n+b\n';
  const addsPackage = 'diff --git a/utils/mypkg/Makefile b/utils/mypkg/Makefile\nnew file mode 100644\n--- /dev/null\n+++ b/utils/mypkg/Makefile\n@@ -0,0 +1,2 @@\n+include $(TOPDIR)/rules.mk\n+PKG_NAME:=mypkg\n';

  // The payload is as old as the event. Another run can change the labels in
  // the meantime, and the branch can move on, so the run reads the pull
  // request again before it writes labels, when its request budget allows.
  test('posts "add package" again when another run took it off after the payload was sent', async () => {
    const posted = [];
    await labelsRemovedFor({ labels: ['Add package'], live: { labels: [] }, patch: addsPackage, posted });
    assert.ok(posted.includes('add package'), `labels posted: ${JSON.stringify(posted)}`);
  });

  test('does not post "add package" that another run already put back', async () => {
    const posted = [];
    await labelsRemovedFor({ labels: [], live: { labels: ['Add package'] }, patch: addsPackage, posted });
    assert.ok(!posted.includes('add package'), `labels posted: ${JSON.stringify(posted)}`);
  });

  for (const [title, run] of [
    ['leaves package labels alone when the branch has moved on since the event',
      { labels: ['Add package'], live: { headSha: 'newersha' }, patch: plainPatch }],
    ['leaves release labels alone when the pull request was retargeted since the event',
      { labels: ['release/24.10'], baseRef: 'openwrt-25.12', live: { baseRef: 'openwrt-24.10' }, patch: plainPatch }]
  ]) {
    test(title, async () => {
      const posted = [];
      const removed = await labelsRemovedFor({ ...run, posted });
      assert.deepStrictEqual(removed, []);
      assert.ok(!posted.some(l => /^(add package|drop package|release\/)/i.test(l)), `labels posted: ${JSON.stringify(posted)}`);
    });
  }

  test('decides from the payload when the pull request cannot be read again', async () => {
    const removed = await labelsRemovedFor({ labels: ['Add package'], live: { status: 500, labels: [] }, patch: plainPatch });
    assert.deepStrictEqual(removed, ['Add package']);
  });

  // The guidelines verdict belongs to the newest event too, and the
  // description it reads can carry an override.
  test('leaves the guidelines label on when the branch has moved on since a passing run', async () => {
    const removed = await labelsRemovedFor({ labels: ['not following guidelines'], live: { headSha: 'newersha' }, patch: plainPatch });
    assert.deepStrictEqual(removed, []);
  });

  test('does not post the guidelines label when the description changed since a failing run', async () => {
    const posted = [];
    await labelsRemovedFor({ labels: [], live: { body: 'Update\n\n[allow branch]' }, patch: addsPackage, posted });
    assert.ok(!posted.includes('not following guidelines'), `labels posted: ${JSON.stringify(posted)}`);
  });

  test('takes back the "add package" label when the branch no longer adds one', async () => {
    // Spelled the way openwrt/packages spells it, which is not how the
    // constant in the bot is written.
    const removed = await labelsRemovedFor({ labels: ['Add package'], patch: plainPatch });
    assert.deepStrictEqual(removed, ['Add package']);
  });

  test('keeps the "add package" label while the branch still adds one', async () => {
    const removed = await labelsRemovedFor({ labels: ['Add package'], patch: addsPackage });
    assert.deepStrictEqual(removed, []);
  });

  test('takes back a release label after the pull request is retargeted', async () => {
    const removed = await labelsRemovedFor({ labels: ['release/24.10'], baseRef: 'openwrt-25.12', patch: plainPatch });
    assert.deepStrictEqual(removed, ['release/24.10']);
  });

  test('keeps the release label that matches the base branch', async () => {
    const removed = await labelsRemovedFor({ labels: ['release/25.12'], baseRef: 'openwrt-25.12', patch: plainPatch });
    assert.deepStrictEqual(removed, []);
  });

  // Withdrawal does not ask the flag that governs applying: a flag turned off
  // stops the bot labelling, it does not freeze a label that stopped being
  // true onto the branch for good.
  test('takes back "add package" even with add_package_label turned off', async () => {
    const removed = await labelsRemovedFor({ labels: ['Add package'], patch: plainPatch, config: { add_package_label: false } });
    assert.deepStrictEqual(removed, ['Add package']);
  });

  test('takes back "drop package" even with drop_package_label turned off', async () => {
    const removed = await labelsRemovedFor({ labels: ['drop package'], patch: plainPatch, config: { drop_package_label: false } });
    assert.deepStrictEqual(removed, ['drop package']);
  });

  test('takes back a stale release label even with branch_labeling turned off', async () => {
    const removed = await labelsRemovedFor({ labels: ['release/24.10'], baseRef: 'openwrt-25.12', patch: plainPatch, config: { branch_labeling: false } });
    assert.deepStrictEqual(removed, ['release/24.10']);
  });

  test('applies the release label with branch_labeling on', async () => {
    const posted = [];
    await labelsRemovedFor({ labels: [], baseRef: 'openwrt-25.12', patch: plainPatch, posted });
    assert.ok(posted.includes('release/25.12'), `labels posted: ${JSON.stringify(posted)}`);
  });

  test('applies no release label with branch_labeling turned off', async () => {
    const posted = [];
    await labelsRemovedFor({ labels: [], baseRef: 'openwrt-25.12', patch: plainPatch, config: { branch_labeling: false }, posted });
    assert.ok(!posted.some(l => /^release\//.test(l)), `labels posted: ${JSON.stringify(posted)}`);
  });

  test('takes off "stale" and the guidelines label the way the repository spells them', async () => {
    const removed = await labelsRemovedFor({ labels: ['Stale', 'Not Following Guidelines'], patch: plainPatch });
    assert.deepStrictEqual([...removed].sort(), ['Not Following Guidelines', 'Stale']);
  });

  // A run that never read the patch knows nothing about the branch's content,
  // so withdrawing on it would strip a label that is still true.
  test('withdraws no content label when the patch could not be read', async () => {
    const removed = await labelsRemovedFor({ labels: ['Add package', 'drop package'], patch: plainPatch, patchStatus: 503 });
    assert.deepStrictEqual(removed, []);
  });

  test('still withdraws a stale release label when the patch could not be read', async () => {
    // The base branch comes from the webhook payload, not from the patch.
    const removed = await labelsRemovedFor({ labels: ['release/24.10'], baseRef: 'openwrt-25.12', patch: plainPatch, patchStatus: 503 });
    assert.deepStrictEqual(removed, ['release/24.10']);
  });

  test('withdraws no content label when every commit is a merge', async () => {
    // A merge commit is given no patch on purpose, so nothing was read here
    // either - and the run must not mistake that for a branch that changed.
    const removed = await labelsRemovedFor({ labels: ['Add package', 'drop package'], patch: plainPatch, mergeOnly: true });
    assert.deepStrictEqual(removed, []);
  });

  test('a flag turned off still stops the label being applied', async () => {
    const posted = [];
    await labelsRemovedFor({ labels: [], patch: addsPackage, config: { add_package_label: false }, posted });
    assert.ok(!posted.includes('add package'), `labels posted: ${JSON.stringify(posted)}`);
  });

  test('a flag turned off never withdraws what the enabled bot would keep', async () => {
    const removed = await labelsRemovedFor({ labels: ['Add package'], patch: addsPackage, config: { add_package_label: false } });
    assert.deepStrictEqual(removed, []);
  });

  test('leaves a label matched from labeler.yml alone', async () => {
    // labeler.yml is on and names the label, but this branch touches none of
    // its paths: the label is still not the bot's to take off.
    const labeler = "target/ath79:\n  - changed-files:\n    - any-glob-to-any-file: 'target/linux/ath79/**'\n";
    const removed = await labelsRemovedFor({ labels: ['target/ath79'], patch: plainPatch, config: { enable_labeler_yml: true }, labeler });
    assert.deepStrictEqual(removed, [], 'a path label is as often set by hand as derived');
  });
});
