/**
 * Encrypts a client's Meta credentials under a fresh master key and prints the two
 * things that have to happen next: the Wrangler secret, and one UPDATE.
 *
 * This is the tool that was missing. Nothing in the repo could produce a
 * `token_ciphertext` — `crypto.ts` only decrypts — so the first account's row was
 * built by hand, which means rotation had no path either. It is also what makes
 * "client #21 is an INSERT" literally true: onboarding runs this and pastes the row.
 *
 * ## Why it takes plaintext rather than re-encrypting what is stored
 *
 * The old master key is a Wrangler secret, and Wrangler secrets are write-only. Not
 * even the account owner can read one back, so decrypt-then-re-encrypt is impossible
 * anywhere except inside a running Worker. The plaintext token and app secret are
 * always retrievable from the Meta app dashboard, so that is the input.
 *
 * ## Why the version goes up rather than V1 being overwritten
 *
 * Rotation is additive by design (see `crypto.ts`): V2 is set alongside V1, rows move
 * over, and only then is V1 deleted. Overwriting V1 makes every stored row
 * undecryptable between the secret landing and the UPDATE committing — a webhook
 * arriving in that window is a customer who gets no reply.
 *
 *   read -rs META_TOKEN;      export META_TOKEN
 *   read -rs META_APP_SECRET; export META_APP_SECRET
 *   pnpm tsx scripts/rotate-key.ts --version 2 --phone-number-id 123456789
 *
 * `read -rs` rather than `META_TOKEN=... pnpm tsx`: the second form puts a live Meta
 * token in shell history.
 */
import { webcrypto as crypto } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    "phone-number-id": { type: "string" },
    key: { type: "string" },
  },
});

const version = Number(values.version);
const phoneNumberId = values["phone-number-id"];
const token = process.env.META_TOKEN;
const appSecret = process.env.META_APP_SECRET;

if (!Number.isInteger(version) || version < 1) {
  console.error("--version must be an integer, e.g. --version 2");
  process.exit(1);
}
if (!phoneNumberId) {
  console.error("--phone-number-id is required — it is what the UPDATE matches on");
  process.exit(1);
}
if (!token || !appSecret) {
  console.error("META_TOKEN and META_APP_SECRET must be set (use `read -rs`, not inline)");
  process.exit(1);
}

const b64 = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");

// Reusing an existing key is what onboarding client #21 does — a new client gets new
// ciphertext under the *current* key, not a new key.
const keyBytes = values.key
  ? new Uint8Array(Buffer.from(values.key, "base64"))
  : crypto.getRandomValues(new Uint8Array(32));

if (keyBytes.length !== 32) {
  console.error(`--key must be 32 bytes base64, got ${keyBytes.length}`);
  process.exit(1);
}

const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);

/** A fresh IV per value. Reusing one across two secrets under one key breaks AES-GCM. */
async function seal(plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: b64(ct), iv: b64(iv) };
}

const sealedToken = await seal(token);
const sealedSecret = await seal(appSecret);

const sql = `update wa_accounts set
  token_ciphertext      = '${sealedToken.ciphertext}',
  token_iv              = '${sealedToken.iv}',
  token_key_version     = ${version},
  app_secret_ciphertext = '${sealedSecret.ciphertext}',
  app_secret_iv         = '${sealedSecret.iv}',
  app_secret_key_version = ${version}
where phone_number_id = '${phoneNumberId}';`;

console.log(`
MASTER_KEY_V${version} (base64) — store this in a password manager NOW. It is not
recoverable once this scrollback is gone, and every stored credential is lost with it:

  ${b64(keyBytes)}

1. Set the secret, and confirm the Worker is serving before touching the database:

  cd workers/api && npx wrangler secret put MASTER_KEY_V${version}

2. Then move the rows. Until this commits, they are still decrypted with the old key,
   which is why step 1 does not disturb anything:

${sql}

3. Send a real WhatsApp message and confirm a reply. Only then:

  cd workers/api && npx wrangler secret delete MASTER_KEY_V${version - 1}
`);
