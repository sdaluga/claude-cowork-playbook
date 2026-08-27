/**
 * Agent options: the blast radius and the tenant isolation, in one place.
 * =======================================================================
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * Every line here is a control. Not a tuning knob -- a control. Somebody who
 * doesn't know why `settingSources: []` is there will delete it during a
 * cleanup, and nothing will fail until one tenant's context shows up in
 * another tenant's prompt.
 *
 * Pulling it out means it can be asserted on in a test, which is the only
 * durable way to say "this line matters". See tests/options.test.ts.
 *
 * The return value is a plain object rather than a named SDK type on purpose:
 * it keeps this file (and its tests) free of any RUNTIME dependency on the
 * SDK, so the options tests are milliseconds and need no install. Type
 * checking still happens where it counts -- `agent.ts` spreads this into
 * `query({ options })`, so the compiler validates the shape at the call site.
 *
 * The one exception is the `import type` below. A type-only import is erased
 * entirely at compile time -- it emits no `require`, no `import`, nothing --
 * so it costs nothing at runtime. It is here because `settingSources` is a
 * union of specific strings, not `string[]`: typing the empty array as
 * `string[]` compiles here and then fails at the call site with an error that
 * points at the wrong file. Borrow the real type and the error lands where
 * the mistake is.
 */

import type { SessionStore, SettingSource } from "@anthropic-ai/claude-agent-sdk";

import { sanitize } from "./contract.js";

export const TRIAGE_MODEL = "claude-haiku-4-5-20251001";
export const TRIAGE_FALLBACK_MODEL = "claude-sonnet-5";

/**
 * @param sessionStore Optional durable transcript mirror. Passed in rather
 *   than constructed here so this file keeps its zero-runtime-SDK property --
 *   the store implementation does import the SDK, and importing it here would
 *   drag that dependency into the options tests for no benefit.
 */
export function buildTriageOptions(
  sessionId: string,
  systemPrompt: string,
  sessionStore?: SessionStore,
) {
  const tenant = sanitize(sessionId);

  return {
    systemPrompt,

    // ---- Session continuity ---------------------------------------------
    // `resume` rehydrates the thread. Triage without history re-litigates
    // every thread from scratch; triage with history knows this is the third
    // follow-up on an unanswered question, which is the actual signal.
    resume: sessionId,

    // Where that history actually lives. Without a store, transcripts are
    // JSONL on the container's local disk and every thread is forgotten on
    // the next restart, scale-down or reschedule -- silently, because
    // triage still returns a confident answer, just a worse one.
    //
    // The subprocess still writes locally first; this receives a copy.
    // See session-store.ts.
    sessionStore,
    // 'batched' (the default) buffers and flushes at end-of-turn. 'eager'
    // gives near-real-time delivery at one append() call per frame, which is
    // only worth it if something outside this service tails the transcript.
    sessionStoreFlush: "batched" as const,

    // ---- Blast radius ----------------------------------------------------
    // The empty allow list is not an oversight. Triage is pure judgment over
    // text that was handed to it: no filesystem, no shell, no network needed.
    // The most secure tool is the one you did not grant.
    allowedTools: [] as string[],
    disallowedTools: ["Bash", "Write", "Edit", "WebFetch", "WebSearch"],

    // With no tools, one turn is all it can take. A hard ceiling on both
    // latency and cost per message.
    maxTurns: 1,

    // ---- Model -----------------------------------------------------------
    // Triage is high-volume and latency-sensitive.
    model: TRIAGE_MODEL,
    fallbackModel: TRIAGE_FALLBACK_MODEL,

    // ---- Multi-tenant isolation ------------------------------------------
    // Four controls. Skipping any one of them leaves the hole open.
    //
    // 1. No CLAUDE.md, no host settings.
    settingSources: [] as SettingSource[],
    env: {
      ...process.env,
      // 2. Auto memory loads into the system prompt REGARDLESS of
      //    settingSources. This is the one people miss.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      // 3. Per-tenant config dir, so tenants never share ~/.claude.json.
      CLAUDE_CONFIG_DIR: `/tmp/claude-config/${tenant}`,
    },
    // 4. Per-tenant working directory.
    //
    // This one does double duty: the SessionStore's `projectKey` is derived
    // from the resolved cwd, so a per-tenant cwd is also what keeps one
    // tenant's stored transcripts out of another tenant's listing. There is
    // no separate projectKey option -- change this line and you have changed
    // the storage partition too.
    cwd: `/tmp/claude-work/${tenant}`,
  };
}
