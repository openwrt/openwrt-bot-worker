export function isValidName(name) {
  const nameRegex = /^[\p{L}'.-]+(?: [\p{L}'.-]+)+$/u;
  return nameRegex.test(name);
}

export function getNormalizedText(str, pkgName) {
  let cleaned = str.toLowerCase();
  if (pkgName) {
    cleaned = cleaned.replace(new RegExp(pkgName.toLowerCase(), 'g'), '');
  }
  // Remove common list bullet markers and generic words
  cleaned = cleaned.replace(/^[\s\-*+•#]+/, '');
  // Remove leading 'v' before a digit (e.g., v1.2 -> 1.2, but keep words like version)
  cleaned = cleaned.replace(/\bv(?=\d)/g, '');
  // Remove all non-alphanumeric characters
  return cleaned.replace(/[^a-z0-9]/g, '');
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
    if (authorEmail.includes('noreply.github.com')) identityErrors.push("Author email must not be a GitHub noreply address");
    if (committerEmail.includes('noreply.github.com')) identityErrors.push("Committer email must not be a GitHub noreply address");
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
    if (!/^[a-zA-Z0-9_-]+: /.test(subject)) {
      subjectErrors.push("Commit subject must start with \`<package name or prefix>: \`");
    } else {
      const afterPrefix = subject.replace(/^[a-zA-Z0-9_-]+: \s*/, '');
      if (afterPrefix.length > 0 && afterPrefix[0] === afterPrefix[0].toUpperCase() && /[a-zA-Z]/.test(afterPrefix[0])) {
        subjectErrors.push("Commit subject must start with a lower-case word after the prefix");
      }
    }
    if (subject.endsWith('.')) {
      subjectErrors.push("Commit subject must not end with a period");
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
      const normSubject = getNormalizedText(lines[0], pkgName);
      const normBody = getNormalizedText(fullCleanBody, pkgName);

      if (normSubject === normBody || (normBody.includes(normSubject) && normBody.length < normSubject.length + 20) || (normSubject.includes(normBody) && normSubject.length < normBody.length + 20)) {
        warnings.push("Commit subject and description body are identical or virtually identical. Avoid repeating the subject line in the body; provide context instead.");
      }
    }
    if (CONFIG.require_release_notes && !/https?:\/\/[^\s]+/i.test(fullCleanBody)) {
      warnings.push("No reference link (e.g., upstream release notes, changelog, or history URL) detected in description.");
    }
  }

  // Body lines width check
  const bodyErrors = [];
  lines.forEach((line, index) => {
    if (index === 0) return;
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
    const signoffErrors = [];
    lines.forEach(line => {
      const matches = line.match(signoffPattern);
      if (matches) {
        hasSignoff = true;
        const sobName = matches[1].trim();
        const sobEmail = matches[2].trim();

        if (sobName.toLowerCase() !== authorName.toLowerCase() || sobEmail.toLowerCase() !== authorEmail.toLowerCase()) {
          signoffErrors.push(`Signed-off-by value (\`${sobName} <${sobEmail}>\`) does not match commit author (\`${authorName} <${authorEmail}>\`)`);
        }
        if (sobEmail.includes('noreply.github.com')) {
          signoffErrors.push("Signed-off-by email must not be a GitHub noreply address");
        }
      }
    });
    if (!hasSignoff) {
      errors.push("- Missing 'Signed-off-by:' line");
    } else if (signoffErrors.length > 0) {
      signoffErrors.forEach(err => errors.push("- " + err));
    } else {
      successes.push("✅ Commit contains a consistent and valid 'Signed-off-by:' line");
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

export function validateMakefileContext(fullCommit, commitPatch, CONFIG, state) {
  const errors = [];
  const successes = [];
  const subject = (fullCommit.commit.message || '').split("\n")[0].trim();

  if (!commitPatch) {
    return { errors: [], successes: ["✅ No codebase text files changed to analyze"] };
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
      const cleanSubject = subject.replace(/^(fixup!|squash!)\s+/, '');
      if (!cleanSubject.includes(newVersion)) {
        errors.push(`- Makefile introduces PKG_VERSION '${newVersion}', but this version string is missing in the commit subject line`);
      } else {
        successes.push(`✅ PKG_VERSION bump matches context information inside subject line (${newVersion})`);
      }
    }
  }

  if (CONFIG.check_openwrt_meta && isNewPackageThisCommit) {
    const requiredMeta = ['PKG_MAINTAINER', 'PKG_LICENSE', 'PKG_LICENSE_FILES'];
    requiredMeta.forEach(meta => {
      const metaRegex = new RegExp(`^\\+\\s*${meta}\\s*(?::=|=)`, 'm');
      if (!metaRegex.test(commitPatch)) {
        errors.push(`- New OpenWrt package is missing the mandatory parameter: '${meta}'`);
      } else {
        successes.push(`✅ Mandatory structural metadata present: '${meta}'`);
      }
    });
  }

  if (CONFIG.check_conffiles && /INSTALL_CONF/m.test(commitPatch)) {
    if (!/define\s+Package\/[a-zA-Z0-9_.-]+\/conffiles/m.test(commitPatch)) {
      errors.push("- Makefile triggers 'INSTALL_CONF', but is missing the required 'conffiles' tracking macro configuration block");
    } else {
      successes.push("✅ Makefile conffiles macro properly registers INSTALL_CONF tracking parameters");
    }
  }

  if (CONFIG.check_crlf) {
    if (/^\+.*\r$/m.test(commitPatch)) {
      errors.push("- Windows style line endings (CRLF) detected inside added source lines. Use UNIX (LF) formatting exclusively");
    } else {
      successes.push("✅ File additions contain clean UNIX (LF) line termination");
    }
  }

  return { errors, successes };
}

export async function validateEmbeddedPatches(commitPatch, CONFIG, fetchFileContent) {
  const errors = [];
  const successes = [];

  if (!CONFIG.check_patch_headers || !commitPatch) {
    return { errors: [], successes: ["✅ Patches validation skipped or no diff footprint present"] };
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
        let hasFrom = false;
        let hasSubject = false;
        let checked = false;

        if (fetchFileContent) {
          try {
            const rawContent = await fetchFileContent(patchFile);
            if (rawContent !== null) {
              hasFrom = /^From:\s+.+/m.test(rawContent);
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
          hasFrom = /^\+\s*From:\s+.+/m.test(chunk);
          hasSubject = /^\+\s*Subject:\s+.+/m.test(chunk);
        }

        if (!hasFrom || !hasSubject) {
          errors.push(`- Embedded patch file '${patchFile}' violates standard guidelines. Missing required Git header parameters ('From:' / 'Subject:') to ensure 'git am' application compatibility`);
        } else {
          successes.push(`✅ Embedded patch '${patchFile}' contains valid Git compliance headers`);
        }
      }
    }
  }

  return { errors, successes };
}
