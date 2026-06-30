import { describe, test } from 'node:test';
import assert from 'node:assert';
import { verifySignature } from '../src/crypto.js';

describe('verifySignature', () => {
  const secret = 'super-secret-key';
  const payload = '{"action":"opened","pull_request":{"number":42}}';

  // Helper to compute HMAC SHA256 hex signature
  async function computeHmac(key, data) {
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
    const hashBytes = new Uint8Array(sig);
    return Array.from(hashBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  test('accepts valid HMAC signature', async () => {
    const signature = await computeHmac(secret, payload);
    const header = `sha256=${signature}`;
    const isValid = await verifySignature(payload, header, secret);
    assert.strictEqual(isValid, true);
  });

  test('rejects signature with incorrect key', async () => {
    const signature = await computeHmac('wrong-secret', payload);
    const header = `sha256=${signature}`;
    const isValid = await verifySignature(payload, header, secret);
    assert.strictEqual(isValid, false);
  });

  test('rejects signature with modified payload', async () => {
    const signature = await computeHmac(secret, payload);
    const header = `sha256=${signature}`;
    const isValid = await verifySignature(payload + 'extra', header, secret);
    assert.strictEqual(isValid, false);
  });

  test('rejects empty signature header gracefully', async () => {
    const isValid = await verifySignature(payload, '', secret);
    assert.strictEqual(isValid, false);
  });

  test('rejects malformed signature prefix gracefully', async () => {
    const signature = await computeHmac(secret, payload);
    const header = `sha1=${signature}`;
    const isValid = await verifySignature(payload, header, secret);
    assert.strictEqual(isValid, false);
  });

  test('rejects empty signature value gracefully (sha256=)', async () => {
    const isValid = await verifySignature(payload, 'sha256=', secret);
    assert.strictEqual(isValid, false);
  });

  test('rejects invalid hex characters gracefully', async () => {
    const invalidHex = 'g'.repeat(64);
    const header = `sha256=${invalidHex}`;
    const isValid = await verifySignature(payload, header, secret);
    assert.strictEqual(isValid, false);
  });

  test('rejects incorrect length signature gracefully', async () => {
    const shortHex = 'a'.repeat(60);
    const header = `sha256=${shortHex}`;
    const isValid = await verifySignature(payload, header, secret);
    assert.strictEqual(isValid, false);
  });
});
