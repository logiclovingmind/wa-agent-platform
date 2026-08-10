/// <reference types="@cloudflare/vitest-pool-workers/types" />

// `cloudflare:test` exports `env` as Cloudflare.Env, which wrangler generates from
// wrangler.jsonc alone — so it knows the vars and bindings and none of the secrets.
// The secrets are injected by vitest.config.ts and have to be declared here, or a test
// cannot hand `env` to anything typed against src/env.ts.
//
// (This file used to augment `ProvidedEnv`; the pool stopped referencing that name, so
// the augmentation silently did nothing.)
declare namespace Cloudflare {
  interface Env {
    SUPABASE_SERVICE_ROLE_KEY: string;
    SUPABASE_ANON_KEY: string;
    META_VERIFY_TOKEN: string;
    LLM_API_KEY: string;
    /** Mirrors src/env.ts: one secret per key *version*, never one per client. */
    [key: `MASTER_KEY_V${number}`]: string | undefined;
  }
}
