import { githubApiCall } from './github.js';

// --- CRYPTO HELPERS FOR JWT SIGNING ---
function base64ToArrayBuffer(b64) {
  const byteString = atob(b64);
  const byteArray = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    byteArray[i] = byteString.charCodeAt(i);
  }
  return byteArray.buffer;
}

function b64url(str) {
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function arrayBufferToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return b64url(binary);
}

export async function generateJWT(appId, privateKeyPEM) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000) - 60;
  const payload = {
    iat: now,
    exp: now + 600,
    iss: appId
  };

  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);

  const cleanPem = privateKeyPEM
    .replace(/-----\s*BEGIN\s+(RSA\s+)?PRIVATE\s+KEY\s*-----/, "")
    .replace(/-----\s*END\s+(RSA\s+)?PRIVATE\s+KEY\s*-----/, "")
    .replace(/\s+/g, "");

  const binaryKey = base64ToArrayBuffer(cleanPem);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: { name: "SHA-256" }
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    data
  );

  return `${encodedHeader}.${encodedPayload}.${arrayBufferToBase64Url(signature)}`;
}

export async function getInstallationToken(installationId, appId, privateKeyPEM) {
  const jwt = await generateJWT(appId, privateKeyPEM);
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const res = await githubApiCall(url, jwt, 'POST');
  return res.data?.token || null;
}

// --- CRYPTO HELPERS FOR WEBHOOK HMAC SIGNATURE ---
export async function verifySignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = signatureHeader.split("=");
  if (parts.length !== 2 || parts[0] !== "sha256") return false;
  const signatureHex = parts[1];

  // Validate that signatureHex is a valid 64-character hex string to avoid crashes
  if (!/^[0-9a-fA-F]{64}$/.test(signatureHex)) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const matches = signatureHex.match(/.{1,2}/g);
  if (!matches) return false;

  const sigBytes = new Uint8Array(matches.map(byte => parseInt(byte, 16)));
  return await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    encoder.encode(payload)
  );
}
