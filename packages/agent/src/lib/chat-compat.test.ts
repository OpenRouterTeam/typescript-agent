import type * as models from '@openrouter/sdk/models';

import { describe, expect, it } from 'vitest';
import { fromChatMessages, toChatMessage } from './chat-compat.js';
import type { Item } from './item-types.js';

/**
 * Creates a properly typed mock OpenResponsesResult for testing.
 * This factory provides all required fields with sensible defaults.
 */
function createMockResponse(
  overrides: Partial<models.OpenResponsesResult> & {
    output: models.OpenResponsesResult['output'];
  },
): models.OpenResponsesResult {
  return {
    id: 'resp_test',
    object: 'response',
    createdAt: Date.now(),
    completedAt: Date.now(),
    model: 'openai/gpt-4',
    status: 'completed',
    error: null,
    incompleteDetails: null,
    temperature: null,
    topP: null,
    presencePenalty: null,
    frequencyPenalty: null,
    metadata: null,
    instructions: null,
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: false,
    ...overrides,
  };
}

describe('fromChatMessages', () => {
  describe('basic message conversion', () => {
    it('converts user message with string content', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'user',
          content: 'Hello, how are you?',
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          role: 'user',
          content: 'Hello, how are you?',
        },
      ]);
    });

    it('converts assistant message with string content', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'assistant',
          content: 'I am doing well, thank you!',
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          role: 'assistant',
          content: 'I am doing well, thank you!',
        },
      ]);
    });

    it('converts system message with string content', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant.',
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          role: 'system',
          content: 'You are a helpful assistant.',
        },
      ]);
    });

    it('converts developer message with string content', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'developer',
          content: 'Developer instructions here.',
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          role: 'developer',
          content: 'Developer instructions here.',
        },
      ]);
    });

    it('converts multiple messages in conversation', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'system',
          content: 'You are helpful.',
        },
        {
          role: 'user',
          content: 'Hi',
        },
        {
          role: 'assistant',
          content: 'Hello!',
        },
        {
          role: 'user',
          content: 'How are you?',
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          role: 'system',
          content: 'You are helpful.',
        },
        {
          role: 'user',
          content: 'Hi',
        },
        {
          role: 'assistant',
          content: 'Hello!',
        },
        {
          role: 'user',
          content: 'How are you?',
        },
      ]);
    });
  });

  describe('tool response message conversion', () => {
    it('converts tool message to function_call_output', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'tool',
          content: 'The weather is sunny and 72F',
          toolCallId: 'call_abc123',
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          type: 'function_call_output',
          callId: 'call_abc123',
          output: 'The weather is sunny and 72F',
        },
      ]);
    });

    it('converts tool message with object content by stringifying', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'tool',
          content: [
            {
              type: 'text',
              text: 'Structured response',
            },
          ],
          toolCallId: 'call_def456',
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          type: 'function_call_output',
          callId: 'call_def456',
          output: JSON.stringify([
            {
              type: 'text',
              text: 'Structured response',
            },
          ]),
        },
      ]);
    });
  });

  describe('content array handling', () => {
    it('stringifies array content for user messages', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hello from array',
            },
          ],
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          role: 'user',
          content: JSON.stringify([
            {
              type: 'text',
              text: 'Hello from array',
            },
          ]),
        },
      ]);
    });

    it('stringifies array content for assistant messages', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Response in array',
            },
          ],
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          role: 'assistant',
          content: JSON.stringify([
            {
              type: 'text',
              text: 'Response in array',
            },
          ]),
        },
      ]);
    });
  });

  describe('null and empty content handling', () => {
    it('handles null content in assistant message', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'assistant',
          content: null,
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          role: 'assistant',
          content: '',
        },
      ]);
    });

    it('handles empty string content', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'user',
          content: '',
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          role: 'user',
          content: '',
        },
      ]);
    });

    it('handles empty messages array', () => {
      const result = fromChatMessages([]);
      expect(result).toEqual([]);
    });
  });

  // Regression tests for https://github.com/OpenRouterTeam/typescript-agent/issues/11
  describe('assistant tool call conversion (#11)', () => {
    it('emits a function_call item for an assistant message with null content and one toolCall', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'user',
          content: 'What is the weather in Paris?',
        },
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'call_123',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"Paris"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Sunny, 22C',
          toolCallId: 'call_123',
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          role: 'user',
          content: 'What is the weather in Paris?',
        },
        {
          type: 'function_call',
          callId: 'call_123',
          id: 'call_123',
          name: 'get_weather',
          arguments: '{"location":"Paris"}',
          status: 'completed',
        },
        {
          type: 'function_call_output',
          callId: 'call_123',
          output: 'Sunny, 22C',
        },
      ]);
    });

    it('emits both a message item and a function_call item when assistant has text and toolCalls', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'assistant',
          content: 'Let me check the weather for you.',
          toolCalls: [
            {
              id: 'call_456',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"London"}',
              },
            },
          ],
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          role: 'assistant',
          content: 'Let me check the weather for you.',
        },
        {
          type: 'function_call',
          callId: 'call_456',
          id: 'call_456',
          name: 'get_weather',
          arguments: '{"location":"London"}',
          status: 'completed',
        },
      ]);
    });

    it('emits one function_call item per toolCall for parallel tool calls', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'call_a',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"Paris"}',
              },
            },
            {
              id: 'call_b',
              type: 'function',
              function: {
                name: 'get_time',
                arguments: '{"tz":"UTC"}',
              },
            },
          ],
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          type: 'function_call',
          callId: 'call_a',
          id: 'call_a',
          name: 'get_weather',
          arguments: '{"location":"Paris"}',
          status: 'completed',
        },
        {
          type: 'function_call',
          callId: 'call_b',
          id: 'call_b',
          name: 'get_time',
          arguments: '{"tz":"UTC"}',
          status: 'completed',
        },
      ]);
    });

    it('does not re-stringify already-serialized tool call arguments', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'call_raw',
              type: 'function',
              function: {
                name: 'noop',
                arguments: '{"a":1}',
              },
            },
          ],
        },
      ];

      const result = fromChatMessages(messages);
      const item = (
        result as Array<{
          arguments?: string;
        }>
      )[0];

      // Would be '"{\\"a\\":1}"' if JSON.stringify were applied a second time.
      expect(item?.arguments).toBe('{"a":1}');
    });

    it('emits nothing extra for an assistant message with an empty toolCalls array', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'assistant',
          content: 'No tools needed.',
          toolCalls: [],
        },
      ];

      const result = fromChatMessages(messages);

      expect(result).toEqual([
        {
          role: 'assistant',
          content: 'No tools needed.',
        },
      ]);
    });
  });

  // Regression test for https://github.com/OpenRouterTeam/typescript-agent/issues/41
  describe('return type is assignable to callModel input (#41)', () => {
    it('returns a value assignable to Item[]', () => {
      const messages: models.ChatMessages[] = [
        {
          role: 'system',
          content: 'You are helpful.',
        },
        {
          role: 'user',
          content: 'Hi',
        },
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'call_typed',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{}',
              },
            },
          ],
        },
        {
          role: 'tool',
          content: 'ok',
          toolCallId: 'call_typed',
        },
      ];

      // Compile-level assertion: this is the shape `callModel({ input })` requires
      // (`FieldOrAsyncFunction<Item[]> | string`). Before the #41 fix this line
      // failed to typecheck because `fromChatMessages` returned `models.InputsUnion`.
      const items: Item[] = fromChatMessages(messages);

      expect(Array.isArray(items)).toBe(true);
    });
  });
});

