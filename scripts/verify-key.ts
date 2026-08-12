/**
 * Answers one question: is the `MASTER_KEY_V1` in your password manager the same key
 * the deployed Worker is using?
 *
 * A Wrangler secret is write-only, so the copy cannot be compared against the original
 * directly. What can be compared is their effect: take a `token_ciphertext` that the
 * live Worker produced, and try to open it with the copy. AES-GCM authenticates, so a
 * wrong key does not yield garbage — it throws. There is no ambiguous outcome.
 *
 * Run it *before* client 1. While the only sealed credentials are a sandbox number's,
 * a bad copy costs nothing; the day after client 1 it costs re-onboarding every client
 * from the Meta dashboard.
 *
 * Get the inputs from the Supabase SQL editor — ciphertext is safe to copy around,
 * that is the point of storing it:
 *
 *   select token_ciphertext, token_iv, token_key_version from wa_accounts;
 *
 * Then:
 *
 *   read -rs MASTER_KEY; export MASTER_KEY
 *   pnpm tsx scripts/verify-key.ts --ciphertext '<base64>' --iv '<base64>'
 *   unset MASTER_KEY
 *
 * `read -rs` and not `MASTER_KEY=... pnpm tsx`: the second form puts the key that
 * protects every client's Meta token into `~/.zsh_history`.
 *
 * Pass `--key-version N` only to label the output when checking a rotated row; the
 * script has no key store to look it up in, so the key on stdin is the one it tries.
 */
import { webcrypto as crypto } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    ciphertext: { type: "string" },
    iv: { type: "string" },
    "key-version": { type: "string" },
  },
});

const ciphertext = values.ciphertext;
const iv = values.iv;
const version = values["key-version"] ?? "1";
const rawKey = process.env.MASTER_KEY;

if (!rawKey) {
  console.error("MASTER_KEY must be set (use `read -rs MASTER_KEY; export MASTER_KEY`)");
  process.exit(1);
}
if (!ciphertext || !iv) {
  console.error("--ciphertext and --iv are both required, straight from wa_accounts");
  process.exit(1);
}

const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, "base64"));

const keyBytes = bytes(rawKey);
if (keyBytes.length !== 32) {
  // Caught here rather than by importKey, whose error does not say which of the two
  // base64 inputs was the malformed one.
  console.error(
    `MASTER_KEY decodes to ${keyBytes.length} bytes, not 32 — this is not an AES-256 key.\n` +
      "Check for a trailing newline or a truncated paste.",
  );
  process.exit(1);
}

const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);

let plaintext: string;
try {
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes(iv) },
    key,
    bytes(ciphertext),
  );
  plaintext = new TextDecoder().decode(opened);
} catch {
  console.error(
    `\n✗ FAIL — this key cannot open that ciphertext.\n\n` +
      `Either the copy is not MASTER_KEY_V${version}, or the row was sealed under a\n` +
      `different version. Check token_key_version on the row before concluding the\n` +
      `copy is wrong. If it really is lost, rotate now while the blast radius is a\n` +
      `sandbox number: docs/rotation.md §1.\n`,
  );
  process.exit(1);
}

// The token itself is never printed. Its shape is enough to confirm a real decrypt and
// not, say, a ciphertext that happened to be sealed under a test key of 32 zero bytes.
const shape = /^EAA[A-Za-z0-9]+$/.test(plaintext)
  ? "looks like a Meta access token (EAA…)"
  : "does NOT look like a Meta token — check which column this ciphertext came from";

console.log(
  `\n✓ PASS — the key opens the ciphertext, so your copy is MASTER_KEY_V${version}.\n\n` +
    `  plaintext: ${plaintext.length} chars, ${shape}\n\n` +
    `Confirm it is in a password manager and not only in a terminal buffer.\n`,
);
