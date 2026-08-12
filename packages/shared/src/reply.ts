import { complete, type Lead, type LlmEnv } from "./llm.js";
import { buildMessages, type ChatMessage, type PromptTurn } from "./prompt.js";
import {
  assertSingleReply,
  BLOCKED_REPLY,
  checkOutput,
  CLOSED_REPLY,
  FALLBACK_REPLY,
  flagFromImage,
  flagFromModel,
  MEDIA_REPLY,
  PAUSED_REPLY,
  prefilter,
  SAFE_REPLY,
  VIDEO_REPLY,
  type ImageFlags,
  type SafetyKind,
  type Sector,
} from "./safety.js";
import { isWithinHours } from "./window.js";

/** The runtime controls of docs/admin-panel.md §3, as they come off the org row. */
export interface OrgControls {
  name: string;
  sector: Sector;
  ai_paused: boolean;
  cap_micros: number | null;
  hours_open_ist: string | null;
  hours_close_ist: string | null;
  out_of_hours: string;
  /** docs/admin-panel.md §10. Null on every client until an admin sets one. */
  voice: string | null;
  reply_max_words: number | null;
  languages: string | null;
}

/** Why the model is not being asked, in the order the reasons should win, or null. */
export type HoldReason = "paused" | "closed" | "capped";

export const HOLD_TEXT: Record<HoldReason, string> = {
  paused: PAUSED_REPLY,
  closed: CLOSED_REPLY,
  capped: PAUSED_REPLY,
};

/**
 * The runtime controls, in the order they should win.
 *
 * A missing org row answers null — the controls must never be the reason a conversation
 * goes quiet, and every one of them defaults to today's behaviour. Shared with the
 * training console so "why has this client stopped replying?" is answered by the same
 * code that stopped it.
 *
 * `monthSpendMicros` is a callback because only a capped client should pay for the read,
 * and it answers null when the meter itself failed.
 */
export async function holdFor(
  org: OrgControls | null,
  monthSpendMicros: () => Promise<number | null>,
  now: Date = new Date(),
): Promise<HoldReason | null> {
  if (!org) return null;

  if (org.ai_paused) return "paused";

  if (org.out_of_hours === "handoff") {
    if (!isWithinHours(now, org.hours_open_ist, org.hours_close_ist)) return "closed";
  }

  // Only a capped client pays for this, and no client is capped by default. The cap
  // protects the shared wallet from one org (§8): at the ceiling the conversation goes to
  // a person rather than stopping, so the client notices before the customer does.
  // Loose on purpose: a column PostgREST did not return is as uncapped as a null one.
  if (org.cap_micros != null) {
    const spend = await monthSpendMicros();
    if (spend === null) return null; // Never let a failed meter reading silence a client.
    if (spend >= org.cap_micros) return "capped";
  }

  return null;
}

/** Meta's inbound `type` values that carry an attachment rather than text. */
const MEDIA_TYPES = new Set(["image", "audio", "video", "document", "sticker"]);

export interface PromptContext {
  businessName: string;
  sector: Sector;
  kb: string;
  history: PromptTurn[];
  /** The constant string to send instead of a model reply, or null to answer. */
  hold: string | null;
  /** docs/admin-panel.md §10. All null on an unconfigured client. */
  voice?: string | null | undefined;
  replyMaxWords?: number | null | undefined;
  languages?: string | null | undefined;
}

export interface ReplyUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Which step settled the turn. The DO ignores it; the training console shows it,
 * because "why did it say that" is the question a console exists to answer.
 */
export type ReplyStage =
  | "no_context"
  | "prefilter"
  | "video"
  | "media_flag"
  | "media"
  | "hold"
  | "llm_error"
  | "model_flag"
  | "multi_reply"
  | "sector_check"
  | "sent";

/**
 * What should happen, not what happened. `safe` also writes a `safety_flags` row and
 * hands off; `handoff` sends the text and hands off with no flag row — not every
 * handoff is a flag.
 */
export type ReplyVerdict =
  | { action: "none"; stage: "no_context" }
  | {
      action: "safe";
      stage: ReplyStage;
      kind: SafetyKind;
      text: string;
      usage?: ReplyUsage;
      messages?: ChatMessage[];
    }
  | {
      action: "handoff";
      stage: ReplyStage;
      text: string;
      usage?: ReplyUsage;
      messages?: ChatMessage[];
    }
  | {
      action: "send";
      stage: "sent";
      text: string;
      usage: ReplyUsage;
      messages: ChatMessage[];
      /**
       * Only on this branch, and deliberately. A flagged turn must not be mined —
       * safety.md forbids marketing toward one, and recording what a distressed person
       * wants to buy is the same act. A blocked or errored turn has no trustworthy
       * extraction to keep either.
       */
      lead?: Lead;
    };

