// --- GITHUB API HELPER ---
export async function githubApiCall(url, token, method = 'GET', payload = null, customAccept = 'application/vnd.github+json', options = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': customAccept,
    'User-Agent': 'FormalityCheck-Bot'
  };

  const fetchOptions = {
    method,
    headers
  };

  if (payload && (method === 'POST' || method === 'PATCH')) {
    fetchOptions.body = JSON.stringify(payload);
    headers['Content-Type'] = 'application/json';
  }

  const maxAttempts = 3;
  let delay = (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test') ? 1 : 500;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, fetchOptions);
      const text = await response.text();

      // Retry on 5xx status codes for all requests (transient GitHub issues)
      const isRetryable5xx = response.status >= 500 && response.status < 600;
      if (isRetryable5xx && attempt < maxAttempts) {
        console.warn(`GitHub API call failed with HTTP ${response.status} (attempt ${attempt}/${maxAttempts}). Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }

      if (response.status >= 400) {
        // 404 on GET /contents/ is always expected noise: file lookups routinely
        // probe paths that may not exist (e.g. Makefile discovery in findPkgRoot).
        const isExpected404 = response.status === 404 &&
          method === 'GET' && url.includes('/contents/');
        // 404/422 is expected only for opt-in callers (options.silent): the
        // fork fallback when a commit SHA vanished after a force-push / rebase,
        // permission probes for users who are not collaborators, and label
        // deletions racing another writer.
        const isSilencedMiss = options.silent === true &&
          (response.status === 404 || response.status === 422);
        if (!isExpected404 && !isSilencedMiss) {
          console.error(`GitHub API call failed: ${method} ${url} -> HTTP ${response.status}: ${text.trim().slice(0, 500)}`);
        }
      }

      let data = null;
      try {
        data = JSON.parse(text);
      } catch (e) {}

      return {
        code: response.status,
        data,
        raw: text,
        headers: response.headers
      };
    } catch (error) {
      // Retry network/fetch errors for all requests
      const isRetryableError = true;
      if (isRetryableError && attempt < maxAttempts) {
        console.warn(`GitHub API call network error (attempt ${attempt}/${maxAttempts}): ${error.message}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }

      console.error(`GitHub API call failed permanently: ${method} ${url} -> ${error.message}`);
      return {
        code: 599,
        data: null,
        raw: error.message,
        headers: { get: () => null }
      };
    }
  }
}

// --- GRAPHQL BATCH FILE FETCH ---
// Fetches raw content for many (repo, ref, path) triples in as few HTTP
// subrequests as possible. GitHub's REST Contents API only serves one file
// per call; GraphQL lets us alias dozens of `object(expression: "ref:path")`
// lookups across multiple repos into a single POST, which matters a great
// deal under Cloudflare Workers' per-invocation subrequest cap.
export const GRAPHQL_URL = 'https://api.github.com/graphql';

