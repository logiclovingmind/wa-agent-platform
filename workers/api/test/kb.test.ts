import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { stubSupabase, type RestCall } from "./fake-supabase.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ADMIN = "55555555-5555-5555-5555-555555555555";
const DOC = "aaaaaaaa-0000-4000-8000-00000000000a";

interface Scenario {
  admin?: boolean;
  /** What `kb_documents` already holds. */
  documents?: Array<Record<string, unknown>>;
  /** What the write is answered with — empty means "no row matched". */
  written?: Array<Record<string, unknown>>;
}

function harness(scenario: Scenario = {}) {
  return stubSupabase(
    (call) => {
      switch (call.table.split("?")[0]) {
        case "org_members":
          return scenario.admin === false ? [{ org_id: ORG_A, role: "owner" }] : [];
        case "users":
          return [{ id: ADMIN, email: "admin@x.test", is_platform_admin: scenario.admin !== false }];
        case "kb_documents":
          if (call.method === "GET") return scenario.documents ?? [];
          return scenario.written ?? [];
        default:
          return [];
      }
    },
    async (_req, url) => {
      if (url.pathname === "/auth/v1/user") return Response.json({ id: ADMIN });
      throw new Error(`unexpected outbound fetch: ${url.pathname}`);
    },
  );
}

async function call(method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const writesTo = (rest: RestCall[], table: string) =>
  rest.filter((c) => c.method === "POST" && c.table.split("?")[0] === table);

const doc = (i: number) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${i}`,
  title: `Doc ${i}`,
  raw: "Haircut ₹400.",
  updated_at: "2026-08-12T00:00:00Z",
});

afterEach(() => vi.unstubAllGlobals());

describe("knowledge base editor", () => {
  it("is closed to a client owner", async () => {
    harness({ admin: false });
    expect((await call("GET", `/api/admin/kb/${ORG_A}`)).status).toBe(403);
    expect(
      (await call("POST", `/api/admin/kb/${ORG_A}`, { title: "T", raw: "R" })).status,
    ).toBe(403);
  });

  it("lists in the order the prompt reads, and says how many of them it reads", async () => {
    const rest = harness({ documents: [doc(1), doc(2)] });
    const res = await call("GET", `/api/admin/kb/${ORG_A}`);

    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect((out["documents"] as unknown[]).length).toBe(2);
    // The DO reads the same five by the same order. An unordered read would make the
    // editor's "these reach the prompt" a guess.
    expect(out["maxDocuments"]).toBe(5);
    expect(rest[rest.length - 1]!.url.searchParams.get("order")).toBe("created_at.asc");
  });

  it("creates a document and audits its size, never its text", async () => {
    const rest = harness({ documents: [], written: [{ ...doc(1), raw: "Open 9am to 8pm." }] });
    const res = await call("POST", `/api/admin/kb/${ORG_A}`, {
      title: "Timings",
      raw: "Open 9am to 8pm.",
    });

    expect(res.status).toBe(201);
    const written = writesTo(rest, "kb_documents");
    expect(written).toHaveLength(1);
    const row = (written[0]!.body as Array<Record<string, unknown>>)[0]!;
    expect(row["org_id"]).toBe(ORG_A);

    const audit = writesTo(rest, "audit_log");
    expect(audit).toHaveLength(1);
    const entry = (audit[0]!.body as Array<Record<string, unknown>>)[0]!;
    expect(entry["action"]).toBe("kb_document_created");
    // The document is its own record. A year of drafts in audit_log is a second,
    // undeleted copy of the client's business data.
    expect(JSON.stringify(entry["detail"])).not.toContain("9am");
    expect((entry["detail"] as Record<string, unknown>)["chars"]).toBe(16);
  });

  it("refuses the document that would never reach the prompt", async () => {
    const rest = harness({ documents: [doc(1), doc(2), doc(3), doc(4), doc(5)] });
    const res = await call("POST", `/api/admin/kb/${ORG_A}`, { title: "Sixth", raw: "..." });

    expect(res.status).toBe(409);
    // Refused, not saved-and-ignored: a document that stores cleanly and never reaches
    // the model is the kind of thing nobody finds for months.
    expect(writesTo(rest, "kb_documents")).toHaveLength(0);
  });

  it("rejects an empty title and an oversized document", async () => {
    harness({ documents: [] });
    expect((await call("POST", `/api/admin/kb/${ORG_A}`, { title: " ", raw: "R" })).status).toBe(400);
    expect(
      (await call("POST", `/api/admin/kb/${ORG_A}`, { title: "T", raw: "x".repeat(10_001) })).status,
    ).toBe(400);
  });

  it("stamps an edit, because the column has no trigger behind it", async () => {
    const rest = harness({ written: [doc(1)] });
    const res = await call("PATCH", `/api/admin/kb/${ORG_A}/${DOC}`, { raw: "Haircut ₹450." });

    expect(res.status).toBe(200);
    const patch = rest.find((c) => c.method === "PATCH")!;
    expect(patch.url.searchParams.get("id")).toBe(`eq.${DOC}`);
    expect((patch.body as Record<string, unknown>)["updated_at"]).toBeTypeOf("string");
  });

  it("answers 404 for a document this client does not have", async () => {
    const rest = harness({ written: [] });
    expect((await call("PATCH", `/api/admin/kb/${ORG_A}/${DOC}`, { raw: "x" })).status).toBe(404);
    expect((await call("DELETE", `/api/admin/kb/${ORG_A}/${DOC}`)).status).toBe(404);
    // Nothing happened, so nothing is claimed to have happened.
    expect(writesTo(rest, "audit_log")).toHaveLength(0);
  });

  it("deletes and audits", async () => {
    const rest = harness({ written: [doc(1)] });
    const res = await call("DELETE", `/api/admin/kb/${ORG_A}/${DOC}`);

    expect(res.status).toBe(200);
    const del = rest.find((c) => c.method === "DELETE")!;
    // The org filter is in the query, not only in the URL the admin typed.
    expect(del.url.searchParams.get("org_id")).toBe(`eq.${ORG_A}`);
    const entry = (writesTo(rest, "audit_log")[0]!.body as Array<Record<string, unknown>>)[0]!;
    expect(entry["action"]).toBe("kb_document_deleted");
  });
});
