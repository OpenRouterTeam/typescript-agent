import { describe, expect, it } from 'vitest';

import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import {
  buildItemsStream,
  consumeStreamForCompletion,
  extractTextDeltas,
} from '../../src/lib/stream-transformers.js';

function makeStream(events: StreamEvents[]): ReusableReadableStream<StreamEvents> {
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

describe('Full streaming pipeline: raw events -> guards -> transformers -> consumer', () => {
  it('text streaming: guard filters to text only -> extractTextDeltas yields strings -> non-text absent', async () => {
    const events = [
      {
        type: 'response.output_text.delta',
        delta: 'Hello',
      },
      {
        type: 'response.reasoning_text.delta',
        delta: 'thinking',
      },
      {
        type: 'response.function_call_arguments.delta',
        delta: '{"q":',
      },
      {
        type: 'response.output_text.delta',
        delta: ' world',
      },
      {
        type: 'response.completed',
        response: {},
      },
    ];
    const stream = makeStream(events);
    const textDeltas = await collectAll(extractTextDeltas(stream));

    // Guard true only for text events
    expect(textDeltas).toEqual([
      'Hello',
      ' world',
    ]);
    // Non-text absent
    expect(textDeltas).not.toContain('thinking');
    expect(textDeltas).not.toContain('{"q":');
  });

  it('items streaming: type guards dispatch to per-type handlers -> consumer gets distinct item types', async () => {
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
        delta: '{"q":"test"}',
        itemId: 'fc_1',
      },
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
        type: 'response.completed',
        response: {},
      },
    ];
    const stream = makeStream(events);
    const items = await collectAll(buildItemsStream(stream));

    const messageItems = items.filter((i) => i.type === 'message');
    const fnCallItems = items.filter((i) => i.type === 'function_call');
    const reasoningItems = items.filter((i) => i.type === 'reasoning');

    // Each type present and distinct
    expect(messageItems.length).toBeGreaterThan(0);
    expect(fnCallItems.length).toBeGreaterThan(0);
    expect(reasoningItems.length).toBeGreaterThan(0);

    // Message items have text
    expect(messageItems[messageItems.length - 1].content[0].text).toBe('Hello');
    // Function call items have arguments
    expect(fnCallItems[fnCallItems.length - 1].arguments).toBe('{"q":"test"}');
    // Reasoning items have content
    expect(reasoningItems[reasoningItems.length - 1].summary[0].text).toBe('thinking');
  });

  it('completion: isResponseCompletedEvent true -> consumeStreamForCompletion returns response -> stream terminates', async () => {
    const response = {
      id: 'r1',
      status: 'completed',
      output: [],
    };
    const events = [
      {
        type: 'response.output_text.delta',
        delta: 'data',
      },
      {
        type: 'response.completed',
        response,
      },
    ];
    const stream = makeStream(events);
    const result = await consumeStreamForCompletion(stream);
    expect(result).toEqual(response);
  });
});
