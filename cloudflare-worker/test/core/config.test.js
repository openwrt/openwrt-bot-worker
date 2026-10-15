import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseAndValidateConfig } from '../../src/types/config.ts';
import { DEFAULT_CONFIG } from '../../src/config.js';

describe('parseAndValidateConfig', () => {
  test('returns default configuration when input is null or empty', () => {
    const resNull = parseAndValidateConfig(null);
    assert.deepStrictEqual(resNull.config, DEFAULT_CONFIG);
    assert.strictEqual(resNull.error, null);

    const resEmpty = parseAndValidateConfig('');
    assert.deepStrictEqual(resEmpty.config, DEFAULT_CONFIG);
    assert.strictEqual(resEmpty.error, null);
  });

  test('merges valid JSON configuration overrides with defaults', () => {
    const raw = JSON.stringify({
      check_signoff: false,
      max_subject_len_soft: 60,
      custom_setting: 'test-value'
    });
    const result = parseAndValidateConfig(raw);
    assert.strictEqual(result.error, null);
    assert.strictEqual(result.config.check_signoff, false);
    assert.strictEqual(result.config.max_subject_len_soft, 60);
    assert.strictEqual(result.config.custom_setting, 'test-value');
    // Unoverridden properties remain default
    assert.strictEqual(result.config.check_branch, DEFAULT_CONFIG.check_branch);
  });

  test('returns error when JSON syntax is invalid', () => {
    const raw = '{ "check_signoff": false, invalid }';
    const result = parseAndValidateConfig(raw);
    assert.ok(result.error);
    assert.deepStrictEqual(result.config, DEFAULT_CONFIG);
  });

  test('returns error when JSON contains non-object root types', () => {
    const resArray = parseAndValidateConfig('["foo", "bar"]');
    assert.match(resArray.error, /does not contain a JSON object \(got array\)/);
    assert.deepStrictEqual(resArray.config, DEFAULT_CONFIG);

    const resNullVal = parseAndValidateConfig('null');
    assert.match(resNullVal.error, /does not contain a JSON object \(got null\)/);
    assert.deepStrictEqual(resNullVal.config, DEFAULT_CONFIG);

    const resPrimitive = parseAndValidateConfig('"hello"');
    assert.match(resPrimitive.error, /does not contain a JSON object \(got string\)/);
    assert.deepStrictEqual(resPrimitive.config, DEFAULT_CONFIG);
  });
});
