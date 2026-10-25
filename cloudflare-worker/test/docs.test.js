import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';

// docs/configuration.md is the list of keys a repository can set, so it has a
// row for every key and for nothing else.
test('docs/configuration.md has one row for every configuration key', () => {
  const doc = readFileSync(new URL('../../docs/configuration.md', import.meta.url), 'utf8');
  const rows = [...doc.matchAll(/^\| `([a-z_]+)` \|/gm)].map(m => m[1]);
  assert.deepStrictEqual([...rows].sort(), Object.keys(DEFAULT_CONFIG).sort());
});
