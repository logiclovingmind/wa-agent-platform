/** MASTER_KEY_V1 in vitest.config.ts is 32 zero bytes. Ciphertext fixtures use it. */
const MASTER_KEY = new Uint8Array(32);

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export async function encryptUnderMasterKey(
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await crypto.subtle.importKey("raw", MASTER_KEY, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: b64(new Uint8Array(ct)), iv: b64(iv) };
}

/** The other direction: proves that what onboarding stored is the token that was typed. */
export async function decryptUnderMasterKey(ciphertext: string, iv: string): Promise<string> {
  const bytes = (b: string) => Uint8Array.from(atob(b), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", MASTER_KEY, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes(iv) },
    key,
    bytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

/** The `X-Hub-Signature-256` header Meta would send for this body. */
export async function signBody(appSecret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