// probes: Array<{ key: string, repoFullname: string, ref: string, path: string | null }>
// `key` is caller-defined and just echoed back so results can be matched up;
// it must be unique across the whole `probes` array passed to one call
// (regardless of which repo each probe targets). A probe with a null/empty
// `path` resolves the ref itself instead of a file — its `exists` answers
// "does this repo know this ref at all", which a null file lookup cannot
// (GraphQL returns the same null both for a missing path and for a ref the
// repo cannot resolve).
// Returns Map<key, { content, exists, isBinary } | { error: Error }>:
//   content  string when the path resolved to a readable text blob, else null
//   exists   true when the ref (and path, if given) resolved at all — a
//            binary or oversized blob has exists: true with content: null
//   isBinary true when the path resolved to a binary blob
export async function graphqlBatchFetchFiles(token, probes) {
  const results = new Map();
  if (!probes || probes.length === 0) return results;

  // Group probes by repo so each distinct repo gets its own aliased
  // `repository(owner:, name:)` selection within a single query.
  const groups = new Map(); // repoFullname -> probes[]
  for (const probe of probes) {
    if (!groups.has(probe.repoFullname)) groups.set(probe.repoFullname, []);
    groups.get(probe.repoFullname).push(probe);
  }

  const varDefs = [];
  const variables = {};
  const queryParts = [];
  // probeMeta mirrors `probes` order and records where to find each probe's
  // result in the response shape (repository alias + field alias).
  const probeMeta = [];

  let repoIndex = 0;
  for (const [repoFullname, groupProbes] of groups) {
    const slashIndex = repoFullname.indexOf('/');
    const owner = repoFullname.slice(0, slashIndex);
    const name = repoFullname.slice(slashIndex + 1);
    const repoAlias = `repo${repoIndex}`;
    const oVar = `o${repoIndex}`;
    const nVar = `n${repoIndex}`;
    varDefs.push(`$${oVar}: String!`, `$${nVar}: String!`);
    variables[oVar] = owner;
    variables[nVar] = name;

    const fieldParts = [];
    groupProbes.forEach((probe, probeIndex) => {
      const fieldAlias = `f${probeIndex}`;
      const eVar = `e${repoIndex}_${probeIndex}`;
      varDefs.push(`$${eVar}: String!`);
      // A bare ref expression (no ":path") resolves the ref itself — used
      // by ref-existence probes. `oid` lives on the GitObject interface, so
      // one selection shape serves both commit and blob results.
      variables[eVar] = probe.path ? `${probe.ref}:${probe.path}` : `${probe.ref}`;
      fieldParts.push(`${fieldAlias}: object(expression: $${eVar}) { oid ... on Blob { text isBinary } }`);
      probeMeta.push({ key: probe.key, repoAlias, fieldAlias });
    });

    queryParts.push(`${repoAlias}: repository(owner: $${oVar}, name: $${nVar}) {\n    ${fieldParts.join('\n    ')}\n  }`);
    repoIndex++;
  }

  const query = `query(${varDefs.join(', ')}) {\n  ${queryParts.join('\n  ')}\n}`;

  const res = await githubApiCall(GRAPHQL_URL, token, 'POST', { query, variables });

  if (res.code !== 200 || !res.data) {
    const cleanRaw = (res.raw || "").trim().slice(0, 200);
    const err = new Error(`GraphQL batch file fetch failed (HTTP ${res.code}): ${cleanRaw}`);
    for (const probe of probes) results.set(probe.key, { error: err });
    return results;
  }

  const topLevelData = res.data.data;
  if (!topLevelData) {
    const errMsgs = Array.isArray(res.data.errors) ? res.data.errors.map(e => e.message).join('; ') : 'no data returned';
    const err = new Error(`GraphQL batch file fetch returned no data: ${errMsgs}`);
    for (const probe of probes) results.set(probe.key, { error: err });
    return results;
  }

  if (Array.isArray(res.data.errors) && res.data.errors.length > 0) {
    // Partial errors (e.g. a single expression failing to parse) still come
    // back with HTTP 200 and a top-level `data` object for the fields that
    // did resolve. Treat the affected fields as "not found" below rather
    // than failing the whole batch, and log once for visibility.
    console.warn(`GraphQL batch file fetch returned partial errors: ${res.data.errors.map(e => e.message).join('; ').slice(0, 500)}`);
  }

  for (const meta of probeMeta) {
    const repoData = topLevelData[meta.repoAlias];
    const field = repoData ? repoData[meta.fieldAlias] : undefined;
    if (field) {
      results.set(meta.key, {
        content: typeof field.text === 'string' ? field.text : null,
        exists: true,
        isBinary: field.isBinary === true
      });
    } else {
      results.set(meta.key, { content: null, exists: false, isBinary: false });
    }
  }

  return results;
}

// --- GRAPHQL REPOSITORY LABELS FETCH ---
// Collects label pages into `labels`, starting after `cursor` (null for the
// first page). Shared by graphqlFetchRepoLabels and graphqlFetchRepoSetup.
// `onCall` is invoked once per HTTP request so callers can count every page
// against their subrequest budget.
async function fetchLabelPages(token, owner, name, labels, cursor, onCall) {
  let hasNextPage = true;

  while (hasNextPage) {
    onCall?.();
    // The cursor travels as a variable: interpolating an externally supplied
    // value into the query string is the one thing GraphQL variables exist to
    // avoid.
    const query = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, after: $after) {
      nodes { name }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

    const res = await githubApiCall(GRAPHQL_URL, token, 'POST', { query, variables: { owner, name, after: cursor } });

    if (res.code !== 200 || !res.data?.data?.repository?.labels) {
      const cleanRaw = (res.raw || '').trim().slice(0, 200);
      throw new Error(`GraphQL label fetch failed (HTTP ${res.code}): ${cleanRaw}`);
    }

    const labelData = res.data.data.repository.labels;
    for (const node of labelData.nodes) {
      labels.add(node.name.toLowerCase());
    }
    hasNextPage = labelData.pageInfo.hasNextPage;
    cursor = labelData.pageInfo.endCursor;
  }
}

