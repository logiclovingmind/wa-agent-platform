import { Hono } from "hono";
import type { Env } from "./env.js";
import { api } from "./api.js";
import { scheduled } from "./cron.js";
import { report } from "./monitor.js";
import { webhook } from "./webhook.js";

export { ConversationDO } from "./do/conversation.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.text("ok"));
app.route("/", webhook);
app.route("/", api);

app.onError((error, c) => {
  c.executionCtx.waitUntil(report(c.env, error, { path: new URL(c.req.url).pathname }));
  return c.text("internal error", 500);
});

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
