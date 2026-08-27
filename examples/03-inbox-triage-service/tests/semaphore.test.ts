/**
 * Tests for the concurrency limiter.
 * ==================================
 *
 * Why bother unit testing forty lines of semaphore? Because every one of the
 * failure modes below is silent in development and fatal in production:
 *
 *   - a limiter that admits max+1 is an OOM kill under burst
 *   - a limiter that leaks a slot on a thrown task deadlocks after N failures
 *   - a limiter that is not FIFO starves the oldest request under sustained load
 *
 * None of that shows up on a laptop running one request at a time.
 *
 * A note on technique: these tests use manually-resolved promises rather than
 * timers. A test that sleeps is a test that is flaky on a loaded CI runner.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createSlotLimiter } from "../src/semaphore.js";

/** A task you can hold open and release on command. No timers involved. */
function deferred() {
  let resolve!: (v?: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res as (v?: unknown) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the microtask queue drain so pending continuations actually run. */
const settle = () => new Promise((r) => setImmediate(r));

describe("createSlotLimiter — construction", () => {
  it("rejects a limit that would misbehave at runtime", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => createSlotLimiter(bad), RangeError, `accepted ${bad}`);
    }
  });

  it("accepts a limit of one", () => {
    assert.equal(createSlotLimiter(1).active(), 0);
  });
});

describe("createSlotLimiter — the bound holds", () => {
  it("never runs more than `max` tasks at once", { timeout: 5_000 }, async () => {
    const limiter = createSlotLimiter(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];

    let peak = 0;
    let running = 0;

    const all = gates.map((g) =>
      limiter.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await g.promise;
        running--;
      }),
    );

    await settle();
    assert.equal(limiter.active(), 2, "exactly two admitted");
    assert.equal(limiter.queued(), 2, "the rest wait");
    assert.equal(limiter.saturated(), true);

    for (const g of gates) {
      g.resolve();
      await settle();
    }
    await Promise.all(all);

    assert.equal(peak, 2, "the ceiling was never breached");
    assert.equal(limiter.active(), 0);
    assert.equal(limiter.queued(), 0);
    assert.equal(limiter.saturated(), false);
  });

  it("admits a waiter the moment a slot frees", { timeout: 5_000 }, async () => {
    const limiter = createSlotLimiter(1);
    const first = deferred();
    const second = deferred();

    let secondStarted = false;

    const a = limiter.run(() => first.promise);
    const b = limiter.run(async () => {
      secondStarted = true;
      await second.promise;
    });

    await settle();
    assert.equal(secondStarted, false, "the second task must wait its turn");

    first.resolve();
    await a;
    await settle();
    assert.equal(secondStarted, true, "and start as soon as the slot frees");

    second.resolve();
    await b;
  });

  it("serves waiters first-in, first-out", { timeout: 5_000 }, async () => {
    const limiter = createSlotLimiter(1);
    const gate = deferred();
    const order: number[] = [];

    const held = limiter.run(() => gate.promise);
    const queued = [1, 2, 3].map((n) =>
      limiter.run(async () => {
        order.push(n);
      }),
    );

    await settle();
    gate.resolve();
    await held;
    await Promise.all(queued);

    assert.deepEqual(order, [1, 2, 3], "a late burst must not jump the queue");
  });
});

describe("createSlotLimiter — failures release their slot", () => {
  it("propagates the rejection to the caller", { timeout: 5_000 }, async () => {
    const limiter = createSlotLimiter(1);
    await assert.rejects(
      () => limiter.run(async () => { throw new Error("subprocess died"); }),
      /subprocess died/,
    );
  });

  it("does not leak a slot when a task throws", { timeout: 5_000 }, async () => {
    const limiter = createSlotLimiter(1);

    // Ten consecutive failures. A limiter that released only on success would
    // be permanently wedged by the first one.
    for (let i = 0; i < 10; i++) {
      await limiter.run(async () => { throw new Error("boom"); }).catch(() => {});
    }

    assert.equal(limiter.active(), 0, "slot count drifted after failures");
    assert.equal(limiter.saturated(), false);

    // And the pool is still usable.
    assert.equal(await limiter.run(async () => "ok"), "ok");
  });

  it("a failing task still hands its slot to the next waiter", { timeout: 5_000 }, async () => {
    const limiter = createSlotLimiter(1);
    const gate = deferred();

    const failing = limiter.run(() => gate.promise).catch(() => "failed");
    const next = limiter.run(async () => "ran anyway");

    await settle();
    gate.reject(new Error("upstream 500"));

    assert.equal(await failing, "failed");
    assert.equal(await next, "ran anyway");
  });
});

describe("createSlotLimiter — the readiness signal", () => {
  it("reports saturation so /readyz can shed traffic", { timeout: 5_000 }, async () => {
    const limiter = createSlotLimiter(2);
    const gates = [deferred(), deferred()];

    assert.equal(limiter.saturated(), false, "idle pool accepts traffic");

    const all = gates.map((g) => limiter.run(() => g.promise));
    await settle();
    assert.equal(limiter.saturated(), true, "full pool sheds traffic");

    gates[0].resolve();
    await all[0];
    await settle();
    assert.equal(limiter.saturated(), false, "recovers when a slot frees");

    gates[1].resolve();
    await Promise.all(all);
  });

  it("returns the task's value untouched", { timeout: 5_000 }, async () => {
    const limiter = createSlotLimiter(3);
    const results = await Promise.all([
      limiter.run(async () => 1),
      limiter.run(async () => "two"),
      limiter.run(async () => ({ three: true })),
    ]);
    assert.deepEqual(results, [1, "two", { three: true }]);
  });
});
