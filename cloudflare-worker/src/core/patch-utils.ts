// --- UTILS FOR PATCHES AND COMMITS ---

export function getDiffFromPatch(patchText: string | null | undefined): string {
  if (!patchText) return '';
  const idx = patchText.indexOf('diff --git ');
  return idx === -1 ? '' : patchText.slice(idx);
}

export const MBOX_ENVELOPE_PATTERN = /^From ([0-9a-f]{40}) Mon Sep 17 00:00:00 2001\r?\nFrom: /gm;

// A pull request's .patch is the mbox-style concatenation of its commits'
// patches in commit order, each opening with git's
// "From <sha> Mon Sep 17 00:00:00 2001" envelope line. Split it back into one
// patch per commit, keyed by SHA, so one request stands in for one fetch per
// commit. The diff bodies are byte-identical to what /commits/<sha> serves;
// only the mail header lines differ (e.g. "[PATCH 2/3]" subjects), and
// nothing downstream reads those from the patch text.
//
// A commit message may itself contain such a line - quoting the upstream mail
// a change was taken from is common, and git passes the body through verbatim
// (openwrt/openwrt commit bcd8d530 is one). Splitting on every envelope-shaped
// line would cut that commit's patch in two and file its diff under the quoted
// SHA, leaving the real commit with headers and no diff, which every check
// then reports as clean. So only an envelope naming one of this pull request's
// own commits counts, taken in the order the commits list gives them: a quoted
// header names some other commit, and one naming a commit already passed is
// behind the position the scan has reached.
//
// Each part is then checked against the number of files GitHub says the
// commit changed: a part that swallowed a neighbour's diff has too many, one
// cut short has too few, and either is left out so the commit is fetched on
// its own. That closes the one gap the order rule leaves - a message quoting
// a commit that comes later in the same pull request.
export function splitPrPatchByCommit(
  prPatch: string | null | undefined,
  commits: Array<{ sha: string; changed_files?: number | null }> | null | undefined
): Map<string, string> {
  const byCommit = new Map<string, string>();
  if (!prPatch || !commits || commits.length === 0) return byCommit;

  const expectedFiles = new Map(commits.map(c => [c.sha, Number.isInteger(c.changed_files) ? c.changed_files : null]));
  let pending = commits.map(c => c.sha);
  const starts: Array<{ sha: string; index: number }> = [];
  const envelope = /^From ([0-9a-f]{40}) Mon Sep 17 00:00:00 2001\r?$/gm;
  let match: RegExpExecArray | null;
  while ((match = envelope.exec(prPatch)) !== null) {
    const position = pending.indexOf(match[1]);
    if (position === -1) continue;
    pending = pending.slice(position + 1);
    starts.push({ sha: match[1], index: match.index });
  }

  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].index : prPatch.length;
    const part = prPatch.slice(starts[i].index, end);
    // Anything without a diff is not something the checks can be run against.
    // Leaving it out sends the commit down its own fetch, which is what the
    // handler did before, rather than passing an empty diff off as inspected.
    const files = (part.match(/^diff --git /gm) || []).length;
    const expected = expectedFiles.get(starts[i].sha);
    if (files > 0 && (expected === null || files === expected)) {
      byCommit.set(starts[i].sha, part);
    }
  }
  return byCommit;
}

export function normalizeDiff(diffText: string | null | undefined): string {
  return (diffText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

export function getCommitMessageFromPatch(patch: string | null | undefined): string {
  if (!patch) return '';
  const lines = patch.split('\n');
  let subject = '';
  const bodyLines: string[] = [];
  let foundSubject = false;
  let inBody = false;

  for (const line of lines) {
    if (line.startsWith('Subject: ')) {
      subject = line.slice(9).replace(/^\[PATCH\]\s*/i, '');
      foundSubject = true;
      inBody = true;
      continue;
    }
    if (foundSubject) {
      if (line.startsWith('---')) {
        break;
      }
      if (inBody) {
        bodyLines.push(line);
      }
    }
  }
  return (subject + '\n' + bodyLines.join('\n')).trim();
}

export function getChangedFilesFromPatch(patch: string | null | undefined): string[] {
  if (!patch) return [];
  const files = new Set<string>();
  const lines = patch.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      const p = line.slice(6).trim().replace(/\r$/, '');
      if (p && p !== '/dev/null') files.add(p);
    } else if (line.startsWith('--- a/')) {
      const p = line.slice(6).trim().replace(/\r$/, '');
      if (p && p !== '/dev/null') files.add(p);
    } else if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
      if (match) {
        const fileA = match[1].trim().replace(/\r$/, '');
        const fileB = match[2].trim().replace(/\r$/, '');
        if (fileA && fileA !== '/dev/null') files.add(fileA);
        if (fileB && fileB !== '/dev/null') files.add(fileB);
      }
    }
  }
  return Array.from(files);
}
