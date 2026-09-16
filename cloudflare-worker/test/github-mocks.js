// Webhook signatures and GitHub API answers shared by the handler tests.

export async function calculateHmac(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const hashArray = Array.from(new Uint8Array(sigBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hashHex}`;
}

// --- GRAPHQL MOCKING HELPERS ---
// The file-content batching loader (fetchFileContentCached in src/index.js)
// sends one POST per batch to /graphql with aliased repository()/object()
// selections instead of one GET per file to the REST Contents API. These
// helpers decode that request and build a matching response so tests can
// assert on which (owner, name, ref, path) triples were actually requested.
export function parseGraphqlRequest(options) {
  const body = JSON.parse(options.body);
  const variables = body.variables || {};
  const groups = [];
  let i = 0;
  while (variables[`o${i}`] !== undefined) {
    const probes = [];
    let j = 0;
    while (variables[`e${i}_${j}`] !== undefined) {
      const expression = variables[`e${i}_${j}`];
      const sepIndex = expression.indexOf(':');
      // A bare-ref expression (no ':') is a ref-existence probe: the loader
      // asks whether the repo can resolve the ref at all, with no file path.
      probes.push({
        fieldAlias: `f${j}`,
        ref: sepIndex === -1 ? expression : expression.slice(0, sepIndex),
        path: sepIndex === -1 ? null : expression.slice(sepIndex + 1)
      });
      j++;
    }
    groups.push({ repoAlias: `repo${i}`, owner: variables[`o${i}`], name: variables[`n${i}`], probes });
    i++;
  }
  return { query: body.query, variables, groups };
}

// resolver(owner, name, ref, path) => string (found) | null (not found) |
// undefined (omit the field, simulating a partial GraphQL error, which
// `reportOmitted` also lists in errors[] the way GitHub does). For
// ref-existence probes (path === null) a string return means "the repo
// resolves this ref" — the value itself is not used as file content.
export function graphqlResponse(groups, resolver, { reportOmitted = false } = {}) {
  const data = {};
  const errors = [];
  for (const group of groups) {
    data[group.repoAlias] = {};
    for (const probe of group.probes) {
      const value = resolver(group.owner, group.name, probe.ref, probe.path);
      if (value === undefined) {
        if (reportOmitted) errors.push({ message: 'Something went wrong while executing your query.', path: [group.repoAlias, probe.fieldAlias] });
        continue;
      }
      if (value === null) {
        data[group.repoAlias][probe.fieldAlias] = null;
      } else if (probe.path === null) {
        // Ref probes resolve to a commit object — oid only, no Blob fields.
        data[group.repoAlias][probe.fieldAlias] = { oid: 'mock-oid' };
      } else {
        data[group.repoAlias][probe.fieldAlias] = { oid: 'mock-oid', text: value, isBinary: false };
      }
    }
  }
  return new Response(JSON.stringify(errors.length > 0 ? { data, errors } : { data }), { status: 200 });
}

// Helper: detect and respond to GraphQL labels queries in mocks.
// Returns a Response (or a Promise of one) if the request is a labels or
// repo-setup query, null otherwise.
//
// The PR handler fetches its per-PR setup (labels + formalities.json +
// labeler.yml) as one fused GraphQL query (graphqlFetchRepoSetup). Rather
// than forcing every test to restate its config in GraphQL shape, this
// helper answers the file parts of that query by re-entering the test's own
// fetch mock through the REST /contents/ URLs the mocks already handle —
// each test keeps declaring its config exactly the way it did when the
// worker still fetched it over REST.
export function graphqlLabelsHandler(url, options, labelNames = []) {
  if (!url.includes('/graphql')) return null;
  if (!options || !options.body) return null;
  { const pageAnswer = graphqlCommitPageHandler(url, options); if (pageAnswer) return pageAnswer; }
  const body = JSON.parse(options.body);
  if (!body.query || !body.query.includes('labels(first:')) return null;

  const labelsPayload = {
    nodes: labelNames.map(name => ({ name })),
    pageInfo: { hasNextPage: false, endCursor: null }
  };

  if (!body.query.includes('cfg: object(')) {
    return new Response(JSON.stringify({
      data: { repository: { labels: labelsPayload } }
    }), { status: 200 });
  }

  // Fused repo-setup query: resolve the two file expressions through the
  // surrounding fetch mock's REST branches, and - when the query asks for the
  // pull request - its commits and comments through the REST listings the
  // mocks already declare, reshaped the way GraphQL returns them (the
  // worker reshapes them back, see restCommitFromGraphql). A test therefore
  // keeps describing commits in the REST shape it always used.
  return (async () => {
    const { owner, name } = body.variables;
    const fetchExpr = async (expr) => {
      const sep = expr.indexOf(':');
      const ref = expr.slice(0, sep);
      const path = expr.slice(sep + 1);
      const res = await globalThis.fetch(
        `https://api.github.com/repos/${owner}/${name}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        { method: 'GET', headers: { Accept: 'application/vnd.github.raw' } }
      );
      if (res.status !== 200) return null;
      return { text: await res.text() };
    };
    const [cfg, labeler] = await Promise.all([
      fetchExpr(body.variables.cfgExpr),
      fetchExpr(body.variables.labExpr)
    ]);
    const repository = { labels: labelsPayload, cfg, labeler };

    if (body.query.includes('pullRequest(number:')) {
      const pr = body.variables.pr;
      // The listings are re-entered with `_setup=1` so a test counting real
      // REST requests can tell these apart from ones the worker makes itself.
      const commits = await restPages(`https://api.github.com/repos/${owner}/${name}/pulls/${pr}/commits`);
      const commentsPage1 = await restListJson(`https://api.github.com/repos/${owner}/${name}/issues/${pr}/comments?per_page=100&page=1&_setup=1`);
      repository.pullRequest = {
        commits: {
          totalCount: commits.length,
          pageInfo: { hasNextPage: commits.length > 100, endCursor: commits.length > 100 ? 'page2' : null },
          nodes: commits.slice(0, 100).map(c => ({ commit: graphqlCommitFromRest(c, owner, name) }))
        },
        comments: {
          totalCount: commentsPage1.length,
          // A full first page means GitHub would report more to come.
          pageInfo: { hasNextPage: commentsPage1.length >= 100 },
          nodes: commentsPage1.map(graphqlCommentFromRest)
        }
      };
    }
    return new Response(JSON.stringify({ data: { repository } }), { status: 200 });
  })();
}

