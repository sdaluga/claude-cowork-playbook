/**
 * Tests for the SessionStore adapter.
 * ===================================
 *
 * One test per sharp edge in the contract, plus a real filesystem round-trip.
 *
 * These matter more than they look. A SessionStore bug does not throw — it
 * quietly returns the wrong history, and the agent then reasons correctly
 * about the wrong conversation. That failure mode never shows up as an
 * exception in a log; it shows up as a customer asking why the assistant
 * forgot what they said yesterday.
 *
 * No API key. No model call. The filesystem tests use a temp directory.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { SessionKey, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

import {
  BlobSessionStore,
  MemoryBackend,
  VolumeBackend,
} from "../src/session-store.js";

const KEY: SessionKey = { projectKey: "tenant-acme", sessionId: "thread-8817" };

function entry(uuid: string, extra: Record<string, unknown> = {}): SessionStoreEntry {
  return { type: "user", uuid, timestamp: "2026-08-27T10:00:00.000Z", ...extra };
}

function store() {
  const backend = new MemoryBackend();
  return { backend, store: new BlobSessionStore(backend) };
}

describe("round trip", () => {
  it("returns what was appended, in order", async () => {
    const { store: s } = store();
    await s.append(KEY, [entry("a"), entry("b")]);
    await s.append(KEY, [entry("c")]);

    const loaded = await s.load(KEY);
    assert.deepEqual(loaded?.map((e) => e.uuid), ["a", "b", "c"]);
  });

  it("preserves arbitrary payloads verbatim", async () => {
    const { store: s } = store();
    const payload = {
      nested: { deep: [1, "two", null, { three: true }] },
      unicode: "Priya — SSO ✓",
    };
    await s.append(KEY, [entry("a", payload)]);

    const loaded = await s.load(KEY);
    assert.deepEqual(loaded?.[0].nested, payload.nested);
    assert.equal(loaded?.[0].unicode, payload.unicode);
  });
});

describe("sharp edge 1 — uuid is an idempotency key", () => {
  it("a retried batch does not duplicate entries", async () => {
    const { store: s } = store();
    const batch = [entry("a"), entry("b")];

    // The SDK retries a rejected batch up to three times.
    await s.append(KEY, batch);
    await s.append(KEY, batch);
    await s.append(KEY, batch);

    assert.deepEqual((await s.load(KEY))?.map((e) => e.uuid), ["a", "b"]);
  });

  it("a partially-overlapping replay keeps only what is new", async () => {
    const { store: s } = store();
    await s.append(KEY, [entry("a"), entry("b")]);
    await s.append(KEY, [entry("b"), entry("c")]);

    assert.deepEqual((await s.load(KEY))?.map((e) => e.uuid), ["a", "b", "c"]);
  });

  it("dedups against entries a PREVIOUS process wrote", async () => {
    // A restart mid-session must not re-append what is already in storage.
    // This is why the uuid set is primed from storage on first touch.
    const backend = new MemoryBackend();
    await new BlobSessionStore(backend).append(KEY, [entry("a"), entry("b")]);

    const restarted = new BlobSessionStore(backend);
    await restarted.append(KEY, [entry("b"), entry("c")]);

    assert.deepEqual((await restarted.load(KEY))?.map((e) => e.uuid), ["a", "b", "c"]);
  });
});

describe("sharp edge 2 — entries without a uuid are never deduped", () => {
  it("keeps repeated title and tag entries", async () => {
    // Titles, tags and mode markers carry no uuid. They are updates, not
    // duplicates: dedup them and the session's title freezes at its first
    // value forever.
    const { store: s } = store();
    await s.append(KEY, [{ type: "title", title: "SSO rollout" }]);
    await s.append(KEY, [{ type: "title", title: "SSO rollout — resolved" }]);

    const titles = (await s.load(KEY))?.filter((e) => e.type === "title");
    assert.equal(titles?.length, 2);
    assert.equal(titles?.[1].title, "SSO rollout — resolved");
  });
});

describe("sharp edge 3 — projectKey is the tenant boundary", () => {
  it("keeps two tenants' sessions apart", async () => {
    const { store: s } = store();
    const acme = { projectKey: "tenant-acme", sessionId: "t-1" };
    const other = { projectKey: "tenant-other", sessionId: "t-1" };

    await s.append(acme, [entry("acme-only")]);
    await s.append(other, [entry("other-only")]);

    assert.deepEqual((await s.load(acme))?.map((e) => e.uuid), ["acme-only"]);
    assert.deepEqual((await s.load(other))?.map((e) => e.uuid), ["other-only"]);
    assert.deepEqual(await s.listSessions("tenant-acme"), [
      { sessionId: "t-1", mtime: (await s.listSessions("tenant-acme"))[0].mtime },
    ]);
  });

  it("a tenant id containing a separator cannot escape its prefix", async () => {
    // projectKey and sessionId are caller-controlled strings that become
    // storage keys. Percent-encoding is what stops "a/../b" from reading
    // another tenant's data.
    const { store: s } = store();
    const evil = { projectKey: "tenant-acme/../tenant-other", sessionId: "t-1" };
    const victim = { projectKey: "tenant-other", sessionId: "t-1" };

    await s.append(victim, [entry("victim-data")]);
    await s.append(evil, [entry("attacker-data")]);

    assert.deepEqual((await s.load(victim))?.map((e) => e.uuid), ["victim-data"]);
    assert.equal((await s.listSessions("tenant-other")).length, 1);
  });

  it("round-trips a session id that needs encoding", async () => {
    const { store: s } = store();
    const key = { projectKey: "tenant-acme", sessionId: "thread/88 17" };
    await s.append(key, [entry("a")]);

    const listed = await s.listSessions("tenant-acme");
    assert.deepEqual(listed.map((x) => x.sessionId), ["thread/88 17"]);
  });
});

describe("sharp edge 4 — null and empty are different answers", () => {
  it("returns null for a session that was never written", async () => {
    const { store: s } = store();
    assert.equal(await s.load({ projectKey: "p", sessionId: "never" }), null);
  });

  it("returns null, not [], so the SDK starts a fresh session", async () => {
    // Returning [] would tell the SDK "this session exists and is empty",
    // which resumes into a blank thread instead of starting a new one.
    const { store: s } = store();
    const loaded = await s.load({ projectKey: "p", sessionId: "never" });
    assert.notDeepEqual(loaded, []);
  });

  it("an appended session is never null", async () => {
    const { store: s } = store();
    await s.append(KEY, [entry("a")]);
    assert.notEqual(await s.load(KEY), null);
  });
});

describe("sharp edge 5 — mtime comes from the storage clock", () => {
  it("summary mtime shares a clock with listSessions", async () => {
    const { store: s } = store();

    // Entry timestamps are deliberately in the past and identical. If the
    // summary took its mtime from them, this session would look stale
    // forever and lose every recency comparison.
    await s.append(KEY, [entry("a", { timestamp: "2020-01-01T00:00:00.000Z" })]);

    const [listed] = await s.listSessions("tenant-acme");
    const [summary] = await s.listSessionSummaries("tenant-acme");

    assert.ok(summary, "no summary was written");
    assert.ok(
      summary.mtime > Date.parse("2020-01-01T00:00:00.000Z"),
      "summary mtime was derived from entry timestamps",
    );
    // Same clock source, so the two are within the same magnitude.
    assert.ok(Math.abs(summary.mtime - listed.mtime) < 1000);
  });

  it("mtime advances on a later append", async () => {
    const { store: s } = store();
    await s.append(KEY, [entry("a")]);
    const first = (await s.listSessionSummaries("tenant-acme"))[0].mtime;

    await s.append(KEY, [entry("b")]);
    const second = (await s.listSessionSummaries("tenant-acme"))[0].mtime;

    assert.ok(second > first, "summary mtime did not advance");
  });

  it("mtime is an integer, as the contract requires", async () => {
    const { store: s } = store();
    await s.append(KEY, [entry("a")]);
    for (const { mtime } of await s.listSessions("tenant-acme")) {
      assert.equal(Number.isInteger(mtime), true, `non-integer mtime: ${mtime}`);
    }
  });
});

describe("sharp edge 6 — concurrent appends must not lose a summary update", () => {
  it("serialises the read-fold-write on the sidecar", async () => {
    // Fire twenty appends without awaiting between them. Unserialised, several
    // would read the same `prev` and the later writes would clobber the
    // earlier folds -- a lost update, silently.
    const { store: s } = store();

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => s.append(KEY, [entry(`e${i}`)])),
    );

    const loaded = await s.load(KEY);
    assert.equal(loaded?.length, 20, "entries were lost under concurrency");
    assert.equal(new Set(loaded?.map((e) => e.uuid)).size, 20, "entries duplicated");

    const summaries = await s.listSessionSummaries("tenant-acme");
    assert.equal(summaries.length, 1);
  });

  it("a later fold sees the earlier one, so set-once fields stay frozen", async () => {
    // The test above cannot fail without a lock, because MemoryBackend never
    // yields between its read and its write -- there is no window to race in.
    // A real backend does I/O there. This one yields, which reopens the
    // window: without serialisation both appends read `prev: undefined`, and
    // the second write clobbers the first.
    //
    // `firstPrompt` is a set-once field, so it is exactly the observable that
    // a lost update corrupts.
    class YieldingBackend extends MemoryBackend {
      override async read(key: string) {
        await new Promise((r) => setImmediate(r));
        return super.read(key);
      }
      override async write(key: string, body: string) {
        await new Promise((r) => setImmediate(r));
        return super.write(key, body);
      }
    }

    const s = new BlobSessionStore(new YieldingBackend());
    const msg = (uuid: string, text: string) =>
      entry(uuid, { message: { role: "user", content: text } });

    await Promise.all([
      s.append(KEY, [msg("a", "FIRST")]),
      s.append(KEY, [msg("b", "SECOND")]),
    ]);

    const [summary] = await s.listSessionSummaries("tenant-acme");
    assert.equal(
      summary.data.firstPrompt,
      "FIRST",
      "a concurrent append clobbered the earlier fold — lost update",
    );
  });

  it("one failing append does not wedge the lock chain", async () => {
    const backend = new MemoryBackend();
    const s = new BlobSessionStore(backend);

    let fail = true;
    const realAppend = backend.append.bind(backend);
    backend.append = async (k, lines) => {
      if (fail) {
        fail = false;
        throw new Error("storage unavailable");
      }
      return realAppend(k, lines);
    };

    await assert.rejects(() => s.append(KEY, [entry("a")]), /storage unavailable/);

    // The next caller must not inherit the failure.
    await s.append(KEY, [entry("b")]);
    assert.deepEqual((await s.load(KEY))?.map((e) => e.uuid), ["b"]);
  });
});

describe("subagent transcripts", () => {
  it("stores subpaths separately from the main transcript", async () => {
    const { store: s } = store();
    await s.append(KEY, [entry("main")]);
    await s.append({ ...KEY, subpath: "agent-1" }, [entry("sub")]);

    assert.deepEqual((await s.load(KEY))?.map((e) => e.uuid), ["main"]);
    assert.deepEqual(await s.listSubkeys(KEY), ["agent-1"]);
  });

  it("does not list a subagent transcript as its own session", async () => {
    const { store: s } = store();
    await s.append(KEY, [entry("main")]);
    await s.append({ ...KEY, subpath: "agent-1" }, [entry("sub")]);

    assert.deepEqual(
      (await s.listSessions("tenant-acme")).map((x) => x.sessionId),
      ["thread-8817"],
    );
  });

  it("returns an empty list when there are no subagents", async () => {
    const { store: s } = store();
    await s.append(KEY, [entry("main")]);
    assert.deepEqual(await s.listSubkeys(KEY), []);
  });
});

describe("delete", () => {
  it("removes the transcript, the sidecar and every subagent file", async () => {
    const { backend, store: s } = store();
    await s.append(KEY, [entry("main")]);
    await s.append({ ...KEY, subpath: "agent-1" }, [entry("sub")]);

    await s.delete(KEY);

    assert.equal(await s.load(KEY), null);
    assert.deepEqual(await s.listSessions("tenant-acme"), []);
    assert.deepEqual(await s.listSessionSummaries("tenant-acme"), []);
    assert.deepEqual(await backend.list("tenant-acme/"), []);
  });

  it("lets the session be recreated cleanly afterwards", async () => {
    // The in-process uuid cache must be dropped on delete, or re-appending
    // the same entries after a delete would be silently discarded.
    const { store: s } = store();
    await s.append(KEY, [entry("a")]);
    await s.delete(KEY);
    await s.append(KEY, [entry("a")]);

    assert.deepEqual((await s.load(KEY))?.map((e) => e.uuid), ["a"]);
  });
});

describe("corrupt data fails loudly, not quietly", () => {
  it("throws rather than resuming a truncated conversation", async () => {
    const { backend, store: s } = store();
    await s.append(KEY, [entry("a")]);
    await backend.append("tenant-acme/thread-8817.jsonl", ["{not json"]);

    await assert.rejects(() => s.load(KEY), /Corrupt transcript entry/);
  });

  it("can be configured to report and continue instead", async () => {
    const backend = new MemoryBackend();
    const seen: string[] = [];
    const s = new BlobSessionStore(backend, {
      onCorruptEntry: (_k, line) => seen.push(line),
    });

    await s.append(KEY, [entry("a")]);
    await backend.append("tenant-acme/thread-8817.jsonl", ["{not json"]);

    assert.equal((await s.load(KEY))?.length, 1);
    assert.deepEqual(seen, ["{not json"]);
  });

  it("survives a corrupt summary sidecar", async () => {
    // Summaries are derived data. Losing one must not fail the append that
    // carries actual conversation.
    const { backend, store: s } = store();
    await s.append(KEY, [entry("a")]);
    await backend.write("tenant-acme/thread-8817.summary.json", "{not json");

    await s.append(KEY, [entry("b")]);
    assert.equal((await s.listSessionSummaries("tenant-acme")).length, 1);
  });
});

describe("VolumeBackend — the same contract, on a real filesystem", () => {
  const dirs: string[] = [];

  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function onDisk() {
    const dir = await mkdtemp(join(tmpdir(), "session-store-"));
    dirs.push(dir);
    return new BlobSessionStore(new VolumeBackend(dir));
  }

  it("round-trips through files", async () => {
    const s = await onDisk();
    await s.append(KEY, [entry("a"), entry("b")]);
    await s.append(KEY, [entry("c")]);

    assert.deepEqual((await s.load(KEY))?.map((e) => e.uuid), ["a", "b", "c"]);
  });

  it("survives a process restart — the point of the whole exercise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-store-"));
    dirs.push(dir);

    // "Process 1" writes.
    await new BlobSessionStore(new VolumeBackend(dir)).append(KEY, [
      entry("before-restart"),
    ]);

    // "Process 2" — a fresh store with no in-memory state — resumes.
    const revived = new BlobSessionStore(new VolumeBackend(dir));
    assert.deepEqual(
      (await revived.load(KEY))?.map((e) => e.uuid),
      ["before-restart"],
    );
  });

  it("returns null for an unwritten session rather than throwing on ENOENT", async () => {
    const s = await onDisk();
    assert.equal(await s.load({ projectKey: "p", sessionId: "never" }), null);
  });

  it("returns an empty listing for an unknown tenant", async () => {
    const s = await onDisk();
    assert.deepEqual(await s.listSessions("no-such-tenant"), []);
  });

  it("lists sessions and subagents without confusing the two", async () => {
    const s = await onDisk();
    await s.append(KEY, [entry("main")]);
    await s.append({ ...KEY, subpath: "agent-1" }, [entry("sub")]);

    assert.deepEqual(
      (await s.listSessions("tenant-acme")).map((x) => x.sessionId),
      ["thread-8817"],
    );
    assert.deepEqual(await s.listSubkeys(KEY), ["agent-1"]);
  });

  it("reports integer mtimes from file modification time", async () => {
    const s = await onDisk();
    await s.append(KEY, [entry("a")]);

    const [listed] = await s.listSessions("tenant-acme");
    assert.equal(Number.isInteger(listed.mtime), true);
    assert.ok(Math.abs(listed.mtime - Date.now()) < 60_000, "mtime is not wall clock");
  });

  it("does not leave temp files behind in listings", async () => {
    const s = await onDisk();
    await s.append(KEY, [entry("a")]);
    const listed = await s.listSessions("tenant-acme");
    assert.equal(listed.every((x) => !x.sessionId.endsWith(".tmp")), true);
  });
});
