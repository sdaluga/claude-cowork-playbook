# Example 03 — Inbox Triage Service

**The agent leaves your laptop.** A long-running TypeScript service that triages inbound messages behind an HTTP port, remembers each thread, and survives a restart.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev

curl -s localhost:8080/triage -H 'content-type: application/json' -d '{
  "sessionId": "thread-8817",
  "from": "priya@customer.example",
  "subject": "Re: Re: SSO rollout — still blocked",
  "body": "Third time asking. Our pilot users cannot log in and the go-live is Thursday."
}' | jq
```

```json
{
  "urgency": "now",
  "category": "customer",
  "summary": "Customer pilot is blocked on SSO login failures with a Thursday go-live.",
  "suggested_reply": "Priya — apologies for the delay...",
  "entities": ["Priya", "SSO"],
  "needs_human": true,
  "reasoning": "Third follow-up on an unanswered blocker with a dated deadline. Customer-facing commitment, so a human sends."
}
```

---

## The one fact that drives every decision in this example

`query()` spawns a **`claude` CLI subprocess** and talks to it over stdio. That subprocess owns a shell, a working directory, and a JSONL transcript on local disk.

```
  client ──► your app ──► claude CLI subprocess ──► api.anthropic.com
                                 │
                                 └──► local disk (transcript, cwd)
```

Hosting the Agent SDK is therefore **not** like hosting a stateless API wrapper. Three consequences, and this example handles all three:

| Consequence | What it means | Where it shows up |
|---|---|---|
| **One session = one subprocess** | Concurrency is bounded by RAM, not by your event loop. Budget ~1 GiB per concurrent agent as a *floor*. | The semaphore in `server.ts` |
| **Local disk is ephemeral** | Transcripts don't survive a restart, a scale-down, or a reschedule. | `SessionStore` — see below |
| **Sessions are sticky** | Behind a load balancer you must pin a session id to a container, or you resume against a subprocess that isn't there. | Consistent hashing at the LB |

> **Sizing formula:** `agents per host = (host RAM − overhead) / per-session RAM ceiling`. Measure the ceiling by running a representative session to your target length under real tool load and recording peak RSS. 1 GiB is a floor, not a ceiling.

## Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │  CONTAINER                                   │
   POST /triage  │                                              │
   ─────────────►│  server.ts                                   │
                 │   ├── validate at the edge                   │
                 │   ├── semaphore  (MAX_CONCURRENT slots)      │
                 │   └── withSlot ──► agent.ts triage()         │
                 │                       │                      │
   GET /healthz  │                       ▼                      │
   GET /readyz   │              query({ resume: sessionId })    │
                 │                       │                      │
                 │                 claude CLI subprocess ───────┼──► api.anthropic.com
                 │                       │                      │
                 │                       ▼                      │
                 │               transcript on local disk       │
                 │                       │                      │
                 └───────────────────────┼──────────────────────┘
                                         ▼
                              SessionStore (S3 / Redis / Postgres)
```

## Sessions: the thing that makes triage actually work

Each thread maps to one `sessionId`. `resume: sessionId` rehydrates the transcript, so turn 4 still knows what happened in turn 1.

That's not a nicety. Triage *without* history re-litigates every thread from scratch. Triage *with* history says **"this is the third follow-up on an unanswered question"** — which is the entire signal. Look at the example response above: `urgency: "now"` is driven by the follow-up count, not by the words in this message.

### Where transcripts live, and why you must change it

| State | Default location | Survives a restart? |
|---|---|---|
| Session transcripts | `~/.claude/projects/`, or `$CLAUDE_CONFIG_DIR/projects/` | ❌ |
| `CLAUDE.md` memory | `~/.claude/CLAUDE.md` and the session cwd | ❌ |
| Working-directory artifacts | The session's cwd | ❌ |

For anything a user expects to resume, attach a **`SessionStore`** adapter so transcripts are mirrored to durable storage. Three things to know about how it behaves:

- **Transcripts only.** It mirrors transcripts, not `CLAUDE.md` or working-directory artifacts. Those need a mounted volume or an object-store sync.
- **Mirror, not replacement.** The subprocess writes local disk first; the SDK forwards a copy to the store.
- **Best-effort.** When a batch can't be delivered, the SDK emits `{ type: "system", subtype: "mirror_error" }` and continues. **Alert on those** if durability matters.

## Choosing a session pattern

Four patterns, from the SDK hosting guidance. Pick one before you pick a cloud.