export async function restListJson(url) {
  const res = await globalThis.fetch(url, { method: 'GET', headers: { Accept: 'application/vnd.github+json' } });
  if (res.status !== 200) return [];
  try { const parsed = JSON.parse(await res.text()); return Array.isArray(parsed) ? parsed : []; } catch (e) { return []; }
}

// Walks the REST listing the mock declares, page by page, the way the worker
// used to, so a fixture of 350 commits still means 350 commits.
export async function restPages(baseUrl) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const items = await restListJson(`${baseUrl}?per_page=100&page=${page}&_setup=1`);
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

// The worker pages commits past the first hundred with a cursor query; answer
// it from the same REST listing.
export function graphqlCommitPageHandler(url, options) {
  if (!url.includes('/graphql') || !options?.body) return null;
  const body = JSON.parse(options.body);
  if (!body.query || !body.query.includes('commits(first: 100, after: $after)')) return null;
  return (async () => {
    const { owner, name, pr, after } = body.variables;
    const pageNumber = Number(String(after).replace('page', ''));
    const all = await restPages(`https://api.github.com/repos/${owner}/${name}/pulls/${pr}/commits`);
    const start = (pageNumber - 1) * 100;
    const nodes = all.slice(start, start + 100).map(c => ({ commit: graphqlCommitFromRest(c, owner, name) }));
    const hasNextPage = all.length > start + 100;
    return new Response(JSON.stringify({
      data: { repository: { pullRequest: { commits: { pageInfo: { hasNextPage, endCursor: hasNextPage ? `page${pageNumber + 1}` : null }, nodes } } } }
    }), { status: 200 });
  })();
}

// REST -> GraphQL for one commit of the listing, the inverse of the worker's
// restCommitFromGraphql for every field the checks read.
export function graphqlCommitFromRest(c, owner, name) {
  const verification = c.commit?.verification;
  const signed = verification && (verification.verified || (verification.reason && verification.reason !== 'unsigned') || verification.signature);
  return {
    oid: c.sha,
    url: c.html_url || `https://github.com/${owner}/${name}/commit/${c.sha}`,
    message: c.commit?.message ?? '',
    changedFilesIfAvailable: Number.isInteger(c.changed_files) ? c.changed_files : null,
    author: { name: c.commit?.author?.name ?? null, email: c.commit?.author?.email ?? null, user: c.author?.login ? { login: c.author.login } : null },
    committer: { name: c.commit?.committer?.name ?? null, email: c.commit?.committer?.email ?? null, user: c.committer?.login ? { login: c.committer.login } : null },
    parents: { totalCount: Array.isArray(c.parents) ? c.parents.length : 1 },
    signature: signed
      ? { isValid: verification.verified === true, state: String(verification.reason || 'valid').toUpperCase(), signature: verification.signature ?? null, keyId: verification.key_id ?? null }
      : null
  };
}

// REST -> GraphQL for one issue comment. Tests run with APP_ID 12345, so a
// comment performed via that app is the viewer's own.
export function graphqlCommentFromRest(c) {
  const login = String(c.user?.login ?? '');
  const isBot = c.user?.type === 'Bot' || /\[bot\]$/.test(login);
  return {
    databaseId: c.id,
    body: c.body ?? '',
    authorAssociation: c.author_association ?? 'NONE',
    viewerDidAuthor: c.performed_via_github_app?.id === 12345,
    author: c.user ? { login: login.replace(/\[bot\]$/, ''), __typename: isBot ? 'Bot' : 'User' } : null
  };
}