// Fetches all repository label names in a single paginated GraphQL query,
// replacing multiple REST calls (one per 100-label page). Returns a Set of
// lowercased label names for O(1) existence checks.
export async function graphqlFetchRepoLabels(token, repoFullname) {
  const slashIndex = repoFullname.indexOf('/');
  const owner = repoFullname.slice(0, slashIndex);
  const name = repoFullname.slice(slashIndex + 1);

  const labels = new Set();
  await fetchLabelPages(token, owner, name, labels, null);
  return labels;
}

// --- GRAPHQL PR SETUP FETCH ---
// Everything a pull_request event needs before validation starts — the
// repository's labels, .github/formalities.json and .github/labeler.yml —
// fetched in one GraphQL round trip instead of two REST calls plus a labels
// query. Returns { labels, configText, labelerText }, where a missing file
// yields null text (callers fall back to their defaults, like the REST 404
// used to). Throws when the query itself fails, matching the strictness of
// the config fetch this replaces; a failure while paging labels past the
// first 100 degrades to labels: null instead, because label bookkeeping is
// not worth failing the run over (see ensureLabelExists).
export async function graphqlFetchRepoSetup(token, repoFullname, ref, configPath, labelerPath, onCall) {
  const slashIndex = repoFullname.indexOf('/');
  const owner = repoFullname.slice(0, slashIndex);
  const name = repoFullname.slice(slashIndex + 1);

  onCall?.();
  const query = `query($owner: String!, $name: String!, $cfgExpr: String!, $labExpr: String!) {
  repository(owner: $owner, name: $name) {
    labels(first: 100) {
      nodes { name }
      pageInfo { hasNextPage endCursor }
    }
    cfg: object(expression: $cfgExpr) { ... on Blob { text } }
    labeler: object(expression: $labExpr) { ... on Blob { text } }
  }
}`;

  const res = await githubApiCall(GRAPHQL_URL, token, 'POST', {
    query,
    variables: { owner, name, cfgExpr: `${ref}:${configPath}`, labExpr: `${ref}:${labelerPath}` }
  });

  const repo = res.code === 200 ? res.data?.data?.repository : null;
  if (!repo) {
    const cleanRaw = (res.raw || '').trim().slice(0, 200);
    throw new Error(`GraphQL repository setup fetch failed (HTTP ${res.code}): ${cleanRaw}`);
  }

  let labels = new Set();
  for (const node of repo.labels?.nodes || []) {
    labels.add(node.name.toLowerCase());
  }
  const pageInfo = repo.labels?.pageInfo;
  if (pageInfo?.hasNextPage) {
    try {
      await fetchLabelPages(token, owner, name, labels, pageInfo.endCursor, onCall);
    } catch (err) {
      console.warn(`Repository label listing failed past the first page, continuing without it: ${err.message}`);
      labels = null;
    }
  }

  return {
    labels,
    configText: typeof repo.cfg?.text === 'string' ? repo.cfg.text : null,
    labelerText: typeof repo.labeler?.text === 'string' ? repo.labeler.text : null
  };
}

// Creates a repository label if it does not already exist. Shared by both
// the PR labeler and the issue labeller. Returns true if created, false if
// it already existed.
// `existingLabels` may be null when the label listing could not be fetched:
// the create is then attempted blindly, with the 422 GitHub answers for an
// already-existing label silenced — labelling must keep working even when
// the listing call failed.
export async function ensureLabelExists(token, repoFullname, name, color, description, existingLabels, onCall) {
  if (existingLabels && existingLabels.has(name.toLowerCase())) return false;
  onCall?.();
  const url = `https://api.github.com/repos/${repoFullname}/labels`;
  // 422 is GitHub for "already exists" — a benign race with another writer
  // (or the blind-create path working as intended), so it is silenced.
  const res = await githubApiCall(url, token, 'POST', { name, color: color || 'ededed', description: description || '' }, 'application/vnd.github+json', { silent: true });
  if (res.code === 422) {
    existingLabels?.add(name.toLowerCase());
    return false;
  }
  if (res.code >= 200 && res.code < 300) {
    existingLabels?.add(name.toLowerCase());
    return true;
  }
  // A failed create must not be recorded as existing, so a later attempt
  // can retry it.
  return false;
}

