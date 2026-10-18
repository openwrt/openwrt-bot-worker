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

  test('validates field types and rejects invalid values with descriptive error', () => {
    // String "false" instead of boolean false
    const resStringBool = parseAndValidateConfig(JSON.stringify({ enable_comments: 'false' }));
    assert.match(resStringBool.error, /field "enable_comments" must be a boolean \(got string\)/);
    assert.deepStrictEqual(resStringBool.config, DEFAULT_CONFIG);

    // String "50" instead of number 50
    const resStringNum = parseAndValidateConfig(JSON.stringify({ max_subject_len_soft: '50' }));
    assert.match(resStringNum.error, /field "max_subject_len_soft" must be a non-negative integer/);

    // Negative number
    const resNegative = parseAndValidateConfig(JSON.stringify({ max_subject_len_hard: -10 }));
    assert.match(resNegative.error, /field "max_subject_len_hard" must be a non-negative integer/);

    // Infinity (e.g. 1e999 in JSON text)
    const resInfinity = parseAndValidateConfig('{"max_subject_len_soft": 1e999}');
    assert.match(resInfinity.error, /field "max_subject_len_soft" must be a non-negative integer/);

    // Float number (must be integer for length limits)
    const resFloat = parseAndValidateConfig(JSON.stringify({ max_subject_len_soft: 50.5 }));
    assert.match(resFloat.error, /field "max_subject_len_soft" must be a non-negative integer/);

    // Invalid discrete modes (e.g. typos or unsupported numbers)
    const resTypo = parseAndValidateConfig(JSON.stringify({ check_pkg_release: 'warnning' }));
    assert.match(resTypo.error, /field "check_pkg_release" must be one of .* \(got "warnning"\)/);

    const resTristate = parseAndValidateConfig(JSON.stringify({ check_pkg_release: 123 }));
    assert.match(resTristate.error, /field "check_pkg_release" must be one of/);

    const resInvalidHash = parseAndValidateConfig(JSON.stringify({ check_pkg_hash: 'strict' }));
    assert.match(resInvalidHash.error, /field "check_pkg_hash" must be one of/);

    // check_pkg_hash: true is ambiguous and rejected in favor of explicit warning / error / false / disabled
    const resHashTrue = parseAndValidateConfig(JSON.stringify({ check_pkg_hash: true }));
    assert.match(resHashTrue.error, /field "check_pkg_hash" must be one of/);

    const resInvalidBinary = parseAndValidateConfig(JSON.stringify({ check_binary_files: 'warnning' }));
    assert.match(resInvalidBinary.error, /field "check_binary_files" must be one of/);

    const resInvalidNewline = parseAndValidateConfig(JSON.stringify({ check_trailing_newline: 'warnning' }));
    assert.match(resInvalidNewline.error, /field "check_trailing_newline" must be one of/);

    const resInvalidLinked = parseAndValidateConfig(JSON.stringify({ require_linked_github_account: 'warnning' }));
    assert.match(resInvalidLinked.error, /field "require_linked_github_account" must be one of/);

    const resInvalidUci = parseAndValidateConfig(JSON.stringify({ check_uci_config: 'warning' }));
    assert.match(resInvalidUci.error, /field "check_uci_config" must be one of/);

    // Invalid check_openwrt_meta
    const resInvalidMetaType = parseAndValidateConfig(JSON.stringify({ check_openwrt_meta: 'warning' }));
    assert.match(resInvalidMetaType.error, /field "check_openwrt_meta" must be a boolean or an array of valid Makefile variable names/);

    const resInvalidMetaItems = parseAndValidateConfig(JSON.stringify({ check_openwrt_meta: [123, 'PKG_LICENSE'] }));
    assert.match(resInvalidMetaItems.error, /field "check_openwrt_meta" must be a boolean or an array of valid Makefile variable names/);

    const resEmptyMetaString = parseAndValidateConfig(JSON.stringify({ check_openwrt_meta: [''] }));
    assert.match(resEmptyMetaString.error, /field "check_openwrt_meta" must be a boolean or an array of valid Makefile variable names/);

    const resBadMetaIdentifier = parseAndValidateConfig(JSON.stringify({ check_openwrt_meta: ['PKG_LICENSE[BAD]'] }));
    assert.match(resBadMetaIdentifier.error, /field "check_openwrt_meta" must be a boolean or an array of valid Makefile variable names/);

    // Soft/hard subject length limit check
    const resSoftHard = parseAndValidateConfig(JSON.stringify({ max_subject_len_soft: 80, max_subject_len_hard: 60 }));
    assert.match(resSoftHard.error, /max_subject_len_soft \(80\) must not be greater than max_subject_len_hard \(60\)/);

    // Invalid string array
    const resArray = parseAndValidateConfig(JSON.stringify({ stale_ignored_users: 'not-an-array' }));
    assert.match(resArray.error, /field "stale_ignored_users" must be an array of strings/);

    const resArrayItems = parseAndValidateConfig(JSON.stringify({ stale_ignored_users: [123, 456] }));
    assert.match(resArrayItems.error, /field "stale_ignored_users" must be an array of strings/);

    // Null field value
    const resNullField = parseAndValidateConfig(JSON.stringify({ check_signoff: null }));
    assert.match(resNullField.error, /field "check_signoff" must not be null/);
  });

  test('tolerates unknown fields and object prototype keys without error', () => {
    const res = parseAndValidateConfig(JSON.stringify({
      toString: 'custom-to-string',
      valueOf: 'custom-value-of',
      constructor: 'custom-constructor',
      some_custom_future_flag: true
    }));
    assert.strictEqual(res.error, null);
    assert.strictEqual(res.config.toString, 'custom-to-string');
    assert.strictEqual(res.config.some_custom_future_flag, true);
  });

  test('accepts all documented valid configuration values and modes', () => {
    // 1. check_openwrt_meta custom string array
    const metaArray = parseAndValidateConfig(JSON.stringify({
      check_openwrt_meta: ['PKG_MAINTAINER', 'PKG_LICENSE']
    }));
    assert.strictEqual(metaArray.error, null);
    assert.deepStrictEqual(metaArray.config.check_openwrt_meta, ['PKG_MAINTAINER', 'PKG_LICENSE']);

    // 2. check_openwrt_meta boolean flags
    const metaTrue = parseAndValidateConfig(JSON.stringify({ check_openwrt_meta: true }));
    assert.strictEqual(metaTrue.error, null);
    assert.strictEqual(metaTrue.config.check_openwrt_meta, true);

    const metaFalse = parseAndValidateConfig(JSON.stringify({ check_openwrt_meta: false }));
    assert.strictEqual(metaFalse.error, null);
    assert.strictEqual(metaFalse.config.check_openwrt_meta, false);

    // 3. check_binary_files modes
    for (const val of [true, false, 'warning', 'error', 'disabled']) {
      const res = parseAndValidateConfig(JSON.stringify({ check_binary_files: val }));
      assert.strictEqual(res.error, null, `check_binary_files: ${val} should be valid`);
      assert.strictEqual(res.config.check_binary_files, val);
    }

    // 4. check_trailing_newline modes
    for (const val of [true, false, 'warning', 'error', 'disabled']) {
      const res = parseAndValidateConfig(JSON.stringify({ check_trailing_newline: val }));
      assert.strictEqual(res.error, null, `check_trailing_newline: ${val} should be valid`);
      assert.strictEqual(res.config.check_trailing_newline, val);
    }

    // 5. require_linked_github_account modes
    for (const val of [true, false, 'warning', 'error', 'disabled']) {
      const res = parseAndValidateConfig(JSON.stringify({ require_linked_github_account: val }));
      assert.strictEqual(res.error, null, `require_linked_github_account: ${val} should be valid`);
      assert.strictEqual(res.config.require_linked_github_account, val);
    }

    // 6. check_uci_config modes
    for (const val of [true, false, 'disabled']) {
      const res = parseAndValidateConfig(JSON.stringify({ check_uci_config: val }));
      assert.strictEqual(res.error, null, `check_uci_config: ${val} should be valid`);
      assert.strictEqual(res.config.check_uci_config, val);
    }

    // 7. other discrete mode fields
    for (const val of [true, false, 'warning', 'error', 'disabled']) {
      assert.strictEqual(parseAndValidateConfig(JSON.stringify({ check_buildbot_default: val })).error, null);
      assert.strictEqual(parseAndValidateConfig(JSON.stringify({ check_patch_headers: val })).error, null);
      assert.strictEqual(parseAndValidateConfig(JSON.stringify({ check_pkg_release: val })).error, null);
    }

    // 8. check_pkg_hash modes (warning, error, false, disabled)
    for (const val of [false, 'warning', 'error', 'disabled']) {
      assert.strictEqual(parseAndValidateConfig(JSON.stringify({ check_pkg_hash: val })).error, null);
    }
  });
});
