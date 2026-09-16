import { describe, test } from 'node:test';
import assert from 'node:assert';
import { SPDX_LICENSE_IDS, SPDX_EXCEPTION_IDS, SPDX_DEPRECATED, SPDX_LICENSE_LIST_VERSION } from '../../src/spdx-licenses.js';
import { validateMakefileContext, checkSpdxIdentifier } from '../../src/validators.js';
import { CONFIG, makeCommit, existingPackage, assertSomeIncludes } from './helpers.js';

const assertNoWarnings = (res) => assert.deepStrictEqual(res.warnings, []);

describe('generated SPDX data', () => {
  test('records the SPDX release it was generated from', () => {
    assert.ok(SPDX_LICENSE_LIST_VERSION && SPDX_LICENSE_LIST_VERSION.length > 0);
  });

  test('carries a plausible identifier list', () => {
    assert.ok(SPDX_LICENSE_IDS.size > 500, `only ${SPDX_LICENSE_IDS.size} identifiers`);
    assert.ok(SPDX_EXCEPTION_IDS.size > 50, `only ${SPDX_EXCEPTION_IDS.size} exceptions`);
    assert.ok(SPDX_DEPRECATED.size > 20, `only ${SPDX_DEPRECATED.size} deprecated ids`);
    for (const id of ['MIT', 'GPL-2.0-only', 'Apache-2.0']) {
      assert.ok(SPDX_LICENSE_IDS.has(id), `${id} missing from the generated list`);
    }
  });

  test('never suggests a replacement that is not itself a valid identifier', () => {
    for (const [deprecatedId, replacement] of SPDX_DEPRECATED) {
      assert.ok(!SPDX_LICENSE_IDS.has(deprecatedId), `${deprecatedId} is listed as both valid and deprecated`);
      if (!replacement) continue;
      for (const option of replacement.split(' or ')) {
        const [licenseId, , exceptionId] = option.split(' ');
        assert.ok(SPDX_LICENSE_IDS.has(licenseId), `${deprecatedId} points at unknown identifier '${licenseId}'`);
        if (exceptionId) {
          assert.ok(SPDX_EXCEPTION_IDS.has(exceptionId), `${deprecatedId} points at unknown exception '${exceptionId}'`);
        }
      }
    }
  });
});

