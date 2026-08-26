# Deploy

Container, compose file, and Kubernetes manifests for running a Claude Agent SDK service in production — wired to [example 03](../examples/03-inbox-triage-service/).

```bash
# Local, end to end
export ANTHROPIC_API_KEY=sk-ant-...
docker compose -f deploy/docker-compose.yml up --build

# With telemetry, so you can see what the SDK actually emits
docker compose -f deploy/docker-compose.yml --profile observability up --build

# Kubernetes
kubectl create secret generic anthropic --from-literal=api-key=sk-ant-...
kubectl apply -f deploy/k8s/deployment.yaml
```

---

## Read this before you copy the manifests

**The SDK spawns a `claude` CLI subprocess per session.** That subprocess owns a shell, a working directory, and a JSONL transcript on local disk.

Almost every unusual line in these files traces back to that one sentence:

| What looks odd | Why it's there |
|---|---|
| HPA scales on **memory**, not CPU | An agent waiting on a model response uses almost no CPU while holding its full working set. CPU is a poor proxy for agent load. |
| `terminationGracePeriodSeconds: 120` | In-flight agent work is expensive to throw away — you've already paid the tokens. |
| `requests` close to `limits` | Agent memory is lumpy. A session that grows mid-run on a burstable pod gets evicted, and you lose the work. |
| `sessionAffinity` on the Service | A resumed session must land on the pod holding its subprocess. |
| `tini` as PID 1 | The agent forks children. Without an init that reaps them, zombies accumulate until the PID table gives up. |
| `pids_limit` in compose | A runaway loop should exhaust one container's process table, not the host's. |
| `maxUnavailable: 0` | A rolling update shouldn't take capacity away while long sessions are in flight. |
| `emptyDir`, not a PVC | Local disk is scratch. Durable transcripts belong in a `SessionStore`. |

## Sizing

```
agents per pod = (pod RAM − overhead) / per-session RAM ceiling
```

Measure the ceiling yourself: run a representative session to your target length, under your real tool load, and record peak RSS. **1 GiB per agent is a documented floor, not a ceiling.**

Setting `MAX_CONCURRENT=8` on a 4Gi pod does not give you eight agents. It gives you `OOMKilled`.

The defaults here — `MAX_CONCURRENT=3`, `requests: 3Gi`, `limits: 4Gi` — are a starting point that fits a light, single-turn agent like the triage service. A tool-heavy, twenty-turn agent needs considerably more.

## Cost: where the money actually goes

Token cost typically dominates container infrastructure cost **by an order of magnitude or more**. A minimally provisioned container runs roughly $0.05/hour; a single long agent session can spend dollars in tokens.

Practical consequence: optimising your container bin-packing before you've looked at per-session token spend is optimising the wrong number. Instrument cost per run first — every example in this repo logs it.

## The `--omit=optional` trap

In the Dockerfile:

```dockerfile
RUN npm ci        # NOT npm ci --omit=optional
```

The TypeScript SDK ships its bundled Claude Code binary through **npm optional dependencies**. Omit them and you get a container that installs cleanly, builds cleanly, and fails at the first `query()` call with a missing-executable error.

This is the single most common way an agent container breaks in CI, because `--omit=optional` looks like a harmless image-size optimisation.

> Python has an analogous case: if pip installs the source distribution instead of a platform wheel (e.g. ARM64 Windows), no binary is bundled. Install Claude Code natively; the SDK finds it on `PATH`.

## Secrets

Never bake `ANTHROPIC_API_KEY` into an image. Two patterns, in increasing order of paranoia:

1. **Inject at runtime** from your secret manager — `secretKeyRef` in the manifest here.
2. **Keep it out of the container entirely.** Set `ANTHROPIC_BASE_URL` to a proxy that injects the key after the request leaves the container. The agent process then never holds a credential at all.

The same logic applies to tool credentials: route outbound tool calls through a proxy that adds the API key. The agent makes the call; the proxy adds the secret.

## Observability

The SDK inherits OpenTelemetry config from the environment, so setting these at the container level means every `query()` exports:

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1     # required only for traces
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
```

**Prompt text and tool inputs are not included in exports by default.** That's the right default. Turn it on only deliberately, and only where your log retention policy can hold customer content.

Run the `observability` compose profile to see the raw signal before you wire up a real backend.

## Egress

The agent needs outbound HTTPS to `api.anthropic.com` (or your regional provider endpoint) and to any MCP servers it uses. Nothing else.

The `NetworkPolicy` in the manifest is a floor — it can restrict ports and namespaces but **cannot do domain-level filtering**. For that you need an egress proxy with a domain allowlist. In a regulated environment that proxy is also where you get per-tenant outbound IPs and request logging.

## Self-host, or don't

If you don't need infrastructure control, custom isolation, or your own data plane, **Managed Agents** is a hosted REST API where Anthropic runs the agent and the sandbox. Your application sends events and streams back results; there's no hosting infrastructure to operate.

Everything in this directory exists for the case where you *do* need that control — usually because of data residency, a private VPC, or a compliance boundary.

For sandbox-as-a-service between those two poles, the SDK docs list providers worth evaluating: Modal Sandbox, Cloudflare Sandboxes, Daytona, E2B, Fly Machines, and Vercel Sandbox. Choose a **session pattern** first (see [example 03](../examples/03-inbox-triage-service/#choosing-a-session-pattern)), then a deployment target.

---

Full walkthrough: [docs/04-deployment-guide.md](../docs/04-deployment-guide.md) · Hardening: [docs/05-security-and-governance.md](../docs/05-security-and-governance.md)
