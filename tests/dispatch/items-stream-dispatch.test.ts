import { describe, expect, it } from 'vitest';

import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import { buildItemsStream } from '../../src/lib/stream-transformers.js';

function makeStream(events: any[]): ReusableReadableStream<any> {
  const source = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    },
  });
  return new ReusableReadableStream(source);
}

async function collectAll<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iter) {
    result.push(item);
  }
  return result;
}

describe('buildItemsStream routes events via stream type guards', () => {
  it('routes output_item.added to handler because isOutputItemAddedEvent matches (not other guards)', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        item: {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      },
      {
        type: 'response.completed',
        response: {},
      },
    ];
    const stream = makeStream(events);
    const items = await collectAll(buildItemsStream(stream));
    expect(items.length).toBeGreaterThan(0);
    expect((items[0] as any).type).toBe('message');
  });

  it('skips unknown event types that do not match any guard', async () => {
    const events = [
      {
        type: 'response.some_unknown_event',
        data: 'ignored',
      },
      {
        type: 'response.output_item.added',
        item: {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      },
      {
        type: 'response.completed',
        response: {},
      },
    ];
    const stream = makeStream(events);
    const items = await collectAll(buildItemsStream(stream));
    // Only the message item should be yielded, unknown events are silently skipped
    expect(items.every((i: any) => i.type === 'message')).toBe(true);
  });
});
