// --- GITHUB API HELPER ---
export async function githubApiCall(url, token, method = 'GET', payload = null, customAccept = 'application/vnd.github+json') {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': customAccept,
    'User-Agent': 'FormalityCheck-Bot'
  };

  const options = {
    method,
    headers
  };

  if (payload && (method === 'POST' || method === 'PATCH')) {
    options.body = JSON.stringify(payload);
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, options);
  const text = await response.text();

  if (response.status >= 400) {
    const isExpected404 = response.status === 404 && (
      (method === 'GET' && url.includes('/.github/formalities.json')) ||
      (method === 'DELETE' && url.includes('/labels/'))
    );
    if (!isExpected404) {
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
    raw: text
  };
}

export async function fetchRepositoryConfig(data, token, defaultConfig) {
  const repoFullname = data.repository.full_name;
  const branchRef = data.pull_request.head.ref;
  const configUrl = `https://api.github.com/repos/${repoFullname}/contents/.github/formalities.json?ref=${encodeURIComponent(branchRef)}`;

  const res = await githubApiCall(configUrl, token, 'GET', null, 'application/vnd.github.raw');
  if (res.code === 200) {
    try {
      const repoConfig = JSON.parse(res.raw);
      if (repoConfig && typeof repoConfig === 'object') {
        return { ...defaultConfig, ...repoConfig };
      }
    } catch (e) {}
  }
  return defaultConfig;
}
