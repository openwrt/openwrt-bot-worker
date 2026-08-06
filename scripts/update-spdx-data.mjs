#!/usr/bin/env node
// Regenerates cloudflare-worker/src/spdx-licenses.js from the official SPDX
// license list. Run it whenever a new SPDX release should be picked up:
//
//   node scripts/update-spdx-data.mjs
//
// The deprecated -> replacement mapping is derived mechanically (a bare
// version reads as '-only', a '+' suffix as '-or-later', 'X-with-Y-exception'
// as 'X WITH Y') and every derived value is verified against the current
// identifier list. Ids SPDX retired without a mechanical successor are
// emitted with an empty replacement, so the bot names none rather than
// inventing one.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'https://raw.githubusercontent.com/spdx/license-list-data/main/json';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'cloudflare-worker', 'src', 'spdx-licenses.js');

const fetchJson = async (name) => {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`Failed to fetch ${name}: HTTP ${res.status}`);
  return res.json();
};

const licenseData = await fetchJson('licenses.json');
const exceptionData = await fetchJson('exceptions.json');

const version = licenseData.licenseListVersion;
const valid = licenseData.licenses.filter(l => !l.isDeprecatedLicenseId).map(l => l.licenseId).sort();
const deprecated = licenseData.licenses.filter(l => l.isDeprecatedLicenseId).map(l => l.licenseId).sort();
const exceptions = exceptionData.exceptions.filter(e => !e.isDeprecatedLicenseId).map(e => e.licenseExceptionId).sort();

const validSet = new Set(valid);
const exceptionsLower = new Map(exceptions.map(e => [e.toLowerCase(), e]));

function replacementFor(id) {
  const withExc = id.match(/^(.*?)-with-(.*?)-exception$/i);
  if (withExc) {
    const base = `${withExc[1]}-only`;
    const candidates = [...exceptionsLower.keys()].filter(k => k.startsWith(`${withExc[2].toLowerCase()}-exception`));
    if (validSet.has(base) && candidates.length === 1) {
      return `${base} WITH ${exceptionsLower.get(candidates[0])}`;
    }
    return '';
  }
  if (id.endsWith('+')) {
    const orLater = `${id.slice(0, -1)}-or-later`;
    return validSet.has(orLater) ? orLater : '';
  }
  // A bare versioned id is ambiguous, so both readings are offered.
  const only = `${id}-only`;
  const orLater = `${id}-or-later`;
  if (validSet.has(only) && validSet.has(orLater)) return `${only} or ${orLater}`;
  if (validSet.has(only)) return only;
  return '';
}

const pairs = deprecated.map(id => `${id}=${replacementFor(id)}`);

const contents = `// Generated file. Do not edit.
// Source: https://github.com/spdx/license-list-data (release ${version})
// Regenerate with: node scripts/update-spdx-data.mjs
export const SPDX_LICENSE_LIST_VERSION = '${version}';

export const SPDX_LICENSE_IDS = new Set('${valid.join(' ')}'.split(' '));

export const SPDX_EXCEPTION_IDS = new Set('${exceptions.join(' ')}'.split(' '));

// Deprecated identifier -> the replacement SPDX publishes for it. An empty
// value means SPDX retired the id without a mechanical successor.
export const SPDX_DEPRECATED = new Map('${pairs.join('|')}'.split('|').map(e => e.split('=')));
`;

writeFileSync(OUT, contents);
console.log(`Wrote ${OUT}`);
console.log(`SPDX ${version}: ${valid.length} identifiers, ${exceptions.length} exceptions, ${deprecated.length} deprecated (${pairs.filter(p => !p.endsWith('=')).length} with a derived replacement)`);
