import type { Env } from "./env.js";

// Imported CryptoKeys are cached for the life of the isolate. importKey is not free
// and this runs on every inbound webhook.
//
// Keyed by version *and* usage: the webhook path imports decrypt-only, and onboarding
// imports encrypt-only. Same bytes either way, but a key that cannot encrypt is one
// fewer thing the hot path can be made to do.
const masterKeys = new Map<string, CryptoKey>();

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

async function masterKey(
  env: Env,
  version: number,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const cached = masterKeys.get(`${version}:${usage}`);
  if (cached) return cached;

  const raw = env[`MASTER_KEY_V${version}`];
  if (!raw) {
    // Rotation is additive: MASTER_KEY_V2 is set alongside V1, rows are re-encrypted,
    // and only then does V1 go away. A missing version means that order was broken.
    throw new Error(`MASTER_KEY_V${version} is not set`);
  }

  const key = await crypto.subtle.importKey("raw", base64ToBytes(raw), "AES-GCM", false, [usage]);
  masterKeys.set(`${version}:${usage}`, key);
  return key;
}

/**
 * The version a *new* secret is sealed under: the highest `MASTER_KEY_V*` that is set.
 *
 * Rotation is additive, so during a rotation both V1 and V2 exist and a client onboarded
 * mid-rotation must land on V2 — sealing it under V1 would make it a row that the
 * rotation has already passed over, and V1 is about to be deleted.
 */
export function currentKeyVersion(env: Env): number {
  const versions = Object.keys(env)
    .map((k) => /^MASTER_KEY_V(\d+)$/.exec(k)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number);
  if (versions.length === 0) throw new Error("no MASTER_KEY_V* is set");
  return Math.max(...versions);
}

/**
 * Seals a Meta token or app secret for storage in `wa_accounts`.
 *
 * The counterpart to decryptSecret, and the only thing in the Worker that can produce
 * ciphertext. Until now `scripts/rotate-key.ts` was the only way, offline and by hand —
 * see docs/admin-panel.md §4 on why this is the most dangerous surface in the panel.
 *
 * A fresh 12-byte IV per call, never reused. AES-GCM with a repeated IV under the same
 * key does not merely weaken the ciphertext, it leaks the key stream.
 */
export async function encryptSecret(
  env: Env,
  plaintext: string,
  keyVersion: number,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await masterKey(env, keyVersion, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: bytesToBase64(new Uint8Array(sealed)), iv: bytesToBase64(iv) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decrypts a Meta token or app secret held in wa_accounts. */
export async function decryptSecret(
  env: Env,
  ciphertextB64: string,
  ivB64: string,
  keyVersion: number,
): Promise<string> {
  const key = await masterKey(env, keyVersion, "decrypt");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ciphertextB64),
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Verifies Meta's `X-Hub-Signature-256: sha256=<hex>` over the raw request body.
 *
 * crypto.subtle.verify rather than a string compare on our own digest — the
 * comparison is constant time, and the body must be the exact bytes Meta sent, which
 * is why the caller reads text() before any parse.
 */
export async function verifyMetaSignature(
  appSecret: string,
  signatureHeader: string | null | undefined,
  rawBody: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const signature = hexToBytes(signatureHeader.slice("sha256=".length));
  if (!signature || signature.length !== 32) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(rawBody));
}
