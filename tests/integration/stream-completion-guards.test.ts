import { describe, expect, it } from 'vitest';

import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import { consumeStreamForCompletion } from '../../src/lib/stream-transformers.js';

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

describe('consumeStreamForCompletion + stream type guards', () => {
  it('returns response object because isResponseCompletedEvent identified the completion event', async () => {
    const response = {
      id: 'r1',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'm1',
          role: 'assistant',
          content: [],
        },
      ],
    };
    const stream = makeStream([
      {
        type: 'response.output_text.delta',
        delta: 'hello',
      },
      {
        type: 'response.completed',
        response,
      },
    ]);
    const result = await consumeStreamForCompletion(stream);
    expect(result.id).toBe('r1');
    expect(result.status).toBe('completed');
  });

  it('throws on failed response because isResponseFailedEvent caught the failure', async () => {
    const stream = makeStream([
      {
        type: 'response.failed',
        response: {
          error: {
            message: 'quota exceeded',
          },
        },
      },
    ]);
    await expect(consumeStreamForCompletion(stream)).rejects.toThrow('Response failed');
  });
});
