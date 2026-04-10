import { describe, expect, it } from 'vitest';

import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import {
  extractReasoningDeltas,
  extractTextDeltas,
  extractToolDeltas,
} from '../../src/lib/stream-transformers.js';

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

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const item of iter) {
    result.push(item);
  }
  return result;
}

describe('Delta extractors - each yields ONLY its event type', () => {
  const mixedEvents = [
    {
      type: 'response.output_text.delta',
      delta: 'hello',
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
      type: 'response.reasoning_text.delta',
      delta: ' more',
    },
    {
      type: 'response.function_call_arguments.delta',
      delta: '"test"}',
    },
  ];

  it('extractTextDeltas yields strings from output_text.delta events; reasoning + tool deltas ignored', async () => {
    const stream = makeStream(mixedEvents);
    const result = await collect(extractTextDeltas(stream));
    expect(result).toEqual([
      'hello',
      ' world',
    ]);
  });

  it('extractReasoningDeltas yields strings from reasoning_text.delta events; ignores text + tool', async () => {
    const stream = makeStream(mixedEvents);
    const result = await collect(extractReasoningDeltas(stream));
    expect(result).toEqual([
      'thinking',
      ' more',
    ]);
  });

  it('extractToolDeltas yields strings from function_call_arguments.delta events; ignores text + reasoning', async () => {
    const stream = makeStream(mixedEvents);
    const result = await collect(extractToolDeltas(stream));
    expect(result).toEqual([
      '{"q":',
      '"test"}',
    ]);
  });

  it('extractTextDeltas skips events with empty/undefined delta', async () => {
    const events = [
      {
        type: 'response.output_text.delta',
        delta: 'hello',
      },
      {
        type: 'response.output_text.delta',
        delta: '',
      },
      {
        type: 'response.output_text.delta',
        delta: undefined,
      },
      {
        type: 'response.output_text.delta',
        delta: ' world',
      },
    ];
    const stream = makeStream(events);
    const result = await collect(extractTextDeltas(stream));
    expect(result).toEqual([
      'hello',
      ' world',
    ]);
  });
});
