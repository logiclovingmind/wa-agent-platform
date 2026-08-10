import { Client } from "pg";

export const DB_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:54322/wa_agent";

export interface Fixture {
  orgA: string;
  orgB: string;
  userA: string;
  userB: string;
  convA: string;
  convB: string;
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  return client;
}

/** Two orgs that must never see each other. Truncates first, so order is irrelevant. */
export async function seed(db: Client): Promise<Fixture> {
  await db.query(`
    truncate organizations, auth.users restart identity cascade
  `);

  const mk = async (name: string, email: string) => {
    const org = (
      await db.query<{ id: string }>(
        "insert into organizations (name) values ($1) returning id",
        [name],
      )
    ).rows[0]!.id;

    const user = (
      await db.query<{ id: string }>(
        "insert into auth.users (email) values ($1) returning id",
        [email],
      )
    ).rows[0]!.id;

    await db.query(
      "insert into users (id, org_id, email) values ($1, $2, $3)",
      [user, org, email],
    );
    await db.query(
      "insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')",
      [org, user],
    );

    const wa = (
      await db.query<{ id: string }>(
        `insert into wa_accounts
           (org_id, phone_number_id, waba_id, display_phone_number, webhook_slug,
            token_ciphertext, token_iv, app_secret_ciphertext, app_secret_iv)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id`,
        [
          org,
          `pn_${name}`,
          `waba_${name}`,
          `+9199000000${name.length}`,
          `slug_${name}`,
          "Y3Q=",
          "aXY=",
          "Y3Q=",
          "aXY=",
        ],
      )
    ).rows[0]!.id;

    const conv = (
      await db.query<{ id: string }>(
        `insert into conversations (org_id, wa_account_id, customer_wa_id)
         values ($1, $2, $3) returning id`,
        [org, wa, `9198765432${name.length}`],
      )
    ).rows[0]!.id;

    await db.query(
      `insert into messages (org_id, conversation_id, wa_message_id, direction, body)
       values ($1, $2, $3, 'inbound', $4)`,
      [org, conv, `wamid.${name}.1`, `hello from ${name}`],
    );

    await db.query(
      `insert into usage_events (org_id, conversation_id, pricing_category, cost_micros)
       values ($1, $2, 'service', 1000)`,
      [org, conv],
    );

    return { org, user, conv };
  };

  const a = await mk("alpha", "owner@alpha.test");
  const b = await mk("bravo", "owner@bravo.test");

  return { orgA: a.org, orgB: b.org, userA: a.user, userB: b.user, convA: a.conv, convB: b.conv };
}

/**
 * Run fn as a logged-in dashboard user, exactly as PostgREST would: the
 * `authenticated` role plus a JWT claims blob that auth.uid() reads.
 * Always rolled back.
 */
export async function asUser<T>(
  db: Client,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await db.query("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await db.query("set local role authenticated");
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

/** Run fn as the Worker does: service_role, which bypasses RLS entirely. */
export async function asServiceRole<T>(db: Client, fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query("set local role service_role");
    return await fn();
  } finally {
    await db.query("rollback");
  }
}
