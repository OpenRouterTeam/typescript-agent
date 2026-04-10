import { describe, expect, it } from 'vitest';

import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import {
  extractToolCallsFromResponse,
  responseHasToolCalls,
} from '../../src/lib/stream-transformers.js';

function makeStream<T>(items: T[]): ReusableReadableStream<T> {
  const source = new ReadableStream<T>({
    start(controller) {
      for (const item of items) {
        controller.enqueue(item);
      }
      controller.close();
    },
  });
  return new ReusableReadableStream(source);
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of stream) {
    result.push(item);
  }
  return result;
}

describe('Stream data pipeline: source -> guards -> transformers -> consumers', () => {
  it('two consumers created from same ReusableReadableStream both receive all items', async () => {
    const stream = makeStream([
      1,
      2,
      3,
    ]);
    const consumer1 = stream.createConsumer();
    const consumer2 = stream.createConsumer();

    const [result1, result2] = await Promise.all([
      collect(consumer1),
      collect(consumer2),
    ]);
    expect(result1).toEqual([
      1,
      2,
      3,
    ]);
    expect(result2).toEqual([
      1,
      2,
      3,
    ]);
  });

  it('consumer created after some items buffered still gets all items from position 0', async () => {
    const stream = makeStream([
      10,
      20,
      30,
    ]);

    const consumer1 = stream.createConsumer();
    const items1: number[] = [];
    for await (const item of consumer1) {
      items1.push(item);
      if (items1.length === 2) {
        break;
      }
    }

    // Create second consumer after first has consumed some items
    const consumer2 = stream.createConsumer();
    const items2 = await collect(consumer2);
    expect(items2).toEqual([
      10,
      20,
      30,
    ]);
  });

  it('consumer created after source completes still gets all buffered items', async () => {
    const stream = makeStream([
      1,
      2,
      3,
    ]);
    // Consume fully to complete
    const c1 = stream.createConsumer();
    await collect(c1);

    // Late join after completion
    const c2 = stream.createConsumer();
    const result = await collect(c2);
    expect(result).toEqual([
      1,
      2,
      3,
    ]);
  });

  it('responseHasToolCalls returning true <-> extractToolCallsFromResponse returning non-empty', () => {
    const responseWithTools = {
      id: 'r1',
      output: [
        {
          type: 'function_call' as const,
          id: 'fc1',
          callId: 'fc1',
          name: 'search',
          arguments: '{"q":"test"}',
          status: 'completed' as const,
        },
      ],
      status: 'completed' as const,
      outputText: '',
      model: 'test-model',
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
      },
    };

    const hasTools = responseHasToolCalls(responseWithTools as any);
    const extracted = extractToolCallsFromResponse(responseWithTools as any);

    expect(hasTools).toBe(true);
    expect(extracted.length).toBeGreaterThan(0);

    const responseNoTools = {
      id: 'r2',
      output: [
        {
          type: 'message' as const,
          id: 'm1',
          role: 'assistant' as const,
          status: 'completed' as const,
          content: [
            {
              type: 'output_text' as const,
              text: 'Hello',
              annotations: [],
            },
          ],
        },
      ],
      status: 'completed' as const,
      outputText: 'Hello',
      model: 'test-model',
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
      },
    };

    const hasTools2 = responseHasToolCalls(responseNoTools as any);
    const extracted2 = extractToolCallsFromResponse(responseNoTools as any);

    expect(hasTools2).toBe(false);
    expect(extracted2).toEqual([]);
  });
});
