import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { githubApiCall, graphqlBatchFetchFiles, graphqlFetchRepoSetup, graphqlFetchRepoLabels, graphqlCheckExistence, fetchUserRepoPermission, restCommitFromGraphql, restCommentFromGraphql, GRAPHQL_URL } from '../src/github.js';

describe('graphqlBatchFetchFiles', { concurrency: 1 }, () => {
  let originalFetch;
  let fetchMock;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (fetchMock) {
        return fetchMock(url, options);
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns an empty map without making any request when probes is empty', async () => {
    let called = false;
    fetchMock = () => { called = true; return new Response(JSON.stringify({ data: {} }), { status: 200 }); };

    const result = await graphqlBatchFetchFiles('token', []);
    assert.strictEqual(result.size, 0);
    assert.strictEqual(called, false);
  });

  test('fetches a single file in one POST to the GraphQL endpoint', async () => {
    let requestCount = 0;
    let capturedUrl = null;
    let capturedBody = null;
    fetchMock = (url, options) => {
      requestCount++;
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        data: { repo0: { f0: { text: 'PKG_NAME:=bash\n' } } }
      }), { status: 200 });
    };

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'k1', repoFullname: 'openwrt/openwrt', ref: 'abc123', path: 'package/utils/bash/Makefile' }
    ]);

    assert.strictEqual(requestCount, 1);
    assert.strictEqual(capturedUrl, GRAPHQL_URL);
    assert.strictEqual(capturedBody.variables.o0, 'openwrt');
    assert.strictEqual(capturedBody.variables.n0, 'openwrt');
    assert.strictEqual(capturedBody.variables.e0_0, 'abc123:package/utils/bash/Makefile');
    assert.deepStrictEqual(result.get('k1'), { content: 'PKG_NAME:=bash\n', exists: true, isBinary: false });
  });

  test('batches many files from the same repo into a single query', async () => {
    let requestCount = 0;
    let aliasCount = 0;
    fetchMock = (url, options) => {
      requestCount++;
      const body = JSON.parse(options.body);
      aliasCount = (body.query.match(/f\d+: object/g) || []).length;
      const fields = {};
      for (let i = 0; i < 5; i++) {
        fields[`f${i}`] = { text: `content-${i}` };
      }
      return new Response(JSON.stringify({ data: { repo0: fields } }), { status: 200 });
    };

    const probes = Array.from({ length: 5 }, (_, i) => ({
      key: `k${i}`, repoFullname: 'openwrt/openwrt', ref: 'sha', path: `pkg${i}/Makefile`
    }));

    const result = await graphqlBatchFetchFiles('token', probes);

    assert.strictEqual(requestCount, 1);
    assert.strictEqual(aliasCount, 5);
    for (let i = 0; i < 5; i++) {
      assert.deepStrictEqual(result.get(`k${i}`), { content: `content-${i}`, exists: true, isBinary: false });
    }
  });

  test('groups probes across multiple repos into aliased repository() blocks in one query', async () => {
    let requestCount = 0;
    let capturedVariables = null;
    fetchMock = (url, options) => {
      requestCount++;
      capturedVariables = JSON.parse(options.body).variables;
      return new Response(JSON.stringify({
        data: {
          repo0: { f0: { text: 'base content' } },
          repo1: { f0: { text: 'fork content' } }
        }
      }), { status: 200 });
    };

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'base', repoFullname: 'openwrt/openwrt', ref: 'sha1', path: 'a/Makefile' },
      { key: 'fork', repoFullname: 'someuser/openwrt', ref: 'sha1', path: 'a/Makefile' }
    ]);

    assert.strictEqual(requestCount, 1);
    assert.strictEqual(capturedVariables.o0, 'openwrt');
    assert.strictEqual(capturedVariables.o1, 'someuser');
    assert.deepStrictEqual(result.get('base'), { content: 'base content', exists: true, isBinary: false });
    assert.deepStrictEqual(result.get('fork'), { content: 'fork content', exists: true, isBinary: false });
  });

  test('maps a null object (path/ref not found) to content: null, not an error', async () => {
    fetchMock = () => new Response(JSON.stringify({
      data: { repo0: { f0: null } }
    }), { status: 200 });

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'missing', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'does/not/exist' }
    ]);

    assert.deepStrictEqual(result.get('missing'), { content: null, exists: false, isBinary: false });
  });

  test('treats a field missing due to a partial errors[] entry as content: null with a warning, not a crash', async () => {
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    try {
      fetchMock = () => new Response(JSON.stringify({
        data: { repo0: { f0: { text: 'ok' } } },
        errors: [{ message: 'Something went wrong for f1', path: ['repo0', 'f1'] }]
      }), { status: 200 });

      const result = await graphqlBatchFetchFiles('token', [
        { key: 'ok', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'a' },
        { key: 'broken', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'b' }
      ]);

      assert.deepStrictEqual(result.get('ok'), { content: 'ok', exists: true, isBinary: false });
      assert.deepStrictEqual(result.get('broken'), { content: null, exists: false, isBinary: false, failed: true });
      assert.strictEqual(warned, true);
    } finally {
      console.warn = originalWarn;
    }
  });

  // An empty field is either a file that is not there or a field an error
  // took away, and only the first may be read as the file being missing.
  for (const [title, data, errors, expected] of [
    ['marks the fields of a repository a partial error names',
      { repo0: { f0: null }, repo1: null },
      [{ message: "Could not resolve to a Repository with the name 'someuser/gone'.", path: ['repo1'] }],
      { missing: { content: null, exists: false, isBinary: false }, lost: { content: null, exists: false, isBinary: false, failed: true } }],
    ['marks only the field a partial error names, not the empty fields beside it',
      { repo0: { f0: null }, repo1: { f0: null } },
      [{ message: 'Something went wrong while executing your query.', path: ['repo0', 'f1'] }],
      { missing: { content: null, exists: false, isBinary: false }, lost: { content: null, exists: false, isBinary: false } }],
    ['marks every empty field when a partial error names no place',
      { repo0: { f0: null }, repo1: { f0: { text: 'ok' } } },
      [{ message: 'Something went wrong while executing your query.' }],
      { missing: { content: null, exists: false, isBinary: false, failed: true }, lost: { content: 'ok', exists: true, isBinary: false } }]
  ]) {
    test(title, async () => {
      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        fetchMock = () => new Response(JSON.stringify({ data, errors }), { status: 200 });
        const result = await graphqlBatchFetchFiles('token', [
          { key: 'missing', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'a' },
          { key: 'lost', repoFullname: 'someuser/gone', ref: 'sha', path: 'a' }
        ]);
        assert.deepStrictEqual(result.get('missing'), expected.missing);
        assert.deepStrictEqual(result.get('lost'), expected.lost);
      } finally {
        console.warn = originalWarn;
      }
    });
  }

  test('resolves every probe to an error when the HTTP call itself fails', async () => {
    fetchMock = () => new Response('Too many subrequests', { status: 500 });

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'a', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'x' },
      { key: 'b', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'y' }
    ]);

    assert.ok(result.get('a').error instanceof Error);
    assert.ok(result.get('b').error instanceof Error);
  });

  test('resolves every probe to an error when GraphQL returns no top-level data', async () => {
    fetchMock = () => new Response(JSON.stringify({
      errors: [{ message: 'Could not resolve to a Repository' }]
    }), { status: 200 });

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'a', repoFullname: 'openwrt/doesnotexist', ref: 'sha', path: 'x' }
    ]);

    assert.ok(result.get('a').error instanceof Error);
    assert.ok(result.get('a').error.message.includes('Could not resolve to a Repository'));
  });

  test('marks a binary blob as existing without content instead of treating it as not found', async () => {
    fetchMock = () => new Response(JSON.stringify({
      data: { repo0: { f0: { oid: 'abc123', text: null, isBinary: true } } }
    }), { status: 200 });

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'bin', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'files/logo.png' }
    ]);

    assert.deepStrictEqual(result.get('bin'), { content: null, exists: true, isBinary: true });
  });

  test('marks probe as failed: true when GraphQL returns a Blob object but errors reading its text', async () => {
    fetchMock = () => new Response(JSON.stringify({
      data: { repo0: { f0: { oid: 'abc123', text: null, isBinary: false } } },
      errors: [{ message: 'Read failed', path: ['repo0', 'f0', 'text'] }]
    }), { status: 200 });

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'f', repoFullname: 'openwrt/openwrt', ref: 'sha', path: 'Makefile' }
    ]);

    assert.deepStrictEqual(result.get('f'), { content: null, exists: true, isBinary: false, failed: true });
  });

  test('probes ref existence with a bare-ref expression when path is null', async () => {
    let capturedVariables = null;
    fetchMock = (url, options) => {
      capturedVariables = JSON.parse(options.body).variables;
      return new Response(JSON.stringify({
        data: { repo0: { f0: { oid: 'commitsha' } } }
      }), { status: 200 });
    };

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'refprobe', repoFullname: 'openwrt/openwrt', ref: 'abc123', path: null }
    ]);

    // The expression must be the bare ref — no ':path' suffix.
    assert.strictEqual(capturedVariables.e0_0, 'abc123');
    assert.deepStrictEqual(result.get('refprobe'), { content: null, exists: true, isBinary: false });
  });

  test('reports a non-existing ref via a null bare-ref probe result', async () => {
    fetchMock = () => new Response(JSON.stringify({
      data: { repo0: { f0: null } }
    }), { status: 200 });

    const result = await graphqlBatchFetchFiles('token', [
      { key: 'refprobe', repoFullname: 'openwrt/openwrt', ref: 'deadbeef', path: null }
    ]);

    assert.deepStrictEqual(result.get('refprobe'), { content: null, exists: false, isBinary: false });
  });
});

