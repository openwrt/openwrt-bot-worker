import { SPDX_LICENSE_IDS, SPDX_EXCEPTION_IDS, SPDX_DEPRECATED } from './spdx-licenses.js';

// The grammar of a commit subject prefix: a package name (`bash`) or a source
// tree path with subdirectories (`tools/cmake`, `toolchain/musl`), followed by
// `: `. Defined once and reused by every place that has to recognize one, so
// the subject check and the revert parser cannot drift apart again.
export const SUBJECT_PREFIX_SOURCE = '[a-zA-Z0-9_-]+(?:\\/[a-zA-Z0-9_-]+)*: ';
const SUBJECT_PREFIX_RE = new RegExp(`^${SUBJECT_PREFIX_SOURCE}`);
const SUBJECT_PREFIX_STRIP_RE = new RegExp(`^${SUBJECT_PREFIX_SOURCE}\\s*`);

export function isValidName(name) {
  const nameRegex = /^[\p{L}'.-]+(?: [\p{L}'.-]+)+$/u;
  return nameRegex.test(name);
}

export function isNoreplyEmail(email) {
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  const domain = parts[1].toLowerCase();
  return domain === 'noreply.github.com' || domain === 'users.noreply.github.com';
}

export function getNormalizedText(str, pkgName) {
  let cleaned = str.toLowerCase();
  if (pkgName) {
    cleaned = cleaned.replaceAll(pkgName.toLowerCase(), '');
  }
  // Remove common list bullet markers and generic words
  cleaned = cleaned.replace(/^[\s\-*+•#]+/, '');
  // Remove leading 'v' before a digit (e.g., v1.2 -> 1.2, but keep words like version)
  cleaned = cleaned.replace(/\bv(?=\d)/g, '');
  // Remove all non-alphanumeric characters
  return cleaned.replace(/[^a-z0-9]/g, '');
}

export function isVirtuallyIdentical(subject, body, pkgName) {
  const normSubject = getNormalizedText(subject, pkgName);
  const normBody = getNormalizedText(body, pkgName);

  // 1. Direct or substring matching
  if (normSubject === normBody || 
      (normBody.includes(normSubject) && normBody.length < normSubject.length + 20) || 
      (normSubject.includes(normBody) && normSubject.length < normBody.length + 20)) {
    return true;
  }

  // 2. Token-based synonym/meaningless body check
  const genericWords = new Set([
    'bump', 'bumps', 'bumped',
    'update', 'updates', 'updated',
    'upgrade', 'upgrades', 'upgraded',
    'newest', 'latest', 'new', 'old', 'current', 'currently', 'recent', 'available',
    'from', 'to', 'the', 'a', 'an', 'and', 'or', 'in', 'of', 'for', 'with', 'by', 'on', 'at', 'it', 'its',
    'version', 'versions', 'v', 'cli', 'package', 'packages', 'release', 'releases', 'revision', 'revisions',
    // Qualifiers that describe the kind of release without saying what changed
    'upstream', 'downstream', 'stable', 'maintenance', 'point', 'minor', 'major',
    'bugfix', 'bugfixes', 'hotfix', 'hotfixes', 'fix', 'fixes', 'bug', 'bugs',
    'source', 'sources', 'tarball', 'changes', 'changelog',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
    'about', 'again', 'all', 'any', 'both', 'each', 'few', 'more', 'other', 'some', 'such', 'than', 'too', 'very',
    'just', 'only', 'then', 'here', 'there', 'when', 'where', 'why', 'how', 'this'
  ]);

  const pkgWords = new Set();
  if (pkgName) {
    pkgWords.add(pkgName.toLowerCase());
    pkgName.toLowerCase().split(/[-_]/).forEach(w => {
      if (w) pkgWords.add(w);
    });
  }

  // Split body into lowercase alphanumeric tokens
  const bodyTokens = body.toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, '') // Keep dots and hyphens/dashes for version numbers or compound words
    .split(/\s+/);

  let hasMeaningfulWord = false;
  for (let token of bodyTokens) {
    token = token.trim();
    if (!token) continue;
    // Strip trailing period or comma from token
    token = token.replace(/[.,]$/, '');
    
    if (pkgWords.has(token)) continue;
    if (genericWords.has(token)) continue;
    // Check if version number (e.g. 29.6.1, v2.0, 2026.27, etc.)
    if (/^v?\d+(?:[.-]\d+)*$/.test(token)) continue;

    // If it is any other word, it is considered meaningful
    hasMeaningfulWord = true;
    break;
  }

  return !hasMeaningfulWord;
}

// `git revert` builds the subject from the reverted commit verbatim as
// `Revert "<original subject>"`, reverting a revert nests the wrapper another
// level, and OpenWrt also uses a prefixed `<pkg>: Revert "<original>"` variant.
// None of these can satisfy the regular subject rules - the package prefix sits
// inside the quotes, `Revert` is capitalized, and the wrapper eats into the
// length budget - and the author cannot rewrite the quoted part without losing
// the reference to the commit being reverted.
// Returns { prefix, original, depth } for a revert subject, null otherwise.
export function parseRevertSubject(subject) {
  if (typeof subject !== 'string') return null;

  // `(?:<name>: )*` also covers `tools/cmake: ` and chained `toolchain: binutils: ` prefixes.
  const outer = subject.trim().match(new RegExp(`^((?:${SUBJECT_PREFIX_SOURCE})*)[Rr]evert "(.+)"$`));
  if (!outer) return null;

  let original = outer[2];
  let depth = 1;
  let nested;
  while ((nested = original.match(/^[Rr]evert "(.+)"$/))) {
    original = nested[1];
    depth++;
  }

  return { prefix: outer[1], original, depth };
}

// Besides the subject, `git revert` records the commit being undone in the body
// as `This reverts commit <sha>.`; the revert button on GitHub references the
// reverted pull request instead. Requiring one of the two ties the relaxed
// revert rules to a commit that really is a revert, rather than to any subject
// that happens to be shaped like one.
export function hasRevertReference(body) {
  if (typeof body !== 'string') return false;
  return /^\s*this reverts commit\s+[0-9a-f]{7,40}\b/im.test(body) ||
    /^\s*reverts\s+[\w.-]+\/[\w.-]+#\d+\s*$/im.test(body);
}

// Returns { prefix, original, depth } when a full commit message is a revert -
// its subject and its body both have to say so - and null otherwise.
export function parseRevertCommit(message) {
  if (typeof message !== 'string') return null;

  const lines = message.split('\n');
  if (!hasRevertReference(lines.slice(1).join('\n'))) return null;

  return parseRevertSubject(lines[0].trim().replace(/^(fixup!|squash!)\s+/, ''));
}

async function getSshKeyFingerprint(sigText) {
  try {
    let cleanSig = sigText.replace(/-----[a-zA-Z0-9\s]+-----/g, '');
    cleanSig = cleanSig.replace(/[^a-zA-Z0-9+\/=]/g, '');

    const binaryString = atob(cleanSig);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    if (bytes[0] !== 0x53 || bytes[1] !== 0x53 || bytes[2] !== 0x48 || 
        bytes[3] !== 0x53 || bytes[4] !== 0x49 || bytes[5] !== 0x47) {
      return null;
    }

    const pubKeyLen = (bytes[10] << 24) | (bytes[11] << 16) | (bytes[12] << 8) | bytes[13];
    if (pubKeyLen <= 0 || pubKeyLen + 14 > bytes.length) {
      return null;
    }

    const pubKeyBlob = bytes.slice(14, 14 + pubKeyLen);
    const hashBuffer = await crypto.subtle.digest("SHA-256", pubKeyBlob);
    const hashBytes = new Uint8Array(hashBuffer);

    let binaryHash = '';
    for (let i = 0; i < hashBytes.length; i++) {
      binaryHash += String.fromCharCode(hashBytes[i]);
    }
    return btoa(binaryHash).replace(/=+$/, '');
  } catch (e) {
    return null;
  }
}

// Body lines that carry verbatim terminal output, which must never be
// re-wrapped to satisfy the width limit. One space of indent is deliberately
// not enough: single-space bullets are how contributors write ordinary prose
// lists, and those should wrap like any other prose.
const VERBATIM_LINE_PATTERNS = [
  /^(?:\t| {2,})/,            // quoted material indented with a tab or 2+ spaces
  /^\S+:\d+(?::\d+)?: /,      // compiler/linker diagnostic: file.c:12:34: error: ...
  /^\[ *\d+\.\d+\] /,         // kernel log timestamp: [   10.933640] ...
  /^make(?:\[\d+\])?: /,      // make output: make[3]: *** ...
  /^[$#] /,                   // shell prompt / git bisect transcript
  /^Fixes: [0-9a-f]{7,40}\b/  // Fixes: <sha> ("...") — never wrapped, per git convention
];

// --- ENGINE CHECKS ---
export async function validateFormalities(fullCommit, CONFIG) {
  const errors = [];
  const successes = [];
  const warnings = [];

  const commit = fullCommit.commit;
  const message = commit.message || '';

  const authorName = commit.author?.name || '';
  const authorEmail = commit.author?.email || '';
  const committerName = commit.committer?.name || '';
  const committerEmail = commit.committer?.email || '';

  if (!message.trim()) {
    return { errors: ["- Commit message is completely empty"], successes: [], warnings: [] };
  }

  const lines = message.split("\n");
  let subject = lines[0].trim();

  // Commits made through GitHub's web interface (file editor, "Commit
  // suggestion", "Update branch") are committed as `GitHub <noreply@github.com>`
  // on the user's behalf. GitHub resolves that committer to its own `web-flow`
  // account, which the API reports and a local git config cannot claim, so
  // prefer it and fall back to the identity itself when the account is absent.
  const isGitHubWebCommit = fullCommit.committer?.login === 'web-flow' ||
    (committerName === 'GitHub' && committerEmail === 'noreply@github.com');

  // Identity Check
  const identityErrors = [];
  if (!isValidName(authorName)) identityErrors.push(`Author name format is invalid ('${authorName}'). Please set your full name (first and last, e.g. 'Jane Doe').`);
  // The committer of a web commit is GitHub itself, so its name and email say
  // nothing about the contributor and cannot be corrected by them either.
  if (!isGitHubWebCommit && !isValidName(committerName)) identityErrors.push(`Committer name format is invalid ('${committerName}'). Please set your full name (first and last, e.g. 'Jane Doe').`);
  if (CONFIG.check_noreply_email) {
    if (isNoreplyEmail(authorEmail)) identityErrors.push(`Author email must not be a GitHub noreply address ('${authorEmail}'). Please use a real email address that is linked to your GitHub account.`);
    if (!isGitHubWebCommit && isNoreplyEmail(committerEmail)) identityErrors.push(`Committer email must not be a GitHub noreply address ('${committerEmail}'). Please use a real email address that is linked to your GitHub account.`);
  }
  if (CONFIG.require_linked_github_account && CONFIG.require_linked_github_account !== 'disabled') {
    if (!fullCommit.author || !fullCommit.author.login) {
      const msg = `Commit author email '${authorEmail}' is not linked to any registered GitHub account. Please add and verify this email in your GitHub profile settings.`;
      if (CONFIG.require_linked_github_account === 'warning') {
        warnings.push(msg);
      } else {
        identityErrors.push(msg);
      }
    }
  }

  if (identityErrors.length === 0) {
    successes.push(isGitHubWebCommit
      ? "✅ Author identity is valid (committed through the GitHub web interface)"
      : "✅ Author and committer identities are valid");
  } else {
    identityErrors.forEach(err => errors.push("- " + err));
  }

  // Merge commits check
  if (CONFIG.check_merge_commits) {
    if ((fullCommit.parents || []).length > 1) {
      errors.push("- Merge commits are not allowed within the pull request");
    } else {
      successes.push("✅ Commit is not a merge commit");
    }
  }

  // Subject layout checks
  const subjectErrors = [];
  let isAutosquash = false;
  if (CONFIG.allow_autosquash && /^(fixup!|squash!)\s+/.test(subject)) {
    isAutosquash = true;
    subject = subject.replace(/^(fixup!|squash!)\s+/, '');
  }

  const revert = CONFIG.allow_revert === false ? null : parseRevertCommit(message);

  if (!isAutosquash) {
    if (/^\s/.test(lines[0])) subjectErrors.push("Commit subject must not start with whitespace");

    // Subject, blank line, then the description: without the separator, git
    // and every tool reading the log treat the whole first paragraph as one
    // overlong subject.
    if (lines.length > 1 && lines[1].trim() !== '') {
      subjectErrors.push("Commit subject must be followed by a blank line separating it from the description body");
    }

    // The quoted part of a revert subject is copied from the reverted commit,
    // so the prefix/lower-case/period rules apply to the original subject and
    // not to the wrapper `git revert` generated around it.
    if (!revert) {
      // The prefix is a package name (`bash: `) or a source tree path with
      // subdirectories (`tools/cmake: `, `toolchain/musl: `) - openwrt.git
      // history uses both shapes, so any of them satisfies the prefix rule.
      if (!SUBJECT_PREFIX_RE.test(subject)) {
        subjectErrors.push("Commit subject must start with `<package name or prefix>: `");
      } else {
        const afterPrefix = subject.replace(SUBJECT_PREFIX_STRIP_RE, '');
        if (afterPrefix.length > 0 && afterPrefix[0] === afterPrefix[0].toUpperCase() && /[a-zA-Z]/.test(afterPrefix[0])) {
          subjectErrors.push("Commit subject must start with a lower-case word after the prefix");
        }
        if (subject.endsWith('.')) {
          subjectErrors.push("Commit subject must not end with a period");
        }
      }
    }
  }

  // Measure a revert against the subject underneath the `Revert "..."` wrapper:
  // the wrapper is generated from the reverted commit, so the author cannot
  // shorten it without breaking the reference. Everything else is measured on
  // the normalized subject, so an `fixup!`/`squash!` marker that disappears on
  // autosquash does not eat into the budget of the subject it is applied to.
  const subjectLen = revert ? (revert.prefix + revert.original).length : subject.length;
  const lenSuffix = revert ? ' chars, excluding the `Revert "..."` wrapper' : ' chars';
  if (subjectLen > CONFIG.max_subject_len_hard) {
    subjectErrors.push(`Subject line exceeds hard limit (${subjectLen}/${CONFIG.max_subject_len_hard}${lenSuffix})`);
  } else if (subjectLen > CONFIG.max_subject_len_soft) {
    warnings.push(`Subject line exceeds soft limit (${subjectLen}/${CONFIG.max_subject_len_soft}${lenSuffix})`);
  }

  // A subject shaped like a revert but without the reference in the body is held
  // to the regular rules. Say why, because the prefix and lower-case complaints
  // that follow from the `Revert "..."` wrapper do not point at what is missing.
  if (subjectErrors.length > 0 && !revert && CONFIG.allow_revert !== false && parseRevertSubject(subject)) {
    subjectErrors.push('Subject is formatted as a revert, but the body does not reference the reverted commit. Keep the `This reverts commit <sha>.` line that `git revert` generates, or reword the subject to follow the regular `<package name or prefix>: ` format');
  }

  if (subjectErrors.length === 0) {
    if (revert) {
      successes.push(`✅ Commit subject layout and length are valid (revert of "${revert.original}")`);
    } else {
      successes.push(`✅ Commit subject layout and length are valid: "${lines[0]}"`);
    }
  } else {
    subjectErrors.forEach(err => errors.push("- " + err));
  }

  // Description Quality Warnings
  const bodyLines = lines.slice(1);
  const cleanBodyLines = [];
  bodyLines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed === '' || /^(signed-off-by:|\(?cherry[ -]picked from)/i.test(trimmed)) {
      return;
    }
    cleanBodyLines.push(trimmed);
  });
  const fullCleanBody = cleanBodyLines.join(" ");

  // Require meaningful commit body (not just trailers)
  if (CONFIG.require_body && fullCleanBody.length === 0) {
    errors.push("- Commit description body is empty or contains only trailers (e.g. Signed-off-by). Please provide a meaningful description of what this change does and why");
  }

  // Imperative mood: the guidelines ask for "add support for X", not
  // "added support for X". Only forms that map cleanly back to an
  // imperative are flagged, so the warning can always say what to write
  // instead; anything ambiguous passes silently.
  if (CONFIG.warn_imperative_mood && !isAutosquash && !revert) {
    const NON_IMPERATIVE = {
      added: 'add', adding: 'add',
      fixed: 'fix', fixing: 'fix',
      updated: 'update', updating: 'update',
      bumped: 'bump', bumping: 'bump',
      upgraded: 'upgrade', upgrading: 'upgrade',
      removed: 'remove', removing: 'remove',
      dropped: 'drop', dropping: 'drop',
      changed: 'change', changing: 'change',
      moved: 'move', moving: 'move',
      renamed: 'rename', renaming: 'rename',
      switched: 'switch', switching: 'switch',
      improved: 'improve', improving: 'improve',
      corrected: 'correct', correcting: 'correct',
      reworked: 'rework', reworking: 'rework',
      refactored: 'refactor', refactoring: 'refactor',
      introduced: 'introduce', introducing: 'introduce',
      implemented: 'implement', implementing: 'implement',
      enabled: 'enable', enabling: 'enable',
      disabled: 'disable', disabling: 'disable',
      replaced: 'replace', replacing: 'replace'
    };
    const afterPrefix = subject.replace(/^(?:[a-zA-Z0-9_/-]+: )+/, '');
    const firstWord = (afterPrefix.match(/^[A-Za-z]+/) || [''])[0].toLowerCase();
    const imperative = NON_IMPERATIVE[firstWord];
    if (imperative) {
      warnings.push(`Subject should use the imperative mood: write '${imperative} ...', not '${firstWord} ...' (e.g. "add support for X", not "added support for X").`);
    }
  }

  // Generic phrase checking
  if (CONFIG.warn_generic_subjects) {
    const genericPatterns = [
      /update to latest version/i, /bump to latest/i,
      /minor update/i, /fix bugs/i
    ];
    for (const pattern of genericPatterns) {
      if (pattern.test(lines[0])) {
        warnings.push(`Subject uses generic phrase matching '${pattern.source}'. Please specify explicitly what changed.`);
        break;
      }
    }
  }

  if (fullCleanBody.length > 0) {
    if (CONFIG.warn_duplicate_body) {
      const pkgPrefixMatch = lines[0].match(/^([a-zA-Z0-9_-]+):/);
      const pkgName = pkgPrefixMatch ? pkgPrefixMatch[1] : '';

      if (isVirtuallyIdentical(lines[0], fullCleanBody, pkgName)) {
        warnings.push("Commit subject and description body are identical or virtually identical. Avoid repeating the subject line in the body; provide context instead.");
      }
    }
    if (CONFIG.require_release_notes && !/https?:\/\/[^\s]+/i.test(fullCleanBody)) {
      warnings.push("No reference link (e.g., upstream release notes, changelog, or history URL) detected in description.");
    }
  }

  // OpenWrt spelling capitalization check
  if (CONFIG.check_openwrt_spelling) {
    const incorrectCasingPattern = /\bopenwrt\b/gi;
    let foundIncorrect = null;
    let spellingInCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (i > 0) {
        if (trimmed.startsWith('```')) {
          spellingInCodeBlock = !spellingInCodeBlock;
          continue;
        }
        if (spellingInCodeBlock) {
          continue;
        }
        if (/^(signed-off-by:|\(?cherry[ -]picked from)/i.test(trimmed)) {
          continue;
        }
      }

      // Remove URLs to avoid false positives inside links
      const lineWithoutUrls = line.replace(/[a-zA-Z]+:\/\/\S+/g, '');

      let match;
      while ((match = incorrectCasingPattern.exec(lineWithoutUrls)) !== null) {
        const word = match[0];
        if (word !== 'OpenWrt' && word !== 'openwrt') {
          foundIncorrect = word;
          break;
        }
      }
      if (foundIncorrect) {
        break;
      }
    }

    if (foundIncorrect) {
      warnings.push(`Incorrect capitalization of 'OpenWrt' detected: '${foundIncorrect}'. Please use the correct spelling 'OpenWrt' (or lowercase 'openwrt' where appropriate).`);
    }
  }

  // Body lines width check
  const bodyErrors = [];
  let inCodeBlock = false;
  lines.forEach((line, index) => {
    if (index === 0) return;
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      return;
    }
    if (inCodeBlock) {
      return;
    }
    if (/[a-zA-Z]+:\/\/\S+/.test(line)) {
      return;
    }
    if (line.length > CONFIG.max_body_line_len) {
      // A line whose overflow comes from a single unbreakable token — a file
      // path, a kernel symbol, a checksum — cannot be wrapped under the limit
      // no matter where it breaks. Verbatim build logs and error messages
      // ('ERROR: module .../ip6_tables.ko is missing.') are quoted exactly so
      // they stay searchable, and inserting a break inside the token would
      // corrupt what it quotes.
      const hasUnbreakableToken = line.trim().split(/\s+/).some(token => token.length > CONFIG.max_body_line_len);
      // Verbatim terminal output must not be re-wrapped even when its words
      // are short. These shapes cover what openwrt/openwrt contributors
      // actually paste (measured over the repo's full history): material
      // quoted with an indent, compiler/linker diagnostics, kernel log
      // lines, make output, shell or bisect transcripts, and 'Fixes:'
      // references, which git convention forbids wrapping.
      const looksVerbatim = VERBATIM_LINE_PATTERNS.some(pattern => pattern.test(line));
      if (!hasUnbreakableToken && !looksVerbatim) {
        bodyErrors.push(`Line ${index + 1} in commit body exceeds max width (${line.length}/${CONFIG.max_body_line_len} chars)`);
      }
    }
  });
  if (bodyErrors.length === 0) {
    successes.push("✅ Commit description lines adhere to width formatting rules");
  } else {
    bodyErrors.forEach(err => errors.push("- " + err));
  }

  // Signed-off-by check
  if (CONFIG.check_signoff) {
    const signoffPattern = /Signed-off-by:\s*([^<]+)\s*<([^>]+)>/i;
    let hasSignoff = false;
    const signoffEntries = [];
    const noreplyErrors = [];
    lines.forEach(line => {
      const matches = line.match(signoffPattern);
      if (matches) {
        hasSignoff = true;
        const entry = {
          name: matches[1].trim(),
          email: matches[2].trim()
        };
        signoffEntries.push(entry);
        if (isNoreplyEmail(entry.email)) {
          noreplyErrors.push(`Signed-off-by email must not be a GitHub noreply address ('${entry.email}'). Please use a real email address that is linked to your GitHub account.`);
        }
      }
    });
    if (!hasSignoff) {
      errors.push("- Missing 'Signed-off-by:' line. Please add a line at the end of the commit message in the format 'Signed-off-by: Your Name <your@email.com>', matching your commit author or committer identity.");
    } else {
      const signoffErrors = [];

      // Check that at least one Signed-off-by matches the commit author
      const authorMatch = signoffEntries.some(entry =>
        entry.name.toLowerCase() === authorName.toLowerCase() &&
        entry.email.toLowerCase() === authorEmail.toLowerCase()
      );

      // Check that at least one Signed-off-by matches the commit committer.
      // A web commit's committer is GitHub itself, so nobody can sign off as it.
      const committerMatch = !isGitHubWebCommit && signoffEntries.some(entry =>
        entry.name.toLowerCase() === committerName.toLowerCase() &&
        entry.email.toLowerCase() === committerEmail.toLowerCase()
      );

      // After a rebase, the committer changes but the original author's SOB
      // remains valid. Require at least one SOB matching author OR committer.
      if (!authorMatch && !committerMatch) {
        // Naming the committer in the error only helps when signing off as the
        // committer is an option at all: not on a web commit, and not when the
        // committer is the author anyway.
        const authorIsOnlyOption = isGitHubWebCommit ||
          (authorName.toLowerCase() === committerName.toLowerCase() &&
           authorEmail.toLowerCase() === committerEmail.toLowerCase());
        if (authorIsOnlyOption) {
          signoffErrors.push(`No Signed-off-by matches commit author (\`${authorName} <${authorEmail}>\`). Please add a 'Signed-off-by: ${authorName} <${authorEmail}>' line that matches this name and email exactly.`);
        } else {
          signoffErrors.push(`No Signed-off-by matches commit author (\`${authorName} <${authorEmail}>\`) or committer (\`${committerName} <${committerEmail}>\`). Please add a 'Signed-off-by:' line matching either identity exactly (name and email).`);
        }
      }

      // Add noreply errors
      noreplyErrors.forEach(err => signoffErrors.push(err));

      // If there are multiple SOB entries but none matched, provide a helpful hint
      if (signoffEntries.length > 1 && !authorMatch && !committerMatch) {
        const sobList = signoffEntries.map(e => `\`${e.name} <${e.email}>\``).join(', ');
        signoffErrors.push(`Found Signed-off-by entries: ${sobList}`);
      }

      if (signoffErrors.length > 0) {
        signoffErrors.forEach(err => errors.push("- " + err));
      } else {
        successes.push("✅ Commit contains a valid 'Signed-off-by:' line matching author or committer");
      }
    }
  }

  // Signature check
  if (CONFIG.check_signature) {
    const verification = fullCommit.commit.verification || {};
    if (verification.verified === true) {
      let keyDetails = "";
      const reason = verification.reason || '';
      const sigText = verification.signature || '';

      if (verification.key_id) {
        keyDetails = ` (GPG Key ID: ${verification.key_id})`;
      } else if (sigText.includes('SSH SIGNATURE')) {
        const fingerprint = await getSshKeyFingerprint(sigText);
        if (fingerprint) {
          keyDetails = ` (SSH Key Fingerprint: SHA256:${fingerprint})`;
        } else {
          keyDetails = " (Verified via SSH)";
        }
      } else if (reason === 'valid' || reason === 'valid_signature') {
        keyDetails = " (Verified via GitHub Profile)";
      }
      successes.push("✅ Excellent! Commit contains a valid cryptographic signature (GPG/SSH). Thank you for signing your work!" + keyDetails);
    } else {
      const reason = verification.reason || 'unsigned';
      warnings.push(`Commit is unsigned or cryptographic signature verification failed (Reason: ${reason}). Signing commits is a recommended best practice for verifying identity, but is not mandatory.`);
    }
  }

  return { errors, successes, warnings };
}