// --- GRAPHQL ISSUE VALIDATION HELPERS ---
// Checks tag existence and file/directory presence in a single batched query.
// probes: Array<{ key: string, type: 'tag' | 'path', value: string }>
//   type 'tag': checks if refs/tags/<value> exists
//   type 'path': checks if <ref>:<value> object exists (file or tree)
// Returns Map<key, boolean>
export async function graphqlCheckExistence(token, repoFullname, ref, probes) {
  const results = new Map();
  if (!probes || probes.length === 0) return results;

  const slashIndex = repoFullname.indexOf('/');
  const owner = repoFullname.slice(0, slashIndex);
  const name = repoFullname.slice(slashIndex + 1);

  const varDefs = ['$owner: String!', '$name: String!'];
  const variables = { owner, name };
  const fieldParts = [];

  probes.forEach((probe, i) => {
    const alias = `p${i}`;
    const eVar = `expr${i}`;
    varDefs.push(`$${eVar}: String!`);
    if (probe.type === 'tag') {
      variables[eVar] = `refs/tags/${probe.value}`;
      fieldParts.push(`${alias}: ref(qualifiedName: $${eVar}) { name }`);
    } else {
      variables[eVar] = `${ref}:${probe.value}`;
      fieldParts.push(`${alias}: object(expression: $${eVar}) { oid }`);
    }
  });

  const query = `query(${varDefs.join(', ')}) {\n  repository(owner: $owner, name: $name) {\n    ${fieldParts.join('\n    ')}\n  }\n}`;

  const res = await githubApiCall(GRAPHQL_URL, token, 'POST', { query, variables });

  if (res.code !== 200 || !res.data?.data?.repository) {
    // On failure, mark all as non-existent rather than throwing
    for (const probe of probes) results.set(probe.key, false);
    return results;
  }

  const repoData = res.data.data.repository;
  probes.forEach((probe, i) => {
    const field = repoData[`p${i}`];
    results.set(probe.key, field !== null && field !== undefined);
  });

  return results;
}

// Fallback for responses without the `user.permissions` object. The flat
// `permission` field only ever reports admin/write/read/none — a `maintain` or
// custom role that grants push is already folded into `write` there, so those
// two levels are the whole set. `role_name` is deliberately not consulted: it
// can name a custom organization role whose actual rights are unknown.
const WRITE_PERMISSION_LEVELS = ['admin', 'write'];

// Checks whether a user holds write access to a repository. Used as a fallback
// when author_association is CONTRIBUTOR or NONE, which is what GitHub reports
// for maintainers whose organization membership is private.
// Returns true/false when GitHub answered authoritatively — including 404,
// which is the normal answer for "not a collaborator" and is therefore
// silenced rather than logged as an API failure — and null when the lookup
// itself failed (403 without the required app permission, 5xx, network error),
// so callers can tell "no access" apart from "no answer".
export async function fetchUserRepoPermission(repoFullname, username, token, onCall) {
  if (!repoFullname || !username) return false;
  onCall?.();
  const url = `https://api.github.com/repos/${repoFullname}/collaborators/${encodeURIComponent(username)}/permission`;
  const res = await githubApiCall(url, token, 'GET', null, 'application/vnd.github+json', { silent: true });
  if (res.code === 404) {
    return false;
  }
  if (res.code !== 200 || !res.data) {
    return null;
  }
  // `user.permissions` is the documented signal for push access and covers the
  // maintain and custom roles that the flat field flattens away.
  const permissions = res.data.user?.permissions;
  if (permissions && typeof permissions === 'object') {
    return permissions.admin === true || permissions.maintain === true || permissions.push === true;
  }
  return WRITE_PERMISSION_LEVELS.includes((res.data.permission || '').toLowerCase());
}
