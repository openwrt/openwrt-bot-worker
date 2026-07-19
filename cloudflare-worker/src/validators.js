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
    'newest', 'latest', 'new', 'old',
    'from', 'to', 'the', 'a', 'an', 'and', 'or', 'in', 'of', 'for', 'with', 'by', 'on', 'at', 'it', 'its',
    'version', 'versions', 'v', 'cli', 'package', 'packages', 'release', 'releases', 'revision', 'revisions',
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

  // Identity Check
  const identityErrors = [];
  if (!isValidName(authorName)) identityErrors.push(`Author name format is invalid ('${authorName}')`);
  if (!isValidName(committerName)) identityErrors.push(`Committer name format is invalid ('${committerName}')`);
  if (CONFIG.check_noreply_email) {
    if (isNoreplyEmail(authorEmail)) identityErrors.push("Author email must not be a GitHub noreply address");
    if (isNoreplyEmail(committerEmail)) identityErrors.push("Committer email must not be a GitHub noreply address");
  }
  if (CONFIG.require_linked_github_account) {
    if (!fullCommit.author || !fullCommit.author.login) {
      identityErrors.push(`Commit author email '${authorEmail}' is not linked to any registered GitHub account. Please add and verify this email in your GitHub profile settings.`);
    }
  }

  if (identityErrors.length === 0) {
    successes.push("✅ Author and committer identities are valid");
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

  if (!isAutosquash) {
    if (/^\s/.test(lines[0])) subjectErrors.push("Commit subject must not start with whitespace");
    
    // Special case for tools/* prefix (e.g., tools/cmake: backport bootstrap fix)
    // These use a subdirectory naming convention like tools/cmake, tools/bison, etc.
    const toolsPrefixMatch = subject.match(/^(tools\/[a-zA-Z0-9_-]+): /);
    if (toolsPrefixMatch) {
      const afterPrefix = subject.replace(/^(tools\/[a-zA-Z0-9_-]+): \s*/, '');
      if (afterPrefix.length > 0 && afterPrefix[0] === afterPrefix[0].toUpperCase() && /[a-zA-Z]/.test(afterPrefix[0])) {
        subjectErrors.push("Commit subject must start with a lower-case word after the prefix");
      }
      if (subject.endsWith('.')) {
        subjectErrors.push("Commit subject must not end with a period");
      }
    } else if (!/^[a-zA-Z0-9_-]+: /.test(subject)) {
      subjectErrors.push("Commit subject must start with `<package name or prefix>: `");
    } else {
      const afterPrefix = subject.replace(/^[a-zA-Z0-9_-]+: \s*/, '');
      if (afterPrefix.length > 0 && afterPrefix[0] === afterPrefix[0].toUpperCase() && /[a-zA-Z]/.test(afterPrefix[0])) {
        subjectErrors.push("Commit subject must start with a lower-case word after the prefix");
      }
      if (subject.endsWith('.')) {
        subjectErrors.push("Commit subject must not end with a period");
      }
    }
  }

  const subjectLen = lines[0].length;
  if (subjectLen > CONFIG.max_subject_len_hard) {
    subjectErrors.push(`Subject line exceeds hard limit (${subjectLen}/${CONFIG.max_subject_len_hard} chars)`);
  } else if (subjectLen > CONFIG.max_subject_len_soft) {
    warnings.push(`Subject line exceeds soft limit (${subjectLen}/${CONFIG.max_subject_len_soft} chars)`);
  }

  if (subjectErrors.length === 0) {
    successes.push(`✅ Commit subject layout and length are valid: "${lines[0]}"`);
  } else {
    subjectErrors.forEach(err => errors.push("- " + err));
  }

  // Description Quality Warnings
  const bodyLines = lines.slice(1);
  const cleanBodyLines = [];
  bodyLines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed === '' || /^(signed-off-by:|cherry picked from)/i.test(trimmed)) {
      return;
    }
    cleanBodyLines.push(trimmed);
  });
  const fullCleanBody = cleanBodyLines.join(" ");

  // Require meaningful commit body (not just trailers)
  if (CONFIG.require_body && fullCleanBody.length === 0) {
    errors.push("- Commit description body is empty or contains only trailers (e.g. Signed-off-by). Please provide a meaningful description of what this change does and why");
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
        if (/^(signed-off-by:|cherry picked from)/i.test(trimmed)) {
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
      bodyErrors.push(`Line ${index + 1} in commit body exceeds max width (${line.length}/${CONFIG.max_body_line_len} chars)`);
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
          noreplyErrors.push("Signed-off-by email must not be a GitHub noreply address");
        }
      }
    });
    if (!hasSignoff) {
      errors.push("- Missing 'Signed-off-by:' line");
    } else {
      const signoffErrors = [];

      // Check that at least one Signed-off-by matches the commit author
      const authorMatch = signoffEntries.some(entry =>
        entry.name.toLowerCase() === authorName.toLowerCase() &&
        entry.email.toLowerCase() === authorEmail.toLowerCase()
      );

      // Check that at least one Signed-off-by matches the commit committer
      const committerMatch = signoffEntries.some(entry =>
        entry.name.toLowerCase() === committerName.toLowerCase() &&
        entry.email.toLowerCase() === committerEmail.toLowerCase()
      );

      // After a rebase, the committer changes but the original author's SOB
      // remains valid. Require at least one SOB matching author OR committer.
      if (!authorMatch && !committerMatch) {
        const isAuthorCommitterSame =
          authorName.toLowerCase() === committerName.toLowerCase() &&
          authorEmail.toLowerCase() === committerEmail.toLowerCase();
        if (isAuthorCommitterSame) {
          signoffErrors.push(`No Signed-off-by matches commit author (\`${authorName} <${authorEmail}>\`)`);
        } else {
          signoffErrors.push(`No Signed-off-by matches commit author (\`${authorName} <${authorEmail}>\`) or committer (\`${committerName} <${committerEmail}>\`)`);
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

export function validateMakefileContext(fullCommit, commitPatch, CONFIG, state) {
  const errors = [];
  const successes = [];
  const warnings = [];
  const subject = (fullCommit.commit.message || '').split("\n")[0].trim();

  if (!commitPatch) {
    return { errors: [], successes: ["✅ No codebase text files changed to analyze"], warnings: [] };
  }

  let isNewPackageThisCommit = false;
  if (/^---\s+\/dev\/null\r?\n\+\+\+\s+b\/(?:.*\/)?Makefile\r?$/m.test(commitPatch)) {
    state.isNewPackage = true;
    isNewPackageThisCommit = true;
  }

  if (/^---\s+a\/(?:.*\/)?Makefile\r?\n\+\+\+\s+\/dev\/null\r?$/m.test(commitPatch)) {
    state.isDroppedPackage = true;
  }

  if (CONFIG.check_pkg_version && !state.isNewPackage) {
    const versionMatch = commitPatch.match(/^\+\s*PKG_VERSION\s*(?::=|=)\s*(.+)$/m);
    if (versionMatch) {
      const newVersion = versionMatch[1].replace(/["']/g, "").trim();
      if (newVersion.includes('$')) {
        successes.push(`✅ PKG_VERSION is dynamically defined: '${newVersion}', skipping subject validation`);
      } else {
        const cleanSubject = subject.replace(/^(fixup!|squash!)\s+/, '');
        if (!matchVersionString(cleanSubject, newVersion)) {
          errors.push(`- Makefile introduces PKG_VERSION '${newVersion}', but this version string is missing in the commit subject line`);
        } else {
          successes.push(`✅ PKG_VERSION bump matches context information inside subject line (${newVersion})`);
        }
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

  if (CONFIG.check_conffiles) {
    const fileDiffs = commitPatch.split(/^diff --git /m);
    let conffilesCheckRun = false;
    let conffilesCheckErrors = 0;

    for (const fileDiff of fileDiffs) {
      const fileMatch = fileDiff.match(/^\+\+\+\s+b\/(.*)$/m);
      if (!fileMatch) continue;
      const filePath = fileMatch[1].trim();
      const isMakefile = filePath.endsWith('/Makefile') || filePath === 'Makefile';
      if (!isMakefile) continue;

      const lines = fileDiff.split('\n');

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
          const hunkEndefMatch = line.match(/@@.*\bendef\b/);
          if (hunkEndefMatch && inConffiles) {
            inConffiles = false;
            currentPackage = '';
          }
          // Check if hunk header opens a conffiles block
          const hunkDefineMatch = line.match(/@@.*\bdefine\s+(Package\/[^\s]*conffiles)/);
          if (hunkDefineMatch) {
            inConffiles = true;
            currentPackage = hunkDefineMatch[1];
            MakefileHasConffiles = true;
          }
          continue;
        }

        if (line.startsWith('+') || line.startsWith(' ')) {
          const contentLine = line.slice(1);
          const defineMatch = contentLine.match(/^define\s+(Package\/[^\s]*conffiles)/);
          if (defineMatch) {
            inConffiles = true;
            currentPackage = defineMatch[1];
            MakefileHasConffiles = true;
            continue;
          }
          if (contentLine.match(/^endef/)) {
            inConffiles = false;
            currentPackage = '';
            continue;
          }

          if (line.startsWith('+')) {
            // Check if the added line installs configuration files
            const isInstallLine = contentLine.includes('INSTALL_CONF') ||
              (contentLine.includes('$(1)/etc') &&
               !contentLine.includes('/etc/init.d') &&
               !contentLine.includes('/etc/uci-defaults') &&
               !contentLine.includes('/etc/hotplug.d'));
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

      if (MakefileInstallsConfig && !MakefileHasConffiles) {
        errors.push("- Makefile installs configuration files under /etc/, but is missing the required 'conffiles' section");
      } else if (MakefileInstallsConfig && MakefileHasConffiles) {
        successes.push("✅ Makefile conffiles macro properly registers INSTALL_CONF tracking parameters");
      }
    }

    if (conffilesCheckRun && conffilesCheckErrors === 0) {
      successes.push("✅ Makefile conffiles block contains no spaces or indentation and paths are correctly formatted");
    }
  }

  if (CONFIG.check_missing_colon || CONFIG.check_space_after_assignment) {
    const fileDiffs = commitPatch.split(/^diff --git /m);
    let assignmentCheckRun = false;
    let assignmentErrors = 0;

    for (const fileDiff of fileDiffs) {
      const fileMatch = fileDiff.match(/^\+\+\+\s+b\/(.*)$/m);
      if (!fileMatch) continue;
      const filePath = fileMatch[1].trim();
      const isMakefile = filePath.endsWith('/Makefile') || filePath === 'Makefile';
      if (!isMakefile) continue;

      const lines = fileDiff.split('\n');
      for (const line of lines) {
        if (line.startsWith('+')) {
          const contentLine = line.slice(1);
          if (contentLine.trim().startsWith('#') || contentLine.startsWith('\t')) {
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
    const fileDiffs = commitPatch.split(/^diff --git /m);
    let indentationCheckRun = false;
    let indentationErrors = 0;

    for (const fileDiff of fileDiffs) {
      const fileMatch = fileDiff.match(/^\+\+\+\s+b\/(.*)$/m);
      if (!fileMatch) continue;
      const filePath = fileMatch[1].trim();
      const isMakefile = filePath.endsWith('/Makefile') || filePath === 'Makefile';
      if (!isMakefile) continue;

      let inBlock = null; // 'metadata', 'description', 'recipe'
      let blockName = '';
      let isContinuation = false;

      const lines = fileDiff.split('\n');
      for (const line of lines) {
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

  if (CONFIG.check_pkg_name_reuse) {
    const fileDiffs = commitPatch.split(/^diff --git /m);
    let pkgNameCheckRun = false;
    let pkgNameCheckErrors = 0;

    for (const fileDiff of fileDiffs) {
      const fileMatch = fileDiff.match(/^\+\+\+\s+b\/(.*)$/m);
      if (!fileMatch) continue;
      const filePath = fileMatch[1].trim();
      const isMakefile = filePath.endsWith('/Makefile') || filePath === 'Makefile';
      if (!isMakefile) continue;

      const lines = fileDiff.split('\n');
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

  const patchMatch = commitPatch.match(/^\+\+\+\s+b\/(.*\.patch)/mg);
  const patchFiles = patchMatch ? patchMatch.map(line => line.replace(/^\+\+\+\s+b\//, '')) : [];

  if (patchFiles.length === 0) {
    return { errors: [], successes: ["✅ No downstream raw embedded patch files modified or introduced"] };
  }

  const fileChunks = commitPatch.split(/^diff\s+--git\s+/m);
  for (const chunk of fileChunks) {
    for (const patchFile of patchFiles) {
      if (chunk.includes('b/' + patchFile)) {
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
            successes.push(`✅ Embedded patch '${patchFile}' is an existing patch modification, header validation skipped (unable to fetch full file)`);
            continue;
          }
          hasFromHash = /^\+\s*From\s+[0-9a-fA-F]{40,64}\s+Mon\s+Sep\s+17\s+00:00:00\s+2001\r?$/m.test(chunk);
          hasFrom = /^\+\s*From:\s+.+/m.test(chunk);
          hasDate = /^\+\s*Date:\s+.+/m.test(chunk);
          hasSubject = /^\+\s*Subject:\s+.+/m.test(chunk);
        }

        if (!hasFromHash || !hasFrom || !hasDate || !hasSubject) {
          errors.push(`- Embedded patch file '${patchFile}' violates standard guidelines. Missing required Git header parameters ('From <hash> Mon Sep 17 00:00:00 2001' / 'From:' / 'Date:' / 'Subject:') to ensure 'git am' application compatibility`);
        } else {
          successes.push(`✅ Embedded patch '${patchFile}' contains valid Git compliance headers`);
        }
      }
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
  const skipDirs = new Set(['patches', 'files', 'src', 'images', '.github', '.git']);
  const CATEGORIES = new Set([
    'utils', 'net', 'libs', 'lang', 'kernel', 'firmware', 'devel', 'boot',
    'system', 'multimedia', 'mail', 'sound', 'network'
  ]);
  const NESTED_LANGS = new Set(['python', 'perl', 'php', 'ruby']);

  const hasPkgName = async (dir) => {
    if (!fetchFileContent) return false;
    if (dir in cache) return cache[dir];

    const makefilePath = `${dir}/Makefile`;
    const content = await fetchFileContent(makefilePath);
    const ok = !!(content && /^PKG_NAME\s*(?::=|=)/m.test(content));
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

  // Traverse up skipping standard directories
  while (parts.length > 0) {
    const last = parts[parts.length - 1];
    if (skipDirs.has(last) || last.startsWith('.')) {
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

  // Fallback candidates for uncommon feed/category layouts.
  for (let i = parts.length; i >= 2; i--) {
    pushCandidate(parts.slice(0, i).join('/'));
  }

  for (const candidate of candidates) {
    const candidateParts = candidate.split('/');
    const last = candidateParts[candidateParts.length - 1];
    if (last === 'package' || last.startsWith('.') || skipDirs.has(last)) {
      continue;
    }
    if (isCategoryLevel(candidateParts)) {
      continue;
    }

    if (await hasPkgName(candidate)) {
      return candidate;
    }

    // When fetching is unavailable (unit tests / dry mode), trust first viable heuristic candidate.
    if (!fetchFileContent) {
      return candidate;
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

export async function validatePkgReleaseBumps(commitDetails, CONFIG, fetchFileContentAtHead, fetchFileContentAtBase) {
  const errors = [];
  const warnings = [];
  const successes = [];

  if (CONFIG.check_pkg_release === false || CONFIG.check_pkg_release === 'disabled') {
    return { errors, warnings, successes };
  }

  // 1. Collect all modified package roots and file changes
  const pkgRoots = new Set();
  const pkgRootCache = {};

  const addedFiles = new Set();
  const deletedFiles = new Set();
  const modifiedFiles = new Set();
  const fileChanges = {}; // filePath -> { added: [], deleted: [] }

  let exceededPkgLimit = false;
  outer: for (const item of commitDetails) {
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
      if (isHiddenOrSpecial(file)) continue;

      // Ignore test files that serve only within CI/CD (e.g. test.sh, test-version.sh)
      const filename = file.split('/').pop();
      if (filename === 'test.sh' || filename === 'test-version.sh') {
        continue;
      }

      const pkgRoot = await findPkgRoot(file, fetchFileContentAtHead, pkgRootCache);
      if (pkgRoot) {
        pkgRoots.add(pkgRoot);
        if (pkgRoots.size > 15) {
          exceededPkgLimit = true;
          break outer;
        }
      }
    }
  }

  if (exceededPkgLimit) {
    warnings.push(`Package release bump audit skipped: PR modifies ${pkgRoots.size} packages. Batch updates of >15 packages are not automatically audited to prevent hitting API rate/subrequest limits.`);
    return { errors, warnings, successes };
  }

  // 2. Process each package root
  for (const pkgRoot of pkgRoots) {
    const makefilePath = `${pkgRoot}/Makefile`;

    if (deletedFiles.has(makefilePath)) {
      // Package was deleted/dropped, skip checks
      continue;
    }

    // OPTIMIZATION: If the Makefile itself was not modified in the PR,
    // then the version and release cannot have changed (bumped = false).
    // We can skip fetching the Makefile contents entirely!
    let bumped = false;
    let versionChanged = false;
    let releaseChanged = false;
    let headRelease = null;
    let baseRelease = null;
    let headVersion = null;
    let baseVersion = null;
    let headSourceVer = null;
    let baseSourceVer = null;
    let headSourceDate = null;
    let baseSourceDate = null;

    if (modifiedFiles.has(makefilePath)) {
      const headContent = await fetchFileContentAtHead(makefilePath);
      if (headContent === null) {
        // Package was deleted/dropped, skip checks
        continue;
      }

      const isNew = addedFiles.has(makefilePath);
      const baseContent = isNew ? null : await fetchFileContentAtBase(makefilePath);

      headRelease = resolveMakefileVar(headContent, 'PKG_RELEASE');

      if (isNew) {
        if (headRelease !== '1') {
          errors.push(`New package \`${pkgRoot}\` must start with PKG_RELEASE set to 1 (currently: '${headRelease || 'not defined'}')`);
        } else {
          successes.push(`✅ New package \`${pkgRoot}\` correctly initializes PKG_RELEASE to 1`);
        }
        continue;
      }

      // Existing package modified
      baseVersion = resolveMakefileVar(baseContent, 'PKG_VERSION');
      headVersion = resolveMakefileVar(headContent, 'PKG_VERSION');

      baseRelease = resolveMakefileVar(baseContent, 'PKG_RELEASE');

      baseSourceVer = resolveMakefileVar(baseContent, 'PKG_SOURCE_VERSION');
      headSourceVer = resolveMakefileVar(headContent, 'PKG_SOURCE_VERSION');

      baseSourceDate = resolveMakefileVar(baseContent, 'PKG_SOURCE_DATE');
      headSourceDate = resolveMakefileVar(headContent, 'PKG_SOURCE_DATE');

      versionChanged = (baseVersion !== headVersion) || (baseSourceVer !== headSourceVer) || (baseSourceDate !== headSourceDate);
      releaseChanged = (baseRelease !== headRelease);
      bumped = versionChanged || releaseChanged;
    }

    if (!bumped) {
      // Check if package changes are minor
      let packageHasOnlyMinorChanges = true;
      let packageModifiedFilesCount = 0;

      for (const file in fileChanges) {
        if (file === pkgRoot || file.startsWith(pkgRoot + '/')) {
          // Ignore test files that serve only within CI/CD (e.g. test.sh, test-version.sh)
          const filename = file.split('/').pop();
          if (filename === 'test.sh' || filename === 'test-version.sh') {
            continue;
          }

          packageModifiedFilesCount++;

          // If file is newly added or deleted, it's not a minor change
          if (addedFiles.has(file) || deletedFiles.has(file)) {
            packageHasOnlyMinorChanges = false;
            break;
          }

          const changes = fileChanges[file];
          if (!isFileChangeMinor(file, changes.added, changes.deleted)) {
            packageHasOnlyMinorChanges = false;
            break;
          }
        }
      }

      if (packageModifiedFilesCount === 0) {
        packageHasOnlyMinorChanges = false;
      }

      if (packageHasOnlyMinorChanges) {
        successes.push(`✅ Package \`${pkgRoot}\` content changed with only minor/cosmetic updates, no PKG_RELEASE bump required`);
      } else {
        errors.push(`Package \`${pkgRoot}\` content changed without a PKG_RELEASE or version bump
- **Do not increment release for minor changes.** Cosmetic edits (e.g., typos in comments, copyright updates, formatting/whitespace), changing the package maintainer (\`PKG_MAINTAINER\`), or updating source download info (\`PKG_SOURCE_URL\` / \`PKG_HASH\`) do not require incrementing \`PKG_RELEASE\`.`);
      }
    } else if (versionChanged) {
      if (headRelease !== '1') {
        errors.push(`Package \`${pkgRoot}\` version updated from '${baseVersion || baseSourceVer || baseSourceDate}' to '${headVersion || headSourceVer || headSourceDate}', but PKG_RELEASE was not reset to 1 (currently: '${headRelease || 'not defined'}')`);
      } else {
        successes.push(`✅ Package \`${pkgRoot}\` version updated to '${headVersion || headSourceVer || headSourceDate}' and PKG_RELEASE correctly reset to 1`);
      }
    } else {
      successes.push(`✅ Package \`${pkgRoot}\` version unchanged, but PKG_RELEASE bumped from '${baseRelease}' to '${headRelease}'`);
    }
  }

  return { errors, warnings, successes };
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

  for (const file of changedFiles) {
    if (deletedFiles.has(file)) continue;
    if (isHiddenOrSpecial(file)) continue;

    // A file could be destined for /etc/config/ if its path contains /etc/config/
    // or if it's in a files/ directory.
    const isCandidate = file.includes('/etc/config/') || file.includes('/files/');
    if (!isCandidate) continue;

    const pkgRoot = await findPkgRoot(file, fetchFileContent, pkgRootCache);
    if (!pkgRoot) continue;

    let makefileContent = null;
    try {
      makefileContent = await fetchFileContent(`${pkgRoot}/Makefile`);
    } catch (e) {
      // Ignore errors fetching the Makefile
    }

    const filename = file.split('/').pop();
    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    const skipExtensions = new Set(['init', 'sh', 'hotplug', 'py', 'pl', 'lua', 'cron', 'md', 'patch', 'sed', 'defaults', 'uc']);
    if (skipExtensions.has(ext)) continue;

    let isDestinedForEtcConfig = false;
    if (file.includes('/etc/config/')) {
      isDestinedForEtcConfig = true;
    } else if (makefileContent) {
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
          errors.push(`- File '${file}' is destined for '/etc/config/' but is not a valid UCI configuration file. In OpenWrt, '/etc/config/' is reserved for UCI-formatted configuration files. Raw files (such as TOML, JSON, or YAML) are not allowed at this path. Invalid line ${invalidLineNum}: '${invalidLine}'`);
        } else {
          successes.push(`✅ Configuration file '${file}' destined for '/etc/config/' is a valid UCI configuration file`);
        }
      }
    }
  }

  return { errors, successes };
}