describe('graphqlFetchRepoSetup', { concurrency: 1 }, () => {
  let originalFetch;
  let fetchMock;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => fetchMock(url, options);
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  const setupResponse = (repository) =>
    new Response(JSON.stringify({ data: { repository } }), { status: 200 });

  test('fetches labels and both config files in a single request', async () => {
    let requestCount = 0;
    let capturedVariables = null;
    fetchMock = (url, options) => {
      requestCount++;
      capturedVariables = JSON.parse(options.body).variables;
      return setupResponse({
        labels: { nodes: [{ name: 'Bug' }, { name: 'stale' }], pageInfo: { hasNextPage: false, endCursor: null } },
        cfg: { text: '{"check_branch": false}' },
        labeler: { text: 'docs:\n  - "docs/**"\n' }
      });
    };

    const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml');

    assert.strictEqual(requestCount, 1);
    assert.strictEqual(capturedVariables.cfgExpr, 'main:.github/formalities.json');
    assert.strictEqual(capturedVariables.labExpr, 'main:.github/labeler.yml');
    assert.deepStrictEqual([...setup.labels].sort(), ['bug', 'stale']);
    assert.strictEqual(setup.configText, '{"check_branch": false}');
    assert.strictEqual(setup.labelerText, 'docs:\n  - "docs/**"\n');
  });

  test('reports missing config files as null text', async () => {
    fetchMock = () => setupResponse({
      labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      cfg: null,
      labeler: null
    });

    const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml');
    assert.strictEqual(setup.configText, null);
    assert.strictEqual(setup.labelerText, null);
    assert.strictEqual(setup.configFailed, false, 'a null text with no error beside it is a file that is not there');
    assert.strictEqual(setup.labelerFailed, false);
    assert.strictEqual(setup.labels.size, 0);
  });

  test('pages labels past the first 100 with labels-only queries, counting every page', async () => {
    let requestCount = 0;
    let onCallCount = 0;
    fetchMock = (url, options) => {
      requestCount++;
      const body = JSON.parse(options.body);
      if (requestCount === 1) {
        return setupResponse({
          labels: { nodes: [{ name: 'one' }], pageInfo: { hasNextPage: true, endCursor: 'CURSOR1' } },
          cfg: null,
          labeler: null
        });
      }
      assert.strictEqual(body.variables.after, 'CURSOR1');
      return setupResponse({
        labels: { nodes: [{ name: 'two' }], pageInfo: { hasNextPage: false, endCursor: null } }
      });
    };

    const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', () => { onCallCount++; });
    assert.strictEqual(requestCount, 2);
    assert.strictEqual(onCallCount, 2);
    assert.deepStrictEqual([...setup.labels].sort(), ['one', 'two']);
  });

  test('degrades to labels: null when a later label page fails, keeping the config', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      let requestCount = 0;
      fetchMock = () => {
        requestCount++;
        if (requestCount === 1) {
          return setupResponse({
            labels: { nodes: [{ name: 'one' }], pageInfo: { hasNextPage: true, endCursor: 'CURSOR1' } },
            cfg: { text: '{}' },
            labeler: null
          });
        }
        return new Response('boom', { status: 500 });
      };

      const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml');
      assert.strictEqual(setup.labels, null);
      assert.strictEqual(setup.configText, '{}');
    } finally {
      console.warn = originalWarn;
    }
  });


  // An HTTP 200 with a populated data.repository and a partial error that
  // emptied one field: the null text it leaves is byte for byte the null text
  // a repository without the file leaves. Read as the second, the audit runs
  // on DEFAULT_CONFIG and still reports itself complete, which answers for
  // rules the repository may have written differently - or switched off.
  const setupResponseWithErrors = (repository, errors) =>
    new Response(JSON.stringify({ data: { repository }, errors }), { status: 200 });

  const quietWarnings = async (fn) => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (msg) => { warnings.push(String(msg)); };
    try {
      return { result: await fn(), warnings };
    } finally {
      console.warn = originalWarn;
    }
  };

  test('reports a config lost to a partial error as unread rather than absent', async () => {
    let requestCount = 0;
    let onCallCount = 0;
    fetchMock = () => {
      requestCount++;
      return setupResponseWithErrors({
        labels: { nodes: [{ name: 'bug' }], pageInfo: { hasNextPage: false, endCursor: null } },
        cfg: null,
        labeler: { text: 'docs:\n  - "docs/**"\n' }
      }, [{ message: 'Something went wrong while executing your query.', path: ['repository', 'cfg'] }]);
    };

    const { result: setup, warnings } = await quietWarnings(() => graphqlFetchRepoSetup(
      'token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml',
      () => { onCallCount++; }
    ));

    assert.strictEqual(requestCount, 1, 'the whole setup is still one HTTP attempt');
    assert.strictEqual(onCallCount, 1, 'and one charged subrequest');
    assert.strictEqual(setup.configText, null);
    assert.strictEqual(setup.configFailed, true, 'the field was emptied by an error, so it says nothing about the file');
    assert.strictEqual(setup.labelerText, 'docs:\n  - "docs/**"\n');
    assert.strictEqual(setup.labelerFailed, false, 'the error named cfg alone');
    assert.ok(
      warnings.some(w => w.includes('.github/formalities.json') && !w.includes('.github/labeler.yml')),
      'the lost file is named once, in a warning of its own'
    );
  });

  test('reports labeler rules lost to a partial error as unread rather than absent', async () => {
    fetchMock = () => setupResponseWithErrors({
      labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      cfg: { text: '{"check_branch": false}' },
      labeler: null
    }, [{ message: 'Something went wrong while executing your query.', path: ['repository', 'labeler'] }]);

    const { result: setup } = await quietWarnings(() => graphqlFetchRepoSetup(
      'token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml'
    ));

    assert.strictEqual(setup.labelerText, null);
    assert.strictEqual(setup.labelerFailed, true, 'a file that exists but could not be read is not "no labeler"');
    assert.strictEqual(setup.configText, '{"check_branch": false}');
    assert.strictEqual(setup.configFailed, false);
  });

  test('marks no file when the partial error happened somewhere else entirely', async () => {
    fetchMock = () => setupResponseWithErrors({
      labels: { nodes: [{ name: 'bug' }], pageInfo: { hasNextPage: false, endCursor: null } },
      cfg: null,
      labeler: null
    }, [{ message: 'Something went wrong while executing your query.', path: ['repository', 'labels', 'nodes', 3] }]);

    const { result: setup } = await quietWarnings(() => graphqlFetchRepoSetup(
      'token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml'
    ));

    assert.strictEqual(setup.configFailed, false, 'an error under labels says nothing about the two files');
    assert.strictEqual(setup.labelerFailed, false);
  });

  test('keeps a field the error named but GitHub served anyway', async () => {
    fetchMock = () => setupResponseWithErrors({
      labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      cfg: { text: '{}' },
      labeler: null
    }, [{ message: 'Something went wrong while executing your query.', path: ['repository', 'cfg'] }]);

    const { result: setup } = await quietWarnings(() => graphqlFetchRepoSetup(
      'token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml'
    ));

    assert.strictEqual(setup.configText, '{}', 'text that arrived is text that arrived');
    assert.strictEqual(setup.configFailed, false, 'only an empty field can have been lost');
  });

  test('marks both files unread when the partial error names no path at all', async () => {
    fetchMock = () => setupResponseWithErrors({
      labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      cfg: null,
      labeler: null
    }, [{ message: 'Something went wrong while executing your query.' }]);

    const { result: setup } = await quietWarnings(() => graphqlFetchRepoSetup(
      'token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml'
    ));

    assert.strictEqual(setup.configFailed, true, 'an unlocated error could be the one that emptied either field');
    assert.strictEqual(setup.labelerFailed, true);
  });

  test('throws when the setup query itself fails', async () => {
    fetchMock = () => new Response('Server Error', { status: 500 });
    await assert.rejects(
      () => graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml'),
      /GraphQL repository setup fetch failed/
    );
  });
});

