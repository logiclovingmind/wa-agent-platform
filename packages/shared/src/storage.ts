/**
 * Customer media lives in a private Supabase Storage bucket.
 *
 * R2 would be the better home — this is object storage bolted onto the same 500MB and
 * the same 5GB/mo egress budget Postgres is already spending — but enabling R2 needs a
 * payment method this account does not have. See docs/backups.md for the same trade
 * made for dumps.
 *
 * Raw fetch rather than supabase-js `.storage`: the upload body is the ReadableStream
 * coming straight off Meta's CDN, and passing it through untouched is what keeps a
 * 50MB attachment out of the Worker's 128MB memory ceiling. Buffering it first would
 * also make the copy CPU work instead of I/O.
 */

export const MEDIA_BUCKET = "media";

export interface StorageEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

/** org first so one customer's media is a single prefix, and orgs can never collide. */
export function mediaPath(orgId: string, conversationId: string, waMessageId: string): string {
  return `${orgId}/${conversationId}/${waMessageId}`;
}

function headers(env: StorageEnv): Record<string, string> {
  return {
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/** Returns the stored path, or null if the upload did not land. */
export async function putMedia(
  env: StorageEnv,
  path: string,
  body: ReadableStream,
  contentType: string,
): Promise<string | null> {
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${MEDIA_BUCKET}/${path}`, {
    method: "POST",
    headers: { ...headers(env), "content-type": contentType },
    body,
    // Cloudflare requires this to stream a request body it has not buffered.
    duplex: "half",
  } as RequestInit);

  return res.ok ? path : null;
}

const PAGE = 1000;

/** Bulk delete. Storage takes the paths in the body, so one call covers a whole page. */
export async function removeMedia(env: StorageEnv, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += PAGE) {
    await fetch(`${env.SUPABASE_URL}/storage/v1/object/${MEDIA_BUCKET}`, {
      method: "DELETE",
      headers: { ...headers(env), "content-type": "application/json" },
      body: JSON.stringify({ prefixes: paths.slice(i, i + PAGE) }),
    });
  }
}

/**
 * Every object directly under `prefix`, as full paths. Storage `list` returns names
 * relative to the prefix, which are not what `removeMedia` wants.
 *
 * Paged to exhaustion rather than capped: this backs erasure, and a partial list would
 * leave a customer's media behind while reporting success.
 */
export async function listMedia(env: StorageEnv, prefix: string): Promise<string[]> {
  const paths: string[] = [];

  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/${MEDIA_BUCKET}`, {
      method: "POST",
      headers: { ...headers(env), "content-type": "application/json" },
      body: JSON.stringify({ prefix, limit: PAGE, offset }),
    });
    if (!res.ok) return paths;

    const objects = (await res.json()) as Array<{ name?: string }>;
    for (const object of objects) {
      if (object.name) paths.push(`${prefix}/${object.name}`);
    }
    if (objects.length < PAGE) return paths;
  }
}
