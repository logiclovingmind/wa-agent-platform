import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("runtime", () => {
  it("serves a request", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(await res.text()).toBe("ok");
  });

  it("reaches a SQLite-backed Durable Object", async () => {
    const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName("smoke"));
    expect(await stub.getState()).toEqual({
      handoff: "bot",
      canBotReply: true,
      pending: 0,
      lastBatchSize: null,
    });
  });
});