describe('fetchUserRepoPermission', { concurrency: 1 }, () => {
  let originalFetch;
  let fetchMock;
  let requestedUrls;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      requestedUrls.push(url);
      return fetchMock(url, options);
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    requestedUrls = [];
    fetchMock = () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  });

  const permissionResponse = (body, status = 200) =>
    () => new Response(JSON.stringify(body), { status });

  test('returns false without spending a request when the repository or login is missing', async () => {
    let onCallCount = 0;
    assert.strictEqual(await fetchUserRepoPermission('', 'someone', 'token', () => { onCallCount++; }), false);
    assert.strictEqual(await fetchUserRepoPermission('test/repo', '', 'token', () => { onCallCount++; }), false);
    assert.deepStrictEqual(requestedUrls, []);
    assert.strictEqual(onCallCount, 0);
  });

  test('asks the collaborator permission endpoint with an encoded login and reports the call', async () => {
    let onCallCount = 0;
    fetchMock = permissionResponse({ permission: 'write', user: { permissions: { push: true } } });

    assert.strictEqual(await fetchUserRepoPermission('test/repo', 'user name', 'token', () => { onCallCount++; }), true);
    assert.deepStrictEqual(requestedUrls, ['https://api.github.com/repos/test/repo/collaborators/user%20name/permission']);
    assert.strictEqual(onCallCount, 1);
  });

  test('accepts push access reported through user.permissions', async () => {
    fetchMock = permissionResponse({
      permission: 'write',
      role_name: 'write',
      user: { permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } }
    });
    assert.strictEqual(await fetchUserRepoPermission('test/repo', 'writer', 'token'), true);
  });

  test('accepts the maintain role', async () => {
    fetchMock = permissionResponse({
      permission: 'write',
      role_name: 'maintain',
      user: { permissions: { admin: false, maintain: true, push: true, triage: true, pull: true } }
    });
    assert.strictEqual(await fetchUserRepoPermission('test/repo', 'maintainer', 'token'), true);
  });

  test('rejects the triage role, which cannot push', async () => {
    fetchMock = permissionResponse({
      permission: 'read',
      role_name: 'triage',
      user: { permissions: { admin: false, maintain: false, push: false, triage: true, pull: true } }
    });
    assert.strictEqual(await fetchUserRepoPermission('test/repo', 'triager', 'token'), false);
  });

  test('rejects read access', async () => {
    fetchMock = permissionResponse({
      permission: 'read',
      role_name: 'read',
      user: { permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } }
    });
    assert.strictEqual(await fetchUserRepoPermission('test/repo', 'reader', 'token'), false);
  });

  test('falls back to the flat permission field when user.permissions is absent', async () => {
    fetchMock = permissionResponse({ permission: 'admin' });
    assert.strictEqual(await fetchUserRepoPermission('test/repo', 'owner', 'token'), true);

    fetchMock = permissionResponse({ permission: 'WRITE' });
    assert.strictEqual(await fetchUserRepoPermission('test/repo', 'writer', 'token'), true);

    fetchMock = permissionResponse({ permission: 'read' });
    assert.strictEqual(await fetchUserRepoPermission('test/repo', 'reader', 'token'), false);
  });

  // role_name may carry a custom organization role whose rights are unknown,
  // so it must not grant write access on its own.
  test('does not grant access from role_name alone', async () => {
    fetchMock = permissionResponse({ permission: 'read', role_name: 'maintain' });
    assert.strictEqual(await fetchUserRepoPermission('test/repo', 'customrole', 'token'), false);
  });

  test('returns false for a 404, the answer for a user who is not a collaborator', async () => {
    fetchMock = permissionResponse({ message: 'Not Found' }, 404);
    assert.strictEqual(await fetchUserRepoPermission('test/repo', 'outsider', 'token'), false);
  });

  test('returns null when the lookup itself fails, so callers can tell it apart from a denial', async () => {
    fetchMock = permissionResponse({ message: 'Resource not accessible by integration' }, 403);
    assert.strictEqual(await fetchUserRepoPermission('test/repo', 'someone', 'token'), null);
  });

  test('returns null after a network error exhausts the retries', async () => {
    fetchMock = () => { throw new Error('connection reset'); };
    assert.strictEqual(await fetchUserRepoPermission('test/repo', 'someone', 'token'), null);
    assert.strictEqual(requestedUrls.length, 3);
  });

  test('returns null when the response body is not JSON', async () => {
    fetchMock = () => new Response('<html>gateway</html>', { status: 200 });
    assert.strictEqual(await fetchUserRepoPermission('test/repo', 'someone', 'token'), null);
  });
});

