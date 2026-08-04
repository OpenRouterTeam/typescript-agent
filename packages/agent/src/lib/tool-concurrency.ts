/**
 * Minimal FIFO semaphore used to bound tool-execution concurrency.
 *
 * Three gates exist per run:
 * - the round gate (`toolConcurrency.round`) — bounds simultaneous tool
 *   executions within a round;
 * - per-tool gates (`maxConcurrency` on a tool) — bound simultaneous
 *   executions of one tool across the run;
 * - the background pool (`toolConcurrency.background`) — bounds detached
 *   background-tool work that escaped the round barrier.
 *
 * Waiters are released strictly FIFO so a burst of calls cannot starve an
 * earlier one. Zero dependencies; ~60 lines.
 */

/** Release function returned by {@link Semaphore.acquire}. Idempotent. */
export type SemaphoreRelease = () => void;

/**
 * A counting semaphore with FIFO waiters.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<(release: SemaphoreRelease) => void> = [];

  /**
   * @param limit - Maximum concurrent holders. Must be a positive integer.
   */
  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
    }
    this.available = limit;
  }

  /**
   * Acquire one slot. Resolves immediately when a slot is free, otherwise
   * queues FIFO. The returned release function is idempotent — releasing
   * twice does not free two slots.
   */
  acquire(): Promise<SemaphoreRelease> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<SemaphoreRelease>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private makeRelease(): SemaphoreRelease {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the slot directly to the next waiter (no available++/-- churn).
        next(this.makeRelease());
      } else {
        this.available++;
      }
    };
  }
}

/**
 * Acquire multiple gates in the given (fixed) order and return a single
 * release that frees them in reverse order. Callers MUST pass gates in a
 * globally consistent order (round gate before per-tool gate) — fixed
 * ordering is what makes multi-gate acquisition deadlock-free.
 */
export async function acquireAll(
  gates: ReadonlyArray<Semaphore | undefined>,
): Promise<SemaphoreRelease> {
  const releases: SemaphoreRelease[] = [];
  for (const gate of gates) {
    if (gate) {
      releases.push(await gate.acquire());
    }
  }
  return () => {
    for (let i = releases.length - 1; i >= 0; i--) {
      releases[i]?.();
    }
  };
}
