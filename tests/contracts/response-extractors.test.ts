import { describe, expect, it } from 'vitest';

import {
  extractMessageFromResponse,
  extractResponsesMessageFromResponse,
} from '../../src/lib/stream-transformers.js';

function makeResponse(text: string) {
  return {
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
            text,
            annotations: [],
          },
        ],
      },
    ],
    status: 'completed' as const,
    outputText: text,
    model: 'test-model',
    usage: {
      totalTokens: 100,
      inputTokens: 50,
      outputTokens: 50,
    },
  };
}

describe('Response extractors - same response, distinct shapes', () => {
  it('extractMessageFromResponse returns ChatAssistantMessage (role + content string)', () => {
    const response = makeResponse('Hello world');
    const msg = extractMessageFromResponse(response as any);
    expect(msg.role).toBe('assistant');
    expect(typeof msg.content).toBe('string');
    expect(msg).not.toHaveProperty('id');
    expect(msg).not.toHaveProperty('type');
  });

  it('extractResponsesMessageFromResponse returns OutputMessage (id + type + content array)', () => {
    const response = makeResponse('Hello world');
    const msg = extractResponsesMessageFromResponse(response as any);
    expect(msg.id).toBe('msg_1');
    expect(msg.type).toBe('message');
    expect(Array.isArray(msg.content)).toBe(true);
  });

  it('same response -> both extract same text but structurally different objects', () => {
    const response = makeResponse('Hello world');
    const chatMsg = extractMessageFromResponse(response as any);
    const responsesMsg = extractResponsesMessageFromResponse(response as any);

    expect(chatMsg.content).toBe('Hello world');
    const responsesText = responsesMsg.content
      .filter((c: any) => c.type === 'output_text')
      .map((c: any) => c.text)
      .join('');
    expect(responsesText).toBe('Hello world');

    // Structurally different
    expect('id' in chatMsg).toBe(false);
    expect('id' in responsesMsg).toBe(true);
  });

  it('both throw when response has no message item', () => {
    const response = {
      id: 'r1',
      output: [
        {
          type: 'function_call' as const,
          id: 'fc_1',
          callId: 'fc_1',
          name: 'search',
          arguments: '{}',
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

    expect(() => extractMessageFromResponse(response as any)).toThrow('No message found');
    expect(() => extractResponsesMessageFromResponse(response as any)).toThrow('No message found');
  });
});
