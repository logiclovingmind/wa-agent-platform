import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const shared = fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { "@wa/shared": shared } },
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" },
      },
      {
        resolve: { alias: { "@wa/shared": shared } },
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          environment: "node",
          // One cluster and a truncating seed, so two files running at once
          // corrupt each other.
          pool: "forks",
          maxWorkers: 1,
          fileParallelism: false,
          hookTimeout: 30_000,
        },
      },
      "./workers/api/vitest.config.ts",
    ],
  },
});
