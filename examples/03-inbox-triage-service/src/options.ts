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

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";

import { sanitize } from "./contract.js";

export const TRIAGE_MODEL = "claude-haiku-4-5-20251001";
export const TRIAGE_FALLBACK_MODEL = "claude-sonnet-5";

export function buildTriageOptions(sessionId: string, systemPrompt: string) {
  const tenant = sanitize(sessionId);

  return {
    systemPrompt,

    // ---- Session continuity ---------------------------------------------
    // `resume` rehydrates the thread. Triage without history re-litigates
    // every thread from scratch; triage with history knows this is the third
    // follow-up on an unanswered question, which is the actual signal.
    resume: sessionId,

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
    cwd: `/tmp/claude-work/${tenant}`,
  };
}
