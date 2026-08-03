/**
 * A push-based event broadcaster that supports multiple concurrent consumers.
 * Similar to ReusableReadableStream but for push-based events from tool execution.
 *
 * Each consumer gets their own position in the buffer and receives all events
 * from their join point onward. This enables real-time streaming of generator
 * tool preliminary results to multiple consumers simultaneously.
 *
 * @template T - The event type being broadcast
 */
export class ToolEventBroadcaster<T> {
  private buffer: T[] = [];
  private consumers = new Map<number, ConsumerState>();
  private nextConsumerId = 0;
  private isComplete = false;
  private completionError: Error | null = null;
  private historyStart = 0;
  private hasConsumerEverJoined = false;

  constructor(private readonly retention: 'full' | 'active-consumers' = 'full') {}

  /**
   * Push a new event to all consumers.
   * Full-retention events are buffered so late consumers can catch up.
   * Active-consumer retention evicts an event after every attached consumer
   * has advanced past it.
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
    if (this.isComplete && this.consumers.size === 0) {
      this.buffer = [];
    }
  }

  /**
   * Create a new consumer that can independently iterate over events.
   * In full mode, consumers receive all retained history. In active-consumer
   * mode, the first consumer receives history accumulated while the source was
   * starting; later consumers join at the current live position.
   */
  createConsumer(): AsyncIterableIterator<T> {
    const consumerId = this.nextConsumerId++;
    const state: ConsumerState = {
      position:
        this.retention === 'full' || !this.hasConsumerEverJoined
          ? this.historyStart
          : this.historyStart + this.buffer.length,
      waitingPromise: null,
      cancelled: false,
    };
    this.hasConsumerEverJoined = true;
    this.consumers.set(consumerId, state);
    this.compactActiveBuffer();

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return {
      async next(): Promise<IteratorResult<T>> {
        const consumer = self.consumers.get(consumerId);
        if (!consumer) {
          return {
            done: true,
            value: undefined,
          };
        }

        if (consumer.cancelled) {
          return {
            done: true,
            value: undefined,
          };
        }

        // Return buffered event if available
        const bufferEnd = self.historyStart + self.buffer.length;
        if (consumer.position < bufferEnd) {
          const value = self.buffer[consumer.position - self.historyStart]!;
          consumer.position++;
          self.compactActiveBuffer();
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
            consumer.position < self.historyStart + self.buffer.length
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
          self.consumers.delete(consumerId);
          self.compactActiveBuffer();
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
          self.consumers.delete(consumerId);
          self.compactActiveBuffer();
          self.cleanup();
        }
        throw e;
      },

      [Symbol.asyncIterator]() {
        return this;
      },
    };
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

  private compactActiveBuffer(): void {
    if (this.retention !== 'active-consumers' || this.buffer.length === 0) {
      return;
    }
    const bufferEnd = this.historyStart + this.buffer.length;
    let consumedThrough = bufferEnd;
    for (const consumer of this.consumers.values()) {
      consumedThrough = Math.min(consumedThrough, consumer.position);
    }
    const removeCount = Math.min(this.buffer.length, consumedThrough - this.historyStart);
    if (removeCount > 0) {
      this.buffer.splice(0, removeCount);
      this.historyStart += removeCount;
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