describe('githubApiCall rate limits', () => {
  test('waits out a Retry-After answer and tries again', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        return new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 429, headers: { 'retry-after': '1' } });
      }
      return new Response('{"id":1}', { status: 201 });
    };
    const res = await githubApiCall('https://api.github.com/repos/o/r/check-runs', 'token', 'POST', { name: 'x' });
    assert.strictEqual(calls, 2);
    assert.strictEqual(res.code, 201);
  });

  test('takes a Retry-After it cannot wait out as final instead of retrying early', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 429, headers: { 'retry-after': '60' } });
    };
    const res = await githubApiCall('https://api.github.com/repos/o/r/check-runs', 'token', 'POST', { name: 'x' });
    assert.strictEqual(calls, 1, 'retrying before the minute is up would only earn the same answer');
    assert.strictEqual(res.code, 429);
  });

  test('does not retry a plain 403 refusal', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('{"message":"Resource not accessible by integration"}', { status: 403 });
    };
    const res = await githubApiCall('https://api.github.com/repos/o/r/check-runs', 'token', 'POST', { name: 'x' });
    assert.strictEqual(calls, 1);
    assert.strictEqual(res.code, 403);
  });
});

describe('graphqlFetchRepoSetup with a pull request', { concurrency: 1 }, () => {
  let originalFetch;
  let fetchMock;
  before(() => { originalFetch = globalThis.fetch; globalThis.fetch = async (url, options) => fetchMock(url, options); });
  after(() => { globalThis.fetch = originalFetch; });

  const commitNode = (oid, extra = {}) => ({ commit: {
    oid, url: `https://github.com/openwrt/openwrt/commit/${oid}`, message: `pkg: change ${oid.slice(0, 4)}`, changedFilesIfAvailable: 2,
    author: { name: 'Jane Doe', email: 'jane@doe.com', user: { login: 'janedoe' } },
    committer: { name: 'Jane Doe', email: 'jane@doe.com', user: null },
    parents: { totalCount: 1 }, signature: null, ...extra
  } });

  test('returns the commits and comments in the shape the REST listings had', async () => {
    let queries = 0;
    fetchMock = (url, options) => {
      queries++;
      const body = JSON.parse(options.body);
      assert.strictEqual(body.variables.pr, 24988);
      assert.ok(body.query.includes('pullRequest(number: $pr)'));
      return new Response(JSON.stringify({ data: { repository: {
        labels: { nodes: [{ name: 'bug' }], pageInfo: { hasNextPage: false, endCursor: null } },
        cfg: { text: '{}' }, labeler: null,
        pullRequest: {
          commits: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
            commitNode('a'.repeat(40)),
            commitNode('b'.repeat(40), { parents: { totalCount: 2 }, signature: { isValid: true, state: 'VALID', signature: '-----BEGIN PGP SIGNATURE-----', keyId: 'ABCD' } })
          ] },
          comments: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [
            { databaseId: 5, body: '## Formality Check: Failed', authorAssociation: 'NONE', viewerDidAuthor: true, author: { login: 'openwrt', __typename: 'Bot' } }
          ] }
        }
      } } }), { status: 200 });
    };
    const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', null, 24988);
    assert.strictEqual(queries, 1, 'one round trip for setup, commits and comments');
    assert.strictEqual(setup.commitsTotal, 2);
    const [first, merge] = setup.commits;
    assert.strictEqual(first.sha, 'a'.repeat(40));
    assert.strictEqual(first.html_url, `https://github.com/openwrt/openwrt/commit/${'a'.repeat(40)}`);
    assert.deepStrictEqual(first.author, { login: 'janedoe' });
    assert.strictEqual(first.committer, null, 'a committer email without a linked account');
    assert.strictEqual(first.parents.length, 1);
    assert.strictEqual(first.changed_files, 2);
    assert.deepStrictEqual(first.commit.verification, { verified: false, reason: 'unsigned', signature: null });
    assert.strictEqual(merge.parents.length, 2);
    assert.deepStrictEqual(merge.commit.verification, { verified: true, reason: 'valid', signature: '-----BEGIN PGP SIGNATURE-----', key_id: 'ABCD' });
    assert.deepStrictEqual(setup.comments, [{ id: 5, body: '## Formality Check: Failed', author_association: 'NONE', user: { login: 'openwrt[bot]', type: 'Bot' }, viewer_did_author: true }]);
  });

  test('leaves the comments to REST when the thread is longer than a page, and pages the commits', async () => {
    const calls = [];
    fetchMock = (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.variables.after || 'first');
      if (!body.variables.after) {
        return new Response(JSON.stringify({ data: { repository: {
          labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, cfg: null, labeler: null,
          pullRequest: {
            commits: { totalCount: 150, pageInfo: { hasNextPage: true, endCursor: 'C1' }, nodes: [commitNode('1'.repeat(40))] },
            comments: { totalCount: 250, pageInfo: { hasNextPage: true }, nodes: [] }
          }
        } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { repository: { pullRequest: {
        commits: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [commitNode('2'.repeat(40))] }
      } } } }), { status: 200 });
    };
    let onCall = 0;
    const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', () => { onCall++; }, 24988);
    assert.deepStrictEqual(calls, ['first', 'C1']);
    assert.strictEqual(onCall, 2, 'every page counts against the budget');
    assert.deepStrictEqual(setup.commits.map(c => c.sha[0]), ['1', '2']);
    assert.strictEqual(setup.commitsTotal, 150);
    assert.strictEqual(setup.comments, null);
  });

  test('throws when GraphQL response contains errors on commits', async () => {
    fetchMock = () => {
      return new Response(JSON.stringify({
        data: {
          repository: {
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            cfg: null,
            labeler: null,
            pullRequest: {
              commits: null,
              comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }
            }
          }
        },
        errors: [
          { message: 'Could not resolve commits', path: ['repository', 'pullRequest', 'commits'] }
        ]
      }), { status: 200 });
    };

    await assert.rejects(
      () => graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', null, 24988),
      /GraphQL repository setup fetch failed to retrieve commits for PR #24988: Could not resolve commits/
    );
  });

  test('throws when pullRequest.commits is null even without explicit error', async () => {
    fetchMock = () => {
      return new Response(JSON.stringify({
        data: {
          repository: {
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            cfg: null,
            labeler: null,
            pullRequest: {
              commits: null,
              comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }
            }
          }
        }
      }), { status: 200 });
    };

    await assert.rejects(
      () => graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', null, 24988),
      /pullRequest.commits is null/
    );
  });

  test('carries on when a partial error has no path at all and the commits resolved', async () => {
    fetchMock = () => {
      return new Response(JSON.stringify({
        data: {
          repository: {
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            cfg: null,
            labeler: null,
            pullRequest: {
              commits: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [commitNode('a'.repeat(40))] },
              comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }
            }
          }
        },
        errors: [
          { message: 'Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug.' }
        ]
      }), { status: 200 });
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', null, 24988);
      assert.strictEqual(setup.commits.length, 1);
      assert.strictEqual(setup.commits[0].sha, 'a'.repeat(40));
    } finally {
      console.warn = originalWarn;
    }
  });

  test('carries on when a partial error points inside one commit, not at the commits field', async () => {
    fetchMock = () => {
      return new Response(JSON.stringify({
        data: {
          repository: {
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            cfg: null,
            labeler: null,
            pullRequest: {
              commits: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
                commitNode('a'.repeat(40)),
                commitNode('b'.repeat(40))
              ] },
              comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }
            }
          }
        },
        errors: [
          { message: 'Resource not accessible by integration', path: ['repository', 'pullRequest', 'commits', 'nodes', 0, 'commit', 'signature'] }
        ]
      }), { status: 200 });
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', null, 24988);
      assert.deepStrictEqual(setup.commits.map(c => c.sha[0]), ['a', 'b']);
      assert.strictEqual(setup.commitsTotal, 2);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('throws when commits are missing and an error lands above them', async () => {
    fetchMock = () => {
      return new Response(JSON.stringify({
        data: {
          repository: {
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            cfg: null,
            labeler: null,
            pullRequest: { commits: null, comments: null }
          }
        },
        errors: [
          { message: 'Something went wrong while executing your query', path: ['repository', 'pullRequest'] }
        ]
      }), { status: 200 });
    };

    await assert.rejects(
      () => graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', null, 24988),
      /failed to retrieve commits for PR #24988: Something went wrong while executing your query/
    );
  });

  test('carries on when a commit page carries a partial error inside one commit', async () => {
    const calls = [];
    fetchMock = (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.variables.after || 'first');
      if (!body.variables.after) {
        return new Response(JSON.stringify({ data: { repository: {
          labels: { nodes: [], pageInfo: { hasNextPage: false } }, cfg: null, labeler: null,
          pullRequest: {
            commits: { totalCount: 150, pageInfo: { hasNextPage: true, endCursor: 'C1' }, nodes: [commitNode('1'.repeat(40))] },
            comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }
          }
        } } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { repository: { pullRequest: {
          commits: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [commitNode('2'.repeat(40))] }
        } } },
        errors: [
          { message: 'Resource not accessible by integration', path: ['repository', 'pullRequest', 'commits', 'nodes', 0, 'commit', 'signature'] }
        ]
      }), { status: 200 });
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', null, 24988);
      assert.deepStrictEqual(calls, ['first', 'C1']);
      assert.deepStrictEqual(setup.commits.map(c => c.sha[0]), ['1', '2']);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('does not throw when GraphQL errors affect only comments, returning setup with comments: null', async () => {
    fetchMock = () => {
      return new Response(JSON.stringify({
        data: {
          repository: {
            labels: { nodes: [{ name: 'bug' }], pageInfo: { hasNextPage: false, endCursor: null } },
            cfg: { text: '{}' },
            labeler: null,
            pullRequest: {
              commits: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
                commitNode('a'.repeat(40))
              ] },
              comments: null
            }
          }
        },
        errors: [
          { message: 'Comments timeout', path: ['repository', 'pullRequest', 'comments'] }
        ]
      }), { status: 200 });
    };

    const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', null, 24988);
    assert.strictEqual(setup.commits.length, 1);
    assert.strictEqual(setup.commits[0].sha, 'a'.repeat(40));
    assert.strictEqual(setup.comments, null);
  });

  // PullRequestCommit.commit and the fields selected under it are non-null, so
  // a partial error inside one commit comes back as a nulled list element. The
  // run has to survive it with the commits that did resolve: a throw here is a
  // pull request that gets no check-runs and no comment at all.
  test('skips a nulled commit node and still reports the listing as short', async () => {
    fetchMock = () => new Response(JSON.stringify({
      data: { repository: {
        labels: { nodes: [], pageInfo: { hasNextPage: false } }, cfg: null, labeler: null,
        pullRequest: {
          commits: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [null, commitNode('b'.repeat(40))] },
          comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }
        }
      } },
      errors: [
        { message: 'Resource not accessible by integration', path: ['repository', 'pullRequest', 'commits', 'nodes', 0, 'commit', 'signature'] }
      ]
    }), { status: 200 });

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    try {
      const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', null, 24988);
      assert.deepStrictEqual(setup.commits.map(c => c.sha[0]), ['b']);
      assert.strictEqual(setup.commitsTotal, 2, 'the dropped node still counts, so the caller caps the commit scan');
      assert.ok(warnings.some(w => w.includes('1 commit node(s) without a commit')), 'a skipped node must not be invisible');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('skips a node whose commit is null without dying one frame deeper', async () => {
    fetchMock = () => new Response(JSON.stringify({
      data: { repository: {
        labels: { nodes: [], pageInfo: { hasNextPage: false } }, cfg: null, labeler: null,
        pullRequest: {
          commits: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [commitNode('a'.repeat(40)), { commit: null }] },
          comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }
        }
      } },
      errors: [
        { message: 'Something went wrong while executing your query', path: ['repository', 'pullRequest', 'commits', 'nodes', 1, 'commit'] }
      ]
    }), { status: 200 });

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', null, 24988);
      assert.deepStrictEqual(setup.commits.map(c => c.sha[0]), ['a']);
      assert.ok(setup.commitsTotal > setup.commits.length, 'the listing stays visibly short');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('skips a nulled commit node on a later page too', async () => {
    const calls = [];
    fetchMock = (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.variables.after || 'first');
      if (!body.variables.after) {
        return new Response(JSON.stringify({ data: { repository: {
          labels: { nodes: [], pageInfo: { hasNextPage: false } }, cfg: null, labeler: null,
          pullRequest: {
            commits: { totalCount: 3, pageInfo: { hasNextPage: true, endCursor: 'C1' }, nodes: [commitNode('1'.repeat(40))] },
            comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }
          }
        } } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { repository: { pullRequest: {
          commits: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [null, commitNode('2'.repeat(40))] }
        } } },
        errors: [
          { message: 'Resource not accessible by integration', path: ['repository', 'pullRequest', 'commits', 'nodes', 0, 'commit', 'signature'] }
        ]
      }), { status: 200 });
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', null, 24988);
      assert.deepStrictEqual(calls, ['first', 'C1']);
      assert.deepStrictEqual(setup.commits.map(c => c.sha[0]), ['1', '2']);
      assert.strictEqual(setup.commitsTotal, 3, 'the node page 2 dropped keeps the scan capped');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('skips a nulled commit node that comes with no error at all', async () => {
    fetchMock = () => new Response(JSON.stringify({
      data: { repository: {
        labels: { nodes: [], pageInfo: { hasNextPage: false } }, cfg: null, labeler: null,
        pullRequest: {
          commits: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [null, commitNode('b'.repeat(40))] },
          comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }
        }
      } }
    }), { status: 200 });

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', null, 24988);
      assert.deepStrictEqual(setup.commits.map(c => c.sha[0]), ['b']);
      assert.strictEqual(setup.commitsTotal, 2);
    } finally {
      console.warn = originalWarn;
    }
  });

  // Without a totalCount the dropped node is the only trace left, so the total
  // counts the nodes the page carried rather than the commits that survived.
  test('counts a dropped node into the total when totalCount is missing', async () => {
    fetchMock = () => new Response(JSON.stringify({
      data: { repository: {
        labels: { nodes: [], pageInfo: { hasNextPage: false } }, cfg: null, labeler: null,
        pullRequest: {
          commits: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [null, commitNode('b'.repeat(40))] },
          comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }
        }
      } }
    }), { status: 200 });

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const setup = await graphqlFetchRepoSetup('token', 'openwrt/openwrt', 'main', '.github/formalities.json', '.github/labeler.yml', null, 24988);
      assert.strictEqual(setup.commits.length, 1);
      assert.strictEqual(setup.commitsTotal, 2, 'two nodes came back, one of them unusable');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('spells signature states the way REST did', () => {
    const reason = (state) => restCommitFromGraphql({ oid: 'x', parents: { totalCount: 1 }, signature: { isValid: false, state, signature: 's' } }).commit.verification.reason;
    assert.strictEqual(reason('MALFORMED_SIG'), 'malformed_signature');
    assert.strictEqual(reason('UNKNOWN_SIG_TYPE'), 'unknown_signature_type');
    assert.strictEqual(reason('BAD_EMAIL'), 'bad_email');
    assert.deepStrictEqual(restCommentFromGraphql({ databaseId: 1, body: 'hi', authorAssociation: 'MEMBER', viewerDidAuthor: false, author: { login: 'jane', __typename: 'User' } }),
      { id: 1, body: 'hi', author_association: 'MEMBER', user: { login: 'jane', type: 'User' }, viewer_did_author: false });
  });
});