export function matchVersionString(subject, version) {
  if (subject.includes(version)) return true;

  try {
    const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = version.split(/([0-9]+)/);
    const pattern = parts.map(part => {
      if (/^[0-9]+$/.test(part)) {
        return `0*${parseInt(part, 10)}`;
      } else {
        return escapeRegExp(part);
      }
    }).join('');

    const regex = new RegExp(`(?<![0-9])${pattern}(?![0-9])`);
    return regex.test(subject);
  } catch (e) {
    return false;
  }
}

// PKG_LICENSE holds SPDX identifiers, and every judgement below is made
// against the official SPDX license list shipped in ./spdx-licenses.js -
// nothing here is hand-maintained guesswork. A suggestion is only ever
// offered after it has been confirmed to be a real identifier.
const SPDX_ID_BY_LOWERCASE = new Map();
for (const id of SPDX_LICENSE_IDS) {
  SPDX_ID_BY_LOWERCASE.set(id.toLowerCase(), id);
}

const quoteList = (ids) => ids.map(id => `'${id}'`).join(' or ');

// A bare version reads as either the -only or the -or-later variant, so both
// are offered; a '+' suffix says -or-later on its own.
function versionedSuggestions(family, version, orLater) {
  const wanted = orLater
    ? [`${family}-${version}-or-later`]
    : [`${family}-${version}-only`, `${family}-${version}-or-later`];
  const real = wanted.filter(id => SPDX_LICENSE_IDS.has(id));
  return real.length > 0 ? quoteList(real) : null;
}

