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
| **One session = one subprocess** | Concurrency is bounded by RAM, not by your event loop. Budget ~1 GiB per concurrent agent as a *floor*. | `semaphore.ts` |
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
                 │                (ephemeral, source of truth)   │
                 │                       │                      │
                 │                       ▼                      │
                 │            session-store.ts  append()        │
                 └───────────────────────┼──────────────────────┘
                                         ▼
                          durable storage (volume / S3 / Postgres)
                          resume: load() ──► temp JSONL ──► subprocess
```

## How the code is split, and why

You cannot unit test a language model. You *can* unit test every control around it — and in a hosted agent, the controls are where the incidents come from. So the model call is one small file and everything that must be correct regardless of what the model says is pure, importable, and tested.

```
src/
  contract.ts       types, response parsing, id sanitising  pure · 28 tests
  options.ts        blast radius + tenant isolation         pure · 15 tests
  semaphore.ts      the concurrency bound                   pure · 10 tests
  session-store.ts  durable transcripts                          · 33 tests
  agent.ts          prompts and the query() call            the model-facing part
  server.ts         HTTP, health, lifecycle
tests/
  contract.test.ts  options.test.ts  semaphore.test.ts  session-store.test.ts
```

`options.ts` returns a plain object rather than a named SDK type, so it and its tests carry **no runtime dependency on the SDK** — the one `import type` is erased at compile time and emits nothing. Type checking still happens where it counts: `agent.ts` spreads the object into `query({ options })`, so the compiler validates the real shape at the call site.

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
- **Best-effort.** When a batch can't be delivered, the SDK emits `{ type: "system", subtype: "mirror_error" }` and continues. **Alert on those** — the service keeps returning confident answers while its memory develops holes, so nothing else will tell you. `agent.ts` logs it as `session.mirror_error`.

### The adapter, in [`src/session-store.ts`](src/session-store.ts)

The SDK ships exactly one implementation, `InMemorySessionStore`, and it's for tests — it dies with the process, same as local disk. You write the real one.

So this example ships a working adapter. The contract logic is written once against a five-method storage seam, so porting to real infrastructure means writing five methods, not re-deriving the contract:

```ts
interface BlobBackend {
  append(key, lines)   read(key)   write(key, body)
  list(prefix)         remove(key)     stamp()   // the storage clock
}
```

`VolumeBackend` (a mounted PVC/EFS/named volume) ships with it; the S3, Postgres and Redis mappings are documented at the bottom of the file, Postgres DDL included.

**Turn it on** by setting `SESSION_STORE_DIR` and mounting a volume there. Unset, it returns `undefined` — the SDK's no-mirroring default. It deliberately does *not* fall back to an in-memory store: something that looks configured and silently loses everything on restart is worse than nothing, because you find out from a customer.

**Six details the contract makes easy to get wrong**, each pinned by a test:

| # | The mistake | What it costs you |
|---|---|---|
| 1 | Appending without treating `uuid` as an idempotency key | Retries and replays duplicate transcript lines, corrupting the resumed conversation |
| 2 | Deduping entries that have *no* uuid | Titles and tags are updates, not duplicates — the session title freezes at its first value |
| 3 | Leaving `projectKey` as the default sanitised cwd | Cross-tenant reads. Here the per-tenant `cwd` does double duty and partitions storage too |
| 4 | Returning `[]` instead of `null` for an unwritten session | Resumes into a blank thread instead of starting a fresh one |
| 5 | Taking summary `mtime` from entry timestamps | Entries are batched and arrive late; the staleness check silently breaks |
| 6 | Not serialising the summary read-fold-write | Concurrent appends lose updates. `foldSessionSummary` is pure — locking is *your* job |

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

Four controls, and skipping any one of them leaks one tenant's context into another's prompt:

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

## The tests, and what they are actually for

```bash
npm test      # 86 tests, ~2s, no API key, no model call
```

These are not coverage theatre. Every assertion pins down a line that a future reader would reasonably delete.

| Test file | The incident it prevents |
|---|---|
| `contract.test.ts` | A model returns prose, truncated JSON, or an array — and the message is **swallowed** instead of escalated. Seven garbage inputs must all produce `needs_human: true`. |
| `contract.test.ts` | `needs_human: parsed.needs_human !== false` gets "simplified" to `!!parsed.needs_human`. One character; every message missing the field is now silently marked *no human needed*. |
| `options.test.ts` | Someone tidies away `settingSources: []` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY`. Nothing fails — no error, no warning — until a host `CLAUDE.md` or one tenant's context appears inside another tenant's prompt. |
| `options.test.ts` | The `...process.env` spread is dropped, and the subprocess loses `PATH` and `ANTHROPIC_API_KEY`. Fails in production, not on a laptop. |
| `options.test.ts` | A session id of `../../etc` becomes a directory outside its parent. |
| `semaphore.test.ts` | A task that throws never releases its slot; the pool wedges after `MAX_CONCURRENT` failures and the container serves nothing while looking healthy. |
| `semaphore.test.ts` | The bound admits `max + 1` under burst — an OOM kill, not a slow request. |
| `session-store.test.ts` | A retried mirror batch duplicates transcript lines, or `load()` returns `[]` instead of `null` — the agent then reasons correctly about the wrong conversation. That never surfaces as an exception; it surfaces as a customer asking why it forgot. |

