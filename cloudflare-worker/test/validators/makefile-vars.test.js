import { describe, test } from 'node:test';
import assert from 'node:assert';
import { extractConffilesMap, extractDefinedPackages, resolveMakefileVar } from '../../src/validators.js';

// What one reading of a text costs, as the fastest of five runs: the first
// also pays for compiling the code under it, which is several times what the
// reading costs, and taking the fastest is what keeps one descheduled run from
// deciding the answer. Used below to pin a cost as a RATIO between two sizes
// of one dimension rather than as a bound in milliseconds. A bound close
// enough to the unfixed cost to discriminate is missed by 4-40x whenever the
// test runner puts another file's process on the same core, which turned the
// suite red in most contended runs; a ratio inflates on both arms at once.
const costOf = (read) => {
  let best = Infinity;
  let out;
  for (let run = 0; run < 5; run++) {
    const started = performance.now();
    out = read();
    best = Math.min(best, performance.now() - started);
  }
  return { best, out };
};

describe('resolveMakefileVar', () => {
  test('resolves a chain, a cycle and an unset variable', () => {
    const content = 'PKG_VERSION:=$(MAJOR).$(PATCH)\nMAJOR:=1\nPATCH:=2\n';
    assert.strictEqual(resolveMakefileVar(content, 'PKG_VERSION'), '1.2');
    assert.strictEqual(resolveMakefileVar('A:=$(B)\nB:=$(A)\n', 'A'), '');
    assert.strictEqual(resolveMakefileVar(content, 'NOPE'), null);
  });

  // Guards the shared expansion budget. Every branch of the walk carries its
  // own `seen`, so without the budget this chain expands both $(V) on each
  // line in full: 2^18 calls building a 262144-character PKG_RELEASE, which
  // alone is far past the Worker CPU limit. Depth 18 is bounded on purpose -
  // it costs ~0.4 s unfixed instead of the minutes a deeper chain would.
  test('bounds a doubling variable chain instead of expanding it 2^n times', () => {
    const lines = ['PKG_NAME:=demo', 'PKG_VERSION:=1.0', 'PKG_RELEASE:=$(V0)'];
    for (let i = 0; i < 18; i++) lines.push(`V${i}:=$(V${i + 1})$(V${i + 1})`);
    lines.push('V18:=1');

    const started = Date.now();
    const value = resolveMakefileVar(lines.join('\n'), 'PKG_RELEASE');
    const elapsed = Date.now() - started;

    assert.ok(value.length < 1024, `PKG_RELEASE grew to ${value.length} characters`);
    assert.ok(elapsed < 200, `resolving a ${lines.join('\n').length}-byte Makefile took ${elapsed} ms`);
  });

  // The same chain with a long literal on every line: counting expansions
  // alone still allows one assignment's length times the budget, so the budget
  // counts the characters built as well. Depth 10 keeps the unfixed value at a
  // couple of megabytes rather than gigabytes.
  test('bounds the value a doubling chain builds, not only the expansions', () => {
    const padding = 'x'.repeat(2000);
    const lines = ['PKG_RELEASE:=$(V0)'];
    for (let i = 0; i < 10; i++) lines.push(`V${i}:=$(V${i + 1})${padding}$(V${i + 1})`);
    lines.push('V10:=1');

    const value = resolveMakefileVar(lines.join('\n'), 'PKG_RELEASE');
    assert.ok(value.length < 128 * 1024, `PKG_RELEASE grew to ${value.length} characters`);
  });

  // `seen` is the names between the first resolution and this one, and every
  // branch of the walk used to get a copy of it - one copy per expansion, as
  // long as the chain is deep. The walk is depth first, so one set that this
  // name is added to before its references and removed from after leaves
  // every branch the same view, and a Makefile whose names lead into one deep
  // chain stops paying for the copies. `adds` counts the expansions that
  // reach the set the caller passed; before, only the first one did.
  test('threads one set of names down the walk instead of copying it', () => {
    class CountingSet extends Set {
      constructor() { super(); this.adds = 0; }
      add(name) { this.adds++; return super.add(name); }
    }
    const lines = ['PKG_RELEASE:=$(V0)'];
    for (let i = 0; i < 20; i++) lines.push(`V${i}:=$(V${i + 1})$(V${i + 1})`);
    lines.push('V20:=1');

    const seen = new CountingSet();
    const value = resolveMakefileVar(lines.join('\n'), 'PKG_RELEASE', seen);

    assert.ok(seen.adds > 1, `only ${seen.adds} expansion(s) reached the set of names`);
    assert.strictEqual(seen.size, 0, 'the set was left holding names after the walk');
    // Removing the name again is what keeps a name that is not on the path
    // resolvable: two uses of one name in a value are not a cycle, and a
    // real cycle still resolves to ''.
    assert.ok(/^1+$/.test(value), `PKG_RELEASE resolved to '${value.slice(0, 40)}'`);
    assert.strictEqual(resolveMakefileVar('X:=$(A)-$(A)\nA:=1\n', 'X'), '1-1');
    assert.strictEqual(resolveMakefileVar('X:=$(A)$(B)$(A)\nA:=1\nB:=$(A)2\n', 'X'), '1121');
    assert.strictEqual(resolveMakefileVar('A:=$(B)\nB:=$(A)\n', 'A'), '');
  });
});

