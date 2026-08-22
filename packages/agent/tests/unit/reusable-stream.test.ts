import { describe, expect, it } from 'vitest';
import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';

/**
 * Contract tests for the replay-buffer memory/lifecycle edges:
 * - active-consumers mode must not pin O(stream) backlog once every consumer
 *   has departed (the fusion exceededMemory retainer)
 * - full-replay mode (default) keeps replaying everything
 * - a pending next() must never hang after return()/throw()/cancel()
 *
 * A hung next() is caught by vitest's per-test timeout rather than a wall-
 * clock guard: the awaited signal is always the promise under test.
 */
function streamOf<T>(values: readonly T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller): void {
      for (const value of values) {
        controller.enqueue(value);
      }
      controller.close();
    },
  });
}

/** Source whose producer is manually controlled, for mid-stream assertions. */
function controlledStream<T>(): {
  stream: ReadableStream<T>;
  push: (value: T) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<T>;
  const stream = new ReadableStream<T>({
    start(c): void {
      controller = c;
    },
  });
  return {
    stream,
    push: (value) => controller.enqueue(value),
    close: () => controller.close(),
  };
}

describe('ReusableReadableStream', () => {
  it('retains full replay for late consumers by default', async () => {
    const stream = new ReusableReadableStream<number>(
      streamOf([
        1,
        2,
      ]),
    );
    const first = stream.createConsumer();
    expect(await Array.fromAsync(first)).toEqual([
      1,
      2,
    ]);

    const second = stream.createConsumer();
    expect(await Array.fromAsync(second)).toEqual([
      1,
      2,
    ]);
  });

  it('active-consumers: backlog follows the slowest remaining consumer', async () => {
    const source = controlledStream<number>();
    const stream = new ReusableReadableStream<number>(source.stream, {
      streamReplay: 'active-consumers',
    });
    const fast = stream.createConsumer();
    const slow = stream.createConsumer();

    source.push(1);
    source.push(2);
    expect(await fast.next()).toEqual({
      done: false,
      value: 1,
    });
    expect(await fast.next()).toEqual({
      done: false,
      value: 2,
    });
    await fast.return();

    // The slow consumer still reads from position 0 — trimming follows the
    // slowest attached consumer, never the fastest.
    expect(await slow.next()).toEqual({
      done: false,
      value: 1,
    });
    expect(await slow.next()).toEqual({
      done: false,
      value: 2,
    });
    source.close();
    expect((await slow.next()).done).toBe(true);
  });

  it('active-consumers: backlog is dropped once every consumer departs', async () => {
    const source = controlledStream<number>();
    const stream = new ReusableReadableStream<number>(source.stream, {
      streamReplay: 'active-consumers',
    });
    const only = stream.createConsumer();
    source.push(1);
    source.push(2);
    expect(await only.next()).toEqual({
      done: false,
      value: 1,
    });
    expect(await only.next()).toEqual({
      done: false,
      value: 2,
    });
    await only.return();

    // Nobody is attached anymore: the retained backlog is dropped instead of
    // staying pinned until GC.
    expect(stream.findLastBuffered(() => true)).toBeUndefined();

    // A late consumer starts at the watermark instead of replaying history.
    source.push(3);
    const late = stream.createConsumer();
    expect(await late.next()).toEqual({
      done: false,
      value: 3,
    });
    source.close();
  });

  it('active-consumers: a fully caught-up consumer leaves nothing for later joiners', async () => {
    // Trimming follows consumption, not attachment time: once every consumer
    // has read everything, the backlog is gone. Replay-after-detach is the
    // documented trade-off of active-consumers mode; default ('full') mode
    // keeps it.
    const stream = new ReusableReadableStream<number>(
      streamOf([
        1,
        2,
      ]),
      {
        streamReplay: 'active-consumers',
      },
    );
    const only = stream.createConsumer();
    expect(await Array.fromAsync(only)).toEqual([
      1,
      2,
    ]);

    const late = stream.createConsumer();
    expect(await Array.fromAsync(late)).toEqual([]);
  });

  it('return() wakes a pending next() instead of hanging', async () => {
    const source = controlledStream<number>();
    const stream = new ReusableReadableStream<number>(source.stream);
    const consumer = stream.createConsumer();
    source.push(1);
    expect(await consumer.next()).toEqual({
      done: false,
      value: 1,
    });

    const pending = consumer.next();
    await consumer.return();
    await expect(pending).resolves.toEqual({
      done: true,
      value: undefined,
    });
    source.close();
  });

  it('throw() rejects a pending next() with a normalized error', async () => {
    const source = controlledStream<number>();
    const stream = new ReusableReadableStream<number>(source.stream);
    const consumer = stream.createConsumer();
    source.push(1);
    await consumer.next();

    const pending = consumer.next();
    await expect(
      consumer.throw(new Error('boom')).catch((error: Error) => error),
    ).resolves.toBeInstanceOf(Error);
    await expect(pending).rejects.toThrow('boom');
    source.close();
  });

  it('cancel() settles waiters and leaves no buffered backlog', async () => {
    const source = controlledStream<number>();
    const stream = new ReusableReadableStream<number>(source.stream);
    const consumer = stream.createConsumer();
    source.push(1);
    source.push(2);

    /*
     * Whether the parked next() wakes with a buffered value or as done
     * depends on microtask interleaving with the pump; the contract is only
     * that it settles and that no backlog survives.
     */
    const pending = consumer.next();
    await Promise.all([
      pending.catch(() => {}),
      stream.cancel(),
    ]);

    expect(stream.findLastBuffered(() => true)).toBeUndefined();
    const fresh = stream.createConsumer();
    expect((await fresh.next()).done).toBe(true);
    // No source.close(): cancel() already terminated the source stream.
  });
});