describe('subrequest accounting', { concurrency: 1 }, () => {
  let originalFetch;
  let fetchMock;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => fetchMock(url, options);
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  test('counts every retry attempt, not just the call', async () => {
    let served = 0;
    fetchMock = async (_url, _options) => {
      served++;
      return served < 3
        ? new Response('upstream hiccup', { status: 503 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    let counted = 0;
    const res = await githubApiCall('https://api.github.com/x', 'token', 'GET', null,
      'application/vnd.github+json', { onAttempt: () => { counted++; } });

    assert.strictEqual(res.code, 200);
    assert.strictEqual(served, 3, 'the request really was retried twice');
    assert.strictEqual(counted, served, 'budget accounting must match the fetches Cloudflare saw');
  });

  test('counts attempts for network failures too', async () => {
    fetchMock = async (_url, _options) => { throw new Error('connection reset'); };

    let counted = 0;
    const res = await githubApiCall('https://api.github.com/x', 'token', 'GET', null,
      'application/vnd.github+json', { onAttempt: () => { counted++; } });

    assert.strictEqual(res.code, 599);
    assert.strictEqual(counted, 3, 'all three attempts must be counted');
  });

  test('passes the counter through the GraphQL batch helper', async () => {
    let served = 0;
    fetchMock = async (_url, _options) => {
      served++;
      return served < 2
        ? new Response('boom', { status: 500 })
        : new Response(JSON.stringify({ data: { repo0: { f0: { oid: 'x', text: 'hello' } } } }), { status: 200 });
    };

    let counted = 0;
    await graphqlBatchFetchFiles('token', [{ key: 'k', repoFullname: 'o/r', ref: 'main', path: 'F' }], () => { counted++; });
    assert.strictEqual(counted, served);
    assert.strictEqual(counted, 2);
  });
});

describe('githubApiCall declined attempts', { concurrency: 1 }, () => {
  test('hands back a readable answer when the very first attempt is declined', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    let served = 0;
    globalThis.fetch = async () => { served++; return new Response('{}', { status: 200 }); };

    const res = await githubApiCall('https://api.github.com/x', 'token', 'GET', null,
      'application/vnd.github+json', { onAttempt: () => false });

    assert.strictEqual(served, 0, 'nothing was requested');
    // Every caller reads res.code straight away, so null would be a TypeError.
    assert.ok(res, 'a declined attempt must still answer with a result object');
    assert.strictEqual(res.code, 599);
    assert.strictEqual(res.data, null);
    assert.strictEqual(res.headers.get('retry-after'), null);
  });

  test('hands back the rate-limited answer when the retry after it is declined', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    let served = 0;
    globalThis.fetch = async () => {
      served++;
      return new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 429, headers: { 'retry-after': '1' } });
    };

    const res = await githubApiCall('https://api.github.com/x', 'token', 'POST', { name: 'x' },
      'application/vnd.github+json', { onAttempt: (attempt) => attempt === 1 });

    assert.strictEqual(served, 1);
    assert.strictEqual(res.code, 429, 'the caller must see the rate limit, not a stale answer');
  });

  test('hands back the answer it already had when a retry is declined', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    let served = 0;
    globalThis.fetch = async () => { served++; return new Response('upstream hiccup', { status: 503 }); };

    const res = await githubApiCall('https://api.github.com/x', 'token', 'GET', null,
      'application/vnd.github+json', { onAttempt: (attempt) => attempt === 1 });

    assert.strictEqual(served, 1);
    assert.strictEqual(res.code, 503, 'the 503 that would have been retried is what the caller sees');
  });
});

