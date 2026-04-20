import { describe, expect, it } from 'vitest';
import { ToolEventBroadcaster } from '../../src/lib/tool-event-broadcaster.js';

async function collect<T>(iter: AsyncIterableIterator<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const v of iter) {
    result.push(v);
  }
  return result;
}

describe('ToolEventBroadcaster - single consumer', () => {
  it('consumer receives all pushed events after complete', async () => {
    const broadcaster = new ToolEventBroadcaster<number>();
    broadcaster.push(1);
    broadcaster.push(2);
    broadcaster.push(3);
    broadcaster.complete();
    const consumer = broadcaster.createConsumer();
    const values = await collect(consumer);
    expect(values).toEqual([
      1,
      2,
      3,
    ]);
  });

  it('consumer receives events pushed before and after creation', async () => {
    const broadcaster = new ToolEventBroadcaster<string>();
    broadcaster.push('before');
    const consumer = broadcaster.createConsumer();
    broadcaster.push('after');
    broadcaster.complete();
    const values = await collect(consumer);
    expect(values).toEqual([
      'before',
      'after',
    ]);
  });

  it('empty broadcaster yields no values', async () => {
    const broadcaster = new ToolEventBroadcaster<number>();
    broadcaster.complete();
    const consumer = broadcaster.createConsumer();
    const values = await collect(consumer);
    expect(values).toEqual([]);
  });
});

describe('ToolEventBroadcaster - multiple consumers', () => {
  it('two consumers independently receive all events', async () => {
    const broadcaster = new ToolEventBroadcaster<number>();
    const c1 = broadcaster.createConsumer();
    const c2 = broadcaster.createConsumer();
    broadcaster.push(10);
    broadcaster.push(20);
    broadcaster.complete();
    const [v1, v2] = await Promise.all([
      collect(c1),
      collect(c2),
    ]);
    expect(v1).toEqual([
      10,
      20,
    ]);
    expect(v2).toEqual([
      10,
      20,
    ]);
  });
});

describe('ToolEventBroadcaster - error handling', () => {
  it('complete(error) propagates error to consumer', async () => {
    const broadcaster = new ToolEventBroadcaster<number>();
    broadcaster.push(1);
    const consumer = broadcaster.createConsumer();
    const first = await consumer.next();
    expect(first.value).toBe(1);
    broadcaster.complete(new Error('test error'));
    await expect(consumer.next()).rejects.toThrow('test error');
  });
});

describe('ToolEventBroadcaster - cancellation', () => {
  it('consumer.return() cancels the consumer', async () => {
    const broadcaster = new ToolEventBroadcaster<number>();
    broadcaster.push(1);
    const consumer = broadcaster.createConsumer();
    await consumer.return!();
    const result = await consumer.next();
    expect(result.done).toBe(true);
  });

  it('consumer.throw() cancels the consumer and throws', async () => {
    const broadcaster = new ToolEventBroadcaster<number>();
    const consumer = broadcaster.createConsumer();
    await expect(consumer.throw!(new Error('abort'))).rejects.toThrow('abort');
  });
});

describe('ToolEventBroadcaster - push after complete is ignored', () => {
  it('events pushed after complete are not delivered', async () => {
    const broadcaster = new ToolEventBroadcaster<number>();
    broadcaster.push(1);
    broadcaster.complete();
    broadcaster.push(2);
    const consumer = broadcaster.createConsumer();
    const values = await collect(consumer);
    expect(values).toEqual([
      1,
    ]);
  });
});

describe('ToolEventBroadcaster - async iteration protocol', () => {
  it('supports for-await-of loop', async () => {
    const broadcaster = new ToolEventBroadcaster<string>();
    broadcaster.push('a');
    broadcaster.push('b');
    broadcaster.complete();
    const values: string[] = [];
    for await (const v of broadcaster.createConsumer()) {
      values.push(v);
    }
    expect(values).toEqual([
      'a',
      'b',
    ]);
  });
});
