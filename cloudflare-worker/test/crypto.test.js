import { describe, test } from 'node:test';
import assert from 'node:assert';
import { verifySignature, getInstallationToken } from '../src/crypto.js';

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

describe('getInstallationToken', () => {
  async function testPrivateKeyPEM() {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify']);
    const exported = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
    return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
  }

  test('reports every outgoing fetch of the token mint, retries included', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      if (fetches === 1) return new Response('{"message":"upstream hiccup"}', { status: 502 });
      return new Response('{"token":"ghs_abc"}', { status: 201 });
    };
    let attempts = 0;
    const token = await getInstallationToken(456, '12345', await testPrivateKeyPEM(), () => { attempts++; });
    assert.strictEqual(token, 'ghs_abc');
    assert.strictEqual(fetches, 2);
    assert.strictEqual(attempts, 2);
  });
});
