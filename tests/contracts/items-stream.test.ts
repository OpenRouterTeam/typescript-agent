import { describe, expect, it } from 'vitest';

import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import { buildItemsStream } from '../../src/lib/stream-transformers.js';

function makeStream(
  events: Record<string, unknown>[],
): ReusableReadableStream<Record<string, unknown>> {
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

describe('buildItemsStream - yields distinct item types per event', () => {
  it('message items: accumulated text from text deltas', async () => {
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
        type: 'response.output_text.delta',
        delta: ' world',
        itemId: 'msg_1',
      },
      {
        type: 'response.completed',
        response: {},
      },
    ];
    const stream = makeStream(events);
    const items = await collectAll(buildItemsStream(stream));
    const lastMsg = items.filter((i) => i.type === 'message').pop()!;
    expect(
      (
        lastMsg as {
          content: Array<{
            text: string;
          }>;
        }
      ).content[0].text,
    ).toBe('Hello world');
  });

  it('function_call items: accumulated arguments from function_call deltas', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'fc_1',
          callId: 'fc_1',
          name: 'search',
          arguments: '',
          status: 'in_progress',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        delta: '{"q":',
        itemId: 'fc_1',
      },
      {
        type: 'response.function_call_arguments.delta',
        delta: '"test"}',
        itemId: 'fc_1',
      },
      {
        type: 'response.completed',
        response: {},
      },
    ];
    const stream = makeStream(events);
    const items = await collectAll(buildItemsStream(stream));
    const lastFn = items.filter((i) => i.type === 'function_call').pop()!;
    expect(
      (
        lastFn as {
          arguments: string;
        }
      ).arguments,
    ).toBe('{"q":"test"}');
  });

  it('reasoning items: accumulated content from reasoning deltas', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        item: {
          type: 'reasoning',
          id: 'r_1',
          status: 'in_progress',
          summary: [],
        },
      },
      {
        type: 'response.reasoning_text.delta',
        delta: 'thinking',
        itemId: 'r_1',
      },
      {
        type: 'response.reasoning_text.delta',
        delta: ' more',
        itemId: 'r_1',
      },
      {
        type: 'response.completed',
        response: {},
      },
    ];
    const stream = makeStream(events);
    const items = await collectAll(buildItemsStream(stream));
    const lastReasoning = items.filter((i) => i.type === 'reasoning').pop()!;
    expect(
      (
        lastReasoning as {
          summary: Array<{
            text: string;
          }>;
        }
      ).summary[0].text,
    ).toBe('thinking more');
  });

  it('server tool items (web_search_call, file_search_call, image_generation_call): passthrough', async () => {
    const webSearch = {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
    };
    const fileSearch = {
      type: 'file_search_call',
      id: 'fs_1',
      status: 'completed',
    };
    const imageGen = {
      type: 'image_generation_call',
      id: 'ig_1',
      status: 'completed',
    };
    const events = [
      {
        type: 'response.output_item.added',
        item: webSearch,
      },
      {
        type: 'response.output_item.added',
        item: fileSearch,
      },
      {
        type: 'response.output_item.added',
        item: imageGen,
      },
      {
        type: 'response.completed',
        response: {},
      },
    ];
    const stream = makeStream(events);
    const items = await collectAll(buildItemsStream(stream));
    const types = items.map((i) => i.type);
    expect(types).toContain('web_search_call');
    expect(types).toContain('file_search_call');
    expect(types).toContain('image_generation_call');
  });

  it('final complete items from output_item.done events', async () => {
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
        delta: 'Hi',
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
              text: 'Hi',
              annotations: [],
            },
          ],
        },
      },
      {
        type: 'response.completed',
        response: {},
      },
    ];
    const stream = makeStream(events);
    const items = await collectAll(buildItemsStream(stream));
    const doneItem = items[items.length - 1]!;
    expect(
      (
        doneItem as {
          status: string;
        }
      ).status,
    ).toBe('completed');
  });

  it('termination events (completed/failed/incomplete) -> stream stops', async () => {
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
        delta: 'Hi',
        itemId: 'msg_1',
      },
      {
        type: 'response.completed',
        response: {},
      },
      // These should never be reached
      {
        type: 'response.output_text.delta',
        delta: 'SHOULD NOT APPEAR',
        itemId: 'msg_1',
      },
    ];
    const stream = makeStream(events);
    const items = await collectAll(buildItemsStream(stream));
    const allText = items
      .filter((i) => i.type === 'message')
      .map(
        (i) =>
          (
            i as {
              content?: Array<{
                text?: string;
              }>;
            }
          ).content?.[0]?.text ?? '',
      );
    expect(allText.join('')).not.toContain('SHOULD NOT APPEAR');
  });
});
