import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateMakefileContext, collectBinaryFiles } from '../../src/validators.js';
import {
  CONFIG, makeCommit, existingPackage, diff, gitModified, gitAdded,
  assertSomeIncludes, assertNoneIncludes, assertNoErrors, assertErrorIncludes, assertNoErrorIncludes
} from './helpers.js';

const validate = (message, patch, config = CONFIG) =>
  validateMakefileContext(makeCommit(message), patch, config, existingPackage());

// A file git could not express as hunks, in the two shapes it writes: the
// base85 payload of `format-patch`, which is what GitHub serves for a commit,
// and the bare notice of a plain `diff`.
const binaryPayload = (path, ...header) => diff(
  `diff --git a/${path} b/${path}`,
  ...header,
  'index 0000000000000000000000000000000000000000..b754da7527bfea8562fc8f91abff742363099e74',
  'GIT binary patch',
  'literal 92',
  'zcmebE4DeKNaq?t<07gLu2F402#!xfH1DjZRco>Y0w=<gVW;8m)$at7h@(82CF-HCi',
  'hOiLC%;Jd)V$H~cRXzU>_B5G*z5W*LQ@f8^~832ME6Ndl*',
  '',
  'literal 0',
  'HcmV?d00001',
  ''
);

const binaryNotice = (path, ...header) => diff(
  `diff --git a/${path} b/${path}`,
  ...header,
  `Binary files /dev/null and b/${path} differ`
);

describe('collectBinaryFiles', () => {
  const BIN = 'package/firmware/mipi-dbi/files/ubnt,utr-lcd.bin';

  test('names a file added as a base85 payload', () => {
    assert.deepStrictEqual(collectBinaryFiles(binaryPayload(BIN, 'new file mode 100644')), [BIN]);
  });

  test('names a file added as a bare binary notice', () => {
    assert.deepStrictEqual(collectBinaryFiles(binaryNotice(BIN, 'new file mode 100644')), [BIN]);
  });

  test('names a file whose binary content changed', () => {
    assert.deepStrictEqual(collectBinaryFiles(binaryPayload(BIN)), [BIN]);
  });

  test('ignores a deleted binary file', () => {
    assert.deepStrictEqual(collectBinaryFiles(binaryPayload(BIN, 'deleted file mode 100644')), []);
  });

  test('ignores an ordinary text diff', () => {
    assert.deepStrictEqual(
      collectBinaryFiles(diff(gitAdded('package/utils/foo/Makefile'), '+PKG_NAME:=foo')),
      []
    );
  });

  test('ignores the markers inside an added patch file', () => {
    assert.deepStrictEqual(collectBinaryFiles(diff(
      gitAdded('target/linux/generic/pending-6.18/900-add-blob.patch'),
      '@@ -0,0 +1,4 @@',
      '+diff --git a/firmware/blob.bin b/firmware/blob.bin',
      '+new file mode 100644',
      '+GIT binary patch',
      '+literal 4'
    )), []);
  });

  test('does not carry a file across the next commit in a pull request patch', () => {
    const patch = [
      'From 51627b9699b7b24b38901d54f500e0620172a6ee Mon Sep 17 00:00:00 2001',
      'Subject: [PATCH] foo: describe a payload',
      '',
      'GIT binary patch',
      '',
      '---',
    ].join('\n');
    assert.deepStrictEqual(collectBinaryFiles(patch), []);
  });

  test('returns nothing for an empty patch', () => {
    assert.deepStrictEqual(collectBinaryFiles(''), []);
    assert.deepStrictEqual(collectBinaryFiles(null), []);
  });
});

describe('validateMakefileContext', () => {
  const BIN = 'package/firmware/mipi-dbi/files/ubnt,utr-lcd.bin';

  test('rejects an added binary file', () => {
    const res = validate('mipi-dbi: add MIPI DBI LCD init sequence packages', binaryPayload(BIN, 'new file mode 100644'));
    assertErrorIncludes(res, BIN);
    assertErrorIncludes(res, 'is not text');
  });

  test('reports a binary file as a warning when configured to', () => {
    const res = validate(
      'mipi-dbi: add MIPI DBI LCD init sequence packages',
      binaryPayload(BIN, 'new file mode 100644'),
      { ...CONFIG, check_binary_files: 'warning' }
    );
    assertNoErrorIncludes(res, 'is not text');
    assertSomeIncludes(res.warnings, 'is not text', 'warnings');
  });

  for (const value of [false, 'disabled']) {
    test(`skips the check when check_binary_files is ${JSON.stringify(value)}`, () => {
      const res = validate(
        'mipi-dbi: add MIPI DBI LCD init sequence packages',
        binaryPayload(BIN, 'new file mode 100644'),
        { ...CONFIG, check_binary_files: value }
      );
      assertNoErrorIncludes(res, 'is not text');
      assertNoneIncludes(res.warnings, 'is not text', 'warnings');
      assertNoneIncludes(res.successes, 'File additions are text', 'successes');
    });
  }

  test('accepts dropping a binary file', () => {
    const res = validate('mipi-dbi: build init sequences from source', binaryPayload(BIN, 'deleted file mode 100644'));
    assertNoErrorIncludes(res, 'is not text');
  });

  test('passes a text-only change', () => {
    const res = validate('foo: fix typo', diff(gitModified('package/utils/foo/files/foo.txt'), '+command 0x11'));
    assertNoErrors(res);
    assertSomeIncludes(res.successes, 'File additions are text', 'successes');
  });
});