**These tests were mutation tested.** Each control was deliberately broken in turn — truthy `needs_human`, deleted `settingSources`, deleted auto-memory flag, dropped env spread, unsanitised tenant path, slot released outside `finally` — and the suite was confirmed to go red for every one. A test that stays green when you break the thing it names is worse than no test, because it certifies the wrong thing.

Writing them also caught a real bug: `sanitize("///")` returned `"___"`, because the fallback only fired on an *empty* string. Safe, but a meaningless tenant directory. The guard now checks for alphanumeric content.

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
npm test             # 86 control tests — no API key needed
npm run typecheck    # src and tests, both strict
npm run build && npm start
```

`npm test` is the one command here that needs no API key and spends no money. Run it first — if it fails on a fresh clone, the problem is your install, not your key.

| Env var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required |
| `PORT` | `8080` | HTTP port |
| `MAX_CONCURRENT` | `4` | Concurrent agents — this is a **RAM** bound |
| `SESSION_STORE_DIR` | — | Mirror transcripts here. Unset = local disk only, lost on restart |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | — | Set `1` for OTEL export |

## Deploy it

`deploy/` in the repo root has the Dockerfile, compose file, and Kubernetes manifest, with the sizing and probe configuration wired to this service. See [docs/04-deployment-guide.md](../../docs/04-deployment-guide.md).

## Make it yours

| You want | Change this |
|---|---|
| Real durable sessions | Set `SESSION_STORE_DIR` and mount a volume — or swap `VolumeBackend` for S3/Postgres, five methods |
| Different urgency semantics | `SYSTEM_PROMPT` in `agent.ts` — one place, whole service |
| Different output fields | `contract.ts`, then extend `contract.test.ts` — the parser is the contract |
| Slack instead of email | Keep `triage()`; swap `server.ts` for a Slack Events handler |
| Auto-send safe replies | Add a `send_reply` tool, gate it on `needs_human === false`, log every send — and add a test that a missing `needs_human` never opens that gate |
| Higher throughput | Raise `MAX_CONCURRENT` **only** alongside container memory, then scale horizontally with sticky sessions |

## Where this breaks

- **No auth.** Deliberately. Authentication belongs at a gateway in front of this; the agent should receive pre-authenticated requests. See [docs/05-security-and-governance.md](../../docs/05-security-and-governance.md).
- **`MAX_CONCURRENT` is a memory bound.** Raising it without raising RAM gets you OOM kills, not throughput.
- **In-memory semaphore.** Fine for one container. Across a fleet, the bound is per-pod, so size the fleet accordingly.
- **No session eviction.** A long-lived container accumulates transcripts. The SDK never deletes from your store — retention is the adapter's job. Add a TTL sweep, an S3 lifecycle rule, or a scheduled cleanup to match your compliance window.
- **`VolumeBackend` is single-writer.** Its uuid dedup is per-process, which covers the SDK's retries and import replays. Two replicas appending to one session need the dedup enforced in storage — the Postgres unique index in `session-store.ts` does exactly that. Sticky sessions mean you should not be in that situation anyway.

---

**Back to:** [repo README](../../README.md) · **Deploy:** [docs/04-deployment-guide.md](../../docs/04-deployment-guide.md)