// A page and a retry are each one subrequest, so the counter has to be handed
// to the function that makes them, not charged once at the call site.
describe('subrequest accounting in paged and probe queries', { concurrency: 1 }, () => {
  let originalFetch;

  before(() => { originalFetch = globalThis.fetch; });
  after(() => { globalThis.fetch = originalFetch; });

  test('charges every label page', async () => {
    const pages = [
      { nodes: [{ name: 'bug' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
      { nodes: [{ name: 'stale' }], pageInfo: { hasNextPage: false, endCursor: null } }
    ];
    let served = 0;
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { repository: { labels: pages[served++] } } }), { status: 200 });

    let charged = 0;
    const labels = await graphqlFetchRepoLabels('token', 'openwrt/openwrt', () => { charged++; return true; });

    assert.deepStrictEqual([...labels].sort(), ['bug', 'stale']);
    assert.strictEqual(served, 2);
    assert.strictEqual(charged, served);
  });

  test('charges every attempt of an existence probe, retries included', async () => {
    let served = 0;
    globalThis.fetch = async () => {
      served++;
      return served === 1
        ? new Response('upstream hiccup', { status: 500 })
        : new Response(JSON.stringify({ data: { repository: { p0: { oid: 'abc123' } } } }), { status: 200 });
    };

    let charged = 0;
    const res = await graphqlCheckExistence('token', 'openwrt/openwrt', 'HEAD', [{ key: 'k', type: 'path', value: 'README.md' }], () => { charged++; return true; });

    assert.strictEqual(res.get('k'), true);
    assert.strictEqual(served, 2);
    assert.strictEqual(charged, served);
  });
});