describe('extractConffilesMap', () => {
  // The budget bounds one resolution, and a resolution that runs into it still
  // costs a fraction of a millisecond, so resolving every '$(VAR)' on every
  // line from scratch put a conffiles block of a few dozen entries over the
  // whole Worker CPU limit. The Makefile says the same thing about a name
  // whichever line asks, so a name is resolved once for the extraction and
  // read out of the text once per resolution.
  //
  // The dimension that must not multiply the resolution is how many entries
  // name the variable, so the same block is read with one entry and with 500:
  // resolving once makes the two cost about the same, resolving per line makes
  // the second hundreds of times the first.
  test('resolves each variable once for a whole conffiles block', () => {
    const block = (entries) => {
      const lines = ['PKG_NAME:=foo'];
      for (let i = 0; i < 40; i++) lines.push(`V${i}:=$(V${i + 1})$(V${i + 1})`);
      lines.push('V40:=1');
      lines.push('define Package/foo/conffiles');
      for (let i = 0; i < entries; i++) lines.push(`/etc/config/e${i}$(V0)`);
      lines.push('endef');
      return lines.join('\n');
    };
    const one = block(1);
    const content = block(500);

    const single = costOf(() => extractConffilesMap(one));
    const many = costOf(() => extractConffilesMap(content));

    assert.ok(many.best < single.best * 10 + 5,
      `500 entries naming one variable cost ${many.best.toFixed(1)} ms against ${single.best.toFixed(1)} ms for one: the variable is resolved per line`);
    // Resolving once must give what resolving per line gave: the guard that
    // this is a saving and not a change of answer.
    const value = resolveMakefileVar(content, 'V0');
    assert.strictEqual(single.out.get('foo').size, 1);
    assert.strictEqual(many.out.get('foo').size, 500);
    assert.deepStrictEqual([...many.out.get('foo')].slice(0, 3), [0, 1, 2].map(i => `/etc/config/e${i}${value}`));
  });

  // Which assignment a name has is a pure function of the text, so reading it
  // belongs to the text and not to one resolution: 40 names that each lead
  // into the same chain of 40 assignments re-read a 97 KB Makefile 1640 times
  // between them. Shared, it is read once per name on the chain. The padding
  // is what a real package Makefile of this size holds.
  //
  // The dimension that must not multiply the read is how many names lead into
  // the chain, so the same Makefile is read with one such name and with 40:
  // sharing the read leaves only the walk down the chain to pay per name,
  // which is a fraction of reading it, while reading per name makes the second
  // some forty times the first. 40 names and not more because the walk itself
  // is linear in the names even when the read is shared, and enough of them
  // make that linear part alone an order of magnitude.
  test('reads an assignment once per Makefile, not once per name leading to it', () => {
    const makefile = (names) => {
      const lines = ['PKG_NAME:=foo'];
      for (let i = 0; i < 1200; i++) lines.push('# ' + 'a'.repeat(78));
      for (let i = 0; i < names; i++) lines.push(`N${i}:=$(A0)${i}`);
      for (let d = 0; d < 40; d++) lines.push(`A${d}:=$(A${d + 1})`);
      lines.push('A40:=z', 'define Package/foo/conffiles');
      for (let i = 0; i < names; i++) lines.push(`/etc/config/c$(N${i})`);
      lines.push('endef');
      return lines.join('\n');
    };
    const one = makefile(1);
    const forty = makefile(40);

    const single = costOf(() => extractConffilesMap(one));
    const many = costOf(() => extractConffilesMap(forty));

    assert.ok(many.best < single.best * 10 + 5,
      `40 names leading into the chain cost ${many.best.toFixed(1)} ms against ${single.best.toFixed(1)} ms for one: the Makefile is read per name`);
    // Sharing the read must give what reading per name gave.
    assert.strictEqual(single.out.get('foo').size, 1);
    assert.strictEqual(many.out.get('foo').size, 40);
    assert.deepStrictEqual([...many.out.get('foo')].slice(0, 3), [0, 1, 2].map(i => `/etc/config/cz${i}`));
  });
});

describe('extractDefinedPackages', () => {
  // A package name written as an expansion is resolved against the Makefile
  // with its patch markers stripped, and that stripped text, plus what each
  // name in it resolves to, was rebuilt for every name asked about. A
  // Makefile defining a sub-package per configuration file asks once per
  // block, and a 123 KB Makefile with nothing pathological in it then spends
  // more than the whole Worker CPU budget here.
  //
  // The dimension that must not multiply the stripping is how many blocks ask
  // for it, so the same padding is read with one block and with 400: stripping
  // once keeps the padding's own cost the whole cost, while stripping per
  // block makes the second hundreds of times the first.
  test('strips the patch markers once per Makefile, not once per package block', () => {
    const chunkOf = (blocks) => {
      const lines = ['+PKG_NAME:=mypkg', '+PKG_VERSION:=1.0'];
      for (let i = 0; i < 1300; i++) lines.push('+# ' + 'a'.repeat(78));
      for (let i = 0; i < blocks; i++) lines.push(`+define Package/$(PKG_NAME)-sub${i}`, '+  TITLE:=x', '+endef', '+');
      return lines.join('\n');
    };
    const one = chunkOf(1);
    const chunk = chunkOf(400);

    const single = costOf(() => extractDefinedPackages(one));
    const many = costOf(() => extractDefinedPackages(chunk));

    assert.ok(many.best < single.best * 10 + 5,
      `400 package blocks cost ${many.best.toFixed(1)} ms against ${single.best.toFixed(1)} ms for one: the markers are stripped per block`);
    assert.strictEqual(single.out.size, 1);
    assert.strictEqual(many.out.size, 400);
    assert.ok(many.out.has('mypkg-sub0') && many.out.has('mypkg-sub399'), `names: ${[...many.out].slice(0, 3)}`);
  });
});
