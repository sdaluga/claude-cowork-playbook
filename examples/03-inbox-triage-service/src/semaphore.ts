/**
 * A concurrency limiter — the difference between backpressure and an OOM kill.
 * ===========================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Every in-flight triage holds a `claude` CLI subprocess. That makes
 * concurrency a MEMORY bound, not an event-loop bound. Without a limiter, a
 * burst of 200 messages spawns 200 subprocesses and the container dies.
 * With one, the 5th caller waits.
 *
 * Backpressure is a feature. A queued request completes late; an OOM-killed
 * container loses every request it was holding, including the tokens already
 * spent on them.
 *
 * WHY IT'S ITS OWN FILE
 * ---------------------
 * Off-by-one here is a production incident, and it is trivially testable in
 * isolation. See tests/semaphore.test.ts.
 */

export interface SlotLimiter {
  /** Run `fn` once a slot is free. Resolves with `fn`'s result. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** How many are executing right now. */
  active(): number;
  /** How many are waiting for a slot. */
  queued(): number;
  /** True when no slots remain — readiness probes use this to shed traffic. */
  saturated(): boolean;
}

export function createSlotLimiter(max: number): SlotLimiter {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, got ${max}`);
  }

  let active = 0;
  const waiting: Array<() => void> = [];

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      // FIFO. A caller that has waited longest goes first, so a sustained
      // burst can't starve the request that arrived before it.
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      // `finally`, not the happy path: a throwing task must still release its
      // slot, or the pool leaks a slot per failure and eventually deadlocks.
      active--;
      waiting.shift()?.();
    }
  }

  return {
    run,
    active: () => active,
    queued: () => waiting.length,
    saturated: () => active >= max,
  };
}
