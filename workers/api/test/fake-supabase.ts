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

export function stubSupabase(
  reply: (call: RestCall) => unknown,
  /** Everything that is not PostgREST — the LLM and the Graph API. */
  outbound?: (req: Request, url: URL) => Response | Promise<Response>,
): RestCall[] {
  const calls: RestCall[] = [];

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
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
