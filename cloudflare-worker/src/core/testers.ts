// Testers live in CODEOWNERS comments, which GitHub ignores:
//
//   # rft: /target/linux/mediatek/ @alice @bob
//   /package/network/services/dropbear/ @owner # rft: @carol
//
// A comment line names its own pattern. A comment after an owner line takes
// that line's pattern.

const LOGIN = /^@([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})$/;

export interface TesterEntry {
  line: number;
  pattern: string;
  regex: RegExp;
  logins: string[];
}

// CODEOWNERS pattern syntax, as GitHub documents it: a leading or inner slash
// anchors the pattern at the root, `apps/` matches a directory anywhere, a
// directory covers everything under it, and `docs/*` only its direct files.
export function codeownersPatternRegex(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
  p = p.replace(/^\//, '');
  const directory = p.endsWith('/');
  if (directory) p = p.slice(0, -1);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const lastSegment = p.slice(p.lastIndexOf('/') + 1);
  const suffix = directory ? '/.*' : lastSegment.includes('*') ? '' : '(?:/.*)?';
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}${suffix}$`);
}

export function parseTesterEntries(text: string | null | undefined): { entries: TesterEntry[]; problems: string[] } {
  const entries: TesterEntry[] = [];
  const problems: string[] = [];
  if (!text) return { entries, problems };

  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    const hash = raw.indexOf('#');
    if (hash === -1) return;
    const rft = raw.slice(hash + 1).trim().match(/^rft:\s*(.*)$/i);
    if (!rft) return;
    // Text after another # is a note, such as the boards a tester has.
    const tokens = rft[1].replace(/\s+#.*$/, '').split(/\s+/).filter(Boolean);
    const owners = raw.slice(0, hash).trim().split(/\s+/).filter(Boolean);

    let pattern: string;
    if (owners.length > 0) {
      pattern = owners[0];
      // GitHub reads a pattern with no owner as clearing the ownership of
      // its files, so testers do not belong on such a line.
      if (owners.length === 1) problems.push(`line ${line} has a pattern with no owner, which GitHub reads as clearing ownership. Put its testers on a comment line of their own.`);
    } else if (tokens.length > 0 && !tokens[0].startsWith('@')) {
      pattern = tokens.shift() as string;
    } else {
      problems.push(`line ${line} names no pattern for its testers.`);
      return;
    }

    const logins: string[] = [];
    for (const token of tokens) {
      const login = token.match(LOGIN);
      if (login) logins.push(login[1]);
      else problems.push(`line ${line}: '${token}' is not a GitHub login.`);
    }
    if (logins.length === 0) {
      problems.push(`line ${line} names no testers.`);
      return;
    }
    entries.push({ line, pattern, regex: codeownersPatternRegex(pattern), logins });
  });
  return { entries, problems };
}

// Unlike owners, testers add up: everyone whose pattern matches a changed
// file is returned, not only the last match. Keyed by lowercased login.
export function matchTesters(entries: TesterEntry[], files: string[]): Map<string, string> {
  const testers = new Map<string, string>();
  for (const entry of entries) {
    if (!files.some(file => entry.regex.test(file))) continue;
    for (const login of entry.logins) {
      if (!testers.has(login.toLowerCase())) testers.set(login.toLowerCase(), login);
    }
  }
  return testers;
}
