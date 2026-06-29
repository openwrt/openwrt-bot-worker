export function isValidName(name) {
  const pLRegex = /^[A-Z\p{L}a-z]+( [A-Z\p{L}a-z]+)+$/u;
  const fallbackRegex = /^[a-zA-Z0-9_-]+$/;
  return pLRegex.test(name) || fallbackRegex.test(name);
}

// --- ENGINE CHECKS ---
export function validateFormalities(fullCommit, CONFIG) {
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
      subjectErrors.push("Commit subject must start with '<package name or prefix>: '");
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
      const coreSubject = lines[0].replace(/^[a-zA-Z0-9_-]+: \s*/, '').trim();
      if (coreSubject.toLowerCase() === fullCleanBody.toLowerCase() || lines[0].toLowerCase() === fullCleanBody.toLowerCase()) {
        warnings.push("Commit subject and description body are identical. Avoid repeating the subject line in the body; provide context instead.");
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
          signoffErrors.push(`Signed-off-by value (${sobName} <${sobEmail}>) does not match commit author (${authorName} <${authorEmail}>)`);
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
        const cleanSig = sigText.replace(/[^a-zA-Z0-9+\/]/g, '');
        if (cleanSig) {
          keyDetails = ` (SSH Key snippet: ...${cleanSig.slice(-12)})`;
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

  if (/^---\s+\/dev\/null\r?\n\+\+\+\s+b\/(?:.*\/)?Makefile\r?$/m.test(commitPatch)) {
    state.isNewPackage = true;
  }

  if (/^---\s+a\/(?:.*\/)?Makefile\r?\n\+\+\+\s+\/dev\/null\r?$/m.test(commitPatch)) {
    state.isDroppedPackage = true;
  }

  if (CONFIG.check_pkg_version) {
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

  if (CONFIG.check_openwrt_meta && state.isNewPackage) {
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

export function validateEmbeddedPatches(commitPatch, CONFIG) {
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
  fileChunks.forEach(chunk => {
    patchFiles.forEach(patchFile => {
      if (chunk.includes('b/' + patchFile)) {
        const hasFrom = /^\+\s*From:\s+.+/m.test(chunk);
        const hasSubject = /^\+\s*Subject:\s+.+/m.test(chunk);

        if (!hasFrom || !hasSubject) {
          errors.push(`- Embedded patch file '${patchFile}' violates standard guidelines. Missing required Git header parameters ('From:' / 'Subject:') to ensure 'git am' application compatibility`);
        } else {
          successes.push(`✅ Embedded patch '${patchFile}' contains valid Git compliance headers`);
        }
      }
    });
  });

  return { errors, successes };
}