// Returns null for a valid identifier, otherwise { reason, suggestion }.
// `suggestion` may be null when SPDX retired an id without a successor and
// nothing can honestly be recommended in its place.
export function checkSpdxIdentifier(token) {
  // 'LicenseRef-...' is how SPDX names a license it does not list, so a
  // proprietary or vendor license spelled that way is already correct.
  if (SPDX_LICENSE_IDS.has(token) || SPDX_EXCEPTION_IDS.has(token) || /^LicenseRef-/i.test(token)) {
    return null;
  }

  if (SPDX_DEPRECATED.has(token)) {
    const replacement = SPDX_DEPRECATED.get(token);
    return {
      reason: 'is deprecated by SPDX',
      suggestion: replacement ? quoteList(replacement.split(' or ')) : null
    };
  }

  // Right identifier, wrong capitalization (e.g. 'BSD-2-clause').
  const exact = SPDX_ID_BY_LOWERCASE.get(token.toLowerCase());
  if (exact) {
    return { reason: 'is written with the wrong capitalization', suggestion: `'${exact}'` };
  }

  // Informal GPL-family spellings: GPLv2, GPL2, LGPLv2.1+, AGPLv3, GPL-2 ...
  const informal = token.match(/^([AaLl]?[Gg][Pp][Ll])[\s_-]*v?(\d)(\.\d+)?(\+)?$/);
  if (informal) {
    const family = informal[1].toUpperCase();
    const version = `${informal[2]}${informal[3] || '.0'}`;
    const suggestion = versionedSuggestions(family, version, !!informal[4]);
    if (suggestion) {
      return { reason: 'is not an SPDX identifier', suggestion };
    }
  }

  // 'GPL-2.0-or-later-with-Autoconf-exception-2.0' spells with a hyphen what
  // SPDX joins with the WITH operator.
  const withExc = token.match(/^(.+?)-with-(.+)$/i);
  if (withExc) {
    const base = SPDX_ID_BY_LOWERCASE.get(withExc[1].toLowerCase());
    const exception = [...SPDX_EXCEPTION_IDS].find(id => id.toLowerCase() === withExc[2].toLowerCase());
    if (base && exception) {
      return { reason: 'is not an SPDX identifier', suggestion: `'${base} WITH ${exception}'` };
    }
  }

  // '-later' instead of '-or-later', a common slip.
  if (/-later$/.test(token)) {
    const fixed = token.replace(/-later$/, '-or-later');
    if (SPDX_LICENSE_IDS.has(fixed)) {
      return { reason: 'is not an SPDX identifier', suggestion: `'${fixed}'` };
    }
  }

  // Slash-joined pairs such as 'MIT/X11' name two identifiers at once.
  if (token.includes('/')) {
    const parts = token.split('/').map(p => SPDX_ID_BY_LOWERCASE.get(p.toLowerCase())).filter(Boolean);
    if (parts.length > 0) {
      return {
        reason: 'is not an SPDX identifier',
        suggestion: `${quoteList(parts)} (one identifier per license, joined with OR when a package really is dual-licensed)`
      };
    }
  }

  // A license family without the variant that SPDX actually names.
  const families = {
    bsd: ['BSD-3-Clause', 'BSD-2-Clause'],
    apache: ['Apache-2.0'],
    lgpl: ['LGPL-2.1-or-later', 'LGPL-3.0-or-later'],
    gpl: ['GPL-2.0-or-later', 'GPL-3.0-or-later'],
    mpl: ['MPL-2.0'],
    zlib: ['Zlib'],
    'public-domain': ['CC0-1.0', 'Unlicense'],
    publicdomain: ['CC0-1.0', 'Unlicense'],
    'public domain': ['CC0-1.0', 'Unlicense']
  };
  const family = families[token.toLowerCase()];
  if (family) {
    const real = family.filter(id => SPDX_LICENSE_IDS.has(id));
    if (real.length > 0) {
      return { reason: 'names a license family rather than an SPDX identifier', suggestion: quoteList(real) };
    }
  }

  return { reason: 'is not a known SPDX identifier', suggestion: null };
}

// Trees whose Makefiles describe build infrastructure instead of a software
// package: `target/` holds target/subtarget and image definitions, `tools/` and
// `toolchain/` host-side build helpers. None of them carry PKG_MAINTAINER,
// PKG_LICENSE or PKG_LICENSE_FILES, so adding such a Makefile must not be
// reported as a new package missing its mandatory metadata.
const NON_PACKAGE_MAKEFILE_ROOTS = new Set(['target', 'tools', 'toolchain']);

