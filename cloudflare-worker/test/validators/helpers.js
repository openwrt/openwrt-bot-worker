import assert from 'node:assert';

// Configuration shared by the validator tests.
// Mock Config Object
export const CONFIG = {
  check_branch: true,
  check_merge_commits: true,
  check_noreply_email: true,
  check_signoff: true,
  check_signature: true,
  allow_autosquash: true,
  enable_comments: true,
  show_force_push_tip: true,
  max_subject_len_soft: 60,
  max_subject_len_hard: 80,
  max_body_line_len: 100,
  warn_duplicate_body: true,
  warn_generic_subjects: true,
  require_release_notes: true,
  require_body: true,
  check_pkg_version: true,
  check_crlf: true,
  check_trailing_newline: true,
  add_package_label: true,
  drop_package_label: true,
  branch_labeling: true,
  check_openwrt_meta: true,
  check_conffiles: true,
  check_pkg_name_reuse: true,
  check_buildbot_default: 'warning',
  check_patch_headers: true,
  require_linked_github_account: false,
  check_openwrt_spelling: true
};

// The identity most tests commit as.
export const JOHN = Object.freeze({ name: 'John Doe', email: 'john@doe.com' });

// A commit in the shape the validators read from the GitHub API. Only the
// fields a test names are present, so a test about a missing committer can
// still leave it out.
export const makeCommit = (message, fields = {}) => ({ commit: { message, ...fields } });

// A commit authored and committed by the same person.
export const commitBy = (message, person = JOHN) => makeCommit(message, { author: person, committer: person });

// What validateMakefileContext is told about the package. A fresh object on
// every call, since a validator may record what it finds in it.
export const existingPackage = () => ({ isNewPackage: false, isDroppedPackage: false });
export const newPackage = () => ({ isNewPackage: true, isDroppedPackage: false });
export const droppedPackage = () => ({ isNewPackage: false, isDroppedPackage: true });

// A diff of one existing file: its header pair, then lines that already carry
// their +, - or space prefix.
export const fileDiff = (path, lines) => `--- a/${path}\n+++ b/${path}\n${lines.join('\n')}\n`;

// A diff exactly as the Makefile tests have always written it in a template
// literal: a newline, the lines, then the closing backtick's indentation as a
// line of its own, which the Makefile checks read as one more context line.
// Lines carry their own +, - or space prefix; nested arrays are flattened, so a
// file header below can be passed as one argument. fileDiff above has neither
// the leading newline nor that last line.
export const diff = (...lines) => `\n${[...lines.flat(Infinity), '    '].join('\n')}`;

// File headers for diff(), with or without git's own `diff --git` line.
export const modified = (path) => [`--- a/${path}`, `+++ b/${path}`];
export const added = (path) => ['--- /dev/null', `+++ b/${path}`];
export const removed = (path) => [`--- a/${path}`, '+++ /dev/null'];
export const gitModified = (path) => [`diff --git a/${path} b/${path}`, ...modified(path)];
export const gitAdded = (path) => [`diff --git a/${path} b/${path}`, ...added(path)];

// Assertions that print what the validator actually reported when they fail.
export const assertSomeIncludes = (list, text, what = 'entries') =>
  assert.ok(list.some(entry => entry.includes(text)), `no ${what} contain ${JSON.stringify(text)}: ${JSON.stringify(list)}`);
export const assertNoneIncludes = (list, text, what = 'entries') =>
  assert.ok(!list.some(entry => entry.includes(text)), `${what} contain ${JSON.stringify(text)}: ${JSON.stringify(list)}`);
export const assertNoErrors = (res) => assert.deepStrictEqual(res.errors, []);
export const assertErrorIncludes = (res, text) => assertSomeIncludes(res.errors, text, 'errors');
export const assertNoErrorIncludes = (res, text) => assertNoneIncludes(res.errors, text, 'errors');
