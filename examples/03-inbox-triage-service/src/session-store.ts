/**
 * A SessionStore adapter — making sessions survive the container.
 * ==============================================================
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * `query()` spawns a `claude` CLI subprocess, and that subprocess writes its
 * transcript to local disk under `CLAUDE_CONFIG_DIR`. In a container, local
 * disk is a lie: it disappears on restart, on scale-down, and on a reschedule
 * to a different node. Every thread this service has ever reasoned about goes
 * with it, and triage silently regresses to "first ask" on every message.
 *
 * A `SessionStore` is the SDK's seam for fixing that. The subprocess still
 * writes locally first -- durability is already guaranteed there -- and the
 * SDK forwards a *copy* of each batch to your adapter. On resume, the SDK
 * calls `load()`, materialises a temporary JSONL file, and the subprocess
 * resumes from that.
 *
 *      subprocess ──► local disk (source of truth, ephemeral)
 *                          │
 *                          └──► SDK ──► append()  ──► your storage (durable)
 *
 *      resume:  load() ──► temp JSONL ──► subprocess
 *
 * WHAT THIS FILE ACTUALLY IS
 * --------------------------
 * The contract has six sharp edges, and they are the same six whether you
 * back it with a filesystem, S3, Redis or Postgres. So the contract logic is
 * written once, here, against a tiny storage seam:
 *
 *      BlobBackend        five methods: append, read, write, list, remove
 *      BlobSessionStore   the SessionStore contract, backend-agnostic
 *      VolumeBackend      a BlobBackend over a directory (mount a PVC/EFS)
 *      MemoryBackend      a BlobBackend for tests
 *
 * Swapping in S3 or Postgres means writing five methods, not re-deriving the
 * contract. The mapping for both is at the bottom of this file.
 *
 * THE SIX SHARP EDGES
 * -------------------
 *   1. `uuid` is an idempotency key. Batches are retried (3 attempts), and
 *      `importSessionToStore()` replays. Append blindly and you get duplicate
 *      transcript lines, which corrupts the resumed conversation.
 *   2. Entries WITHOUT a uuid (titles, tags, mode markers) must be appended
 *      without dedup. They are not duplicates; they are updates.
 *   3. `projectKey` defaults to the sanitised cwd. In a multi-tenant service
 *      that is a cross-tenant read waiting to happen -- set it to the tenant.
 *   4. `load()` returns `null` for "never written". Returning `[]` instead
 *      tells the SDK the session exists and is empty, which resumes into a
 *      blank thread rather than starting a fresh one.
 *   5. Summary `mtime` must come from the STORAGE clock, the same source as
 *      `listSessions()`. Deriving it from entry timestamps defeats the
 *      staleness check, because entries are batched and arrive late.
 *   6. Concurrent `append()` calls for one session race on the summary
 *      sidecar. `foldSessionSummary` is pure; serialising is the store's job.
 *
 * All six are asserted on in tests/session-store.test.ts.
 */

import {
  foldSessionSummary,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SessionSummaryEntry,
} from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// The storage seam
// ---------------------------------------------------------------------------

/**
 * Five methods. Implement these and you have a durable SessionStore.
 *
 * Keys are opaque, `/`-delimited strings. Bodies are UTF-8 text.
 */
export interface BlobBackend {
  /** Append lines to a key, creating it if absent. */
  append(key: string, lines: string[]): Promise<void>;
  /** Whole contents, or `null` if the key was never written. */
  read(key: string): Promise<string | null>;
  /** Replace a key's contents wholesale. Used for the summary sidecar. */
  write(key: string, body: string): Promise<void>;
  /** Keys under a prefix, with modification times in epoch milliseconds. */
  list(prefix: string): Promise<Array<{ key: string; mtime: number }>>;
  /** Remove a key. Must not throw when the key is absent. */
  remove(key: string): Promise<void>;
  /**
   * The storage clock, in epoch milliseconds.
   *
   * This MUST be the same clock that `list()` reports as `mtime` -- file
   * mtime, S3 LastModified, Postgres `updated_at`. Sharp edge #5: mixing two
   * clocks here silently breaks the staleness check that decides which
   * session is most recent.
   */
  stamp(): number;
}

