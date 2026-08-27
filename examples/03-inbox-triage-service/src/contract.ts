/**
 * The triage contract: types, parsing, and input sanitising.
 * =========================================================
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * Everything here is pure. No SDK import, no network, no filesystem. That is
 * deliberate: it means the most consequential logic in the service can be
 * tested exhaustively, in milliseconds, with no API key and no model call.
 *
 * `agent.ts` handles the part that talks to a model. This file handles the
 * part that has to be right whether or not the model behaves — which is the
 * part you can actually make promises about.
 *
 * See tests/contract.test.ts.
 */

export type Urgency = "now" | "today" | "this_week" | "no_action";

export interface TriageResult {
  urgency: Urgency;
  category: string;
  summary: string;
  suggested_reply: string | null;
  entities: string[];
  needs_human: boolean;
  reasoning: string;
}

export interface TriageRequest {
  /** Stable id for the conversation thread. Same thread -> same id. */
  sessionId: string;
  /** Who sent it, as free text. */
  from: string;
  subject: string;
  body: string;
}

export const VALID_URGENCY: readonly Urgency[] = [
  "now",
  "today",
  "this_week",
  "no_action",
];

/**
 * What we return when we cannot read the model's response.
 *
 * Note what this is NOT: it is not an error, and it is not a dropped message.
 * It is an escalation. The expensive failure in triage is a silently swallowed
 * urgent message; an extra item in a human's queue costs almost nothing.
 *
 * Fail safe, not closed.
 */
export function escalationFallback(reason: string): TriageResult {
  return {
    urgency: "today",
    category: "other",
    summary: "Triage output could not be parsed; routed to a human.",
    suggested_reply: null,
    entities: [],
    needs_human: true,
    reasoning: reason,
  };
}

/**
 * Parse a model response into a TriageResult.
 *
 * Never trust the shape of model output. Parse it the way you would parse a
 * request body from the internet: defensively, with every field validated and
 * a fallback that escalates rather than guesses.
 */
export function parseTriage(raw: string): TriageResult {
  // Models sometimes wrap JSON in a fenced code block despite instructions.
  const cleaned = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return escalationFallback("The agent response contained no JSON object.");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return escalationFallback("The agent response was not valid JSON.");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return escalationFallback("The agent response was not a JSON object.");
  }

  const urgency = parsed.urgency as Urgency;

  return {
    // An unrecognised urgency is not a reason to drop the message. Land in the
    // middle and let a human sort it.
    urgency: VALID_URGENCY.includes(urgency) ? urgency : "today",
    category: typeof parsed.category === "string" ? parsed.category : "other",
    summary: String(parsed.summary ?? "").slice(0, 400),
    suggested_reply:
      typeof parsed.suggested_reply === "string" ? parsed.suggested_reply : null,
    entities: Array.isArray(parsed.entities)
      ? parsed.entities.map(String).slice(0, 20)
      : [],
    // THE IMPORTANT LINE. Only an explicit `false` means "no human needed".
    // A missing field, a null, a string, a typo -- all escalate. Getting this
    // backwards is one character and a silently swallowed urgent message.
    needs_human: parsed.needs_human !== false,
    reasoning: String(parsed.reasoning ?? "").slice(0, 600),
  };
}

/**
 * Session ids arrive from callers and end up as directory names under
 * /tmp/claude-work and /tmp/claude-config. Sanitise them.
 *
 * Same class of bug as a path-traversal write guard: an id like
 * "../../etc" must not become a directory outside its parent.
 *
 * Two rules, and the second one was added because a test caught it:
 *
 *   1. Anything outside [a-zA-Z0-9_-] becomes an underscore, and the result is
 *      capped at 64 characters. That kills traversal, separators, spaces and
 *      shell metacharacters in one pass.
 *   2. If nothing recognisable survives, fall back to "default". Checking for
 *      an empty string is not enough: "///" survives rule 1 as "___", which is
 *      safe but meaningless. The real question is whether the id carried any
 *      alphanumeric content at all.
 *
 * Note that this is for PATHS only. The session id passed to `resume` is the
 * caller's original string -- rewriting it would quietly point two different
 * threads at the same transcript.
 */
export function sanitize(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return /[a-zA-Z0-9]/.test(cleaned) ? cleaned : "default";
}
