import { describe, expect, it } from 'vitest';
import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';

function makeStream<T>(values: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const v of values) {
        controller.enqueue(v);
      }
      controller.close();
    },
  });
}

function makeDelayedStream<T>(values: T[], delayMs = 5): ReadableStream<T> {
  return new ReadableStream<T>({
    async start(controller) {
      for (const v of values) {
        await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(v);
      }
      controller.close();
    },
  });
}

async function collect<T>(iter: AsyncIterableIterator<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const v of iter) {
    result.push(v);
  }
  return result;
}

describe('reusable stream - single consumer', () => {
  it('single consumer reads all values from source', async () => {
    const rrs = new ReusableReadableStream(
      makeStream([
        1,
        2,
        3,
      ]),
    );
    const values = await collect(rrs.createConsumer());
    expect(values).toEqual([
      1,
      2,
      3,
    ]);
  });

  it('empty source stream yields no values', async () => {
    const rrs = new ReusableReadableStream(makeStream([]));
    const values = await collect(rrs.createConsumer());
    expect(values).toEqual([]);
  });
});

describe('reusable stream - multiple consumers', () => {
  it('two consumers independently read the same values', async () => {
    const rrs = new ReusableReadableStream(
      makeStream([
        10,
        20,
        30,
      ]),
    );
    const c1 = rrs.createConsumer();
    const c2 = rrs.createConsumer();
    const [v1, v2] = await Promise.all([
      collect(c1),
      collect(c2),
    ]);
    expect(v1).toEqual([
      10,
      20,
      30,
    ]);
    expect(v2).toEqual([
      10,
      20,
      30,
    ]);
  });

  it('late-joining consumer gets all buffered values plus new ones', async () => {
    const rrs = new ReusableReadableStream(
      makeDelayedStream(
        [
          1,
          2,
          3,
          4,
        ],
        5,
      ),
    );
    const c1 = rrs.createConsumer();
    // Let first consumer read a bit
    const first = await c1.next();
    expect(first.done).toBe(false);
    // Join late
    const c2 = rrs.createConsumer();
    const [remaining1, values2] = await Promise.all([
      collect(c1),
      collect(c2),
    ]);
    // c1 already read first value, so remaining has rest
    expect(remaining1.length).toBeGreaterThanOrEqual(2);
    // c2 should have all values
    expect(values2).toEqual([
      1,
      2,
      3,
      4,
    ]);
  });
});

describe('reusable stream - error propagation', () => {
  it('propagates source error to consumer', async () => {
    let controllerRef: ReadableStreamDefaultController<number>;
    const errorStream = new ReadableStream<number>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(1);
      },
      pull() {
        controllerRef!.error(new Error('source error'));
      },
    });
    const rrs = new ReusableReadableStream(errorStream);
    const consumer = rrs.createConsumer();
    const first = await consumer.next();
    expect(first.value).toBe(1);
    await expect(consumer.next()).rejects.toThrow('source error');
  });
});

describe('reusable stream - cancellation', () => {
  it('cancel() stops all consumers', async () => {
    const rrs = new ReusableReadableStream(
      makeDelayedStream(
        [
          1,
          2,
          3,
          4,
          5,
        ],
        50,
      ),
    );
    const c1 = rrs.createConsumer();
    const first = await c1.next();
    expect(first.done).toBe(false);
    await rrs.cancel();
    const next = await c1.next();
    expect(next.done).toBe(true);
  });

  it('consumer.return() cancels that consumer only', async () => {
    const rrs = new ReusableReadableStream(
      makeStream([
        1,
        2,
        3,
      ]),
    );
    const c1 = rrs.createConsumer();
    const c2 = rrs.createConsumer();
    await c1.return!();
    const result = await c1.next();
    expect(result.done).toBe(true);
    // c2 should still work
    const values = await collect(c2);
    expect(values).toEqual([
      1,
      2,
      3,
    ]);
  });
});

describe('reusable stream - async iteration protocol', () => {
  it('supports for-await-of loop', async () => {
    const rrs = new ReusableReadableStream(
      makeStream([
        'a',
        'b',
        'c',
      ]),
    );
    const values: string[] = [];
    for await (const v of rrs.createConsumer()) {
      values.push(v);
    }
    expect(values).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});