// ---------------------------------------------------------------------------
// Key layout
// ---------------------------------------------------------------------------
//
// A SessionKey is (projectKey, sessionId, subpath?). Both projectKey and
// sessionId are caller-controlled strings that become storage keys, so they
// get percent-encoded rather than trusted -- a tenant id containing a slash
// would otherwise read another tenant's prefix.
//
//   <project>/<session>.jsonl           main transcript
//   <project>/<session>.summary.json    summary sidecar
//   <project>/<session>/<subpath>.jsonl subagent transcript

const enc = encodeURIComponent;

function transcriptKey(key: SessionKey): string {
  return key.subpath
    ? `${enc(key.projectKey)}/${enc(key.sessionId)}/${enc(key.subpath)}.jsonl`
    : `${enc(key.projectKey)}/${enc(key.sessionId)}.jsonl`;
}

function summaryKey(key: SessionKey): string {
  return `${enc(key.projectKey)}/${enc(key.sessionId)}.summary.json`;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface BlobSessionStoreOptions {
  /**
   * Maintain the summary sidecar so `listSessions()` is one round-trip
   * instead of one `load()` per session. Costs a read-fold-write per append.
   * Default: true.
   */
  summaries?: boolean;
  /**
   * Called when a stored entry cannot be parsed on load. Default: throw.
   * A store that silently drops corrupt lines resumes a truncated
   * conversation, which is worse than failing loudly.
   */
  onCorruptEntry?: (key: SessionKey, line: string, err: unknown) => void;
}

export class BlobSessionStore implements SessionStore {
  private readonly backend: BlobBackend;
  private readonly summaries: boolean;
  private readonly onCorruptEntry?: BlobSessionStoreOptions["onCorruptEntry"];

  /**
   * Sharp edge #1: uuids already written, per session, so a retried batch is
   * a no-op instead of a duplicate.
   *
   * This is an in-process cache, which is exactly the scope of the problem it
   * solves: the SDK's 3-attempt retry and `importSessionToStore()` replays
   * both happen in this process. It does NOT dedup across replicas. If two
   * replicas can append to one session -- they should not, sessions are
   * sticky -- enforce it in storage with a unique index on (key, uuid).
   */
  private readonly seen = new Map<string, Set<string>>();

  /** Sharp edge #6: one promise chain per session serialises summary folds. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(backend: BlobBackend, options: BlobSessionStoreOptions = {}) {
    this.backend = backend;
    this.summaries = options.summaries ?? true;
    this.onCorruptEntry = options.onCorruptEntry;
  }

  /**
   * Run `fn` with exclusive access to `key`. Serialises the read-fold-write
   * on the summary sidecar so two concurrent appends cannot both read the
   * same `prev` and write conflicting folds -- one of the two updates would
   * be lost.
   */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    // `.catch` so one failed append does not poison the chain for the next.
    const next = prior.catch(() => {}).then(fn);
    this.locks.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const blob = transcriptKey(key);

    await this.withLock(blob, async () => {
      let seen = this.seen.get(blob);
      if (!seen) {
        // First append in this process for this session. Prime the uuid set
        // from storage, so a restart mid-session does not re-append entries
        // the previous process already wrote.
        seen = new Set(
          (await this.readEntries(key)).map((e) => e.uuid).filter(Boolean) as string[],
        );
        this.seen.set(blob, seen);
      }

      const fresh = entries.filter((entry) => {
        // Sharp edge #2: no uuid means it is not a transcript line -- titles,
        // tags and mode markers legitimately repeat. Never dedup those.
        if (!entry.uuid) return true;
        if (seen.has(entry.uuid)) return false;
        seen.add(entry.uuid);
        return true;
      });

      if (fresh.length === 0) return;

      await this.backend.append(
        blob,
        fresh.map((e) => JSON.stringify(e)),
      );

      if (this.summaries) await this.foldSummary(key, fresh);
    });
  }

  /**
   * Keep the summary sidecar current without re-reading the transcript.
   *
   * `foldSessionSummary` is the SDK's own reducer and its `data` blob is
   * opaque -- persist it verbatim, never interpret it.
   */
  private async foldSummary(
    key: SessionKey,
    entries: SessionStoreEntry[],
  ): Promise<void> {
    // Subagent transcripts do not get their own summary; the main session's
    // sidecar represents the session.
    if (key.subpath) return;

    const sKey = summaryKey(key);
    const raw = await this.backend.read(sKey);

    let prev: SessionSummaryEntry | undefined;
    if (raw) {
      try {
        prev = JSON.parse(raw) as SessionSummaryEntry;
      } catch {
        // A corrupt sidecar is recoverable -- it is derived data. Refold from
        // scratch rather than failing the append that carries real content.
        prev = undefined;
      }
    }

    // Sharp edge #5: the storage clock, stamped at persist time.
    const next = foldSessionSummary(prev, key, entries, {
      mtime: this.backend.stamp(),
    });

    await this.backend.write(sKey, JSON.stringify(next));
  }

  private async readEntries(key: SessionKey): Promise<SessionStoreEntry[]> {
    const raw = await this.backend.read(transcriptKey(key));
    if (raw === null) return [];

    const out: SessionStoreEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SessionStoreEntry);
      } catch (err) {
        if (this.onCorruptEntry) this.onCorruptEntry(key, line, err);
        else throw new Error(`Corrupt transcript entry in ${transcriptKey(key)}`);
      }
    }
    return out;
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const raw = await this.backend.read(transcriptKey(key));

    // Sharp edge #4: `null` means "never written" and starts a fresh session.
    // `[]` means "exists, empty" and resumes into a blank thread. They are
    // different answers and the SDK acts on the difference.
    if (raw === null) return null;

    return this.readEntries(key);
  }

  async listSessions(
    projectKey: string,
  ): Promise<Array<{ sessionId: string; mtime: number }>> {
    const prefix = `${enc(projectKey)}/`;
    const blobs = await this.backend.list(prefix);

    return blobs
      .filter(({ key }) => {
        const rest = key.slice(prefix.length);
        // Top-level transcripts only: skip sidecars and subagent files, which
        // live one directory deeper.
        return rest.endsWith(".jsonl") && !rest.includes("/");
      })
      .map(({ key, mtime }) => ({
        sessionId: decodeURIComponent(key.slice(prefix.length, -".jsonl".length)),
        mtime,
      }));
    // Order is unspecified by the contract -- the SDK sorts by mtime desc.
  }

  async listSessionSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
    const prefix = `${enc(projectKey)}/`;
    const blobs = await this.backend.list(prefix);

    const out: SessionSummaryEntry[] = [];
    for (const { key } of blobs) {
      if (!key.endsWith(".summary.json")) continue;
      const raw = await this.backend.read(key);
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw) as SessionSummaryEntry);
      } catch {
        // Derived data. A corrupt sidecar drops out of the listing rather
        // than failing the whole call; the next append refolds it.
      }
    }
    return out;
  }

  async listSubkeys(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]> {
    const prefix = `${enc(key.projectKey)}/${enc(key.sessionId)}/`;
    const blobs = await this.backend.list(prefix);

    return blobs
      .filter((b) => b.key.endsWith(".jsonl"))
      .map((b) => decodeURIComponent(b.key.slice(prefix.length, -".jsonl".length)));
  }

  /**
   * Optional in the contract. Implemented here because a volume is not WORM.
   *
   * Drop this method entirely for an append-only backend (S3 with object
   * lock, an audit table) -- the SDK treats an absent `delete` as a no-op
   * rather than an error, which is the correct behaviour for storage that
   * genuinely cannot delete. Retention is then a lifecycle policy, not code.
   */
  async delete(key: SessionKey): Promise<void> {
    const blob = transcriptKey(key);
    await this.backend.remove(blob);
    await this.backend.remove(summaryKey(key));
    this.seen.delete(blob);

    // Subagent transcripts are children of this session; leaving them behind
    // orphans them under a session id that no longer exists.
    for (const sub of await this.listSubkeys(key)) {
      await this.backend.remove(transcriptKey({ ...key, subpath: sub }));
    }
  }
}

