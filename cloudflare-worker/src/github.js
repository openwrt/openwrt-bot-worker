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
        // 404/422 on GET /commits/ is expected only for opt-in callers
        // (options.silent), e.g. the fork fallback when a commit SHA vanished
        // after a force-push / rebase.
        const isSilencedCommitMiss = options.silent === true &&
          (response.status === 404 || response.status === 422) &&
          method === 'GET' && url.includes('/commits/');
        if (!isExpected404 && !isSilencedCommitMiss) {
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

export async function fetchRepositoryConfig(data, token, defaultConfig, onCall) {
  const repoFullname = data.repository.full_name;
  const branchRef = data.pull_request.base.ref;
  const configUrl = `https://api.github.com/repos/${repoFullname}/contents/.github/formalities.json?ref=${encodeURIComponent(branchRef)}`;

  onCall?.();
  const res = await githubApiCall(configUrl, token, 'GET', null, 'application/vnd.github.raw');
  if (res.code === 200) {
    try {
      const repoConfig = JSON.parse(res.raw);
      if (repoConfig && typeof repoConfig === 'object') {
        return { ...defaultConfig, ...repoConfig };
      }
    } catch (e) {}
  } else if (res.code !== 404) {
    const cleanRaw = (res.raw || "").trim().slice(0, 200);
    throw new Error(`Failed to fetch repository config from ${configUrl} (HTTP ${res.code}): ${cleanRaw}`);
  }
  return defaultConfig;
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
