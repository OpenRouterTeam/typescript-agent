import { describe, expect, it } from 'vitest';

import { fromClaudeMessages, toClaudeMessage } from '../../src/lib/anthropic-compat.js';
import { fromChatMessages, toChatMessage } from '../../src/lib/chat-compat.js';

describe('Bidirectional format conversion', () => {
  it('Claude round-trip: Claude messages -> fromClaudeMessages -> OR format -> each block type maps distinctly', () => {
    const claudeMessages = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: 'Search for cats',
          },
        ],
      },
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'text' as const,
            text: 'Let me search.',
          },
          {
            type: 'tool_use' as const,
            id: 'tu_1',
            name: 'search',
            input: {
              q: 'cats',
            },
          },
        ],
      },
      {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tu_1',
            content: 'Found cats',
          },
        ],
      },
    ];

    // Claude -> OR format
    const orFormat = fromClaudeMessages(claudeMessages);
    const items = orFormat as any[];

    // Text blocks -> EasyInputMessage
    const textItems = items.filter((i: any) => !i.type || i.role);
    expect(textItems.length).toBeGreaterThan(0);

    // tool_use -> FunctionCallItem
    const fnCalls = items.filter((i: any) => i.type === 'function_call');
    expect(fnCalls).toHaveLength(1);
    expect(fnCalls[0].name).toBe('search');

    // tool_result -> FunctionCallOutputItem
    const fnOutputs = items.filter((i: any) => i.type === 'function_call_output');
    expect(fnOutputs).toHaveLength(1);
    expect(fnOutputs[0].callId).toBe('tu_1');

    // Verify OR format -> Claude format works on a response
    const mockResponse = {
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
              text: 'Here are cats',
              annotations: [],
            },
          ],
        },
      ],
      status: 'completed' as const,
      outputText: 'Here are cats',
      model: 'test-model',
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
      },
    };
    const claudeResponse = toClaudeMessage(mockResponse as any);
    expect(claudeResponse.role).toBe('assistant');
    expect(Array.isArray(claudeResponse.content)).toBe(true);
  });

  it('Chat round-trip: Chat messages -> fromChatMessages -> OR format -> each role maps distinctly', () => {
    const chatMessages = [
      {
        role: 'system' as const,
        content: 'You are helpful',
      },
      {
        role: 'user' as const,
        content: 'Hello',
      },
      {
        role: 'assistant' as const,
        content: 'Hi there',
      },
      {
        role: 'tool' as const,
        toolCallId: 'tc_1',
        content: 'Tool result',
      },
    ] as any[];

    // Chat -> OR format
    const orFormat = fromChatMessages(chatMessages);
    const items = orFormat as any[];

    // System message
    const systemItems = items.filter((i: any) => i.role === 'system');
    expect(systemItems).toHaveLength(1);

    // User message
    const userItems = items.filter((i: any) => i.role === 'user');
    expect(userItems).toHaveLength(1);

    // Assistant message
    const assistantItems = items.filter((i: any) => i.role === 'assistant');
    expect(assistantItems).toHaveLength(1);

    // Tool message -> FunctionCallOutputItem
    const toolOutputs = items.filter((i: any) => i.type === 'function_call_output');
    expect(toolOutputs).toHaveLength(1);

    // Verify OR format -> Chat format works on a response
    const mockResponse = {
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
              text: 'Response',
              annotations: [],
            },
          ],
        },
      ],
      status: 'completed' as const,
      outputText: 'Response',
      model: 'test-model',
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
      },
    };
    const chatResponse = toChatMessage(mockResponse as any);
    expect(chatResponse.role).toBe('assistant');
    expect(typeof chatResponse.content).toBe('string');
  });
});
