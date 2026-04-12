import { describe, expect, it } from 'vitest';

import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import { consumeStreamForCompletion } from '../../src/lib/stream-transformers.js';

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

describe('consumeStreamForCompletion - completion vs failure distinction', () => {
  it('response.completed event -> returns the response', async () => {
    const response = {
      id: 'r1',
      status: 'completed',
      output: [],
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
    expect(result).toEqual(response);
  });

  it('response.incomplete event -> returns the incomplete response', async () => {
    const response = {
      id: 'r1',
      status: 'incomplete',
      output: [],
    };
    const stream = makeStream([
      {
        type: 'response.incomplete',
        response,
      },
    ]);
    const result = await consumeStreamForCompletion(stream);
    expect(result).toEqual(response);
  });

  it('response.failed event -> throws', async () => {
    const stream = makeStream([
      {
        type: 'response.failed',
        response: {
          error: {
            message: 'rate limited',
          },
        },
      },
    ]);
    await expect(consumeStreamForCompletion(stream)).rejects.toThrow('Response failed');
  });

  it('stream ends without completion event -> throws', async () => {
    const stream = makeStream([
      {
        type: 'response.output_text.delta',
        delta: 'hello',
      },
    ]);
    await expect(consumeStreamForCompletion(stream)).rejects.toThrow(
      'Stream ended without completion event',
    );
  });
});
