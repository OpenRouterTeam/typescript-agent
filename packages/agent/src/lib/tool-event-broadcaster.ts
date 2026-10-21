import type { StreamReplay } from './reusable-stream.js';

/**
 * A push-based event broadcaster that supports multiple concurrent consumers.
 * Similar to ReusableReadableStream but for push-based events from tool execution.
 *
 * Each consumer gets their own position in the buffer. Full replay is the
 * default, and active-consumer replay can compact consumed events.
 *
 * @template T - The event type being broadcast
 */
export class ToolEventBroadcaster<T> {
  private buffer: (T | undefined)[] = [];
  private bufferHead = 0;
  // Consumer positions are absolute. Buffer index = bufferHead + position - trimOffset.
  private trimOffset = 0;
  private consumers = new Map<number, ConsumerState>();
  private nextConsumerId = 0;
  private isComplete = false;
  private completionError: Error | null = null;

  constructor(private readonly streamReplay: StreamReplay = 'full') {}

  /**
   * Push a new event to all consumers.
   * Events are buffered so late-joining consumers can catch up.
   */
  push(event: T): void {
    if (this.isComplete) {
      return;
    }
    this.buffer.push(event);
    this.notifyWaitingConsumers();
  }

  /**
   * Mark the broadcaster as complete - no more events will be pushed.
   * Optionally pass an error to signal failure to all consumers.
   * Cleans up buffer and consumers after completion.
   */
  complete(error?: Error): void {
    this.isComplete = true;
    this.completionError = error ?? null;
    this.notifyWaitingConsumers();
    // Schedule cleanup after consumers have processed completion
    queueMicrotask(() => this.cleanup());
  }

  /**
   * Clean up resources after all consumers have finished.
   * Called automatically after complete(), but can be called manually.
   */
  private cleanup(): void {
    // Only cleanup if complete and all consumers are done
    if (this.streamReplay === 'active-consumers' && this.isComplete && this.consumers.size === 0) {
      this.buffer = [];
      this.bufferHead = 0;
    }
  }

  /**
   * Create a new consumer that can independently iterate over events.
   * Full-replay consumers start at position 0. Active-consumer replay starts
   * at the current trim watermark.
   */
  createConsumer(): AsyncIterableIterator<T> {
    const consumerId = this.nextConsumerId++;
    const state: ConsumerState = {
      position: this.trimOffset,
      waitingPromise: null,
      cancelled: false,
    };
    this.consumers.set(consumerId, state);

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return {
      async next(): Promise<IteratorResult<T>> {
        const consumer = self.consumers.get(consumerId);
        if (!consumer || consumer.cancelled) {
          return {
            done: true,
            value: undefined,
          };
        }

        const bufferIndex = self.bufferHead + consumer.position - self.trimOffset;
        if (bufferIndex < self.buffer.length) {
          const value = self.buffer[bufferIndex];
          if (value === undefined) {
            throw new Error(
              'ToolEventBroadcaster buffer invariant violated: consumed slot was cleared',
            );
          }
          consumer.position++;
          self.trimConsumed();
          return {
            done: false,
            value,
          };
        }

        // If complete and caught up, we're done
        if (self.isComplete) {
          self.consumers.delete(consumerId);
          self.cleanup();
          if (self.completionError) {
            throw self.completionError;
          }
          return {
            done: true,
            value: undefined,
          };
        }

        // Set up waiting promise FIRST to avoid race condition
        const waitPromise = new Promise<void>((resolve, reject) => {
          consumer.waitingPromise = {
            resolve,
            reject,
          };

          // Immediately check if we should resolve after setting up promise
          if (
            self.isComplete ||
            self.completionError ||
            self.bufferHead + consumer.position - self.trimOffset < self.buffer.length
          ) {
            resolve();
          }
        });

        await waitPromise;
        consumer.waitingPromise = null;

        // Recursively try again after waking up
        return this.next();
      },

      async return(): Promise<IteratorResult<T>> {
        const consumer = self.consumers.get(consumerId);
        if (consumer) {
          consumer.cancelled = true;
          // Wake a pending next() so it does not hang forever on a consumer
          // that has just been removed; the re-run next() observes the
          // removal and reports done.
          if (consumer.waitingPromise) {
            consumer.waitingPromise.resolve();
            consumer.waitingPromise = null;
          }
          self.consumers.delete(consumerId);
          self.trimConsumed();
          self.cleanup();
        }
        return {
          done: true,
          value: undefined,
        };
      },

      async throw(e?: unknown): Promise<IteratorResult<T>> {
        const consumer = self.consumers.get(consumerId);
        if (consumer) {
          consumer.cancelled = true;
          // Reject a pending next() with the same error so it does not hang
          // on a consumer that has just been removed.
          if (consumer.waitingPromise) {
            consumer.waitingPromise.reject(e instanceof Error ? e : new Error(String(e)));
            consumer.waitingPromise = null;
          }
          self.consumers.delete(consumerId);
          self.trimConsumed();
          self.cleanup();
        }
        throw e;
      },

      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  private trimConsumed(): void {
    if (this.streamReplay === 'full') {
      return;
    }
    if (this.consumers.size === 0) {
      this.dropUnreadBacklog();
      return;
    }

    let min = Number.POSITIVE_INFINITY;
    for (const consumer of this.consumers.values()) {
      if (consumer.position < min) {
        min = consumer.position;
      }
    }

    const nextHead = this.bufferHead + min - this.trimOffset;
    if (nextHead <= this.bufferHead) {
      return;
    }

    this.trimOffset = min;
    if (nextHead === this.buffer.length) {
      this.buffer = [];
      this.bufferHead = 0;
      return;
    }

    this.buffer.fill(undefined, this.bufferHead, nextHead);
    if (nextHead >= BUFFER_COMPACTION_MIN_HEAD && nextHead * 2 >= this.buffer.length) {
      this.buffer = this.buffer.slice(nextHead);
      this.bufferHead = 0;
      return;
    }
    this.bufferHead = nextHead;
  }

  /**
   * Drop the retained backlog once no consumer can ever read it again.
   * Before the first consumer joins, the buffer IS the catch-up history late
   * joiners replay — retain it. Once at least one consumer has existed and
   * none remain, any future consumer starts at the watermark anyway, so the
   * retained events would stay pinned until GC for nothing.
   */
  private dropUnreadBacklog(): void {
    if (this.nextConsumerId === 0) {
      return;
    }
    const dropped = this.buffer.length - this.bufferHead;
    if (dropped === 0) {
      return;
    }
    this.trimOffset += dropped;
    this.buffer = [];
    this.bufferHead = 0;
  }

  /**
   * Notify all waiting consumers that new data is available or stream completed
   */
  private notifyWaitingConsumers(): void {
    for (const consumer of this.consumers.values()) {
      if (consumer.waitingPromise) {
        if (this.completionError) {
          consumer.waitingPromise.reject(this.completionError);
        } else {
          consumer.waitingPromise.resolve();
        }
        consumer.waitingPromise = null;
      }
    }
  }
}

interface ConsumerState {
  position: number;
  waitingPromise: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null;
  cancelled: boolean;
}

const BUFFER_COMPACTION_MIN_HEAD = 1024;
