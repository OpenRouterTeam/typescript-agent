import { describe, expect, it } from 'vitest';

import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import { buildItemsStream, consumeStreamForCompletion } from '../../src/lib/stream-transformers.js';

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

describe('ReusableReadableStream -> concurrent transformer consumption', () => {
  it('buildItemsStream and consumeStreamForCompletion both consume same stream correctly', async () => {
    const response = {
      id: 'r1',
      status: 'completed',
      output: [],
    };
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
        type: 'response.output_text.delta',
        delta: 'Hello',
        itemId: 'msg_1',
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'Hello',
              annotations: [],
            },
          ],
        },
      },
      {
        type: 'response.completed',
        response,
      },
    ];

    const stream = makeStream(events);

    const [items, completedResponse] = await Promise.all([
      collectAll(buildItemsStream(stream)),
      consumeStreamForCompletion(stream),
    ]);

    expect(items.length).toBeGreaterThan(0);
    expect(completedResponse).toEqual(response);
  });
});
