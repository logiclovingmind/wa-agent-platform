import { vi } from "vitest";

/**
 * The workers pool provides no database, so PostgREST is faked at the HTTP edge.
 * `SELF` and the Durable Objects it owns run in the test isolate, so stubbing the
 * global `fetch` covers every Supabase call the Worker makes.
 *
 * Recording the calls is the point: "a duplicate never reaches Postgres" is only
 * provable by counting requests.
 */
export interface RestCall {
  method: string;
  table: string;
  url: URL;
  body: unknown;
}

/** In-memory stand-in for the private Storage bucket. Cleared by each `stubSupabase`. */
export const storedMedia = new Map<string, { body: string; contentType: string }>();

const OBJECT_PREFIX = "/storage/v1/object/media/";
const LIST_PATH = "/storage/v1/object/list/media";

async function storage(req: Request, url: URL): Promise<Response> {
  if (req.method === "POST" && url.pathname === LIST_PATH) {
    const { prefix } = (await req.json()) as { prefix: string };
    const names = [...storedMedia.keys()]
      .filter((key) => key.startsWith(`${prefix}/`))
      .map((key) => ({ name: key.slice(prefix.length + 1) }));
    return Response.json(names);
  }

  if (req.method === "DELETE") {
    const { prefixes } = (await req.json()) as { prefixes: string[] };
    for (const path of prefixes) storedMedia.delete(path);
    return Response.json([]);
  }

  if (req.method === "POST" && url.pathname.startsWith(OBJECT_PREFIX)) {
    storedMedia.set(url.pathname.slice(OBJECT_PREFIX.length), {
      body: await req.text(),
      contentType: req.headers.get("content-type") ?? "",
    });
    return Response.json({});
  }

  return new Response("no", { status: 404 });
}

export function stubSupabase(
  reply: (call: RestCall) => unknown,
  /** Everything that is not PostgREST — the LLM and the Graph API. */
  outbound?: (req: Request, url: URL) => Response | Promise<Response>,
): RestCall[] {
  const calls: RestCall[] = [];
  storedMedia.clear();

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.pathname.startsWith("/storage/v1/")) return storage(req, url);
    if (!url.pathname.startsWith("/rest/v1/")) {
      if (outbound) return outbound(req, url);
      throw new Error(`unexpected outbound fetch: ${req.method} ${req.url}`);
    }

    const call: RestCall = {
      method: req.method,
      table: url.pathname.slice("/rest/v1/".length),
      url,
      body: req.method === "GET" ? null : await req.clone().json().catch(() => null),
    };
    calls.push(call);

    const data = reply(call);
    const wantsOne = (req.headers.get("accept") ?? "").includes("pgrst.object");
    const payload = wantsOne && Array.isArray(data) ? (data[0] ?? null) : data;

    return new Response(JSON.stringify(payload ?? null), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  return calls;
}
