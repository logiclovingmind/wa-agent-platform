import type { ChatMessage } from "./prompt.js";
import type { ModelFlags } from "./safety.js";

/**
 * Every model call in the platform goes through here. The provider's base URL is not
 * settled yet, so it is configuration rather than a constant, and nothing outside this
 * file knows the wire format.
 */
export interface LlmEnv {
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL?: string | undefined;
}

export const LLM_TIMEOUT_MS = 12_000;
export const DEFAULT_MODEL = "gpt-4o-mini";

/** gpt-4o-mini list price, in micro-USD per token. A constant, not an env var: it is
 * the price of the DEFAULT_MODEL, so revisit this when the model changes. */
export const MICRO_USD_PER_PROMPT_TOKEN = 0.15; // $0.15 / 1M input tokens
export const MICRO_USD_PER_COMPLETION_TOKEN = 0.6; // $0.60 / 1M output tokens

export function costMicros(usage: { promptTokens: number; completionTokens: number }): number {
  return Math.round(
    usage.promptTokens * MICRO_USD_PER_PROMPT_TOKEN +
      usage.completionTokens * MICRO_USD_PER_COMPLETION_TOKEN,
  );
}

export interface Completion {
  reply: string;
  flags: ModelFlags;
  /** For usage_events. Snapshotted at send time because prices change. */
  usage: { promptTokens: number; completionTokens: number };
}

const EMPTY_FLAGS: ModelFlags = { minor: false, distress: false, out_of_scope: false };

/**
 * One retry, then give up — the caller sends the hardcoded fallback. Waiting is I/O and
 * costs no CPU, but a customer waiting 36 seconds has already left.
 */
export async function complete(env: LlmEnv, messages: ChatMessage[]): Promise<Completion> {
  try {
    return await once(env, messages);
  } catch {
    return once(env, messages);
  }
}

async function once(env: LlmEnv, messages: ChatMessage[]): Promise<Completion> {
  const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.LLM_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.LLM_MODEL ?? DEFAULT_MODEL,
      messages,
      temperature: 0.3,
      // Structured output in the one completion. A second call to classify safety would
      // double the latency and the bill for no extra signal.
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`llm returned ${res.status}`);

  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("llm returned no content");

  const parsed = JSON.parse(content) as { reply?: unknown; flags?: Partial<ModelFlags> };
  if (typeof parsed.reply !== "string") throw new Error("llm returned no reply string");

  return {
    reply: parsed.reply,
    // A missing flag is false, not a reason to fail: the regex prefilter has already
    // run and outranks anything the model says here.
    flags: { ...EMPTY_FLAGS, ...parsed.flags },
    usage: {
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
    },
  };
}
