import { describe, expect, it } from 'vitest';
import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';

function source(values: number[]): ReadableStream<number> {
  return new ReadableStream<number>({
    start(controller) {
      for (const value of values) {
        controller.enqueue(value);
      }
      controller.close();
    },
  });
}

describe('ReusableReadableStream replay policy', () => {
  it('replays the complete history to sequential and post-completion consumers by default', async () => {
    const stream = new ReusableReadableStream(
      source([
        1,
        2,
        3,
      ]),
    );

    expect(await Array.fromAsync(stream.createConsumer())).toEqual([
      1,
      2,
      3,
    ]);
    expect(await Array.fromAsync(stream.createConsumer())).toEqual([
      1,
      2,
      3,
    ]);
  });

  it('starts new active-consumer consumers at the current watermark', async () => {
    const stream = new ReusableReadableStream(
      source([
        1,
        2,
        3,
      ]),
      {
        streamReplay: 'active-consumers',
      },
    );
    const first = stream.createConsumer();

    expect(await first.next()).toEqual({
      done: false,
      value: 1,
    });
    const second = stream.createConsumer();
    expect(await Array.fromAsync(first)).toEqual([
      2,
      3,
    ]);
    expect(await Array.fromAsync(second)).toEqual([
      2,
      3,
    ]);
  });

  it('continues to replay active-consumer events through repeated compaction', async () => {
    const values = Array.from(
      {
        length: 2500,
      },
      (_, index) => index,
    );
    const stream = new ReusableReadableStream(source(values), {
      streamReplay: 'active-consumers',
    });
    const consumer = stream.createConsumer();

    expect(await Array.fromAsync(consumer)).toEqual(values);
    const lateConsumer = stream.createConsumer();
    expect(await Array.fromAsync(lateConsumer)).toEqual([]);
  });

  it('stops at a terminal value and cancels the source once', async () => {
    let cancellationCount = 0;
    let releaseCount = 0;
    const stream = new ReusableReadableStream(
      new ReadableStream<number>({
        pull(controller) {
          controller.enqueue(1);
          controller.enqueue(2);
        },
        cancel() {
          cancellationCount++;
        },
      }),
      {
        isTerminalValue: (value) => value === 1,
      },
    );
    const consumer = stream.createConsumer();
    const originalReleaseLock = ReadableStreamDefaultReader.prototype.releaseLock;
    ReadableStreamDefaultReader.prototype.releaseLock = function releaseLock() {
      releaseCount++;
      originalReleaseLock.call(this);
    };

    try {
      expect(await Array.fromAsync(consumer)).toEqual([
        1,
      ]);
    } finally {
      ReadableStreamDefaultReader.prototype.releaseLock = originalReleaseLock;
    }

    expect(cancellationCount).toBe(1);
    expect(releaseCount).toBe(1);
  });

  it('retains the terminal value when source cancellation fails', async () => {
    const stream = new ReusableReadableStream(
      new ReadableStream<number>({
        pull(controller) {
          controller.enqueue(1);
        },
        cancel() {
          return Promise.reject(new Error('cleanup failed'));
        },
      }),
      {
        isTerminalValue: (value) => value === 1,
      },
    );

    await expect(Array.fromAsync(stream.createConsumer())).resolves.toEqual([
      1,
    ]);
  });

  it('treats a failed terminal value as the final buffered event', async () => {
    const stream = new ReusableReadableStream(
      source([
        1,
        2,
      ]),
      {
        isTerminalValue: (value) => value === 2,
      },
    );

    await expect(Array.fromAsync(stream.createConsumer())).resolves.toEqual([
      1,
      2,
    ]);
  });

  it('treats an incomplete terminal value as the final buffered event', async () => {
    const stream = new ReusableReadableStream(
      source([
        1,
        2,
      ]),
      {
        isTerminalValue: (value) => value === 2,
      },
    );

    await expect(Array.fromAsync(stream.createConsumer())).resolves.toEqual([
      1,
      2,
    ]);
  });
});