describe('checkSpdxIdentifier', () => {
  test('accepts identifiers from the SPDX list', () => {
    for (const id of ['MIT', 'GPL-2.0-only', 'GPL-2.0-or-later', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'Artistic-1.0-Perl', 'PHP-3.01', 'OLDAP-2.8', 'blessing']) {
      assert.strictEqual(checkSpdxIdentifier(id), null, `${id} should be valid`);
    }
  });

  test('accepts LicenseRef- identifiers for licenses SPDX does not list', () => {
    assert.strictEqual(checkSpdxIdentifier('LicenseRef-MaxLinear-Software-License-Agreement'), null);
  });

  test('reports deprecated identifiers with the SPDX replacement', () => {
    assert.deepStrictEqual(checkSpdxIdentifier('GPL-2.0'), {
      reason: 'is deprecated by SPDX',
      suggestion: "'GPL-2.0-only' or 'GPL-2.0-or-later'"
    });
    assert.deepStrictEqual(checkSpdxIdentifier('LGPL-2.1+'), {
      reason: 'is deprecated by SPDX',
      suggestion: "'LGPL-2.1-or-later'"
    });
  });

  test('offers no replacement when SPDX retired an id without a successor', () => {
    const res = checkSpdxIdentifier('GPL-3.0-with-GCC-exception');
    assert.strictEqual(res.reason, 'is deprecated by SPDX');
    assert.strictEqual(res.suggestion, null);
  });

  test('reports wrong capitalization with the exact identifier', () => {
    assert.deepStrictEqual(checkSpdxIdentifier('BSD-2-clause'), {
      reason: 'is written with the wrong capitalization',
      suggestion: "'BSD-2-Clause'"
    });
  });

  test('maps informal GPL spellings onto real identifiers', () => {
    assert.strictEqual(checkSpdxIdentifier('GPLv2').suggestion, "'GPL-2.0-only' or 'GPL-2.0-or-later'");
    assert.strictEqual(checkSpdxIdentifier('GPLv3').suggestion, "'GPL-3.0-only' or 'GPL-3.0-or-later'");
    assert.strictEqual(checkSpdxIdentifier('LGPLv2.1+').suggestion, "'LGPL-2.1-or-later'");
  });

  test('rewrites a hyphenated exception into the WITH operator', () => {
    assert.strictEqual(
      checkSpdxIdentifier('GPL-2.0-or-later-with-Autoconf-exception-2.0').suggestion,
      "'GPL-2.0-or-later WITH Autoconf-exception-2.0'"
    );
  });

  test('fixes the -later slip', () => {
    assert.strictEqual(checkSpdxIdentifier('GPL-3.0-later').suggestion, "'GPL-3.0-or-later'");
  });

  test('splits slash-joined pairs like MIT/X11', () => {
    assert.match(checkSpdxIdentifier('MIT/X11').suggestion, /'MIT' or 'X11'/);
  });

  test('names concrete identifiers for a bare license family', () => {
    assert.strictEqual(checkSpdxIdentifier('BSD').reason, 'names a license family rather than an SPDX identifier');
    assert.strictEqual(checkSpdxIdentifier('Apache').suggestion, "'Apache-2.0'");
    assert.strictEqual(checkSpdxIdentifier('Public-Domain').suggestion, "'CC0-1.0' or 'Unlicense'");
  });

  test('reports placeholders with no invented replacement', () => {
    for (const junk of ['VARIOUS', 'Custom', 'COPYING', 'EULA', 'FREE']) {
      const res = checkSpdxIdentifier(junk);
      assert.strictEqual(res.reason, 'is not a known SPDX identifier');
      assert.strictEqual(res.suggestion, null);
    }
  });
});

describe('validateMakefileContext SPDX licenses', () => {
  const SPDX_CONFIG = { ...CONFIG, check_spdx_license: true };
  // The leading newline and the indented last line are what these patches have
  // always looked like; the validator keeps seeing exactly that.
  const patchWith = (line) => `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+${line}
    `;
  const commit = makeCommit('mypkg: set license');
  const check = (line, config = SPDX_CONFIG) => validateMakefileContext(commit, patchWith(line), config, existingPackage());

  const WARNINGS = [
    ['warns about the deprecated GPL-2.0 identifier', 'PKG_LICENSE:=GPL-2.0', "'GPL-2.0-only' or 'GPL-2.0-or-later'"],
    ['warns about informal spellings like GPLv2+', 'PKG_LICENSE:=GPLv2+', "'GPL-2.0-or-later'"],
    ['warns about a bare BSD license', 'PKG_LICENSE:=BSD', 'BSD-3-Clause'],
    ['checks licenses appended with +=', 'PKG_LICENSE += GPLv2', "'GPL-2.0-only' or 'GPL-2.0-or-later'"]
  ];
  for (const [name, line, suggestion] of WARNINGS) {
    test(name, () => {
      assertSomeIncludes(check(line).warnings, suggestion, 'warnings');
    });
  }

  test('accepts valid SPDX expressions', () => {
    const res = check('PKG_LICENSE:=GPL-2.0-only OR MIT');
    assertNoWarnings(res);
    assertSomeIncludes(res.successes, 'SPDX', 'successes');
  });

  test('leaves dynamic license values alone', () => {
    assertNoWarnings(check('PKG_LICENSE:=$(BASE_LICENSE)'));
  });

  test('ignores trailing comments after the license expression', () => {
    assertNoWarnings(check('PKG_LICENSE:=MIT # formerly GPLv2'));
  });

  test('does nothing when disabled', () => {
    assertNoWarnings(check('PKG_LICENSE:=GPLv2', { ...CONFIG, check_spdx_license: false }));
  });
});
