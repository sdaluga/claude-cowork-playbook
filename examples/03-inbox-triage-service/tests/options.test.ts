/**
 * Tests for the agent options — the controls, not the knobs.
 * =========================================================
 *
 * These tests exist for one reason: to make a security control fail loudly
 * when someone deletes it.
 *
 * Every assertion below corresponds to a line in src/options.ts that looks
 * removable to a reader who does not know why it is there. Delete
 * `settingSources: []` during a cleanup and nothing breaks — no error, no
 * warning, no failing build — until the day a host CLAUDE.md, or one tenant's
 * context, shows up inside another tenant's prompt.
 *
 * A test is the only durable way to write "this line matters" in a way that CI
 * will enforce. Each `it()` here names the incident it is preventing.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  buildTriageOptions,
  TRIAGE_FALLBACK_MODEL,
  TRIAGE_MODEL,
} from "../src/options.js";

const SYSTEM = "you triage messages";
const opts = (sessionId = "thread-8817") => buildTriageOptions(sessionId, SYSTEM);

describe("blast radius — the agent can only think", () => {
  it("grants no tools at all", () => {
    // Triage is pure judgment over text it was handed. It needs no filesystem,
    // no shell and no network. The most secure tool is the one not granted.
    assert.deepEqual(opts().allowedTools, []);
  });

  it("denies the dangerous tools explicitly as well", () => {
    // Belt and braces. An empty allow list is the control; the deny list is
    // the second line, and it survives someone "temporarily" adding a tool.
    const { disallowedTools } = opts();
    for (const tool of ["Bash", "Write", "Edit", "WebFetch", "WebSearch"]) {
      assert.ok(disallowedTools.includes(tool), `${tool} is not denied`);
    }
  });

  it("caps the interaction at a single turn", () => {
    // With no tools there is nothing to iterate on, so one turn is a hard
    // ceiling on both latency and cost per message.
    assert.equal(opts().maxTurns, 1);
  });
});

describe("multi-tenant isolation — four controls, all required", () => {
  it("1. loads no host settings or CLAUDE.md", () => {
    // Without this, the agent inherits whatever the host container's
    // CLAUDE.md and settings.json happen to say. In a multi-tenant service
    // that is someone else's context leaking into this prompt.
    assert.deepEqual(opts().settingSources, []);
  });

  it("2. disables auto memory, which settingSources does NOT cover", () => {
    // The one people miss. Auto memory loads into the system prompt
    // regardless of settingSources, so it needs its own switch.
    assert.equal(opts().env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  });

  it("3. gives each tenant its own config directory", () => {
    // Tenants sharing ~/.claude.json share credentials and history.
    const a = opts("tenant-a").env.CLAUDE_CONFIG_DIR;
    const b = opts("tenant-b").env.CLAUDE_CONFIG_DIR;
    assert.notEqual(a, b, "two tenants resolved to the same config dir");
    assert.ok(a.includes("tenant-a"));
  });

  it("4. gives each tenant its own working directory", () => {
    const a = opts("tenant-a").cwd;
    const b = opts("tenant-b").cwd;
    assert.notEqual(a, b, "two tenants resolved to the same cwd");
    assert.ok(a.includes("tenant-a"));
  });

  it("passes the ambient environment through rather than replacing it", () => {
    // The TypeScript SDK REPLACES the subprocess environment when `env` is
    // set (Python merges it). Drop the spread and the subprocess loses PATH
    // and ANTHROPIC_API_KEY — which fails at runtime, in production, not here.
    const { env } = opts();
    assert.ok("PATH" in env, "PATH was not forwarded to the subprocess");
  });
});

describe("path safety — a session id becomes a directory name", () => {
  // Session ids arrive over HTTP. They are attacker-controlled strings that
  // this code turns into filesystem paths, which is exactly the shape of a
  // traversal bug.

  it("neutralises traversal in the config dir and cwd", () => {
    const o = opts("../../../../etc/passwd");
    assert.equal(o.cwd.includes(".."), false, `traversal survived: ${o.cwd}`);
    assert.equal(o.env.CLAUDE_CONFIG_DIR.includes(".."), false);
  });

  it("keeps both paths under their intended roots", () => {
    const o = opts("../../root");
    assert.ok(o.cwd.startsWith("/tmp/claude-work/"), o.cwd);
    assert.ok(o.env.CLAUDE_CONFIG_DIR.startsWith("/tmp/claude-config/"));
  });

  it("neutralises shell metacharacters", () => {
    const o = opts("a; rm -rf /");
    assert.equal(/[;$`\s]/.test(o.cwd), false, `metacharacters survived: ${o.cwd}`);
  });

  it("still resumes against the ORIGINAL id, not the sanitised one", () => {
    // Sanitising is for paths only. Rewriting the resume id would silently
    // point two different threads at the same transcript.
    assert.equal(opts("thread/8817").resume, "thread/8817");
  });
});

describe("model selection", () => {
  it("uses a fast model for a high-volume path", () => {
    assert.equal(opts().model, TRIAGE_MODEL);
  });

  it("configures a fallback so a capacity blip degrades instead of failing", () => {
    assert.equal(opts().fallbackModel, TRIAGE_FALLBACK_MODEL);
    assert.notEqual(TRIAGE_MODEL, TRIAGE_FALLBACK_MODEL);
  });

  it("passes the system prompt through unmodified", () => {
    assert.equal(opts().systemPrompt, SYSTEM);
  });
});
