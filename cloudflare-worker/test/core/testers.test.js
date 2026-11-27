import { describe, test } from 'node:test';
import assert from 'node:assert';
import { codeownersPatternRegex, parseTesterEntries, matchTesters } from '../../src/core/testers.ts';

// The examples from GitHub's CODEOWNERS documentation.
describe('codeownersPatternRegex', () => {
  for (const [pattern, matches, misses] of [
    ['*', ['README.md', 'a/b/c.txt'], []],
    ['*.js', ['app.js', 'src/lib/app.js'], ['app.jsx', 'src/app.ts']],
    ['/build/logs/', ['build/logs/a.log', 'build/logs/old/b.log'], ['src/build/logs/a.log', 'build/logs']],
    ['docs/*', ['docs/getting-started.md'], ['docs/build-app/troubleshooting.md']],
    ['apps/', ['apps/a.js', 'src/apps/b/c.js'], ['myapps/a.js']],
    ['/docs/', ['docs/a.md', 'docs/x/y.md'], ['src/docs/a.md']],
    ['**/logs', ['logs/a', 'build/logs/a', 'deeply/nested/logs/a'], ['catalogs/a']],
    ['/apps/github', ['apps/github', 'apps/github/x.js'], ['apps/githubber/x.js']],
    ['/target/linux/mediatek/dts/*bpi-r3*', ['target/linux/mediatek/dts/mt7986a-bananapi-bpi-r3.dts'], ['target/linux/mediatek/dts/sub/bpi-r3.dts']]
  ]) {
    test(pattern, () => {
      const re = codeownersPatternRegex(pattern);
      for (const path of matches) assert.ok(re.test(path), `${pattern} should match ${path}`);
      for (const path of misses) assert.ok(!re.test(path), `${pattern} should not match ${path}`);
    });
  }
});

describe('parseTesterEntries', () => {
  const CODEOWNERS = [
    '# Owners',
    '/package/network/services/dropbear/ @owner # rft: @dave',
    '# rft: /target/linux/mediatek/ @alice @Bob',
    '# RFT: /target/linux/mediatek/dts/*bpi-r3* @carol',
    '*.md @docs-owner # not a tester line',
    '/target/linux/ramips/ # rft: @erin',
    '# rft: @frank',
    '# rft: /target/linux/x86/ alice'
  ].join('\n');

  test('reads comment lines and comments after an owner line', () => {
    const { entries } = parseTesterEntries(CODEOWNERS);
    assert.deepStrictEqual(entries.map(e => [e.line, e.pattern, e.logins]), [
      [2, '/package/network/services/dropbear/', ['dave']],
      [3, '/target/linux/mediatek/', ['alice', 'Bob']],
      [4, '/target/linux/mediatek/dts/*bpi-r3*', ['carol']],
      [6, '/target/linux/ramips/', ['erin']]
    ]);
  });

  test('names what it could not use', () => {
    const { problems } = parseTesterEntries(CODEOWNERS);
    assert.deepStrictEqual(problems, [
      'line 6 has a pattern with no owner, which GitHub reads as clearing ownership. Put its testers on a comment line of their own.',
      'line 7 names no pattern for its testers.',
      "line 8: 'alice' is not a GitHub login.",
      'line 8 names no testers.'
    ]);
  });

  test('takes text after another # as a note', () => {
    const { entries, problems } = parseTesterEntries('# rft: /target/linux/mediatek/ @alice @bob # BPi-R3, AX3000T');
    assert.deepStrictEqual(entries.map(e => e.logins), [['alice', 'bob']]);
    assert.deepStrictEqual(problems, []);
  });

  test('answers nothing for a missing file', () => {
    assert.deepStrictEqual(parseTesterEntries(null), { entries: [], problems: [] });
  });
});

describe('matchTesters', () => {
  const { entries } = parseTesterEntries([
    '# rft: /target/linux/mediatek/ @alice @bob',
    '# rft: /target/linux/mediatek/dts/*bpi-r3* @carol @Alice',
    '# rft: /target/linux/x86/ @dave'
  ].join('\n'));

  test('adds up every matching entry, once per login', () => {
    const testers = matchTesters(entries, ['target/linux/mediatek/dts/mt7986a-bananapi-bpi-r3.dts']);
    assert.deepStrictEqual([...testers.values()], ['alice', 'bob', 'carol']);
  });

  test('matches nobody for unrelated files', () => {
    assert.strictEqual(matchTesters(entries, ['package/utils/busybox/Makefile']).size, 0);
  });
});
