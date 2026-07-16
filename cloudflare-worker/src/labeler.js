// Custom light-weight YAML parser and glob-matcher for .github/labeler.yml compatibility.

export function normalizePath(p) {
  let clean = p.trim();
  if (clean.startsWith('./')) {
    clean = clean.slice(2);
  }
  if (clean.startsWith('/')) {
    clean = clean.slice(1);
  }
  return clean;
}

export function getAllChangedFiles(patch) {
  if (!patch) return [];
  const files = new Set();
  const lines = patch.split('\n');
  for (const line of lines) {
    if (line.startsWith('--- a/')) {
      const file = line.slice(6).trim().replace(/\r$/, '');
      if (file !== '/dev/null') {
        files.add(file);
      }
    } else if (line.startsWith('+++ b/')) {
      const file = line.slice(6).trim().replace(/\r$/, '');
      if (file !== '/dev/null') {
        files.add(file);
      }
    }
  }
  return Array.from(files);
}

export function globToRegex(glob) {
  const cleanGlob = normalizePath(glob);
  const segments = cleanGlob.split('/');
  const regexSegments = segments.map(segment => {
    if (segment === '**') {
      return '.*';
    }
    // Escape special regex characters except '*' and '?'
    return segment
      .replace(/[\\^$.|+( )[\]{}]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
  });

  const regexStr = regexSegments.join('/').replace(/\/+/g, '/');
  return new RegExp(`^${regexStr}$`);
}

export function parseYaml(yamlText) {
  if (!yamlText) return {};
  const lines = yamlText.split('\n');
  const result = {};
  let currentLabel = null;
  let inChangedFiles = false;
  let inAnyGlob = false;

  for (let line of lines) {
    // Strip comments
    const hashIndex = line.indexOf('#');
    if (hashIndex !== -1) {
      line = line.substring(0, hashIndex);
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if line defines a new top-level label
    const keyMatch = line.match(/^"([^"]+)":\s*$/) ||
                     line.match(/^'([^']+)':\s*$/) ||
                     line.match(/^([^:]+):\s*$/);

    if (keyMatch && !line.startsWith(' ') && !line.startsWith('-')) {
      currentLabel = keyMatch[1].trim();
      result[currentLabel] = [];
      inChangedFiles = false;
      inAnyGlob = false;
      continue;
    }

    if (!currentLabel) continue;

    // Detect changed-files block
    if (trimmed === '- changed-files:') {
      inChangedFiles = true;
      inAnyGlob = false;
      continue;
    }

    // Detect if we entered any-glob block
    const anyGlobInlineMatch = trimmed.match(/^(?:-\s*)?any-glob-to-any-file:\s*(.+)$/);
    if (anyGlobInlineMatch) {
      let val = anyGlobInlineMatch[1].trim();
      if (val.startsWith('[') && val.endsWith(']')) {
        const paths = val.slice(1, -1).split(',').map(s => {
          let p = s.trim();
          if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
            p = p.slice(1, -1);
          }
          return p;
        });
        result[currentLabel].push(...paths);
      } else {
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        result[currentLabel].push(val);
      }
      inAnyGlob = false;
      continue;
    }

    if (inChangedFiles && (trimmed === '- any-glob-to-any-file:' || trimmed === 'any-glob-to-any-file:')) {
      inAnyGlob = true;
      continue;
    }

    // Process list items
    if (trimmed.startsWith('-')) {
      let pattern = trimmed.slice(1).trim();
      if ((pattern.startsWith('"') && pattern.endsWith('"')) || (pattern.startsWith("'") && pattern.endsWith("'"))) {
        pattern = pattern.slice(1, -1);
      }
      if (inAnyGlob) {
        result[currentLabel].push(pattern);
      } else if (!inChangedFiles) {
        // v4 format: direct list under label
        result[currentLabel].push(pattern);
      }
    }
  }

  return result;
}

export function matchFiles(changedFiles, globPatterns) {
  if (!Array.isArray(changedFiles) || !Array.isArray(globPatterns) || globPatterns.length === 0) {
    return false;
  }

  const regexes = globPatterns.map(p => globToRegex(p));
  const normalizedFiles = changedFiles.map(f => normalizePath(f));

  for (const file of normalizedFiles) {
    for (const regex of regexes) {
      if (regex.test(file)) {
        return true;
      }
    }
  }

  return false;
}

export function getLabelsForChangedFiles(changedFiles, parsedConfig) {
  const matchingLabels = [];
  if (!parsedConfig || typeof parsedConfig !== 'object') {
    return matchingLabels;
  }

  for (const [label, patterns] of Object.entries(parsedConfig)) {
    if (matchFiles(changedFiles, patterns)) {
      matchingLabels.push(label);
    }
  }

  return matchingLabels;
}
