import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseEnvInt, safeTruncate, isBotUser, optionalAttemptCounter, reserveOptionalAttempt } from '../../src/core/utils.ts';

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
    test('charges the first attempt while headroom is left', () => {
      const budget = { limit: 50, reserve: 5, used: 40 };
      const counter = optionalAttemptCounter(budget);
      assert.strictEqual(counter(1), true);
      assert.strictEqual(budget.used, 41);
    });

    // Replaces 'increments used on first attempt regardless of headroom',
    // which asserted the opposite: that was the one test encoding the hole,
    // an optional lookup spending out of the reserve the closing writes need.
    test('refuses the first attempt once only the reserve is left', () => {
      const budget = { limit: 50, reserve: 5, used: 45 };
      const counter = optionalAttemptCounter(budget);
      assert.strictEqual(counter(1), false);
      assert.strictEqual(budget.used, 45);
    });

    // What the reviewer measured as the live cost of charging attempt 1: two
    // optional lookups starting together both went out and left the loader
    // nothing, with `used` past limit - reserve.
    test('hands two lookups starting together only the attempt that exists', () => {
      const budget = { limit: 10, reserve: 5, used: 4 };
      const counter = optionalAttemptCounter(budget);
      assert.deepStrictEqual([counter(1), counter(1)], [true, false]);
      assert.strictEqual(budget.used, 5);
      assert.strictEqual(budget.limit - budget.used, budget.reserve);
    });

    test('declines retry when headroom is exhausted', () => {
      const budget = { limit: 50, reserve: 5, used: 45 }; // 50 - 5 - 45 = 0
      const counter = optionalAttemptCounter(budget);
      assert.strictEqual(counter(2), false);
      assert.strictEqual(budget.used, 45);
    });
  });

  describe('reserveOptionalAttempt', () => {
    test('charges the budget when headroom is left', () => {
      const budget = { limit: 50, reserve: 5, used: 40 };
      assert.strictEqual(reserveOptionalAttempt(budget), true);
      assert.strictEqual(budget.used, 41);
    });

    test('refuses without charging once only the reserve is left', () => {
      const budget = { limit: 50, reserve: 5, used: 45 }; // 50 - 5 - 45 = 0
      assert.strictEqual(reserveOptionalAttempt(budget), false);
      assert.strictEqual(budget.used, 45, 'a refused attempt costs nothing');
    });

    // What a planning site relies on: reserving in a loop, with nothing
    // charged in between, hands out exactly the attempts that exist.
    test('hands out the affordable attempts and no more when called repeatedly', () => {
      const budget = { limit: 10, reserve: 5, used: 0 };
      const answers = Array.from({ length: 8 }, () => reserveOptionalAttempt(budget));
      assert.deepStrictEqual(answers, [true, true, true, true, true, false, false, false]);
      assert.strictEqual(budget.used, 5);
      assert.strictEqual(budget.limit - budget.used, budget.reserve);
    });
  });
});