describe('toChatMessage', () => {
  describe('basic message conversion', () => {
    it('converts response with text output to ChatAssistantMessage', () => {
      const response = createMockResponse({
        id: 'resp_123',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'Hello! How can I help you?',
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          inputTokensDetails: {
            cachedTokens: 0,
          },
          outputTokensDetails: {
            reasoningTokens: 0,
          },
        },
      });

      const result = toChatMessage(response);

      expect(result).toEqual({
        role: 'assistant',
        content: 'Hello! How can I help you?',
      });
    });

    it('combines multiple text parts into single content string', () => {
      const response = createMockResponse({
        id: 'resp_456',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'Part 1. ',
                annotations: [],
              },
              {
                type: 'output_text',
                text: 'Part 2.',
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          inputTokens: 5,
          outputTokens: 10,
          totalTokens: 15,
          inputTokensDetails: {
            cachedTokens: 0,
          },
          outputTokensDetails: {
            reasoningTokens: 0,
          },
        },
      });

      const result = toChatMessage(response);

      expect(result).toEqual({
        role: 'assistant',
        content: 'Part 1. Part 2.',
      });
    });

    it('returns null content when message has no text', () => {
      const response = createMockResponse({
        id: 'resp_789',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [],
          },
        ],
        usage: {
          inputTokens: 5,
          outputTokens: 0,
          totalTokens: 5,
          inputTokensDetails: {
            cachedTokens: 0,
          },
          outputTokensDetails: {
            reasoningTokens: 0,
          },
        },
      });

      const result = toChatMessage(response);

      expect(result).toEqual({
        role: 'assistant',
        content: null,
      });
    });
  });

  describe('error handling', () => {
    it('throws error when no message found in output', () => {
      const response = createMockResponse({
        id: 'resp_err',
        output: [
          {
            type: 'function_call',
            callId: 'call_1',
            name: 'test_tool',
            arguments: '{}',
            id: 'fc_1',
            status: 'completed',
          },
        ],
        usage: {
          inputTokens: 5,
          outputTokens: 10,
          totalTokens: 15,
          inputTokensDetails: {
            cachedTokens: 0,
          },
          outputTokensDetails: {
            reasoningTokens: 0,
          },
        },
      });

      expect(() => toChatMessage(response)).toThrow('No message found in response output');
    });
  });
});
