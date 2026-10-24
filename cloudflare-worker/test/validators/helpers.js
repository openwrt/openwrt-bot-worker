import assert from 'node:assert';
import { appendFileSync, readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

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
  check_binary_files: true,
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

// A file from test/fixtures.
export const readFixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

// Assertions that print what the validator actually reported when they fail.
export const assertSomeIncludes = (list, text, what = 'entries') =>
  assert.ok(list.some(entry => entry.includes(text)), `no ${what} contain ${JSON.stringify(text)}: ${JSON.stringify(list)}`);
export const assertNoneIncludes = (list, text, what = 'entries') =>
  assert.ok(!list.some(entry => entry.includes(text)), `${what} contain ${JSON.stringify(text)}: ${JSON.stringify(list)}`);
export const assertNoErrors = (res) => assert.deepStrictEqual(res.errors, []);
export const assertErrorIncludes = (res, text) => assertSomeIncludes(res.errors, text, 'errors');
export const assertNoErrorIncludes = (res, text) => assertNoneIncludes(res.errors, text, 'errors');

// What one arm of a cost test costs against another, as a ratio of thread CPU
// time. Time the thread spends descheduled on a busy machine is in neither
// arm, and the arms alternate round by round, so the load that is left
// (caches, clock speed) weighs on both at once. A bound in milliseconds can do
// neither: loose enough for a loaded runner, it misses a 10 ms regression,
// and tight enough to see one, it fails the deploy.
//
// `arms` runs in a worker thread, so a regression that blocks for seconds
// fails at the cut-off with a message instead of hanging the suite. It is
// handed over as source and must be self-contained: it gets the validators
// module, this module and `data`, and returns { base, measured }, each doing
// one unit of work. Both repeat until a round lasts `minRoundMs` and ten steps
// of the thread clock as sampled when the worker starts: macOS counts
// microseconds, but Linux, where CI runs, counts scheduler ticks of 1-4 ms,
// and a context switch can make a sampled step shorter than a tick. A round in
// which either arm read under half its length is dropped and the repetitions
// grow, so a read of no clock step never becomes a ratio. Once the measured
// arm has spent `budgetMs` the rounds stop, so the unfixed shape fails on its
// ratio rather than at the cut-off. It resolves to { ratio, measuredMs, base,
// measured }: the median ratio of the rounds, the median thread CPU
// milliseconds one call of the measured arm took, and what each arm returned
// last (the raw `ratios`, `reps`, `tickMs` and `roundMs` come along for
// COST_RATIO_LOG). The ratio catches a change of shape; a slowdown that hits
// both arms alike leaves it near 1, so a test that must also stay cheap
// asserts a ceiling on measuredMs. `clock`, for this helper's own tests,
// replaces the thread clock with one that returns milliseconds.
const THREAD_CLOCK = '() => { const { user, system } = process.threadCpuUsage(); return (user + system) / 1000; }';
const RATIO_WORKER = (source, clock) => `
  import { parentPort, workerData } from 'node:worker_threads';
  const { data, validators, helpers, minRoundMs, budgetMs, rounds } = workerData;
  const cpu = ${clock};
  const { base, measured } = await (${source})({ validators: await import(validators), helpers: await import(helpers), data });
  const time = async (arm, reps) => {
    let last;
    let calls = 0;
    const started = cpu();
    while (calls < reps) {
      last = await arm();
      calls++;
      if (cpu() - started > budgetMs) break;
    }
    const total = cpu() - started;
    return { total, perCall: total / calls, last };
  };
  await time(base, 1);
  let m = await time(measured, 1);
  // How far the clock moves at a time, read once start-up is over: a step
  // near the top of 15, since a thread switched out mid-tick sees a part of
  // one, and the largest can be a catch-up of several.
  const steps = [];
  for (let last = cpu(), reads = 0; steps.length < 15 && reads < 1e8; reads++) {
    const now = cpu();
    if (now !== last) { steps.push(now - last); last = now; }
  }
  if (steps.length < 15) throw new Error('the thread clock did not advance');
  const tickMs = steps.sort((x, y) => x - y)[11];
  const roundMs = Math.max(minRoundMs, 10 * tickMs);
  let spent = m.total;
  let reps = 1;
  let b = await time(base, reps);
  while (reps < 1e6 && b.total < roundMs) b = await time(base, reps *= 2);
  if (b.total < roundMs) throw new Error('the base arm costs nothing the thread clock can see');
  let ref = b;
  const ratios = [];
  const perCall = [];
  for (let round = 0, tries = 0; round < rounds && spent < budgetMs && tries < 4 * rounds; tries++) {
    if (round % 2 === 0) { b = await time(base, reps); m = await time(measured, reps); }
    else { m = await time(measured, reps); b = await time(base, reps); }
    spent += m.total;
    const shorter = Math.min(b.total, m.total);
    if (shorter < roundMs / 2) {
      // Too few ticks to tell: one cold call ended the calibration early, or
      // the measured arm is far cheaper than the base. Grow and run again.
      reps = Math.min(1e6, Math.ceil(reps * Math.min(64, Math.max(2, roundMs / Math.max(shorter, tickMs)))));
      continue;
    }
    ref = b;
    ratios.push(m.perCall / b.perCall);
    perCall.push(m.perCall);
    round++;
  }
  // The measured arm spent the whole budget before a round counted.
  if (ratios.length === 0 && m.total >= roundMs / 2) { ratios.push(m.perCall / ref.perCall); perCall.push(m.perCall); }
  if (ratios.length === 0) throw new Error(\`no round lasted \${roundMs} ms on both arms\`);
  const median = (xs) => xs.sort((x, y) => x - y)[xs.length >> 1];
  parentPort.postMessage({ ratio: median(ratios), ratios, measuredMs: median(perCall), reps, tickMs, roundMs, base: b.last, measured: m.last });
`;

export const cpuRatio = async (arms, data = {}, { what = 'the measured arm', rounds = 9, minRoundMs = 4, budgetMs = 3000, cutOffMs = 20000, clock = THREAD_CLOCK } = {}) => {
  const worker = new Worker(RATIO_WORKER(arms.toString(), clock.toString()), {
    eval: true,
    workerData: {
      data,
      validators: new URL('../../src/validators.js', import.meta.url).href,
      helpers: import.meta.url,
      minRoundMs,
      budgetMs,
      rounds
    }
  });
  let watch;
  try {
    return await new Promise((settle, fail) => {
      // The cut-off counts the worker's CPU time as well, so a loaded machine
      // cannot trip it; only where Node cannot tell does it count wall time.
      const onCpu = typeof worker.cpuUsage === 'function';
      const cutOff = () => fail(new Error(`${what} did not settle within ${cutOffMs / 1000} s of ${onCpu ? 'CPU' : 'wall time'}`));
      watch = onCpu
        ? setInterval(() => worker.cpuUsage().then(({ user, system }) => { if ((user + system) / 1000 > cutOffMs) cutOff(); }, () => {}), 250)
        : setTimeout(cutOff, cutOffMs);
      worker.on('message', (value) => {
        // Set COST_RATIO_LOG to a file to collect every ratio, e.g. to see how
        // far a bound sits from what a loaded machine measures.
        if (process.env.COST_RATIO_LOG) appendFileSync(process.env.COST_RATIO_LOG, `${JSON.stringify({ what, ratio: value.ratio, ratios: value.ratios, measuredMs: value.measuredMs, reps: value.reps, tickMs: value.tickMs, roundMs: value.roundMs })}\n`);
        settle(value);
      });
      worker.on('error', fail);
      worker.on('exit', (code) => fail(new Error(`the cost worker exited with code ${code} before it reported`)));
    });
  } finally {
    clearTimeout(watch);
    await worker.terminate();
  }
};
