/**
 * Example 03 — Inbox Triage Service (the hosting half)
 * ====================================================
 *
 * WHAT CHANGES WHEN AN AGENT LEAVES YOUR LAPTOP
 * ---------------------------------------------
 * Examples 01 and 02 are processes that start, do a thing, and exit. This one
 * runs indefinitely, serves many callers, and has to survive being restarted
 * at an inconvenient moment. That is a different engineering problem, and the
 * SDK's architecture is why.
 *
 * THE ONE FACT THAT DRIVES EVERY DECISION HERE
 * --------------------------------------------
 * `query()` spawns a `claude` CLI **subprocess** and talks to it over stdio.
 * That subprocess owns a shell, a working directory, and a JSONL transcript on
 * local disk.
 *
 *      client ──► your app ──► claude CLI subprocess ──► api.anthropic.com
 *                                     │
 *                                     └──► local disk (transcript, cwd)
 *
 * Consequences, all of which this file handles:
 *
 *   1. One session = one subprocess. Concurrency is bounded by RAM, not by
 *      an event loop. Budget ~1 GiB per concurrent agent as a floor.
 *   2. Local disk does not survive a restart. Anything a user expects to
 *      resume needs a SessionStore.
 *   3. Sessions are sticky. Behind a load balancer, pin a session id to a
 *      container with consistent hashing or you will resume against a
 *      subprocess that is not there.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is a reference implementation, not a framework. There is no auth here:
 * authentication belongs at a gateway in front of this service, and the agent
 * should receive pre-authenticated requests. See docs/05-security-and-
 * governance.md.
 */

import express, { type Request, type Response } from "express";
import { triage, type TriageRequest, type TriageResult } from "./agent.js";

const PORT = Number(process.env.PORT ?? 8080);

// Concurrency ceiling. Each in-flight triage holds a subprocess, so this is a
// memory bound, not a throughput knob. Raising it past what the container's
// RAM supports gets you OOM kills, not more throughput.
//
//     agents per host = (host RAM - overhead) / per-session RAM ceiling
//
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 4);

const app = express();
app.use(express.json({ limit: "1mb" }));

// --------------------------------------------------------------------------
// A minimal semaphore.
// --------------------------------------------------------------------------
// Without this, a burst of 200 messages spawns 200 subprocesses and the
// container dies. With it, the 5th caller waits. Backpressure is a feature.

let active = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// --------------------------------------------------------------------------
// Health and readiness
// --------------------------------------------------------------------------
// Two endpoints, not one, and they mean different things.
//
//   /healthz  -- "the process is alive." Kubernetes restarts the pod if this
//                fails. It must never depend on a downstream service, or one
//                slow dependency turns into a restart loop.
//
//   /readyz   -- "send me traffic." Fails when the pool is saturated, so the
//                load balancer routes elsewhere instead of queueing here.

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
});

app.get("/readyz", (_req: Request, res: Response) => {
  const saturated = active >= MAX_CONCURRENT;
  res.status(saturated ? 503 : 200).json({
    ready: !saturated,
    active,
    max: MAX_CONCURRENT,
    queued: waiting.length,
  });
});

// --------------------------------------------------------------------------
// POST /triage
// --------------------------------------------------------------------------

app.post("/triage", async (req: Request, res: Response) => {
  const body = req.body as Partial<TriageRequest>;

  // Validate before spending a token. The cheapest request is the one you
  // reject at the edge.
  if (!body.sessionId || !body.body) {
    return res.status(400).json({
      error: "sessionId and body are required",
    });
  }

  const request: TriageRequest = {
    sessionId: String(body.sessionId),
    from: String(body.from ?? "unknown"),
    subject: String(body.subject ?? "(no subject)"),
    body: String(body.body).slice(0, 50_000),
  };

  const started = Date.now();

  try {
    const result: TriageResult = await withSlot(() => triage(request));

    // Structured logs, one line per request. In production these go to your
    // aggregator; the fields you want are the ones you will filter on at 3am.
    console.log(
      JSON.stringify({
        evt: "triage.ok",
        session: request.sessionId,
        urgency: result.urgency,
        category: result.category,
        needs_human: result.needs_human,
        ms: Date.now() - started,
      }),
    );

    res.json(result);
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "triage.error",
        session: request.sessionId,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    // Fail safe, not closed. A triage service that drops messages on error is
    // worse than one that escalates them. The caller gets something actionable.
    res.status(200).json({
      urgency: "today",
      category: "other",
      summary: "Triage failed; routed to a human.",
      suggested_reply: null,
      entities: [],
      needs_human: true,
      reasoning: "The triage service errored. Review this message manually.",
    });
  }
});

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      evt: "server.start",
      port: PORT,
      max_concurrent: MAX_CONCURRENT,
      telemetry: process.env.CLAUDE_CODE_ENABLE_TELEMETRY === "1",
    }),
  );
});

// Graceful shutdown. An orchestrator sends SIGTERM and then waits before
// SIGKILL. Use that window to finish in-flight work; a triage killed halfway
// costs you the tokens you already spent and produces nothing.
function shutdown(signal: string) {
  console.log(JSON.stringify({ evt: "server.shutdown", signal, active }));
  server.close(() => process.exit(0));
  // Backstop, in case a subprocess wedges.
  setTimeout(() => process.exit(1), 30_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