export interface DecideInput {
  /** The debounced burst, already joined. Untrusted. */
  customerText: string;
  /** Meta's `type` for each message in the burst. */
  types: string[];
  /** `wa_message_id`s of the images in the burst — the only thing that can be classified. */
  imageIds: string[];
  /**
   * Lazy on purpose. A prefiltered or media turn must not pay for the KB read, which is
   * the largest query on this path.
   */
  loadContext: () => Promise<PromptContext | null>;
  /** Must not throw: see the DO's `#classifyImages`. Omit where there are no images. */
  classifyImages?: (imageIds: string[]) => Promise<ImageFlags | null>;
}

/**
 * The whole reply decision, with no sending in it.
 *
 * Extracted from `ConversationDO` so the training console can run the real path instead
 * of a copy of it. A copy drifts, and then reports confidence that is false.
 *
 * The order below is normative and matches `.claude/rules/safety.md`: the regex
 * prefilter outranks everything, media outranks the model, and the sector output check
 * runs on finished text because the client's KB can contradict every prompt instruction.
 */
export async function decideReply(env: LlmEnv, input: DecideInput): Promise<ReplyVerdict> {
  // The prefilter runs before the model and outranks it. A flagged turn never reaches
  // the LLM at all, so there is no model text to leak.
  const prefiltered = prefilter(input.customerText);
  if (prefiltered) {
    return { action: "safe", stage: "prefilter", kind: prefiltered, text: SAFE_REPLY[prefiltered] };
  }

  // Media outranks the model but not the prefilter: a caption can still be the thing
  // that flags the turn, and a flag has to win. Below that, an attachment the model
  // cannot see is a person's job — answering from the caption alone is a guess.
  if (input.types.includes("video")) {
    return { action: "handoff", stage: "video", text: VIDEO_REPLY };
  }
  if (input.types.some((type) => MEDIA_TYPES.has(type))) {
    const flags = input.classifyImages ? await input.classifyImages(input.imageIds) : null;
    const flagged = flagFromImage(flags);
    if (flagged) {
      return { action: "safe", stage: "media_flag", kind: flagged, text: SAFE_REPLY[flagged] };
    }
    return { action: "handoff", stage: "media", text: MEDIA_REPLY };
  }

  const context = await input.loadContext();
  if (!context) return { action: "none", stage: "no_context" };

  // Paused by the owner, over the monthly cap, or outside business hours. All three are
  // "a person answers this one", never silence.
  if (context.hold) {
    return { action: "handoff", stage: "hold", text: context.hold };
  }

  const messages = buildMessages({
    businessName: context.businessName,
    sector: context.sector,
    kb: context.kb,
    history: context.history,
    customerText: input.customerText,
    voice: context.voice,
    replyMaxWords: context.replyMaxWords,
    languages: context.languages,
  });

  let completion;
  try {
    completion = await complete(env, messages);
  } catch {
    // Two timeouts. Never leave the customer with silence.
    return { action: "handoff", stage: "llm_error", text: FALLBACK_REPLY, messages };
  }

  // Carried on every verdict from here down so the console can price a run it did not
  // send. Only the `send` branch is billed, which is what the DO enforces.
  const usage = completion.usage;

  const flagged = flagFromModel(completion.flags);
  if (flagged) {
    return {
      action: "safe",
      stage: "model_flag",
      kind: flagged,
      text: SAFE_REPLY[flagged],
      usage,
      messages,
    };
  }

  let reply: string;
  try {
    reply = assertSingleReply(completion.reply);
  } catch {
    return { action: "handoff", stage: "multi_reply", text: BLOCKED_REPLY, usage, messages };
  }

  // The client's KB can contradict every instruction in the prompt, so the sector rules
  // are checked here, on the finished text.
  if (!checkOutput(context.sector, reply).ok) {
    return { action: "handoff", stage: "sector_check", text: BLOCKED_REPLY, usage, messages };
  }

  return {
    action: "send",
    stage: "sent",
    text: reply,
    usage,
    messages,
    ...(completion.lead ? { lead: completion.lead } : {}),
  };
}