| Pattern | Container lifetime | Good for | Example workloads |
|---|---|---|---|
| **Ephemeral** | One per task, destroyed on completion | One-off work | Bug fix, invoice extraction (our example 02), document translation |
| **Long-running** | Persistent, many sessions per container | Continuous traffic | **This example.** Email triage, Slack bots, site builders |
| **Hybrid** | Ephemeral + hydrate from a `SessionStore` | Spans many interactions, idle between them | Project manager with check-ins, deep research that pauses |
| **Multi-agent** | One container, several SDK subprocesses | Agents that collaborate closely | Simulations, agent-to-agent workflows |

## The blast radius is empty on purpose

```ts
allowedTools: [],
disallowedTools: ["Bash", "Write", "Edit", "WebFetch", "WebSearch"],
maxTurns: 1,
```

That empty allow list is not an oversight. Triage is pure judgment over text that was handed to it — it needs no filesystem, no shell, and no network. **The most secure tool is the one you did not grant.** With no tools, `maxTurns: 1` is a hard ceiling on both latency and cost per message.

## Multi-tenant isolation

Three settings, and skipping any of them leaks one tenant's context into another's prompt:

```ts
settingSources: [],                              // no CLAUDE.md, no host settings
env: {
  ...process.env,                                // TS replaces env — keep PATH and the API key
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",          // auto memory loads regardless of settingSources
  CLAUDE_CONFIG_DIR: `/tmp/claude-config/${id}`, // don't share ~/.claude.json
},
cwd: `/tmp/claude-work/${id}`,                   // per-tenant working directory
```

`CLAUDE_CODE_DISABLE_AUTO_MEMORY` is the one people miss. Auto memory loads into the system prompt **regardless of `settingSources`**.

> In TypeScript, `env` **replaces** the subprocess environment — spread `...process.env` or you lose `PATH` and `ANTHROPIC_API_KEY`. In Python, `env` merges on top. This asymmetry has cost people an afternoon.

## Failing safe, not closed

Two places this service refuses to drop a message:

**Unparseable model output** (`agent.ts` → `parseTriage`) returns `urgency: "today"`, `needs_human: true`. **Service error** (`server.ts` → catch block) returns HTTP 200 with the same escalation shape.

The expensive error in triage is a silently swallowed urgent message, not an extra item in someone's queue. Note also that `needs_human` defaults to `true` when the field is missing — an omission is never read as "no human needed."

## Health vs. readiness

Two endpoints, and they mean different things:

- **`/healthz`** — "the process is alive." Kubernetes restarts the pod when this fails, so it must **never** depend on a downstream service or one slow dependency becomes a restart loop.
- **`/readyz`** — "send me traffic." Returns 503 when the semaphore is saturated, so the load balancer routes elsewhere instead of queueing here.

## Setup

```bash
cd examples/03-inbox-triage-service
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev          # tsx watch
npm run typecheck    # tsc --noEmit
npm run build && npm start
```

| Env var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required |
| `PORT` | `8080` | HTTP port |
| `MAX_CONCURRENT` | `4` | Concurrent agents — this is a **RAM** bound |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | — | Set `1` for OTEL export |

## Deploy it

`deploy/` in the repo root has the Dockerfile, compose file, and Kubernetes manifest, with the sizing and probe configuration wired to this service. See [docs/04-deployment-guide.md](../../docs/04-deployment-guide.md).

## Make it yours

| You want | Change this |
|---|---|
| Real durable sessions | Add a `SessionStore` adapter (S3/Redis/Postgres) to the options in `agent.ts` |
| Different urgency semantics | `SYSTEM_PROMPT` in `agent.ts` — one place, whole service |
| Slack instead of email | Keep `triage()`; swap `server.ts` for a Slack Events handler |
| Auto-send safe replies | Add a `send_reply` tool, gate it on `needs_human === false`, and log every send |
| Higher throughput | Raise `MAX_CONCURRENT` **only** alongside container memory, then scale horizontally with sticky sessions |

## Where this breaks

- **No auth.** Deliberately. Authentication belongs at a gateway in front of this; the agent should receive pre-authenticated requests. See [docs/05-security-and-governance.md](../../docs/05-security-and-governance.md).
- **`MAX_CONCURRENT` is a memory bound.** Raising it without raising RAM gets you OOM kills, not throughput.
- **In-memory semaphore.** Fine for one container. Across a fleet, the bound is per-pod, so size the fleet accordingly.
- **No session eviction.** A long-lived container accumulates transcripts on local disk. Add a TTL sweep or use the hybrid pattern.

---

**Back to:** [repo README](../../README.md) · **Deploy:** [docs/04-deployment-guide.md](../../docs/04-deployment-guide.md)