export function isPackageMakefilePath(filePath) {
  if (!filePath) return false;
  const normalized = filePath.trim().replace(/^\.\//, '');
  if (normalized !== 'Makefile' && !normalized.endsWith('/Makefile')) return false;

  const parts = normalized.split('/');
  // The top-level Makefile is the build system entry point, not a package.
  if (parts.length === 1) return false;
  if (NON_PACKAGE_MAKEFILE_ROOTS.has(parts[0])) return false;
  return true;
}

// Collect the Makefiles a patch adds (`--- /dev/null`) or removes
// (`+++ /dev/null`), dropping the build-infrastructure paths rejected by
// isPackageMakefilePath(). Everything else counts as a package Makefile, so
// unlisted infrastructure trees are still reported as new/dropped packages.
function collectPackageMakefiles(commitPatch, direction) {
  const regex = direction === 'added'
    ? /^---\s+\/dev\/null\r?\n\+\+\+\s+b\/(.*)\r?$/gm
    : /^---\s+a\/(.*)\r?\n\+\+\+\s+\/dev\/null\r?$/gm;

  const paths = [];
  let match;
  while ((match = regex.exec(commitPatch)) !== null) {
    const filePath = match[1].trim();
    if (isPackageMakefilePath(filePath)) {
      paths.push(filePath);
    }
  }
  return paths;
}

// The only repository where a package's own DEFAULT assignment is allowed to
// pull it into buildbot default images; everywhere else (feeds) that
// decision belongs to the main repo, not the package itself.
const MAIN_REPO_FULLNAME = 'openwrt/openwrt';

// GitHub treats owner/repo case-insensitively, so normalise both sides. The
// constant is lowercase today, but nothing stops a later edit from spelling it
// OpenWrt/OpenWrt and silently exempting nobody. An absent value counts as
// "not the main repo" (fail towards reporting) rather than skipping the check.
function isMainRepo(repoFullname) {
  return typeof repoFullname === 'string' &&
    repoFullname.toLowerCase() === MAIN_REPO_FULLNAME.toLowerCase();
}

export function validateMakefileContext(fullCommit, commitPatch, CONFIG, state, repoFullname) {
  const errors = [];
  const successes = [];
  const warnings = [];
  const subject = (fullCommit.commit.message || '').split("\n")[0].trim();

  if (!commitPatch) {
    return { errors: [], successes: ["✅ No codebase text files changed to analyze"], warnings: [] };
  }

  let isNewPackageThisCommit = false;
  if (collectPackageMakefiles(commitPatch, 'added').length > 0) {
    state.isNewPackage = true;
    isNewPackageThisCommit = true;
  }

  if (collectPackageMakefiles(commitPatch, 'removed').length > 0) {
    state.isDroppedPackage = true;
  }

  // Every Makefile check below wants the same thing: the patch split per file,
  // narrowed to Makefiles, split into lines. Compute it once (lazily, so
  // configurations with all Makefile checks off pay nothing) instead of
  // re-scanning the whole patch once per enabled check.
  let cachedMakefileChunks = null;
  const getMakefileChunks = () => {
    if (cachedMakefileChunks !== null) return cachedMakefileChunks;
    cachedMakefileChunks = [];
    for (const fileDiff of commitPatch.split(/^diff --git /m)) {
      const fileMatch = fileDiff.match(/^\+\+\+\s+b\/(.*)$/m);
      if (!fileMatch) continue;
      const filePath = fileMatch[1].trim();
      if (!filePath.endsWith('/Makefile') && filePath !== 'Makefile') continue;
      cachedMakefileChunks.push({ filePath, lines: fileDiff.split('\n') });
    }
    return cachedMakefileChunks;
  };

  if (CONFIG.check_pkg_version) {
    // Judge each changed Makefile on its own instead of taking the first
    // PKG_VERSION line in the whole patch: a commit that bumps two packages
    // used to have only its first bump validated, and one new package
    // anywhere in the PR used to switch the check off for every commit.
    const cleanSubject = subject.replace(/^(fixup!|squash!)\s+/, '');
    // A fixup's subject is dictated by the commit it amends, so it cannot
    // name the version it introduces; the pair is squashed before merging.
    const isAutosquash = CONFIG.allow_autosquash && /^(fixup!|squash!)\s+/.test(subject);
    const isRevert = CONFIG.allow_revert !== false && parseRevertCommit(fullCommit.commit.message || '') !== null;

    for (const fileDiff of commitPatch.split(/^diff --git /m)) {
      const fileMatch = fileDiff.match(/^\+\+\+\s+b\/(.*)$/m);
      if (!fileMatch) continue;
      const filePath = fileMatch[1].trim();
      if (!filePath.endsWith('/Makefile') && filePath !== 'Makefile') continue;
      // A brand-new Makefile is a package addition, not a version bump: its
      // subject says what is added and carries no old-to-new version context.
      if (/^---\s+\/dev\/null/m.test(fileDiff)) continue;

      const versionMatch = fileDiff.match(/^\+\s*PKG_VERSION\s*(?::=|=)\s*(.+)$/m);
      if (!versionMatch) continue;
      const newVersion = versionMatch[1].replace(/["']/g, "").trim();

      if (newVersion.includes('$')) {
        successes.push(`✅ PKG_VERSION is dynamically defined: '${newVersion}', skipping subject validation`);
      } else if (isRevert) {
        // A revert restores the PKG_VERSION that preceded the reverted commit,
        // while its subject quotes that commit (and therefore the version being
        // undone). Requiring the restored version here would force the author
        // away from the `git revert` subject format.
        successes.push(`✅ Commit reverts a previous change, skipping subject validation for restored PKG_VERSION '${newVersion}'`);
      } else if (isAutosquash) {
        successes.push(`✅ Autosquash commit, skipping subject validation for PKG_VERSION '${newVersion}'`);
      } else if (!matchVersionString(cleanSubject, newVersion)) {
        errors.push(`- Makefile introduces PKG_VERSION '${newVersion}', but this version string is missing in the commit subject line. Please mention the new version in the subject, e.g. '<package>: update to ${newVersion}'.`);
      } else {
        successes.push(`✅ PKG_VERSION bump matches context information inside subject line (${newVersion})`);
      }
    }
  }

  if (CONFIG.check_openwrt_meta) {
    let requiredMeta = ['PKG_MAINTAINER', 'PKG_LICENSE', 'PKG_LICENSE_FILES'];
    if (Array.isArray(CONFIG.check_openwrt_meta)) {
      requiredMeta = CONFIG.check_openwrt_meta;
    }
    if (isNewPackageThisCommit) {
      // Detect if the Makefile includes a known .mk file that defines PKG_LICENSE
      // and PKG_LICENSE_FILES centrally (e.g. trusted-firmware-a.mk, u-boot.mk).
      // In those cases, we should not require PKG_LICENSE / PKG_LICENSE_FILES directly.
      const knownLicenseIncludeFiles = ['trusted-firmware-a.mk', 'u-boot.mk'];
      const hasLicenseInclude = knownLicenseIncludeFiles.some(mkFile =>
        new RegExp(`^\\+.*include.*${mkFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(commitPatch)
      );
      if (hasLicenseInclude) {
        requiredMeta = requiredMeta.filter(meta => meta !== 'PKG_LICENSE' && meta !== 'PKG_LICENSE_FILES');
      }
      // LuCI packages generate their package block in luci.mk: the emitted
      // maintainer always comes from LUCI_MAINTAINER (defaulting to the LuCI
      // community), and apps carry an SPDX header instead of a license file.
      // PKG_LICENSE is still read by the build system and stays required.
      if (/^\+\s*include\s+.*\bluci\.mk/m.test(commitPatch)) {
        requiredMeta = requiredMeta.filter(meta => meta !== 'PKG_MAINTAINER' && meta !== 'PKG_LICENSE_FILES');
      }
      requiredMeta.forEach(meta => {
        const metaRegex = new RegExp(`^\\+\\s*${meta}\\s*(?::=|=)`, 'm');
        if (!metaRegex.test(commitPatch)) {
          errors.push(`- New OpenWrt package is missing the mandatory parameter: '${meta}'`);
        } else {
          successes.push(`✅ Mandatory structural metadata present: '${meta}'`);
        }
      });
    }

    const maintainerLines = commitPatch.split('\n').filter(line => line.startsWith('+') && line.includes('PKG_MAINTAINER'));
    for (const line of maintainerLines) {
      const match = line.match(/^\+\s*PKG_MAINTAINER\s*(?::=|=)\s*(.+)$/);
      if (match) {
        const value = match[1].trim();
        const emails = (value.match(/<([^>]+)>/g) || []).map(m => m.slice(1, -1).trim());
        if (emails.length === 0) {
          errors.push(`- PKG_MAINTAINER format is invalid; it should contain an email address inside angle brackets '<>'`);
        } else {
          for (const email of emails) {
            if (email.includes('://') || email.includes('http') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
              errors.push(`- PKG_MAINTAINER contains an invalid email address: '${email}'. In angle brackets '<>' must be a valid email address and not a website/URL.`);
            } else {
              successes.push(`✅ PKG_MAINTAINER email address format is valid: '${email}'`);
            }
          }
        }
      }
    }
  }

  if (CONFIG.check_spdx_license) {
    // `+=` counts too: multi-license packages append identifiers that way.
    // Trailing `#` comments are not part of the license expression.
    const licenseLineRegex = /^\+\s*PKG_LICENSE\s*(?::=|\+=|=)\s*([^#\r\n]+)/gm;
    let licenseChecked = false;
    let licenseWarned = false;
    let licenseMatch;
    while ((licenseMatch = licenseLineRegex.exec(commitPatch)) !== null) {
      const value = licenseMatch[1].replace(/["']/g, '').trim();
      if (value.includes('$')) continue;
      licenseChecked = true;
      // A PKG_LICENSE value is an SPDX expression: identifiers joined by
      // OR/AND/WITH (OpenWrt also space-separates several of them). Judge
      // each identifier on its own.
      for (const rawToken of value.split(/\s+/)) {
        const token = rawToken.replace(/[()]/g, '');
        if (!token || token === '\\' || /^(or|and|with)$/i.test(token)) continue;
        const problem = checkSpdxIdentifier(token);
        if (problem) {
          licenseWarned = true;
          const fix = problem.suggestion
            ? `Use ${problem.suggestion} instead.`
            : 'Pick the matching identifier from https://spdx.org/licenses/, or write it as `LicenseRef-<name>` if this license is not on the SPDX list.';
          warnings.push(`PKG_LICENSE value '${token}' ${problem.reason}. ${fix}`);
        }
      }
    }
    if (licenseChecked && !licenseWarned) {
      successes.push('✅ PKG_LICENSE uses no deprecated or informal SPDX identifiers');
    }
  }

  // OpenWrt init scripts are usually rc.common procedures: rc.common's
  // `enable()` only creates the `/etc/rc.d/S<START><name>` symlink when
  // `START` is set, so a script without it is not started at boot through
  // that path. Which files are init scripts is decided from the path alone,
  // and a package may legitimately install something else there, so both
  // findings are warnings phrased as something to confirm.
  if (CONFIG.check_init_scripts) {
    const fileDiffs = commitPatch.split(/^diff --git /m);
    let initCheckRun = false;
    let initWarned = false;

    for (const fileDiff of fileDiffs) {
      const fileMatch = fileDiff.match(/^\+\+\+\s+b\/(.*)$/m);
      if (!fileMatch) continue;
      const filePath = fileMatch[1].trim();
      // Patches, templates and docs can live under etc/init.d/ paths too -
      // their content is not an init script and must not be judged as one.
      const isInitScript = (/\.init$/.test(filePath) || /\/etc\/init\.d\//.test(filePath)) &&
        !/\.(patch|in|txt|md)$/.test(filePath);
      if (!isInitScript) continue;
      // Only whole new scripts: an edited line of an existing script does not
      // bring its shebang or START= into the diff.
      if (!/^---\s+\/dev\/null/m.test(fileDiff)) continue;

      const addedLines = fileDiff.split('\n')
        .filter(l => l.startsWith('+') && !l.startsWith('+++'))
        .map(l => l.slice(1));
      if (addedLines.length === 0) continue;
      initCheckRun = true;

      if (!/^#!\/bin\/sh \/etc\/rc\.common\s*$/.test(addedLines[0])) {
        initWarned = true;
        warnings.push(`'${filePath}' looks like an init script but does not start with '#!/bin/sh /etc/rc.common' (currently: '${addedLines[0].trim()}'). OpenWrt init scripts normally use rc.common — please confirm this one deliberately uses a different mechanism.`);
      }
      if (!addedLines.some(l => /^START=\d+/.test(l))) {
        initWarned = true;
        warnings.push(`'${filePath}' looks like an init script but defines no 'START=' priority. rc.common only creates the /etc/rc.d boot symlink when START is set, so unless the service is started some other way, add e.g. 'START=95' (and 'STOP=' if shutdown ordering matters).`);
      }
    }

    if (initCheckRun && !initWarned) {
      successes.push('✅ New init scripts declare the rc.common interpreter and a START= priority');
    }
  }

  if (CONFIG.check_conffiles) {
    let conffilesCheckRun = false;
    let conffilesCheckErrors = 0;

    for (const { lines } of getMakefileChunks()) {
      // A diff of an existing Makefile is a window, not the file: the conffiles
      // block usually sits far from the install recipe and never shows up in
      // the hunks, so its absence here proves nothing. Only a newly added
      // Makefile arrives in full, which is where a missing block is real.
      const isAddedMakefile = lines.some(line => /^---\s+\/dev\/null\r?$/.test(line));

      // Pass 1: Collect INSTALL_DIR targets (must be done before conffiles validation
      // since install blocks can appear after conffiles blocks in the diff)
      const installedDirs = new Set();
      for (const line of lines) {
        if (line.startsWith('+')) {
          const contentLine = line.slice(1);
          const installDirMatch = contentLine.match(/\$\(INSTALL_DIR\)\s+\$\(1\)(\/[^\s]*)/);
          if (installDirMatch) {
            installedDirs.add(installDirMatch[1]);
          }
        }
      }

      // Pass 2: Validate conffiles and detect config installations
      let MakefileInstallsConfig = false;
      let MakefileHasConffiles = false;
      let inConffiles = false;
      let currentPackage = '';

      for (const line of lines) {
        // Also check diff hunk headers (lines starting with @@) for endef/define
        // since they may contain context lines that close or open blocks
        if (/^@@/.test(line)) {
          // Git shows the nearest preceding function-like context line after
          // the second '@@'. If that context is anything other than a conffiles
          // define, the hunk lives outside any conffiles block seen in an
          // earlier hunk, so state must not leak across hunks.
          const hunkContextMatch = line.match(/^@@[^@]*@@\s*(.*)$/);
          const hunkContext = hunkContextMatch ? hunkContextMatch[1].trim() : '';

          if (hunkContext) {
            // Only a conffiles define keeps us inside the block. Lines *inside*
            // a conffiles block ('/etc/config/foo') never qualify as git's
            // function context, so any other context ('endef', another define,
            // 'CONFIGURE_VARS += \') means this hunk starts outside the block.
            const hunkDefineMatch = hunkContext.match(/^define\s+(Package\/\S+)/);
            if (hunkDefineMatch && /conffiles$/.test(hunkDefineMatch[1])) {
              inConffiles = true;
              currentPackage = hunkDefineMatch[1];
              MakefileHasConffiles = true;
            } else {
              inConffiles = false;
              currentPackage = '';
            }
          }
          continue;
        }

        if (line.startsWith('+') || line.startsWith(' ')) {
          const contentLine = line.slice(1);
          // Any define opens a new block, so one that is not a conffiles block
          // (e.g. 'define Build/Configure') closes the current one just as
          // 'endef' does — its body must not be validated as conffiles paths.
          const defineMatch = contentLine.match(/^define\s+(\S+)/);
          if (defineMatch) {
            if (/^Package\/[^\s]*conffiles$/.test(defineMatch[1])) {
              inConffiles = true;
              currentPackage = defineMatch[1];
              MakefileHasConffiles = true;
            } else {
              inConffiles = false;
              currentPackage = '';
            }
            continue;
          }
          if (contentLine.match(/^endef/)) {
            inConffiles = false;
            currentPackage = '';
            continue;
          }

          if (line.startsWith('+')) {
            // Only genuine configuration asks for a conffiles entry:
            // INSTALL_CONF is the macro for installing it and /etc/config/ is
            // the UCI home. A bare `$(1)/etc` used to qualify as well, which
            // demanded conffiles for capability files, profile.d snippets and
            // other /etc payload that is not user configuration at all.
            const isInstallLine = contentLine.includes('INSTALL_CONF') ||
              contentLine.includes('$(1)/etc/config');
            if (isInstallLine) {
              MakefileInstallsConfig = true;
            }

            if (inConffiles) {
              conffilesCheckRun = true;
              
              // No indentation/spaces
              if (/[ \t]/.test(contentLine)) {
                conffilesCheckErrors++;
                errors.push(`- ${currentPackage} line '${contentLine}' must not contain any spaces or indentation`);
              }

              const trimmedLine = contentLine.trim();
              if (trimmedLine.length > 0) {
                // Absolute paths must start with '/'
                if (!trimmedLine.startsWith('/')) {
                  conffilesCheckErrors++;
                  errors.push(`- ${currentPackage} line '${trimmedLine}' must be an absolute path starting with '/'`);
                }

                // Directories must end with a trailing slash '/'
                // Individual files must NOT end with a trailing slash.
                if (trimmedLine.endsWith('/')) {
                  // If it has a file extension or is a file ending in '/', it's an error
                  if (/\.(conf|json|cfg|txt|crt|key|pem|sh|ini|xml|yaml|yml)\/$/i.test(trimmedLine)) {
                    conffilesCheckErrors++;
                    errors.push(`- ${currentPackage} line '${trimmedLine}' is an individual file and must not end with a trailing slash`);
                  } else if (trimmedLine.startsWith('/etc/config/') && trimmedLine.length > '/etc/config/'.length) {
                    // Files under /etc/config/ cannot end with / because there are no subdirectories in /etc/config
                    conffilesCheckErrors++;
                    errors.push(`- ${currentPackage} line '${trimmedLine}' is an individual file and must not end with a trailing slash`);
                  }
                } else {
                  // Determine if the path is a directory that should end with '/'
                  // 1. Paths created by INSTALL_DIR in this Makefile are directories
                  const isInstalledDir = installedDirs.has(trimmedLine);
                  // 2. Paths ending with '.d' are directories by Unix convention
                  //    (e.g., conf.d, init.d, cron.d, zabbix_agentd.conf.d, sudoers.d)
                  const isDotDDir = /\.d$/.test(trimmedLine);
                  // 3. Well-known top-level directory paths
                  const isKnownDir = trimmedLine === '/etc' || trimmedLine === '/etc/config';

                  if (isInstalledDir || isDotDDir || isKnownDir) {
                    conffilesCheckErrors++;
                    errors.push(`- ${currentPackage} line '${trimmedLine}' must end with a trailing slash '/' (e.g., '${trimmedLine}/')`);
                  }
                }
              }
            }
          }
        }
      }

      if (MakefileInstallsConfig && !MakefileHasConffiles && isAddedMakefile) {
        errors.push("- Makefile installs configuration files under /etc/, but is missing the required 'conffiles' section. Please add a 'define Package/<pkgname>/conffiles' block listing each installed config file path (e.g. '/etc/config/<pkgname>'), terminated with 'endef'.");
      } else if (MakefileInstallsConfig && MakefileHasConffiles) {
        successes.push("✅ Makefile conffiles macro properly registers INSTALL_CONF tracking parameters");
      }
    }

    if (conffilesCheckRun && conffilesCheckErrors === 0) {
      successes.push("✅ Makefile conffiles block contains no spaces or indentation and paths are correctly formatted");
    }
  }

  // Variables like PROVIDES or TITLE describe one package and only take effect
  // inside its `define Package/<name>` block: BuildPackage evaluates
  // Package/Default (include/package-defaults.mk) first, which resets every one
  // of them, so a value assigned at the top level of the Makefile is silently
  // thrown away. LuCI packages never write the block themselves — luci.mk
  // generates it and reads dedicated variables instead (PKG_PROVIDES,
  // LUCI_TITLE, ...), so the fix differs per context. Deliberately not
  // configurable: such an assignment is dead code in every repository.
  const deadVarLines = new Set();
  {
    // Package-block fields that Package/Default resets. The ones seeded from a
    // PKG_* twin map to that twin; LuCI passes some through LUCI_*/PKG_* names.
    const PKG_TWINS = {
      MAINTAINER: 'PKG_MAINTAINER', URL: 'PKG_URL', LICENSE: 'PKG_LICENSE',
      LICENSE_FILES: 'PKG_LICENSE_FILES', FILE_MODES: 'PKG_FILE_MODES'
    };
    const LUCI_TWINS = {
      PROVIDES: 'PKG_PROVIDES', TITLE: 'LUCI_TITLE', DEPENDS: 'LUCI_DEPENDS',
      EXTRA_DEPENDS: 'LUCI_EXTRA_DEPENDS', PKGARCH: 'LUCI_PKGARCH',
      SECTION: 'LUCI_SECTION', CATEGORY: 'LUCI_CATEGORY', URL: 'LUCI_URL',
      MAINTAINER: 'LUCI_MAINTAINER', DEFAULT: 'LUCI_DEFAULT',
      LICENSE: 'PKG_LICENSE', LICENSE_FILES: 'PKG_LICENSE_FILES'
    };
    const packageBlockVars = new Set([
      'SECTION', 'CATEGORY', 'SUBMENU', 'TITLE', 'DEPENDS', 'MDEPENDS',
      'EXTRA_DEPENDS', 'CONFLICTS', 'PROVIDES', 'MAINTAINER', 'URL',
      'LICENSE', 'LICENSE_FILES', 'FILE_MODES', 'PKGARCH', 'USERID', 'MENU',
      'DEFAULT', 'HIDDEN', 'BUILDONLY', 'KCONFIG', 'VARIANT', 'ALTERNATIVES',
      'ABI_VERSION', 'CONFIGFILE'
    ]);

    const fileDiffs = commitPatch.split(/^diff --git /m);
    let deadVarCheckRun = false;
    let deadVarErrors = 0;

    for (const fileDiff of fileDiffs) {
      const fileMatch = fileDiff.match(/^\+\+\+\s+b\/(.*)$/m);
      if (!fileMatch) continue;
      const filePath = fileMatch[1].trim();
      if (!isPackageMakefilePath(filePath)) continue;
      deadVarCheckRun = true;

      const isLuci = fileDiff.includes('luci.mk') || /^[+ ]LUCI_[A-Z]/m.test(fileDiff);

      // Track define/endef state of the *new* file ('+' and context lines) so
      // block contents are never flagged, even when written without the
      // conventional indentation. Hunk headers carry the nearest preceding
      // define/endef as context; reset there so state cannot leak across hunks.
      let inDefine = false;
      const lines = fileDiff.split('\n');
      for (const line of lines) {
        if (/^@@/.test(line)) {
          const hunkContextMatch = line.match(/^@@[^@]*@@\s*(.*)$/);
          const hunkContext = hunkContextMatch ? hunkContextMatch[1].trim() : '';
          if (hunkContext) inDefine = /^define\s/.test(hunkContext);
          continue;
        }
        if (!line.startsWith('+') && !line.startsWith(' ')) continue;
        const contentLine = line.slice(1);
        const trimmed = contentLine.trim();
        if (/^define\s/.test(trimmed)) { inDefine = true; continue; }
        if (/^endef\b/.test(trimmed)) { inDefine = false; continue; }
        if (!line.startsWith('+') || inDefine) continue;

        const match = contentLine.match(/^([A-Z_]+)\s*(?::=|\+=|\?=|=)\s*(.*)$/);
        if (!match || !packageBlockVars.has(match[1])) continue;

        const varName = match[1];
        const value = match[2].trim();
        deadVarLines.add(contentLine);
        deadVarErrors++;

        const luciTwin = LUCI_TWINS[varName];
        const pkgTwin = PKG_TWINS[varName];
        if (isLuci && luciTwin) {
          errors.push(`- Use '${luciTwin}:=${value}' instead of '${trimmed}': LuCI packages generate the package definition in luci.mk, which ignores a top-level '${varName}'.`);
        } else if (pkgTwin) {
          errors.push(`- Use '${pkgTwin}:=${value}' instead of '${trimmed}': the build system resets '${varName}' before reading the package definition, so this line has no effect.`);
        } else {
          errors.push(`- Move '${trimmed}' into the 'define Package/<name>' block: the build system resets '${varName}' before reading the package definition, so a top-level assignment has no effect.`);
        }
      }
    }

    if (deadVarCheckRun && deadVarErrors === 0) {
      successes.push("✅ Makefile does not assign per-package variables at the top level");
    }
  }

  if (CONFIG.check_missing_colon || CONFIG.check_space_after_assignment) {
    let assignmentCheckRun = false;
    let assignmentErrors = 0;

    for (const { lines } of getMakefileChunks()) {
      for (const line of lines) {
        if (line.startsWith('+')) {
          const contentLine = line.slice(1);
          if (contentLine.trim().startsWith('#') || contentLine.startsWith('\t')) {
            continue;
          }
          // Already reported as a dead top-level assignment — suggesting a
          // ':=' or spacing fix for a line that must go away would mislead.
          if (deadVarLines.has(contentLine)) {
            continue;
          }
          const match = contentLine.match(/^(\s*)([^\s:=?+]+)\s*(:=|\+=|\?=|=)(.*)$/);
          if (match) {
            const indent = match[1];
            const varName = match[2].trim();
            const op = match[3];
            const varValue = match[4];

            if (CONFIG.check_missing_colon && op === '=') {
              const standardVars = ['TITLE', 'URL', 'SECTION', 'CATEGORY', 'SUBMENU', 'DEPENDS', 'USERID', 'PROVIDES', 'MAINTAINER', 'LICENSE', 'LICENSE_FILES'];
              if (varName.startsWith('PKG_') || standardVars.includes(varName)) {
                assignmentErrors++;
                errors.push(`- Makefile line '${contentLine.trim()}' uses '=' instead of ':=' for assignment. Use '${varName}:=${varValue.trim()}' to ensure simple expansion.\n` +
                            `  \`\`\`diff\n` +
                            `  - ${contentLine}\n` +
                            `  + ${indent}${varName}:=${varValue.trim()}\n` +
                            `  \`\`\``);
              }
            } else if (CONFIG.check_space_after_assignment && op === ':=') {
              if (/^[\t ]/.test(varValue) && varValue.trim() !== '\\') {
                assignmentErrors++;
                errors.push(`- Makefile line '${contentLine.trim()}' has a space after ':='. Use '${varName}:=${varValue.trim()}' without leading spaces.\n` +
                            `  \`\`\`diff\n` +
                            `  - ${contentLine}\n` +
                            `  + ${indent}${varName}:=${varValue.trim()}\n` +
                            `  \`\`\``);
              }
            }
          }
        }
      }
      assignmentCheckRun = true;
    }

    if (assignmentCheckRun && assignmentErrors === 0) {
      if (CONFIG.check_missing_colon && CONFIG.check_space_after_assignment) {
        successes.push("✅ Makefile contains valid assignment operators and no spaces after ':='");
      } else if (CONFIG.check_missing_colon) {
        successes.push("✅ Makefile contains valid assignment operators");
      } else if (CONFIG.check_space_after_assignment) {
        successes.push("✅ Makefile does not contain spaces after ':=' assignment operator");
      }
    }
  }

  if (CONFIG.check_makefile_indentation) {
    let indentationCheckRun = false;
    let indentationErrors = 0;

    for (const { lines } of getMakefileChunks()) {
      let inBlock = null; // 'metadata', 'description', 'recipe'
      let blockName = '';
      let isContinuation = false;

      for (const line of lines) {
        // Diff hunk headers (@@ ... @@ <context>) carry the nearest preceding
        // define/endef line as context. A block opened in an earlier hunk may
        // be closed between hunks, so state must not leak across them:
        // reset on every hunk boundary and re-derive from the header context.
        if (/^@@/.test(line)) {
          inBlock = null;
          blockName = '';
          isContinuation = false;

          const hunkContextMatch = line.match(/^@@[^@]*@@\s*(.*)$/);
          const hunkContext = hunkContextMatch ? hunkContextMatch[1] : '';
          if (!/\bendef\b/.test(hunkContext)) {
            const hunkMetadataMatch = hunkContext.match(/^define\s+(Package\/[^\s/]+(?:\/Default)?)$/);
            const hunkDescriptionMatch = hunkContext.match(/^define\s+(Package\/[^\s/]+\/description)$/);
            const hunkRecipeMatch = hunkContext.match(/^define\s+(Package\/[^\s/]+\/install|Build\/[^\s]+|Host\/[^\s]+)$/);
            if (hunkMetadataMatch) {
              inBlock = 'metadata';
              blockName = hunkMetadataMatch[1];
              indentationCheckRun = true;
            } else if (hunkDescriptionMatch) {
              inBlock = 'description';
              blockName = hunkDescriptionMatch[1];
              indentationCheckRun = true;
            } else if (hunkRecipeMatch) {
              inBlock = 'recipe';
              blockName = hunkRecipeMatch[1];
              indentationCheckRun = true;
            }
          }
          continue;
        }

        if (line.startsWith('+') || line.startsWith(' ')) {
          const contentLine = line.slice(1);

          const metadataMatch = contentLine.match(/^define\s+(Package\/[^\s/]+(?:\/Default)?)$/);
          const descriptionMatch = contentLine.match(/^define\s+(Package\/[^\s/]+\/description)$/);
          const recipeMatch = contentLine.match(/^define\s+(Package\/[^\s/]+\/install|Build\/[^\s]+|Host\/[^\s]+)$/);

          if (metadataMatch) {
            inBlock = 'metadata';
            blockName = metadataMatch[1];
            isContinuation = false;
            indentationCheckRun = true;
            continue;
          } else if (descriptionMatch) {
            inBlock = 'description';
            blockName = descriptionMatch[1];
            isContinuation = false;
            indentationCheckRun = true;
            continue;
          } else if (recipeMatch) {
            inBlock = 'recipe';
            blockName = recipeMatch[1];
            isContinuation = false;
            indentationCheckRun = true;
            continue;
          } else if (contentLine.trim() === 'endef') {
            inBlock = null;
            blockName = '';
            isContinuation = false;
            continue;
          } else if (contentLine.startsWith('define ')) {
            inBlock = null;
            blockName = '';
            isContinuation = false;
            continue;
          }

          if (line.startsWith('+') && inBlock) {
            const trimmed = contentLine.trim();
            const isEmpty = trimmed === '';
            const isComment = trimmed.startsWith('#');
            const isConditional = /^(ifeq|ifneq|else|endif)\b/.test(trimmed);

            if (!isEmpty && !isComment && !isContinuation && !isConditional) {
              if (inBlock === 'metadata') {
                if (!/^ {2}[^ \t]/.test(contentLine)) {
                  indentationErrors++;
                  errors.push(`- Makefile line '${contentLine.trim()}' inside '${blockName}' must be indented with exactly 2 spaces`);
                }
              } else if (inBlock === 'description') {
                if (!/^ {2}/.test(contentLine) || contentLine.startsWith('\t')) {
                  indentationErrors++;
                  errors.push(`- Makefile line '${contentLine.trim()}' inside '${blockName}' must be indented with at least 2 spaces`);
                }
              } else if (inBlock === 'recipe') {
                if (!contentLine.startsWith('\t')) {
                  indentationErrors++;
                  errors.push(`- Makefile line '${contentLine.trim()}' inside '${blockName}' must be indented with a tab`);
                }
              }
            }
          }

          isContinuation = contentLine.endsWith('\\');
        }
      }
    }

    if (indentationCheckRun && indentationErrors === 0) {
      successes.push("✅ Makefile blocks contain valid indentation (spaces for metadata/description, tabs for build/install recipes)");
    }
  }

  if (
    CONFIG.check_buildbot_default &&
    CONFIG.check_buildbot_default !== 'disabled' &&
    !isMainRepo(repoFullname)
  ) {
    let buildbotCheckRun = false;
    const buildbotDefaultMessages = new Set();

    for (const { lines } of getMakefileChunks()) {
      buildbotCheckRun = true;

      // Track which Package/* block an added line lives in, purely to produce
      // a friendlier message. Re-derived from hunk header context (like the
      // indentation check) so state does not leak across hunks.
      let currentPackage = '';
      // A DEFAULT assignment may be spread over backslash continuation lines;
      // BUILDBOT can then sit on a line that does not start with DEFAULT.
      // The assignment is tracked whether it starts on an added or a context
      // line — adding an 'if BUILDBOT' continuation under a pre-existing
      // 'DEFAULT:=y \' is the easiest way to sneak the condition in — and
      // reported only when the diff actually introduces or re-arms it:
      // either its value line is added/changed, or an added line carries
      // BUILDBOT itself.
      let pendingDefault = null;

      const flushPending = () => {
        if (pendingDefault && (pendingDefault.startAdded || pendingDefault.buildbotAdded) && /\bBUILDBOT\b/.test(pendingDefault.text)) {
          const pkgLabel = pendingDefault.pkg ? ` inside '${pendingDefault.pkg}'` : '';
          buildbotDefaultMessages.add(
            `- Makefile line '${pendingDefault.text}'${pkgLabel} conditions DEFAULT on BUILDBOT, which forces this feed package into the buildbot default images. Default package selection belongs in the main ${MAIN_REPO_FULLNAME} repository, so please propose it there instead of setting it from a feed package's own Makefile.`
          );
        }
        pendingDefault = null;
      };

      for (const line of lines) {
        if (/^@@/.test(line)) {
          flushPending();
          const hunkContextMatch = line.match(/^@@[^@]*@@\s*(.*)$/);
          // Trimmed for the same reason the in-loop define/endef matches are:
          // Make tolerates leading whitespace, and an indented define carried
          // as hunk context would otherwise lose the package attribution.
          const hunkContext = hunkContextMatch ? hunkContextMatch[1].trim() : '';
          const hunkDefineMatch = /\bendef\b/.test(hunkContext)
            ? null
            : hunkContext.match(/^define\s+(Package\/\S+)/);
          currentPackage = hunkDefineMatch ? hunkDefineMatch[1] : '';
          continue;
        }

        if (!line.startsWith('+') && !line.startsWith(' ')) continue;
        const contentLine = line.slice(1);
        const trimmed = contentLine.trim();

        // Make tolerates leading whitespace on define/endef, so match on the
        // trimmed line: an indented endef that failed to close the block would
        // otherwise label a later DEFAULT with the wrong package name.
        const defineMatch = trimmed.match(/^define\s+(Package\/\S+)/);
        if (defineMatch) {
          flushPending();
          currentPackage = defineMatch[1];
          continue;
        }
        if (/^endef\b/.test(trimmed)) {
          flushPending();
          currentPackage = '';
          continue;
        }

        // Continuation of a DEFAULT assignment whose previous line ended in
        // a backslash. Added and context lines are both part of the
        // post-image; deleted lines never reach this point (see the guard
        // above), which is right for the same reason. An added continuation
        // only implicates the assignment when it carries BUILDBOT itself:
        // an untouched 'DEFAULT:=y if BUILDBOT \' must not be re-reported
        // just because an unrelated clause was appended to it.
        if (pendingDefault) {
          pendingDefault.text += ` ${trimmed.replace(/\\$/, '').trim()}`;
          if (line.startsWith('+') && /\bBUILDBOT\b/.test(trimmed)) pendingDefault.buildbotAdded = true;
          if (!trimmed.endsWith('\\')) flushPending();
          continue;
        }

        if (trimmed.startsWith('#')) continue;

        // Accept every Makefile assignment flavour: =, :=, ::=, +=, ?=
        // `startAdded` means the value line itself is new or changed — that
        // covers flipping 'DEFAULT:=n' to 'DEFAULT:=y' above an untouched
        // 'if BUILDBOT' continuation, which an added-BUILDBOT test alone
        // would miss.
        if (/^DEFAULT\s*(?::{1,2}|[+?])?=/.test(trimmed)) {
          pendingDefault = { pkg: currentPackage, text: trimmed.replace(/\\$/, '').trim(), startAdded: line.startsWith('+'), buildbotAdded: false };
          if (!trimmed.endsWith('\\')) flushPending();
        }
      }

      flushPending();
    }

    if (buildbotDefaultMessages.size > 0) {
      const isWarning = CONFIG.check_buildbot_default === 'warning';
      for (const msg of buildbotDefaultMessages) {
        if (isWarning) {
          warnings.push(msg);
        } else {
          errors.push(msg);
        }
      }
    } else if (buildbotCheckRun) {
      successes.push("✅ No feed package forces its own inclusion into buildbot default images via DEFAULT+BUILDBOT");
    }
  }

  if (CONFIG.check_pkg_name_reuse) {
    let pkgNameCheckRun = false;
    let pkgNameCheckErrors = 0;

    for (const { lines } of getMakefileChunks()) {
      for (const line of lines) {
        if (line.startsWith('+')) {
          const contentLine = line.slice(1);
          if (contentLine.trim().startsWith('#')) {
            continue;
          }
          if (/\$(?:\(PKG_NAME\)|{PKG_NAME})/.test(contentLine)) {
            const hasDefine = /\bdefine\b/.test(contentLine);
            const hasCall = /\bcall\b/.test(contentLine);
            const hasEval = /\beval\b/.test(contentLine);
            if (hasDefine || hasCall || hasEval) {
              pkgNameCheckErrors++;
              errors.push(`- Makefile line '${contentLine.trim()}' reuses PKG_NAME in a call, define, or eval. Use the literal package name instead.`);
            }
          }
        }
      }
      pkgNameCheckRun = true;
    }

    if (pkgNameCheckRun && pkgNameCheckErrors === 0) {
      successes.push("✅ Makefile does not reuse PKG_NAME in call, define, or eval lines");
    }
  }

  if (CONFIG.check_crlf) {
    if (/^\+.*\r$/m.test(commitPatch)) {
      errors.push("- Windows style line endings (CRLF) detected inside added source lines. Use UNIX (LF) formatting exclusively");
    } else {
      successes.push("✅ File additions contain clean UNIX (LF) line termination");
    }
  }

  if (CONFIG.check_trailing_newline && CONFIG.check_trailing_newline !== 'disabled') {
    let currentFile = null;
    let prevLine = null;
    const missingNewlineFiles = [];
    const changedFiles = new Set();

    const patchLines = commitPatch.split('\n');
    for (const line of patchLines) {
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6).trim().replace(/\r$/, '');
        if (currentFile !== '/dev/null') {
          changedFiles.add(currentFile);
        }
      } else if (line.startsWith('+++ /dev/null')) {
        currentFile = null;
      } else if (line.trim() === '\\ No newline at end of file') {
        if (currentFile && prevLine && prevLine.startsWith('+')) {
          missingNewlineFiles.push(currentFile);
        }
      }
      prevLine = line;
    }

    if (missingNewlineFiles.length > 0) {
      const isWarning = CONFIG.check_trailing_newline === 'warning';
      missingNewlineFiles.forEach(file => {
        const msg = `- File '${file}' is missing a trailing newline`;
        if (isWarning) {
          warnings.push(msg);
        } else {
          errors.push(msg);
        }
      });
    } else if (changedFiles.size > 0) {
      successes.push("✅ All modified files contain a trailing newline");
    }
  }

  return { errors, successes, warnings };
}

export async function validateEmbeddedPatches(commitPatch, CONFIG, fetchFileContent) {
  const errors = [];
  const successes = [];

  if (CONFIG.check_patch_headers === false || CONFIG.check_patch_headers === 'disabled') {
    return { errors: [], successes: [] };
  }

  if (!commitPatch) {
    return { errors: [], successes: ["✅ No diff footprint present for patches validation"] };
  }

  // Anchored at the end of the line: without that, the greedy match reads
  // "foo.patch.bak" - a leftover a contributor did not mean to commit - as a
  // patch file named "foo.patch", and the checks then run against a file that
  // was never touched.
  const patchFiles = [];
  const patchHeader = /^\+\+\+\s+b\/(.*\.patch)\r?$/mg;
  let patchHeaderMatch;
  while ((patchHeaderMatch = patchHeader.exec(commitPatch)) !== null) {
    patchFiles.push(patchHeaderMatch[1]);
  }

  if (patchFiles.length === 0) {
    return { errors: [], successes: ["✅ No downstream raw embedded patch files modified or introduced"] };
  }

  // Collect (chunk, patchFile) matches upfront rather than checking each
  // patch file's header inline in the loop: this lets every needed
  // fetchFileContent(patchFile) call fire together (via Promise.all below)
  // instead of one-at-a-time, so a batching loader upstream (see
  // fetchFileContentCached in index.js) can combine them into a single
  // GraphQL request instead of one HTTP call per patch file.
  //
  // Each chunk is paired with the patch file its own `+++ b/` header names.
  // Testing every chunk against every patch file instead is quadratic in the
  // number of files: a kernel bump that refreshes 800 patches would spend
  // ~180 ms of CPU here alone, far past what a Worker invocation gets.
  const wantedPatchFiles = new Set(patchFiles);
  const fileChunks = commitPatch.split(/^diff\s+--git\s+/m);
  const matches = [];
  for (const chunk of fileChunks) {
    const header = chunk.match(/^\+\+\+\s+b\/(.*\.patch)\r?$/m);
    if (header && wantedPatchFiles.has(header[1])) {
      matches.push({ chunk, patchFile: header[1] });
    }
  }

  async function checkPatchHeader({ chunk, patchFile }) {
    let hasFromHash = false;
    let hasFrom = false;
    let hasDate = false;
    let hasSubject = false;
    let checked = false;

    if (fetchFileContent) {
      try {
        const rawContent = await fetchFileContent(patchFile);
        if (rawContent !== null) {
          hasFromHash = /^From\s+[0-9a-fA-F]{40,64}\s+Mon\s+Sep\s+17\s+00:00:00\s+2001\r?$/m.test(rawContent);
          hasFrom = /^From:\s+.+/m.test(rawContent);
          hasDate = /^Date:\s+.+/m.test(rawContent);
          hasSubject = /^Subject:\s+.+/m.test(rawContent);
          checked = true;
        }
      } catch (e) {
        // Ignore fetch errors and fallback
      }
    }

    if (!checked) {
      // Fallback: only validate if it is a new file
      const isNewFile = /^(?:new file mode|--- \/dev\/null)/m.test(chunk);
      if (!isNewFile) {
        return { success: `✅ Embedded patch '${patchFile}' is an existing patch modification, header validation skipped (unable to fetch full file)` };
      }
      hasFromHash = /^\+\s*From\s+[0-9a-fA-F]{40,64}\s+Mon\s+Sep\s+17\s+00:00:00\s+2001\r?$/m.test(chunk);
      hasFrom = /^\+\s*From:\s+.+/m.test(chunk);
      hasDate = /^\+\s*Date:\s+.+/m.test(chunk);
      hasSubject = /^\+\s*Subject:\s+.+/m.test(chunk);
    }

    if (!hasFromHash || !hasFrom || !hasDate || !hasSubject) {
      return { error: `- Embedded patch file '${patchFile}' violates standard guidelines. Missing required Git header parameters ('From <hash> Mon Sep 17 00:00:00 2001' / 'From:' / 'Date:' / 'Subject:') to ensure 'git am' application compatibility` };
    }
    return { success: `✅ Embedded patch '${patchFile}' contains valid Git compliance headers` };
  }

  const results = await Promise.all(matches.map(checkPatchHeader));
  for (const result of results) {
    if (result.error) {
      errors.push(result.error);
    } else if (result.success) {
      successes.push(result.success);
    }
  }

  return { errors, successes };
}

export function getChangedFilesFromPatch(patch) {
  if (!patch) return [];
  const files = [];
  const lines = patch.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      files.push(line.slice(6).trim().replace(/\r$/, ''));
    }
  }
  return files;
}

export function parseDiffFileStates(patch) {
  const addedFiles = new Set();
  const deletedFiles = new Set();
  if (!patch) return { addedFiles, deletedFiles };

  const lines = patch.split('\n');
  let currentFile = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      currentFile = null;
      const match = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
      if (match) {
        currentFile = match[2].trim().replace(/\r$/, '');
      }
    } else if (currentFile) {
      if (line.startsWith('--- /dev/null')) {
        addedFiles.add(currentFile);
      } else if (line.startsWith('+++ /dev/null')) {
        deletedFiles.add(currentFile);
      }
    }
  }

  return { addedFiles, deletedFiles };
}

export function isHiddenOrSpecial(filePath) {
  return filePath.split('/').some(part => part.startsWith('.'));
}

export async function findPkgRoot(filePath, fetchFileContent, cache = {}) {
  // 'root', 'htdocs', 'luasrc', 'ucode' and 'po' are the payload directories
  // of LuCI packages (root/ plays the role files/ has elsewhere).
  const skipDirs = new Set(['patches', 'files', 'src', 'images', '.github', '.git',
    'root', 'htdocs', 'luasrc', 'ucode', 'po']);
  // OpenWrt uses versioned kernel patch dirs such as `target/linux/<subtarget>/patches-6.18/`
  // for kernel-version-specific patches. They must be skipped just like the plain `patches` dir
  // so we don't fall into the expensive candidate fallback and blow past Cloudflare's per-Worker
  // subrequest limit when a PR touches many such files.
  const isSkippableDir = (name) =>
    skipDirs.has(name) ||
    name.startsWith('.') ||
    name.startsWith('patches-') ||
    name.startsWith('files-');
  // 'frameworks' and 'games' come from the video feed.
  const CATEGORIES = new Set([
    'utils', 'net', 'libs', 'lang', 'kernel', 'firmware', 'devel', 'boot',
    'system', 'multimedia', 'mail', 'sound', 'network', 'frameworks', 'games'
  ]);
  const NESTED_LANGS = new Set(['python', 'perl', 'php', 'ruby', 'lua']);

  const hasPkgName = async (dir) => {
    if (!fetchFileContent) return false;
    if (dir in cache) return cache[dir];

    const makefilePath = `${dir}/Makefile`;
    const content = await fetchFileContent(makefilePath);
    // LuCI packages leave PKG_NAME to luci.mk (`PKG_NAME?=$(LUCI_NAME)`), so
    // the include line is what marks their directory as a package root.
    const ok = !!(content && (
      /^PKG_NAME\s*(?::=|=)/m.test(content) ||
      /^\s*include\s+.*\bluci\.mk\s*$/m.test(content)
    ));
    cache[dir] = ok;
    return ok;
  };

  const isCategoryLevel = (parts) => {
    if (parts.length === 0) return true;
    if (parts.length === 1 && CATEGORIES.has(parts[0])) return true;
    if (parts[0] === 'package' && parts.length === 2 && CATEGORIES.has(parts[1])) return true;
    if (parts.length === 2 && CATEGORIES.has(parts[1])) return true;
    return false;
  };

  let parts = filePath.split('/');
  if (parts.length > 0) {
    // Remove filename
    parts.pop();
  }

  // Traverse up skipping standard directories (including versioned
  // `patches-X.Y` / `files-X.Y` dirs used by `target/linux/<subtarget>/`).
  while (parts.length > 0) {
    const last = parts[parts.length - 1];
    if (isSkippableDir(last)) {
      parts.pop();
    } else {
      break;
    }
  }

  if (parts.length === 0 || parts.some(p => p.startsWith('.'))) {
    return null;
  }

      // Fast path for common OpenWrt layouts: no network calls needed.
  if (parts[0] === 'package') {
    if (parts.length >= 3 && CATEGORIES.has(parts[1])) {
      if (parts[1] === 'lang' && NESTED_LANGS.has(parts[2])) {
        if (parts.length >= 4) {
          return `package/lang/${parts[2]}/${parts[3]}`;
        }
        return `package/lang/${parts[2]}`;
      }
      // Only use fast path for exact 3-level depth (package/<category>/<pkgname>)
      // Deeper paths (e.g. package/network/utils/mosdns) need fallback resolution
      if (parts.length === 3) {
        return `package/${parts[1]}/${parts[2]}`;
      }
    }
    if (parts.length === 2 && !CATEGORIES.has(parts[1])) {
      return `package/${parts[1]}`;
    }
  }

  if (parts.length >= 2 && CATEGORIES.has(parts[0])) {
    if (parts[0] === 'lang' && NESTED_LANGS.has(parts[1])) {
      if (parts.length >= 3) {
        return `lang/${parts[1]}/${parts[2]}`;
      }
      return `lang/${parts[1]}`;
    }
    return `${parts[0]}/${parts[1]}`;
  }

  if (parts.length >= 3 && CATEGORIES.has(parts[1])) {
    if (parts[1] === 'lang' && NESTED_LANGS.has(parts[2])) {
      if (parts.length >= 4) {
        return `${parts[0]}/lang/${parts[2]}/${parts[3]}`;
      }
      return `${parts[0]}/lang/${parts[2]}`;
    }
    // Only use fast path for exact 3-level depth (feed/<category>/<pkgname>)
    // Deeper paths (e.g. package/network/utils/mosdns) need fallback resolution
    if (parts.length === 3) {
      return `${parts[0]}/${parts[1]}/${parts[2]}`;
    }
  }

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (candidate) => {
    if (!candidate) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  // Fallback candidates for uncommon feed/category layouts. Single-segment
  // candidates cover feeds that keep packages at the repository root - the
  // routing feed is `babeld/`, `batman-adv/`, ... with no category level at
  // all. Whether such a directory really is a package is decided by the
  // Makefile probe below, so non-package roots still resolve to null.
  for (let i = parts.length; i >= 1; i--) {
    pushCandidate(parts.slice(0, i).join('/'));
  }

  const viableCandidates = candidates.filter(candidate => {
    const candidateParts = candidate.split('/');
    const last = candidateParts[candidateParts.length - 1];
    if (last === 'package' || isSkippableDir(last)) return false;
    if (isCategoryLevel(candidateParts)) return false;
    return true;
  });

  if (!fetchFileContent) {
    // Dry mode (unit tests / no fetch available): trust the first viable
    // heuristic candidate without probing anything. Single-segment candidates
    // are only trustworthy after the Makefile probe below - without it, a
    // repository-root directory like scripts/ or include/ would be guessed to
    // be a package - so dry mode keeps requiring a category level.
    const dryCandidates = viableCandidates.filter(candidate => candidate.includes('/'));
    return dryCandidates.length > 0 ? dryCandidates[0] : null;
  }

  // Probe every viable candidate's Makefile in one shot instead of walking
  // up the tree one fetch at a time: still resolves to the same deepest-
  // first match (first `true` in original candidate order), but lets a
  // batching loader upstream (see fetchFileContentCached in index.js)
  // combine all these lookups into a single GraphQL request instead of N
  // sequential HTTP calls.
  const hasPkgNameResults = await Promise.all(viableCandidates.map(candidate => hasPkgName(candidate)));
  for (let i = 0; i < viableCandidates.length; i++) {
    if (hasPkgNameResults[i]) {
      return viableCandidates[i];
    }
  }

  return null;
}

function parseMakefileVar(content, varName) {
  if (!content) return null;
  const regex = new RegExp(`^${varName}\\s*(?::=|=)\\s*([^#\\r\\n]+)`, 'm');
  const match = content.match(regex);
  return match ? match[1].replace(/["']/g, "").trim() : null;
}

// The transitive set of variable names a variable's value is built from:
// PKG_VERSION:=$(GO_VERSION_MAJOR_MINOR).$(GO_VERSION_PATCH) contributes all
// three names. Used to decide whether a diff that never assigns PKG_VERSION
// itself still changed it through one of its helpers.
export function collectResolutionVarNames(content, varName, out = new Set()) {
  if (!content || out.has(varName)) return out;
  out.add(varName);
  const rawValue = parseMakefileVar(content, varName);
  if (rawValue === null) return out;
  const varRegex = /\$\(([A-Za-z0-9_-]+)\)|\$\{([A-Za-z0-9_-]+)\}/g;
  let match;
  while ((match = varRegex.exec(rawValue)) !== null) {
    collectResolutionVarNames(content, (match[1] || match[2]).trim(), out);
  }
  return out;
}

export function resolveMakefileVar(content, varName, seen = new Set()) {
  if (!content || !varName) return null;
  if (seen.has(varName)) {
    return '';
  }

  const rawValue = parseMakefileVar(content, varName);
  if (rawValue === null) {
    return null;
  }

  const newSeen = new Set(seen);
  newSeen.add(varName);

  // Find and replace variable references like $(VAR) or ${VAR}
  const varRegex = /\$\(([A-Za-z0-9_-]+)\)|\$\{([A-Za-z0-9_-]+)\}/g;
  return rawValue.replace(varRegex, (match, p1, p2) => {
    const refVarName = (p1 || p2).trim();
    const resolved = resolveMakefileVar(content, refVarName, newSeen);
    return resolved !== null ? resolved : '';
  });
}

function isFileChangeMinor(filePath, added, deleted) {
  // Helper to check if a line is a comment
  const isComment = (l) => {
    const trimmed = l.trim();
    return trimmed.startsWith('#') || 
           trimmed.startsWith('//') || 
           trimmed.startsWith('/*') || 
           trimmed.startsWith('*') || 
           trimmed.startsWith('--') || 
           trimmed.endsWith('*/');
  };

  // Helper to check if a line is a minor Makefile variable definition
  const isMinorVar = (l) => {
    const trimmed = l.trim();
    return /^(PKG_MAINTAINER|PKG_SOURCE_URL|PKG_HASH)\s*(?::=|=)/.test(trimmed);
  };

  const isMakefile = filePath.endsWith('/Makefile');

  // Filter out comments, minor vars, and pure whitespace
  const remainingAdded = added.filter(l => {
    if (l.trim() === '') return false;
    if (isComment(l)) return false;
    if (isMakefile && isMinorVar(l)) return false;
    return true;
  });

  const remainingDeleted = deleted.filter(l => {
    if (l.trim() === '') return false;
    if (isComment(l)) return false;
    if (isMakefile && isMinorVar(l)) return false;
    return true;
  });

  // If nothing is left, then all changes are comments, minor variables, or blank lines!
  if (remainingAdded.length === 0 && remainingDeleted.length === 0) {
    return true;
  }

  // Now check if the remaining changes are just whitespace/formatting edits of the same lines.
  // We strip all whitespace characters and see if the resulting lines match.
  const stripWs = (l) => l.replace(/\s+/g, '');
  const strippedAdded = remainingAdded.map(stripWs).sort();
  const strippedDeleted = remainingDeleted.map(stripWs).sort();

  if (strippedAdded.length !== strippedDeleted.length) {
    return false;
  }

  for (let i = 0; i < strippedAdded.length; i++) {
    if (strippedAdded[i] !== strippedDeleted[i]) {
      return false;
    }
  }

  return true;
}

// Many Makefiles define a repeatable per-item template (e.g. optional Prometheus
// exporter collectors, kmod sub-packages, LuCI theme variants) that is invoked via
// `$(eval $(call SomeMacro,name,...))` once per item, several times over. Adding one
// more invocation of an already-established template - without touching any existing
// invocation or other already-shipped file - only introduces a brand-new sub-package
// that has never been released before, so there is nothing installed for existing
// users to be out of sync with. This mirrors the exemption already granted to
// brand-new packages (see the `isNew` branch above), just scoped to one new
// sub-package inside an existing Makefile instead of a whole new package directory.
function isNewSubPackageMakefileAddition(added, deleted, headMakefileContent) {
  const isBlankOrComment = (l) => {
    const trimmed = l.trim();
    return trimmed === '' || trimmed.startsWith('#');
  };

  const meaningfulDeleted = deleted.filter(l => !isBlankOrComment(l));
  if (meaningfulDeleted.length > 0) {
    // Existing directives were touched or removed - not a pure addition.
    return false;
  }

  const meaningfulAdded = added.filter(l => !isBlankOrComment(l));
  if (meaningfulAdded.length === 0) {
    return false;
  }

  const callRegex = /\$\(eval\s+\$\(call\s+([A-Za-z0-9_]+)\s*,/;
  const macroNames = new Set();
  for (const line of meaningfulAdded) {
    const match = line.match(callRegex);
    if (!match) {
      // Some added line isn't a template macro invocation, e.g. it tweaks
      // shared build logic that affects already-shipped sub-packages too.
      return false;
    }
    macroNames.add(match[1]);
  }

  for (const macroName of macroNames) {
    const escaped = macroName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const occurrences = (headMakefileContent.match(new RegExp(`\\$\\(eval\\s+\\$\\(call\\s+${escaped}\\s*,`, 'g')) || []).length;
    if (occurrences < 2) {
      // The macro is only invoked once - it's the package's primary/sole
      // definition, not an established repeatable per-item template.
      return false;
    }
  }

  return true;
}

// One package per error keeps the backport filter able to drop a single one;
// they are folded into a single list at render time (see groupReleaseErrors).
export const MISSING_BUMP_ERROR = /^Package `([^`]+)` content changed without a PKG_RELEASE or version bump/;
export const MISSING_BUMP_SUMMARY = 'Content changed in these packages, but without a `PKG_RELEASE` or version bump:';
export const MISSING_BUMP_ACTION = 'Increment `PKG_RELEASE` by 1 (or bump `PKG_VERSION`/`PKG_SOURCE_DATE` and reset `PKG_RELEASE` to 1) so users receive the update.';
const MINOR_CHANGE_ADVICE = '**Do not increment release for minor changes.** Cosmetic edits (e.g., typos in comments, copyright updates, formatting/whitespace), changing the package maintainer (`PKG_MAINTAINER`), or updating source download info (`PKG_SOURCE_URL` / `PKG_HASH`) do not require incrementing `PKG_RELEASE`.';

// Splits the audit's errors into the packages that are missing a bump — one
// finding stated once, however many packages it names — and everything else.
export function groupReleaseErrors(errors) {
  const packages = [];
  const others = [];
  for (const err of errors) {
    const match = err.match(MISSING_BUMP_ERROR);
    if (match) packages.push(match[1]);
    else others.push(err);
  }
  return { packages, others };
}

export async function validatePkgReleaseBumps(commitDetails, CONFIG, fetchFileContentAtHead, fetchFileContentAtBase) {
  const errors = [];
  const warnings = [];
  const successes = [];

  if (CONFIG.check_pkg_release === false || CONFIG.check_pkg_release === 'disabled') {
    return { errors, warnings, successes, notes: [] };
  }

  // 1. Collect all modified package roots and file changes
  const pkgRootCache = {};

  const addedFiles = new Set();
  const deletedFiles = new Set();
  const modifiedFiles = new Set();
  const fileChanges = {}; // filePath -> { added: [], deleted: [] }
  const candidateFiles = [];

  // A revert puts PKG_VERSION and PKG_RELEASE back to the values that preceded
  // the reverted commit, so the version moves backwards and PKG_RELEASE is
  // whatever it was before instead of 1. Record which commits touched a file so
  // packages changed by reverts alone can skip the bump requirements. The
  // PR-wide patch fallback carries no per-commit message and therefore never
  // qualifies, keeping the audit strict when the origin of a change is unknown.
  const nonRevertedFiles = new Set();

  for (const item of commitDetails) {
    const isRevertCommit = CONFIG.allow_revert !== false &&
      parseRevertCommit(item.fullCommit?.commit?.message || '') !== null;

    if (item.commitPatch) {
      const states = parseDiffFileStates(item.commitPatch);
      states.addedFiles.forEach(f => addedFiles.add(f));
      states.deletedFiles.forEach(f => deletedFiles.add(f));

      // Parse changes per file in this commit patch
      const lines = item.commitPatch.split('\n');
      let currentFile = null;
      for (const line of lines) {
        if (line.startsWith('diff --git ')) {
          currentFile = null;
          const match = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
          if (match) {
            currentFile = match[2].trim().replace(/\r$/, '');
          }
        } else if (currentFile) {
          if (line.startsWith('+++ b/') || line.startsWith('--- a/') || line.startsWith('+++ /dev/null') || line.startsWith('--- /dev/null')) {
            continue;
          }
          if (line.startsWith('+')) {
            if (!fileChanges[currentFile]) {
              fileChanges[currentFile] = { added: [], deleted: [] };
            }
            fileChanges[currentFile].added.push(line.slice(1));
          } else if (line.startsWith('-')) {
            if (!fileChanges[currentFile]) {
              fileChanges[currentFile] = { added: [], deleted: [] };
            }
            fileChanges[currentFile].deleted.push(line.slice(1));
          }
        }
      }
    }

    const files = getChangedFilesFromPatch(item.commitPatch);
    for (const file of files) {
      modifiedFiles.add(file);
      if (!isRevertCommit) nonRevertedFiles.add(file);
      if (isHiddenOrSpecial(file)) continue;

      // Ignore test files that serve only within CI/CD (e.g. test.sh, test-version.sh)
      const filename = file.split('/').pop();
      if (filename === 'test.sh' || filename === 'test-version.sh') {
        continue;
      }

      candidateFiles.push(file);
    }
  }

  // Resolve every candidate file's package root together instead of one
  // sequential findPkgRoot call at a time, so a batching loader upstream
  // (see fetchFileContentCached in index.js) can combine the underlying
  // Makefile probes into far fewer GraphQL requests. The >15-package cap
  // below is checked against the full, precomputed set rather than bailing
  // out mid-scan, so the reported count is now always the true total.
  const resolvedRoots = await Promise.all(candidateFiles.map(file => findPkgRoot(file, fetchFileContentAtHead, pkgRootCache)));
  const pkgRoots = new Set();
  for (const pkgRoot of resolvedRoots) {
    if (pkgRoot) pkgRoots.add(pkgRoot);
  }

  if (pkgRoots.size > 15) {
    warnings.push(`Package release bump audit skipped: PR modifies ${pkgRoots.size} packages. Batch updates of >15 packages are not automatically audited to prevent hitting API rate/subrequest limits.`);
    return { errors, warnings, successes, notes: [] };
  }

  // 2. Process each package root — each root's Makefile-diff analysis runs
  // in its own async function returning { errors, successes } instead of
  // pushing into shared arrays directly, so every root can be processed via
  // Promise.all below. This lets multiple roots' head/base Makefile fetches
  // land in the same microtask tick, which a batching loader upstream (see
  // fetchFileContentCached in index.js) can combine into far fewer GraphQL
  // requests than one pair of HTTP calls per package.
  async function processPkgRoot(pkgRoot) {
    const empty = { errors: [], successes: [] };
    const makefilePath = `${pkgRoot}/Makefile`;

    // `tools/` and `toolchain/` hold host-side build helpers that are never
    // shipped to users; their rebuilds are driven by Makefile-hash stamps, so
    // most of them (51 of 73 tools/, 7 of 9 toolchain/ as of 2026) never
    // define PKG_RELEASE at all. Only enforce the release conventions there
    // when the tool itself has adopted PKG_RELEASE (e.g. tools/squashfs4).
    const isHostToolRoot = pkgRoot.startsWith('tools/') || pkgRoot.startsWith('toolchain/');

    // Some package families never adopt PKG_RELEASE: u-boot and ARM Trusted
    // Firmware track the upstream revision via PKG_VERSION/PKG_SOURCE_VERSION,
    // and LuCI packages derive their version from git history inside luci.mk.
    // Don't demand a release convention these Makefiles never had.
    const RELEASE_EXEMPT_INCLUDES = ['u-boot.mk', 'trusted-firmware-a.mk', 'luci.mk'];
    const isReleaseExemptMakefile = (content, release) =>
      release === null && !!content && RELEASE_EXEMPT_INCLUDES.some(mkFile =>
        new RegExp(`^\\s*include\\s+.*${mkFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(content));

    if (deletedFiles.has(makefilePath)) {
      // Package was deleted/dropped, skip checks
      return empty;
    }

    // Only revert commits touched this package, so its PKG_VERSION and
    // PKG_RELEASE are back at the values that preceded the reverted commit.
    const pkgFiles = [...modifiedFiles].filter(file => file === pkgRoot || file.startsWith(pkgRoot + '/'));
    const isRevertOnly = pkgFiles.length > 0 && pkgFiles.every(file => !nonRevertedFiles.has(file));

    // OPTIMIZATION: If the Makefile itself was not modified in the PR,
    // then the version and release cannot have changed (bumped = false).
    // We can skip fetching the Makefile contents entirely!
    let bumped = false;
    let versionChanged = false;
    let headRelease = null;
    let baseRelease = null;
    let headVersion = null;
    let baseVersion = null;
    let headSourceVer = null;
    let baseSourceVer = null;
    let headSourceDate = null;
    let baseSourceDate = null;
    let headMakefileContent = null;
    let isReleaseExempt = false;

    if (modifiedFiles.has(makefilePath)) {
      const headContent = await fetchFileContentAtHead(makefilePath);
      headMakefileContent = headContent;
      if (headContent === null) {
        // Package was deleted/dropped, skip checks
        return empty;
      }

      const isNew = addedFiles.has(makefilePath);
      const baseContent = isNew ? null : await fetchFileContentAtBase(makefilePath);

      headRelease = resolveMakefileVar(headContent, 'PKG_RELEASE');
      isReleaseExempt = isReleaseExemptMakefile(headContent, headRelease);

      if (isNew) {
        if (isRevertOnly) {
          // Reverting the removal of a package restores it with the PKG_RELEASE
          // it was dropped with; it is not a new package starting from scratch.
          return { errors: [], successes: [`✅ Package \`${pkgRoot}\` is restored by a revert with its previous PKG_RELEASE ('${headRelease || 'not defined'}')`] };
        }
        if (isHostToolRoot && headRelease === null) {
          return { errors: [], successes: [`✅ New package \`${pkgRoot}\` is a host-side build tool without PKG_RELEASE, which tools/ and toolchain/ packages are not required to define`] };
        }
        if (isReleaseExempt) {
          return { errors: [], successes: [`✅ New package \`${pkgRoot}\` builds on a shared helper (u-boot.mk / trusted-firmware-a.mk / luci.mk) that doesn't use PKG_RELEASE, no initialization required`] };
        }
        if (headRelease !== '1') {
          return { errors: [`New package \`${pkgRoot}\` must start with PKG_RELEASE set to 1 (currently: '${headRelease || 'not defined'}')`], successes: [] };
        }
        return { errors: [], successes: [`✅ New package \`${pkgRoot}\` correctly initializes PKG_RELEASE to 1`] };
      }

      // Existing package modified
      baseVersion = resolveMakefileVar(baseContent, 'PKG_VERSION');
      headVersion = resolveMakefileVar(headContent, 'PKG_VERSION');

      baseRelease = resolveMakefileVar(baseContent, 'PKG_RELEASE');

      baseSourceVer = resolveMakefileVar(baseContent, 'PKG_SOURCE_VERSION');
      headSourceVer = resolveMakefileVar(headContent, 'PKG_SOURCE_VERSION');

      baseSourceDate = resolveMakefileVar(baseContent, 'PKG_SOURCE_DATE');
      headSourceDate = resolveMakefileVar(headContent, 'PKG_SOURCE_DATE');

      // The PR's own diff is the authority on what this pull request changed;
      // the base/head contents only supply the values. GitHub freezes
      // pull_request.base.sha at the moment the PR is opened, so on a branch
      // created before an in-main version bump the two Makefiles differ in
      // PKG_SOURCE_VERSION even though the PR never touched it - and the
      // content comparison alone then reports main's own bump, backwards, as
      // if this PR had made it and forgot to reset PKG_RELEASE. A variable
      // counts as touched when the diff assigns it or any variable its value
      // is resolved through (PKG_VERSION built from GO_VERSION_PATCH, ...).
      const makefileDiff = fileChanges[makefilePath];
      const diffTouches = (varName) => {
        if (!makefileDiff) return false;
        const names = collectResolutionVarNames(headContent, varName);
        collectResolutionVarNames(baseContent, varName, names);
        for (const line of [...makefileDiff.added, ...makefileDiff.deleted]) {
          const assign = line.match(/^\s*([A-Za-z0-9_-]+)\s*(?::=|\+=|\?=|=)/);
          if (assign && names.has(assign[1])) return true;
        }
        return false;
      };

      versionChanged = ((baseVersion !== headVersion) && diffTouches('PKG_VERSION')) ||
        ((baseSourceVer !== headSourceVer) && diffTouches('PKG_SOURCE_VERSION')) ||
        ((baseSourceDate !== headSourceDate) && diffTouches('PKG_SOURCE_DATE'));
      const releaseChanged = (baseRelease !== headRelease) && diffTouches('PKG_RELEASE');
      bumped = versionChanged || releaseChanged;
    }

    if (!bumped) {
      // Check if package changes are minor
      let packageHasOnlyMinorChanges = true;
      let packageModifiedFilesCount = 0;
      let hasDisqualifyingChange = false;
      let hasQualifyingSubPackageMakefileEdit = false;
      let hasNewFileAdded = false;

      for (const file in fileChanges) {
        if (file === pkgRoot || file.startsWith(pkgRoot + '/')) {
          // Ignore test files that serve only within CI/CD (e.g. test.sh, test-version.sh)
          const filename = file.split('/').pop();
          if (filename === 'test.sh' || filename === 'test-version.sh') {
            continue;
          }

          packageModifiedFilesCount++;
          const changes = fileChanges[file];

          if (deletedFiles.has(file)) {
            // Removing an already-shipped file changes what's installed.
            packageHasOnlyMinorChanges = false;
            hasDisqualifyingChange = true;
            break;
          }

          if (addedFiles.has(file)) {
            packageHasOnlyMinorChanges = false;
            hasNewFileAdded = true;
            continue;
          }

          if (isFileChangeMinor(file, changes.added, changes.deleted)) {
            continue;
          }

          if (file === makefilePath && isNewSubPackageMakefileAddition(changes.added, changes.deleted, headMakefileContent)) {
            packageHasOnlyMinorChanges = false;
            hasQualifyingSubPackageMakefileEdit = true;
            continue;
          }

          packageHasOnlyMinorChanges = false;
          hasDisqualifyingChange = true;
          break;
        }
      }

      if (packageModifiedFilesCount === 0) {
        packageHasOnlyMinorChanges = false;
        hasDisqualifyingChange = true;
      }

      // A new sub-package registered via an already-established per-item template
      // (see isNewSubPackageMakefileAddition) has no prior release for existing
      // users to be out of sync with, as long as nothing else already shipped changed.
      const isNewSubPackageAddition = !hasDisqualifyingChange && hasQualifyingSubPackageMakefileEdit && hasNewFileAdded;

      if (packageHasOnlyMinorChanges) {
        return { errors: [], successes: [`✅ Package \`${pkgRoot}\` content changed with only minor/cosmetic updates, no PKG_RELEASE bump required`] };
      }
      // A patch-only change leaves the Makefile untouched, so it was never
      // fetched above; fetch it now to learn whether the package follows the
      // PKG_RELEASE convention at all - host tools by their location, u-boot/
      // trusted-firmware/LuCI builds by the shared helper they include.
      // Common for LuCI packages, whose changes usually live under htdocs/
      // or root/.
      if (headMakefileContent === null) {
        headMakefileContent = await fetchFileContentAtHead(makefilePath);
        if (headMakefileContent === null) {
          return empty;
        }
        headRelease = resolveMakefileVar(headMakefileContent, 'PKG_RELEASE');
        isReleaseExempt = isReleaseExemptMakefile(headMakefileContent, headRelease);
      }
      if (isHostToolRoot && headRelease === null) {
        return { errors: [], successes: [`✅ Package \`${pkgRoot}\` is a host-side build tool that doesn't follow the PKG_RELEASE convention (no PKG_RELEASE defined), skipping release bump requirement`] };
      }
      if (isReleaseExempt) {
        return { errors: [], successes: [`✅ Package \`${pkgRoot}\` uses a shared build helper that doesn't follow the PKG_RELEASE convention (no PKG_RELEASE defined), skipping release bump requirement`] };
      }
      if (isNewSubPackageAddition) {
        return { errors: [], successes: [`✅ Package \`${pkgRoot}\` only registers a new sub-package via an existing template (e.g. an optional collector/module/kmod) without modifying already-shipped files, no PKG_RELEASE bump required`] };
      }
      // A package changed without touching its Makefile never had it fetched
      // above (the optimization at the top), so read it now: whether the
      // package follows the PKG_RELEASE convention at all decides between the
      // exemption and the missing-bump finding. Common for LuCI packages,
      // whose changes usually live under htdocs/ or root/.
      if (headMakefileContent === null) {
        headMakefileContent = await fetchFileContentAtHead(makefilePath);
        if (headMakefileContent === null) {
          return empty;
        }
        headRelease = resolveMakefileVar(headMakefileContent, 'PKG_RELEASE');
        isReleaseExempt = isReleaseExemptMakefile(headMakefileContent, headRelease);
      }
      if (isReleaseExempt) {
        return { errors: [], successes: [`✅ Package \`${pkgRoot}\` uses a shared build helper that doesn't follow the PKG_RELEASE convention (no PKG_RELEASE defined), skipping release bump requirement`] };
      }
      return {
        errors: [`Package \`${pkgRoot}\` content changed without a PKG_RELEASE or version bump.`],
        successes: []
      };
    }

    // A revert takes the package back to a state that was already released, so
    // its version legitimately moves backwards and PKG_RELEASE keeps the value
    // it had before the reverted commit. Requiring a reset to 1 here would ask
    // for a version bump that a revert must not make.
    if (isRevertOnly) {
      const restoredVersion = headVersion || headSourceVer || headSourceDate;
      const restoredState = restoredVersion
        ? `PKG_VERSION '${restoredVersion}' with PKG_RELEASE '${headRelease || 'not defined'}'`
        : `PKG_RELEASE '${headRelease || 'not defined'}'`;
      return { errors: [], successes: [`✅ Package \`${pkgRoot}\` is reverted to ${restoredState}, matching its state before the reverted commit`] };
    }

    if (versionChanged) {
      // Deliberately keyed on head alone, not base: dropping PKG_RELEASE
      // together with a version update is accepted OpenWrt practice for host
      // tools (upstream cbf8c76d0a "tools/meson: update to 1.2.1",
      // c2d4abc380 "tools/libressl: bump to 3.7.1", 6988fe3d98 "tools/llvm:
      // update to 18.1.7") and equivalent to resetting it to 1.
      if (isHostToolRoot && headRelease === null) {
        return { errors: [], successes: [`✅ Package \`${pkgRoot}\` version updated to '${headVersion || headSourceVer || headSourceDate}'; host-side build tools without PKG_RELEASE don't require a reset to 1`] };
      }
      if (isReleaseExempt) {
        return { errors: [], successes: [`✅ Package \`${pkgRoot}\` version updated to '${headVersion || headSourceVer || headSourceDate}'; packages on a shared helper without PKG_RELEASE don't require a reset to 1`] };
      }
      if (headRelease !== '1') {
        return { errors: [`Package \`${pkgRoot}\` version updated from '${baseVersion || baseSourceVer || baseSourceDate}' to '${headVersion || headSourceVer || headSourceDate}', but PKG_RELEASE was not reset to 1 (currently: '${headRelease || 'not defined'}')`], successes: [] };
      }
      return { errors: [], successes: [`✅ Package \`${pkgRoot}\` version updated to '${headVersion || headSourceVer || headSourceDate}' and PKG_RELEASE correctly reset to 1`] };
    }

    return { errors: [], successes: [`✅ Package \`${pkgRoot}\` version unchanged, but PKG_RELEASE bumped from '${baseRelease}' to '${headRelease}'`] };
  }

  const pkgResults = await Promise.all([...pkgRoots].map(processPkgRoot));
  for (const result of pkgResults) {
    errors.push(...result.errors);
    successes.push(...result.successes);
  }

  // The advice on when a bump is *not* needed is about the rule, not about any
  // one package: a PR touching twelve Makefiles used to repeat it twelve times.
  const notes = errors.some(e => MISSING_BUMP_ERROR.test(e)) ? [MINOR_CHANGE_ADVICE] : [];

  return { errors, warnings, successes, notes };
}

export async function validateUciConfigs(commitPatch, CONFIG, fetchFileContent) {
  const errors = [];
  const successes = [];

  if (CONFIG.check_uci_config === false || CONFIG.check_uci_config === 'disabled') {
    return { errors, successes };
  }

  if (!commitPatch) {
    return { errors, successes };
  }

  const { deletedFiles } = parseDiffFileStates(commitPatch);
  const changedFiles = getChangedFilesFromPatch(commitPatch);
  const pkgRootCache = {};

  // Each file's check chain runs in its own async function returning
  // { errors, successes } instead of pushing into shared arrays directly,
  // so all files can be processed via Promise.all below. This lets multiple
  // files' findPkgRoot/Makefile/content lookups land in the same microtask
  // tick, which a batching loader upstream (see fetchFileContentCached in
  // index.js) can combine into far fewer GraphQL requests than one HTTP
  // call per file.
  async function processFile(file) {
    const empty = { errors: [], successes: [] };
    if (deletedFiles.has(file)) return empty;
    if (isHiddenOrSpecial(file)) return empty;

    // A file could be destined for /etc/config/ if its path contains /etc/config/
    // or if it's in a files/ directory.
    const isCandidate = file.includes('/etc/config/') || file.includes('/files/');
    if (!isCandidate) return empty;

    const pkgRoot = await findPkgRoot(file, fetchFileContent, pkgRootCache);
    if (!pkgRoot) return empty;

    let makefileContent = null;
    try {
      makefileContent = await fetchFileContent(`${pkgRoot}/Makefile`);
    } catch (e) {
      // Ignore errors fetching the Makefile
    }

    const filename = file.split('/').pop();
    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    const skipExtensions = new Set(['init', 'sh', 'hotplug', 'py', 'pl', 'lua', 'cron', 'md', 'patch', 'sed', 'defaults', 'uc']);
    if (skipExtensions.has(ext)) return empty;

    let isDestinedForEtcConfig = false;
    if (file.includes('/etc/config/')) {
      isDestinedForEtcConfig = true;
    } else if (makefileContent) {
      // A Makefile line naming this exact file is authoritative about where
      // it goes: `$(INSTALL_DATA) ./files/uhttpd.acl $(1)/usr/share/acl.d/...`
      // settles uhttpd.acl, however many siblings share its base name
      // (uhttpd.config, uhttpd.init, ...). Only when no line names the file
      // itself may the base-name matching below speak — without this guard,
      // every such sibling matched the /etc/config/uhttpd conffiles entry
      // through the shared stem and was rejected as invalid UCI.
      const namingLines = makefileContent.split('\n')
        .filter(l => !l.trim().startsWith('#') && l.includes(filename));
      if (namingLines.length > 0 && !namingLines.some(l => l.includes('etc/config'))) {
        return empty;
      }

      const nameWithoutExt = filename.includes('.') ? filename.substring(0, filename.lastIndexOf('.')) : filename;
      const lines = makefileContent.split('\n');
      let inConffiles = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) continue;

        // Parse conffiles section boundaries
        if (trimmed.match(/^define\s+(Package\/[^\s]*conffiles)/)) {
          inConffiles = true;
          continue;
        }
        if (trimmed.match(/^endef/)) {
          inConffiles = false;
          continue;
        }

        if (inConffiles) {
          if (trimmed.startsWith('/etc/config/')) {
            // If the file is under a files/ subdirectory like files/etc/init.d/,
            // skip matching against /etc/config/ conffiles entries to avoid false
            // positives (e.g., an init script named 'foo' matching conffile /etc/config/foo).
            // But if the file is not under an etc/ subdirectory at all (e.g., files/lib/foo.uc),
            // still allow matching via install commands.
            const filesIndex = file.indexOf('/files/');
            if (filesIndex !== -1) {
              const relativePath = file.substring(filesIndex + 7);
              if (relativePath.startsWith('etc/') && !relativePath.startsWith('etc/config/')) {
                continue;
              }
            }
            const conffilePart = trimmed.substring('/etc/config/'.length);
            if (conffilePart === filename || conffilePart === nameWithoutExt) {
              isDestinedForEtcConfig = true;
              break;
            }
          }
        } else {
          // Look for install/cp commands
          const filesIndex = file.indexOf('/files/');
          const relativePath = filesIndex !== -1 ? file.substring(filesIndex + 7) : '';

          // If the file is under a files/ subdirectory that is clearly not
          // files/etc/config/ (e.g., files/etc/init.d/), skip matching against
          // /etc/config/ install commands to avoid false positives.
          const isUnderFilesButNotEtcConfig = filesIndex !== -1 && relativePath.startsWith('etc/') && !relativePath.startsWith('etc/config/');

          // When matching 'files/*' wildcard, verify the file is actually under files/etc/config/
          // to avoid false positives for files destined for other paths (e.g., files/etc/init.d/)
          const isDestinedForEtcConfigViaFiles = !isUnderFilesButNotEtcConfig && trimmed.includes('files/*') && relativePath.startsWith('etc/config/');

          if (!isUnderFilesButNotEtcConfig && trimmed.includes('etc/config') &&
              (trimmed.includes(filename) || trimmed.includes(nameWithoutExt) || isDestinedForEtcConfigViaFiles)) {
            isDestinedForEtcConfig = true;
            break;
          }
        }
      }
    }

    if (isDestinedForEtcConfig) {
      const content = await fetchFileContent(file);
      if (content !== null) {
        const uciLines = content.split('\n');
        let isValidUci = true;
        let invalidLine = '';
        let invalidLineNum = 0;

        for (let i = 0; i < uciLines.length; i++) {
          const trimmedLine = uciLines[i].trim();
          if (trimmedLine === '' || trimmedLine.startsWith('#')) {
            continue;
          }
          if (!/^(?:package|config|option|list)[ \t]/.test(trimmedLine)) {
            isValidUci = false;
            invalidLine = uciLines[i];
            invalidLineNum = i + 1;
            break;
          }
        }

        if (!isValidUci) {
          return { errors: [`- File '${file}' is destined for '/etc/config/' but is not a valid UCI configuration file. In OpenWrt, '/etc/config/' is reserved for UCI-formatted configuration files. Raw files (such as TOML, JSON, or YAML) are not allowed at this path. Invalid line ${invalidLineNum}: '${invalidLine}'`], successes: [] };
        }
        return { errors: [], successes: [`✅ Configuration file '${file}' destined for '/etc/config/' is a valid UCI configuration file`] };
      }
    }

    return empty;
  }

  const results = await Promise.all(changedFiles.map(processFile));
  for (const result of results) {
    errors.push(...result.errors);
    successes.push(...result.successes);
  }

  return { errors, successes };
}