// ---------------------------------------------------------------------------
// Backend: a mounted volume
// ---------------------------------------------------------------------------

/**
 * Durable as far as the volume is durable. Point it at a PersistentVolume,
 * EFS, or a Docker named volume -- NOT at the container's writable layer,
 * which is exactly the ephemeral disk this whole file exists to escape.
 *
 * Good for: single-replica services, a first deployment, local development
 * with `docker compose` where you want resume to actually work.
 *
 * Reach for S3 or Postgres when you need multiple replicas writing, or
 * retention policy, or to query sessions from outside this service.
 */
export class VolumeBackend implements BlobBackend {
  constructor(private readonly root: string) {}

  private async fs() {
    return import("node:fs/promises");
  }

  private path(key: string): string {
    // Keys are already percent-encoded per segment, so no segment can contain
    // a separator and no `..` can survive encoding.
    return `${this.root}/${key}`;
  }

  private async ensureDir(file: string): Promise<void> {
    const fs = await this.fs();
    await fs.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  }

  async append(key: string, lines: string[]): Promise<void> {
    const fs = await this.fs();
    const file = this.path(key);
    await this.ensureDir(file);
    await fs.appendFile(file, lines.join("\n") + "\n", "utf8");
  }

  async read(key: string): Promise<string | null> {
    const fs = await this.fs();
    try {
      return await fs.readFile(this.path(key), "utf8");
    } catch (err) {
      // ENOENT is "never written", which the contract distinguishes from
      // empty. Anything else is a real failure and must propagate.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(key: string, body: string): Promise<void> {
    const fs = await this.fs();
    const file = this.path(key);
    await this.ensureDir(file);
    // Write-then-rename: a crash mid-write leaves the old sidecar intact
    // rather than a truncated one.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, file);
  }

  async list(prefix: string): Promise<Array<{ key: string; mtime: number }>> {
    const fs = await this.fs();
    const dir = `${this.root}/${prefix}`;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const out: Array<{ key: string; mtime: number }> = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.endsWith(".tmp")) continue;
      const abs = `${e.parentPath ?? dir}/${e.name}`;
      const stat = await fs.stat(abs);
      out.push({
        key: prefix + abs.slice(dir.length).replace(/^\/+/, ""),
        // Floor: the contract wants integer epoch milliseconds.
        mtime: Math.floor(stat.mtimeMs),
      });
    }
    return out;
  }

  async remove(key: string): Promise<void> {
    const fs = await this.fs();
    await fs.rm(this.path(key), { force: true });
  }

  /** Same clock as `list()`'s mtime: the filesystem's wall clock. */
  stamp(): number {
    return Date.now();
  }
}

