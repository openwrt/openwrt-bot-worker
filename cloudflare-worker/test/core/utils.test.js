import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseEnvInt, safeTruncate, isBotUser, optionalAttemptCounter } from '../../src/core/utils.ts';

describe('core/utils', () => {
  describe('parseEnvInt', () => {
    test('returns fallback for undefined, null, or empty string', () => {
      assert.strictEqual(parseEnvInt(undefined, 50), 50);
      assert.strictEqual(parseEnvInt(null, 50), 50);
      assert.strictEqual(parseEnvInt('', 50), 50);
    });

    test('returns parsed integer for valid numeric strings and numbers', () => {
      assert.strictEqual(parseEnvInt('42', 50), 42);
      assert.strictEqual(parseEnvInt(42, 50), 42);
    });

    test('preserves 0 when no min constraint is provided', () => {
      assert.strictEqual(parseEnvInt('0', 50), 0);
      assert.strictEqual(parseEnvInt(0, 50), 0);
    });

    test('returns fallback when value is below min threshold', () => {
      assert.strictEqual(parseEnvInt('0', 50, 1), 50);
      assert.strictEqual(parseEnvInt('-5', 50, 1), 50);
      assert.strictEqual(parseEnvInt(-10, 50, 1), 50);
      assert.strictEqual(parseEnvInt('1', 50, 1), 1);
      assert.strictEqual(parseEnvInt('10', 50, 1), 10);
    });

    test('returns fallback for non-numeric or non-finite inputs', () => {
      assert.strictEqual(parseEnvInt('abc', 50), 50);
      assert.strictEqual(parseEnvInt(NaN, 50), 50);
      assert.strictEqual(parseEnvInt(Infinity, 50), 50);
      assert.strictEqual(parseEnvInt({}, 50), 50);
    });
  });

  describe('isBotUser', () => {
    test('identifies bot accounts by type and [bot] suffix', () => {
      assert.strictEqual(isBotUser({ login: 'openwrt-bot', type: 'Bot' }), true);
      assert.strictEqual(isBotUser({ login: 'dependabot[bot]', type: 'User' }), true);
      assert.strictEqual(isBotUser({ login: 'DEVELOPER[BOT]', type: 'User' }), true);
      assert.strictEqual(isBotUser({ login: 'alice', type: 'User' }), false);
      assert.strictEqual(isBotUser(null), false);
      assert.strictEqual(isBotUser(undefined), false);
    });
  });

  describe('safeTruncate', () => {
    test('returns original string when within limit', () => {
      assert.strictEqual(safeTruncate('hello world', 50), 'hello world');
    });

    test('truncates long strings and appends suffix without breaking UTF-8', () => {
      const longText = 'a'.repeat(200);
      const truncated = safeTruncate(longText, 100);
      assert.ok(truncated.includes('Output truncated'));
      assert.ok(new TextEncoder().encode(truncated).length <= 100);
    });
  });

  describe('optionalAttemptCounter', () => {
    test('increments used on first attempt regardless of headroom', () => {
      const budget = { limit: 50, reserve: 5, used: 48 };
      const counter = optionalAttemptCounter(budget);
      assert.strictEqual(counter(1), true);
      assert.strictEqual(budget.used, 49);
    });

    test('declines retry when headroom is exhausted', () => {
      const budget = { limit: 50, reserve: 5, used: 45 }; // 50 - 5 - 45 = 0
      const counter = optionalAttemptCounter(budget);
      assert.strictEqual(counter(2), false);
      assert.strictEqual(budget.used, 45);
    });
  });
});
