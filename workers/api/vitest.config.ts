import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const shared = fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
          META_VERIFY_TOKEN: "test-verify-token",
          // Hosts that only exist inside the fetch stub, so a missing stub fails loudly
          // rather than reaching the real Graph API or the real model.
          META_GRAPH_URL: "https://graph.test/v21.0",
          LLM_BASE_URL: "https://llm.test/v1",
          LLM_API_KEY: "test-llm-key",
          // Deliberately not the `https://api.test` the test requests are sent to, so a
          // webhook URL rebuilt from the request origin fails the assertion rather than
          // matching it by coincidence.
          PUBLIC_API_ORIGIN: "https://webhook.test",
          // 32 zero bytes, base64. Fixtures encrypt against this exact key.
          MASTER_KEY_V1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
    }),
  ],
  resolve: { alias: { "@wa/shared": shared } },
  test: {
    name: "workers",
    include: ["test/**/*.test.ts"],
  },
});
