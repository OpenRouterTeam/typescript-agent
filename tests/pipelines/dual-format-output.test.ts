import { describe, expect, it } from 'vitest';

import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import {
  buildItemsStream,
  buildMessageStream,
  buildResponsesMessageStream,
  convertToClaudeMessage,
  extractMessageFromResponse,
  extractToolCallsFromResponse,
} from '../../src/lib/stream-transformers.js';
import { TEST_MODEL } from '../test-constants.js';

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

describe('Dual-format output: same response -> structurally distinct formats', () => {
  it('from response: same response -> extractMessageFromResponse, convertToClaudeMessage, extractToolCallsFromResponse all work', () => {
    const response = {
      id: 'r1',
      output: [
        {
          type: 'message' as const,
          id: 'msg_1',
          role: 'assistant' as const,
          status: 'completed' as const,
          content: [
            {
              type: 'output_text' as const,
              text: 'Found results',
              annotations: [],
            },
          ],
        },
        {
          type: 'function_call' as const,
          id: 'fc_1',
          callId: 'fc_1',
          name: 'search',
          arguments: '{"q":"test"}',
          status: 'completed' as const,
        },
      ],
      status: 'completed' as const,
      outputText: 'Found results',
      model: TEST_MODEL,
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
      },
    };

    // Chat format
    const chatMsg = extractMessageFromResponse(response as any);
    expect(chatMsg.role).toBe('assistant');
    expect(typeof chatMsg.content).toBe('string');

    // Claude format
    const claudeMsg = convertToClaudeMessage(response as any);
    expect(claudeMsg.role).toBe('assistant');
    expect(Array.isArray(claudeMsg.content)).toBe(true);

    // Tool calls
    const toolCalls = extractToolCallsFromResponse(response as any);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.name).toBe('search');

    // All semantically equivalent, structurally different
    expect(chatMsg.content).toBe('Found results');
    const claudeText = claudeMsg.content.find((b: any) => b.type === 'text');
    expect((claudeText as any).text).toBe('Found results');
  });

  it('through streaming: same ReusableReadableStream -> three concurrent consumers all complete', async () => {
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
        response: {
          id: 'r1',
        },
      },
    ];

    const stream = makeStream(events);

    // Three concurrent consumers
    const [chatMsgs, responsesMsgs, items] = await Promise.all([
      collectAll(buildMessageStream(stream)),
      collectAll(buildResponsesMessageStream(stream)),
      collectAll(buildItemsStream(stream)),
    ]);

    // All complete without blocking each other
    expect(chatMsgs.length).toBeGreaterThan(0);
    expect(responsesMsgs.length).toBeGreaterThan(0);
    expect(items.length).toBeGreaterThan(0);

    // Structurally different
    const lastChat = chatMsgs[chatMsgs.length - 1]!;
    const lastResponses = responsesMsgs[responsesMsgs.length - 1]!;

    expect('id' in lastChat).toBe(false);
    expect('id' in lastResponses).toBe(true);
  });
});
