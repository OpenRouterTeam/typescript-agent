import { describe, expect, it } from 'vitest';

import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import {
  buildMessageStream,
  buildResponsesMessageStream,
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

const streamEvents = [
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
    type: 'response.output_item.done',
    item: {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'Hello world',
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

describe('Message stream builders - same input, structurally distinct outputs', () => {
  it('buildResponsesMessageStream yields OutputMessage: { id, type: "message", role: "assistant", content: [...] }', async () => {
    const stream = makeStream(streamEvents);
    const results = await collectAll(buildResponsesMessageStream(stream));
    expect(results.length).toBeGreaterThan(0);
    const last = results[results.length - 1]!;
    expect(last).toHaveProperty('id');
    expect(last).toHaveProperty('type', 'message');
    expect(last).toHaveProperty('role', 'assistant');
    expect(last).toHaveProperty('content');
    expect(Array.isArray(last.content)).toBe(true);
  });

  it('buildMessageStream yields ChatAssistantMessage: { role: "assistant", content: string }', async () => {
    const stream = makeStream(streamEvents);
    const results = await collectAll(buildMessageStream(stream));
    expect(results.length).toBeGreaterThan(0);
    const last = results[results.length - 1]!;
    expect(last).toHaveProperty('role', 'assistant');
    expect(typeof last.content).toBe('string');
    expect(last).not.toHaveProperty('id');
    expect(last).not.toHaveProperty('type');
  });

  it('same stream events -> both produce same text content but structurally different objects', async () => {
    const stream1 = makeStream(streamEvents);
    const stream2 = makeStream(streamEvents);

    const responsesResults = await collectAll(buildResponsesMessageStream(stream1));
    const chatResults = await collectAll(buildMessageStream(stream2));

    const responsesLast = responsesResults[responsesResults.length - 1]!;
    const chatLast = chatResults[chatResults.length - 1]!;

    // Same text content
    const responsesText = responsesLast.content
      .filter((c: { type: string; text?: string }) => c.type === 'output_text')
      .map((c: { type: string; text?: string }) => c.text)
      .join('');
    expect(responsesText).toBe('Hello world');
    expect(chatLast.content).toBe('Hello world');

    // Structurally different
    expect('id' in responsesLast).toBe(true);
    expect('id' in chatLast).toBe(false);
  });
});
