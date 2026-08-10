/**
 * Safety runs in code, not in the prompt. The client's KB sits in the same prompt as
 * the customer's message and can contradict any instruction we write, so nothing here
 * may depend on the model behaving.
 */

export type SafetyKind = "distress" | "self_harm" | "abuse" | "minor";

export interface ModelFlags {
  minor: boolean;
  distress: boolean;
  out_of_scope: boolean;
}

/**
 * One constant per outcome. These strings are sent instead of model output, so they
 * are the only thing a flagged customer ever reads from us.
 */
export const SAFE_REPLY: Record<SafetyKind, string> = {
  // Invariant 11. No age question, no interrogation, no auto-resume.
  minor: "I'll need to speak with a parent or guardian.",
  // Invariant 10. Not counselling and not a crisis-line list — an acknowledgement,
  // then a human. Silence at 2am is not an acceptable alternative.
  distress: "I hear you, and I don't want to leave you with a bot right now. I'm bringing a person from our team into this conversation.",
  self_harm: "I hear you, and I don't want to leave you with a bot right now. I'm bringing a person from our team into this conversation.",
  abuse: "I hear you, and I don't want to leave you with a bot right now. I'm bringing a person from our team into this conversation.",
};

/** Sent when the model times out twice. A constant, never model output. */
export const FALLBACK_REPLY =
  "Sorry — I'm having trouble right now. Someone from the team will get back to you shortly.";

/** Sent when the output check rejects a reply. The turn becomes a handoff, not a retry. */
export const BLOCKED_REPLY =
  "Let me get someone from the team to confirm that for you.";

// English only today. Hindi/Kannada/Hinglish need their own list, not a translation
// of this one.
const MINOR_PATTERNS: RegExp[] = [
  /\b(?:8|9|10|11|12)(?:th)?\s+standard\b/i,
  /\bclass\s+(?:8|9|10|11|12)\b/i,
  /\bmy\s+(?:class\s+)?teacher\b/i,
  /\bboard\s+exams?\b/i,
  /\bPUC\b/,
  /\bmy\s+(?:mom|mum|mummy|dad|papa|parents)\s+(?:said|says|will)\b/i,
  /\bi\s+don'?t\s+have\s+a\s+card\b/i,
  /\bi'?m\s+in\s+school\b/i,
  /\bschool\s+student\b/i,
];

// ⚠️ "Messaging during school hours" was in the original doc and is wrong: it fires on
// every adult booking an 11am appointment. Time of day is not a signal at all.

const DISTRESS_PATTERNS: RegExp[] = [
  /\bkill\s+myself\b/i,
  /\bend\s+(?:it\s+all|my\s+life)\b/i,
  /\bsuicid(?:e|al)\b/i,
  /\bself[\s-]?harm\b/i,
  /\bwant\s+to\s+die\b/i,
  /\bhurt(?:ing)?\s+myself\b/i,
  /\bno\s+reason\s+to\s+live\b/i,
];

const ABUSE_PATTERNS: RegExp[] = [
  /\b(?:he|she|they|husband|wife|father|mother)\s+(?:hits|beats|hit|beat)\s+me\b/i,
  /\bbeing\s+abused\b/i,
  /\bnot\s+safe\s+at\s+home\b/i,
  /\bthreaten(?:s|ed|ing)\s+to\s+(?:kill|hurt)\s+me\b/i,
];

/**
 * Runs before the model and outranks it. If this fires, the model's reply is discarded
 * whatever the model said about its own flags — the model is the thing we do not trust.
 */
export function prefilter(text: string | null | undefined): SafetyKind | null {
  if (!text) return null;
  // Order is severity: an at-risk adult and a minor in the same message is handled as
  // the at-risk adult.
  if (DISTRESS_PATTERNS.some((re) => re.test(text))) return "self_harm";
  if (ABUSE_PATTERNS.some((re) => re.test(text))) return "abuse";
  if (MINOR_PATTERNS.some((re) => re.test(text))) return "minor";
  return null;
}

/** Maps the model's own flags onto the same outcomes. Only consulted if the prefilter stayed quiet. */
export function flagFromModel(flags: ModelFlags | undefined): SafetyKind | null {
  if (!flags) return null;
  if (flags.distress) return "distress";
  if (flags.minor) return "minor";
  return null;
}

// --- output check ----------------------------------------------------------

/**
 * Sectors we onboard. Investment, insurance, lending and legal are absent on purpose:
 * they are out of scope, and the check for them is refusing the contract.
 */
export const SECTORS = ["general", "real_estate", "healthcare", "pharmacy"] as const;
export type Sector = (typeof SECTORS)[number];

export interface OutputVerdict {
  ok: boolean;
  /** Why it was rejected. Goes to the owner, never to the customer. */
  reason?: string;
}

const PRICE = /(?:₹|\bRs\.?\b|\bINR\b)\s?[\d,]/i;
const RERA = /\bRERA\b|\b[A-Z]{2}RERA[A-Z0-9/-]+\b/i;
const POSSESSION = /\bpossession\b.*\b(?:20\d\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const DIAGNOSIS = /\b(?:you\s+(?:have|likely\s+have|probably\s+have)|sounds\s+like\s+you\s+have)\b/i;
const PRESCRIPTION = /\b(?:take|apply|use)\s+\d+\s?(?:mg|ml|tablets?|drops?)\b|\bprescrib/i;
const CURE = /\b(?:cures?|cured|curing)\b|\b100%\s+(?:relief|results?)\b|\bpermanent(?:ly)?\s+(?:cure|relief)\b/i;

/**
 * Runs on the model's text before it is sent, regardless of what the KB said. A
 * rejected reply becomes a handoff — never a retry, because a retry with the same KB
 * produces the same sentence.
 */
export function checkOutput(sector: Sector, reply: string): OutputVerdict {
  switch (sector) {
    case "real_estate":
      if (PRICE.test(reply) && !RERA.test(reply)) {
        return { ok: false, reason: "quoted a price without a RERA number" };
      }
      if (POSSESSION.test(reply) && !RERA.test(reply)) {
        return { ok: false, reason: "gave a possession date without a RERA number" };
      }
      return { ok: true };

    case "healthcare":
      if (DIAGNOSIS.test(reply)) return { ok: false, reason: "diagnosed the customer" };
      if (PRESCRIPTION.test(reply)) return { ok: false, reason: "prescribed a dose" };
      return { ok: true };

    case "pharmacy":
      // Advertising a cure for a listed condition is a criminal offence under the
      // Drugs and Magic Remedies Act, so this one is not a style preference.
      if (CURE.test(reply)) return { ok: false, reason: "advertised a cure" };
      if (PRESCRIPTION.test(reply)) return { ok: false, reason: "prescribed a dose" };
      return { ok: true };

    case "general":
      return { ok: true };
  }
}

/**
 * Invariant 5. The prompt asks for one message; this is the half that is enforced.
 * A model that splits its answer would otherwise cost two Meta sends and read as two
 * separate replies to the customer.
 */
export function assertSingleReply(reply: string): string {
  const trimmed = reply.trim();
  if (trimmed.length === 0) throw new Error("model returned an empty reply");
  if (trimmed.includes("\n\n\n")) throw new Error("model returned more than one message");
  if (/^\s*(?:message\s*[12]\s*:|\[\s*message\s*[12]\s*\])/im.test(trimmed)) {
    throw new Error("model returned more than one message");
  }
  return trimmed;
}
