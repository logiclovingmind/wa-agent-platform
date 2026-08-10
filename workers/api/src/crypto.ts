import type { Env } from "./env.js";

// Imported CryptoKeys are cached for the life of the isolate. importKey is not free
// and this runs on every inbound webhook.
const masterKeys = new Map<number, CryptoKey>();

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

async function masterKey(env: Env, version: number): Promise<CryptoKey> {
  const cached = masterKeys.get(version);
  if (cached) return cached;

  const raw = env[`MASTER_KEY_V${version}`];
  if (!raw) {
    // Rotation is additive: MASTER_KEY_V2 is set alongside V1, rows are re-encrypted,
    // and only then does V1 go away. A missing version means that order was broken.
    throw new Error(`MASTER_KEY_V${version} is not set`);
  }

  const key = await crypto.subtle.importKey("raw", base64ToBytes(raw), "AES-GCM", false, [
    "decrypt",
  ]);
  masterKeys.set(version, key);
  return key;
}

/** Decrypts a Meta token or app secret held in wa_accounts. */
export async function decryptSecret(
  env: Env,
  ciphertextB64: string,
  ivB64: string,
  keyVersion: number,
): Promise<string> {
  const key = await masterKey(env, keyVersion);
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
