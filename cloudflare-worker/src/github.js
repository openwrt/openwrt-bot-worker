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

export async function fetchRepositoryConfig(data, token, defaultConfig) {
  const repoFullname = data.repository.full_name;
  const branchRef = data.pull_request.base.ref;
  const configUrl = `https://api.github.com/repos/${repoFullname}/contents/.github/formalities.json?ref=${encodeURIComponent(branchRef)}`;

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
