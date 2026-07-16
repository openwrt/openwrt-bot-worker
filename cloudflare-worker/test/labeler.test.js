import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseYaml, globToRegex, matchFiles, getLabelsForChangedFiles, normalizePath, getAllChangedFiles } from '../src/labeler.js';

describe('labeler unit tests', () => {
  describe('normalizePath', () => {
    test('removes leading slash and dot-slash', () => {
      assert.strictEqual(normalizePath('./foo/bar'), 'foo/bar');
      assert.strictEqual(normalizePath('/foo/bar'), 'foo/bar');
      assert.strictEqual(normalizePath('foo/bar'), 'foo/bar');
    });
  });

  describe('getAllChangedFiles', () => {
    test('extracts added, modified, and deleted files from patch', () => {
      const patch = `
diff --git a/target/linux/airoha/Makefile b/target/linux/airoha/Makefile
--- a/target/linux/airoha/Makefile
+++ b/target/linux/airoha/Makefile
@@ -1,3 +1,4 @@
diff --git a/deleted/file b/deleted/file
--- a/deleted/file
+++ /dev/null
diff --git a/added/file b/added/file
--- /dev/null
+++ b/added/file
`;
      const expected = ['target/linux/airoha/Makefile', 'deleted/file', 'added/file'];
      assert.deepStrictEqual(getAllChangedFiles(patch).sort(), expected.sort());
    });
  });

  describe('globToRegex', () => {
    test('handles double star (**)', () => {
      const regex = globToRegex('target/linux/airoha/**');
      assert.ok(regex.test('target/linux/airoha/Makefile'));
      assert.ok(regex.test('target/linux/airoha/image/Makefile'));
      assert.ok(!regex.test('target/linux/other/Makefile'));
    });

    test('handles single star (*)', () => {
      const regex = globToRegex('target/linux/*/Makefile');
      assert.ok(regex.test('target/linux/airoha/Makefile'));
      assert.ok(regex.test('target/linux/apm821xx/Makefile'));
      assert.ok(!regex.test('target/linux/airoha/image/Makefile')); // doesn't cross slash boundaries
    });
  });

  describe('parseYaml', () => {
    test('parses actions/labeler v5/v6 format', () => {
      const yaml = `
# comment
"target/airoha":
- changed-files:
  - any-glob-to-any-file:
    - "target/linux/airoha/**"
"target/at91":
- changed-files:
  - any-glob-to-any-file:
    - "target/linux/at91/**"
    - "package/boot/at91bootstrap/**"
`;
      const expected = {
        'target/airoha': ['target/linux/airoha/**'],
        'target/at91': [
          'target/linux/at91/**',
          'package/boot/at91bootstrap/**'
        ]
      };
      assert.deepStrictEqual(parseYaml(yaml), expected);
    });

    test('parses actions/labeler v5/v6 inline array format', () => {
      const yaml = `
"target/airoha":
- changed-files:
  - any-glob-to-any-file: ["target/linux/airoha/**", "other/**"]
`;
      const expected = {
        'target/airoha': ['target/linux/airoha/**', 'other/**']
      };
      assert.deepStrictEqual(parseYaml(yaml), expected);
    });

    test('parses actions/labeler v4 format', () => {
      const yaml = `
target/airoha:
  - target/linux/airoha/**
`;
      const expected = {
        'target/airoha': ['target/linux/airoha/**']
      };
      assert.deepStrictEqual(parseYaml(yaml), expected);
    });
  });

  describe('matchFiles', () => {
    test('matches files correctly', () => {
      const files = ['target/linux/airoha/Makefile', 'other/file.txt'];
      assert.ok(matchFiles(files, ['target/linux/airoha/**']));
      assert.ok(!matchFiles(files, ['target/linux/at91/**']));
    });
  });

  describe('getLabelsForChangedFiles', () => {
    test('extracts correct labels', () => {
      const files = ['target/linux/airoha/Makefile', 'package/boot/at91bootstrap/Makefile'];
      const parsedConfig = {
        'target/airoha': ['target/linux/airoha/**'],
        'target/at91': ['target/linux/at91/**', 'package/boot/at91bootstrap/**'],
        'target/other': ['target/linux/other/**']
      };
      const labels = getLabelsForChangedFiles(files, parsedConfig);
      assert.deepStrictEqual(labels.sort(), ['target/airoha', 'target/at91'].sort());
    });
  });
});
