import { describe, expect, it } from 'vitest';
import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';

function streamFrom<T>(values: readonly T[]): ReadableStream<T> {
  let index = 0;
  return new ReadableStream<T>({
    pull(controller) {
      const value = values[index++];
      if (value === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
  });
}

async function collect<T>(consumer: AsyncIterableIterator<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of consumer) {
    values.push(value);
  }
  return values;
}

describe('ReusableReadableStream', () => {
  it('gives concurrent and post-completion consumers the same events', async () => {
    const stream = new ReusableReadableStream(
      streamFrom([
        1,
        2,
        3,
      ]),
    );

    const first = collect(stream.createConsumer());
    const second = collect(stream.createConsumer());

    expect(await first).toEqual([
      1,
      2,
      3,
    ]);
    expect(await second).toEqual([
      1,
      2,
      3,
    ]);
    expect(stream.isComplete).toBe(true);
    expect(await collect(stream.createConsumer())).toEqual([
      1,
      2,
      3,
    ]);
  });

  it('continues pumping after an early consumer returns so a late consumer can replay', async () => {
    const stream = new ReusableReadableStream(
      streamFrom([
        'a',
        'b',
        'c',
      ]),
    );
    const consumer = stream.createConsumer();

    expect(await consumer.next()).toEqual({
      done: false,
      value: 'a',
    });
    await consumer.return?.();

    while (!stream.isComplete) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(await collect(stream.createConsumer())).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('can be cancelled after completion without releasing the reader twice', async () => {
    const stream = new ReusableReadableStream(
      streamFrom([
        'only',
      ]),
    );

    expect(await collect(stream.createConsumer())).toEqual([
      'only',
    ]);
    await expect(stream.cancel()).resolves.toBeUndefined();

    // Cancellation releases transport resources, not the compatibility replay.
    expect(await collect(stream.createConsumer())).toEqual([
      'only',
    ]);
  });

  it('cancels an active transport once and wakes waiting consumers', async () => {
    let cancelCount = 0;
    const source = new ReadableStream<string>({
      pull() {
        // Stay pending until cancellation.
      },
      cancel() {
        cancelCount += 1;
      },
    });
    const stream = new ReusableReadableStream(source);
    const consumer = stream.createConsumer();
    const pending = consumer.next();

    await stream.cancel();

    await expect(pending).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(cancelCount).toBe(1);
  });
});