// Only an answer may be reported. A probe the caller declined, and one GitHub
// failed to answer, both asked nothing: reading either as "nothing exists"
// would label an issue from an answer that never came. GitHub saying it cannot
// resolve the repository is an answer and still marks the probes absent.
describe('graphqlCheckExistence when nothing was answered', { concurrency: 1 }, () => {
  let originalFetch;

  before(() => { originalFetch = globalThis.fetch; });
  after(() => { globalThis.fetch = originalFetch; });

  // Silences the warn/error lines a failing query logs, so the run stays
  // readable, and hands back what the probes resolved to.
  const probeQuietly = async (onCall = () => true, probes = [
    { key: 'tag', type: 'tag', value: 'v24.10.0' },
    { key: 'path', type: 'path', value: 'package/utils/foo' }
  ]) => {
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = () => {};
    console.error = () => {};
    try {
      return await graphqlCheckExistence('token', 'openwrt/openwrt', 'HEAD', probes, onCall);
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  };

  test('raises instead of reporting every probe false when the attempt is declined', async () => {
    let served = 0;
    globalThis.fetch = async () => { served++; return new Response(JSON.stringify({ data: { repository: { p0: { name: 'v24.10.0' } } } }), { status: 200 }); };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await assert.rejects(
        () => graphqlCheckExistence('token', 'openwrt/openwrt', 'HEAD', [{ key: 'tag', type: 'tag', value: 'v24.10.0' }], () => false),
        /existence probe for openwrt\/openwrt was not sent/
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.strictEqual(served, 0, 'nothing was asked, so nothing may be answered');
  });

  test('raises when GitHub itself fails, rather than calling an existing tag absent', async () => {
    let served = 0;
    globalThis.fetch = async () => { served++; return new Response('upstream hiccup', { status: 500 }); };

    await assert.rejects(
      () => probeQuietly(),
      /existence probe for openwrt\/openwrt was not answered \(HTTP 500: upstream hiccup\)/
    );
    assert.strictEqual(served, 3, 'a real failure is retried to exhaustion');
  });

  test('raises when the query never reached GitHub at all', async () => {
    globalThis.fetch = async () => { throw new Error('connection reset'); };

    await assert.rejects(
      () => probeQuietly(),
      /existence probe for openwrt\/openwrt was not answered \(HTTP 599: connection reset\)/
    );
  });

  test('raises on a null repository that comes with no reason at all', async () => {
    // GitHub names a NOT_FOUND when a repository is really gone, so a null
    // repository on its own states nothing: counting it as "every probe
    // absent" would rest on an empty error list being vacuously all misses.
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { repository: null } }), { status: 200 });

    await assert.rejects(() => probeQuietly(), /was not answered \(HTTP 200/);
  });

  test('raises on a 200 whose errors say the query could not be executed', async () => {
    // GitHub reports its own timeouts inside a 200: no `data`, just an error
    // that says nothing about any tag.
    globalThis.fetch = async () => new Response(JSON.stringify({
      errors: [{ message: 'Something went wrong while executing your query.' }]
    }), { status: 200 });

    await assert.rejects(() => probeQuietly(), /was not answered \(HTTP 200/);
  });

  test('raises on a rate limit, which answers no question about existence', async () => {
    globalThis.fetch = async () => new Response('API rate limit exceeded', { status: 403 });

    await assert.rejects(() => probeQuietly(), /was not answered \(HTTP 403/);
  });

  test('marks every probe absent when GitHub cannot resolve the repository', async () => {
    // A 200 carrying `data` with a null repository and a NOT_FOUND error is
    // GitHub's answer for a repository that is not there - the tag and the
    // path are genuinely absent.
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: { repository: null },
      errors: [{ type: 'NOT_FOUND', path: ['repository'], message: "Could not resolve to a Repository with the name 'openwrt/openwrt'." }]
    }), { status: 200 });

    const results = await probeQuietly();
    assert.deepStrictEqual([...results.entries()], [['tag', false], ['path', false]]);
  });

  test('marks every probe absent on a 404', async () => {
    globalThis.fetch = async () => new Response('Not Found', { status: 404 });

    const results = await probeQuietly();
    assert.deepStrictEqual([...results.entries()], [['tag', false], ['path', false]]);
  });

  test('raises when a partial error emptied one probe field', async () => {
    // The repository resolved and so did the tag; only the path lookup was
    // lost. Reporting it absent invents the one answer that was missing.
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: { repository: { p0: { name: 'v24.10.0' }, p1: null } },
      errors: [{ message: 'Something went wrong while executing your query.', path: ['repository', 'p1'] }]
    }), { status: 200 });

    await assert.rejects(() => probeQuietly(), /probe path for openwrt\/openwrt was lost to a partial GraphQL error/);
  });

  test('marks a probe absent when the partial error on it is a lookup miss', async () => {
    // A NOT_FOUND on the field itself is still GitHub answering the probe, so
    // it must not be read as a lost answer - the same line the guard above
    // draws for the repository.
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: { repository: { p0: { name: 'v24.10.0' }, p1: null } },
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'p1'], message: 'Could not resolve to a Tree with the path.' }]
    }), { status: 200 });

    const results = await probeQuietly();
    assert.deepStrictEqual([...results.entries()], [['tag', true], ['path', false]]);
  });

  test('reports a probe the partial error left alone', async () => {
    // The error names a field that resolved anyway, so no probe lost its
    // answer and the run carries on.
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: { repository: { p0: { name: 'v24.10.0' }, p1: null } },
      errors: [{ message: 'Something went wrong while executing your query.', path: ['repository', 'p0'] }]
    }), { status: 200 });

    const results = await probeQuietly();
    assert.deepStrictEqual([...results.entries()], [['tag', true], ['path', false]]);
  });

  test('still reports a tag that resolves and a path that does not', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: { repository: { p0: { name: 'v24.10.0' }, p1: null } }
    }), { status: 200 });

    const results = await probeQuietly();
    assert.deepStrictEqual([...results.entries()], [['tag', true], ['path', false]]);
  });
});
