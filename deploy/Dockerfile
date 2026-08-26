# =============================================================================
# Dockerfile — Claude Agent SDK service (example 03)
# =============================================================================
#
# WHAT MAKES AN AGENT CONTAINER DIFFERENT
# ---------------------------------------
# The SDK spawns a `claude` CLI subprocess that owns a shell, a working
# directory, and a JSONL transcript on local disk. So this container is not a
# stateless request handler with a Node process in it -- it is a small process
# supervisor. Three things follow, and all three are handled below:
#
#   1. It needs writable scratch space (per-tenant cwd + config dir).
#   2. It needs a real init process, because it forks children. Without one,
#      you accumulate zombies until the PID table gives up.
#   3. It needs enough RAM for N concurrent subprocesses, not for one Node
#      process. See deploy/k8s/deployment.yaml for the sizing.
#
# BUILD AND RUN
#   docker build -f deploy/Dockerfile -t inbox-triage:latest .
#   docker run --rm -p 8080:8080 -e ANTHROPIC_API_KEY=sk-ant-... inbox-triage
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — build
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy manifests first so the dependency layer caches independently of source.
COPY examples/03-inbox-triage-service/package*.json ./

# This example ships without a committed package-lock.json so readers always
# resolve current SDK versions, hence `npm install`. In your own project,
# commit the lockfile and use `npm ci` for reproducible builds.
#
# IMPORTANT, either way: do NOT add `--omit=optional`. The TypeScript SDK ships
# its bundled Claude Code binary through npm OPTIONAL dependencies. Omit them
# and you get a container that installs cleanly, builds cleanly, and fails at
# the first query() call with a missing-executable error. This is the single
# most common way an agent container breaks in CI.
RUN npm install --no-audit --no-fund

COPY examples/03-inbox-triage-service/tsconfig.json ./
COPY examples/03-inbox-triage-service/src ./src
RUN npm run build


# -----------------------------------------------------------------------------
# Stage 2 — runtime
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# tini: a real PID 1. The agent forks subprocesses; without an init that reaps
# them, zombie processes accumulate for the life of the container.
# ca-certificates: outbound TLS to api.anthropic.com.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY examples/03-inbox-triage-service/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

# Scratch space for per-session working directories and config dirs. These are
# the paths agent.ts points CLAUDE_CONFIG_DIR and cwd at. Owned by the
# non-root user, because the container does not run as root.
RUN mkdir -p /tmp/claude-work /tmp/claude-config \
    && chown -R node:node /tmp/claude-work /tmp/claude-config /app

# Never run an agent as root. It executes model-directed work; give it the
# smallest identity that still functions.
USER node

ENV NODE_ENV=production \
    PORT=8080 \
    MAX_CONCURRENT=4

# --- Observability -----------------------------------------------------------
# The SDK inherits OpenTelemetry configuration from the environment, so setting
# these at the container level means every query() exports spans, metrics, and
# logs. Uncomment and point at your collector.
#
# ENV CLAUDE_CODE_ENABLE_TELEMETRY=1
# ENV CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
# ENV OTEL_TRACES_EXPORTER=otlp
# ENV OTEL_METRICS_EXPORTER=otlp
# ENV OTEL_LOGS_EXPORTER=otlp
# ENV OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
# ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
#
# Prompt text and tool inputs are NOT included in exports by default. That is
# the right default. Turn it on only deliberately, and only where your log
# retention policy can hold customer content.

EXPOSE 8080

# Never bake ANTHROPIC_API_KEY into the image. Inject at runtime from your
# secret manager, or set ANTHROPIC_BASE_URL to a proxy that injects the key
# outside the container so the agent process never holds it at all.

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
