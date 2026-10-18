import { describe, test } from 'node:test';
import assert from 'node:assert';
import { GitHubWriteQueue } from '../../src/core/github-write-queue.ts';

describe('GitHubWriteQueue', () => {
  test('executes operations in sequential order and records results', async () => {
    const queue = new GitHubWriteQueue(123);
    const executionOrder = [];

    queue.enqueue('first', async () => {
      executionOrder.push('first');
      return { code: 200, data: null, raw: '', headers: { get: () => null } };
    });

    queue.enqueue('second', async () => {
      executionOrder.push('second');
      return { code: 201, data: null, raw: '', headers: { get: () => null } };
    });

    const result = await queue.execute();
    assert.strictEqual(result, null);
    assert.deepStrictEqual(executionOrder, ['first', 'second']);
    assert.deepStrictEqual(queue.statusWrites, [
      { what: 'first', code: 200 },
      { what: 'second', code: 201 }
    ]);
  });

  test('returns 502 response when a write operation fails', async () => {
    const queue = new GitHubWriteQueue(456);

    queue.enqueue('success-write', async () => ({ code: 200, data: null, raw: '', headers: { get: () => null } }));
    queue.enqueue('failed-write', async () => ({ code: 500, data: null, raw: 'Internal Server Error', headers: { get: () => null } }));

    const response = await queue.execute();
    assert.ok(response instanceof Response);
    assert.strictEqual(response.status, 502);
    const body = await response.text();
    assert.match(body, /failed-write \(HTTP 500\)/);
  });

  test('handles thrown exceptions in write operations gracefully', async () => {
    const queue = new GitHubWriteQueue(789);

    queue.enqueue('crash-write', async () => {
      throw new Error('Network timeout');
    });

    const response = await queue.execute();
    assert.ok(response instanceof Response);
    assert.strictEqual(response.status, 502);
    assert.strictEqual(queue.statusWrites[0].code, 599);
  });
});