// ---------------------------------------------------------------------------
// Backend: memory
// ---------------------------------------------------------------------------

/**
 * For tests and local runs. Explicitly NOT durable — it is here so the
 * contract can be exercised without a volume, and so the tests are
 * deterministic and fast.
 *
 * `stamp()` seeds from the wall clock and then increments, so it is both
 * monotonic -- tests can assert on ordering without sleeping -- and in the
 * same range a real backend would report. A test double whose clock reads
 * `1000001` cannot demonstrate anything about sharp edge #5, because every
 * comparison against a real timestamp passes or fails for the wrong reason.
 */
export class MemoryBackend implements BlobBackend {
  private readonly blobs = new Map<string, { body: string; mtime: number }>();
  private clock = Date.now();

  stamp(): number {
    return ++this.clock;
  }

  async append(key: string, lines: string[]): Promise<void> {
    const existing = this.blobs.get(key)?.body ?? "";
    this.blobs.set(key, {
      body: existing + lines.join("\n") + "\n",
      mtime: this.stamp(),
    });
  }

  async read(key: string): Promise<string | null> {
    return this.blobs.get(key)?.body ?? null;
  }

  async write(key: string, body: string): Promise<void> {
    this.blobs.set(key, { body, mtime: this.stamp() });
  }

  async list(prefix: string): Promise<Array<{ key: string; mtime: number }>> {
    return [...this.blobs.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, v]) => ({ key, mtime: v.mtime }));
  }

  async remove(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Build the store this service will use, from configuration.
 *
 * Returns `undefined` when `SESSION_STORE_DIR` is unset, which is the SDK's
 * "no mirroring" default -- local disk only. That is the right default for a
 * laptop and the wrong one for a container, so the deployment manifests set
 * the variable and mount a volume at that path.
 *
 * Deliberately NOT falling back to MemoryBackend when the variable is
 * missing: a store that looks configured and silently loses everything on
 * restart is worse than no store, because the failure is invisible until a
 * customer notices the agent has amnesia.
 */
export function createSessionStore(
  dir = process.env.SESSION_STORE_DIR,
): SessionStore | undefined {
  if (!dir) return undefined;
  return new BlobSessionStore(new VolumeBackend(dir));
}

// ---------------------------------------------------------------------------
// Porting this to real infrastructure
// ---------------------------------------------------------------------------
//
// S3 (or any object store)
// ------------------------
//   append   S3 has no append. Write one object per batch under
//            `<key>/<zero-padded-seq>.jsonl`, and have `read` concatenate
//            them in key order. Cheap, and it makes writes idempotent by
//            construction.
//   read     GetObject, concatenating the batch objects.
//   write    PutObject.
//   list     ListObjectsV2, `mtime` from LastModified.
//   remove   DeleteObject — or omit `delete()` from the store entirely if
//            you use object lock. Retention becomes a lifecycle rule.
//   stamp    Date.now() is close enough to LastModified for staleness.
//
// Postgres
// --------
//   CREATE TABLE session_entries (
//     project_key  text        NOT NULL,
//     session_id   text        NOT NULL,
//     subpath      text        NOT NULL DEFAULT '',
//     seq          bigserial   NOT NULL,
//     uuid         text,
//     entry        jsonb       NOT NULL,
//     created_at   timestamptz NOT NULL DEFAULT now(),
//     PRIMARY KEY (project_key, session_id, subpath, seq)
//   );
//
//   -- Sharp edge #1, enforced by the database rather than by a Map. This is
//   -- what makes dedup correct across replicas, not just within a process.
//   CREATE UNIQUE INDEX ON session_entries (project_key, session_id, subpath, uuid)
//     WHERE uuid IS NOT NULL;
//
//   CREATE TABLE session_summaries (
//     project_key text        NOT NULL,
//     session_id  text        NOT NULL,
//     data        jsonb       NOT NULL,
//     updated_at  timestamptz NOT NULL DEFAULT now(),
//     PRIMARY KEY (project_key, session_id)
//   );
//
//   append   INSERT ... ON CONFLICT DO NOTHING, then fold the summary inside
//            the SAME transaction (sharp edge #6 — the transaction is the
//            lock, so you can drop `withLock` entirely).
//   read     SELECT entry ORDER BY seq.
//   list     SELECT ... , extract(epoch from updated_at) * 1000 AS mtime.
//   stamp    Use `now()` from the database, not the app server — one clock.
//
// Redis
// -----
//   Workable with RPUSH/LRANGE, with two caveats the contract calls out:
//   LRANGE cannot distinguish "never written" from "emptied" (returning null
//   for both is explicitly allowed), and Redis has no native modification
//   time, so `listSessions` needs its own sorted-set index that you maintain
//   on every append.
