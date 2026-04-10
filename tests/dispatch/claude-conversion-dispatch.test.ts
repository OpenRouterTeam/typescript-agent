import { describe, expect, it } from 'vitest';

import { convertToClaudeMessage } from '../../src/lib/stream-transformers.js';

describe('convertToClaudeMessage routes items via output item guards', () => {
  it('same response with message + function_call: isOutputMessage -> text block, isFunctionCallItem -> tool_use block', () => {
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
              text: 'Hello',
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
      outputText: 'Hello',
      model: 'test-model',
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
      },
    };

    const claude = convertToClaudeMessage(response as any);
    const textBlock = claude.content.find((b: any) => b.type === 'text');
    const toolBlock = claude.content.find((b: any) => b.type === 'tool_use');

    expect(textBlock).toBeDefined();
    expect((textBlock as any).text).toBe('Hello');
    expect(toolBlock).toBeDefined();
    expect((toolBlock as any).name).toBe('search');
  });

  it('same response with reasoning + web_search_call: isReasoningOutputItem -> thinking, isWebSearchCallOutputItem -> server_tool_use', () => {
    const response = {
      id: 'r1',
      output: [
        {
          type: 'reasoning' as const,
          id: 'r_1',
          status: 'completed' as const,
          summary: [
            {
              type: 'summary_text' as const,
              text: 'thinking about it',
            },
          ],
        },
        {
          type: 'web_search_call' as const,
          id: 'ws_1',
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

    const claude = convertToClaudeMessage(response as any);
    const thinkingBlock = claude.content.find((b: any) => b.type === 'thinking');
    const serverToolBlock = claude.content.find((b: any) => b.type === 'server_tool_use');

    expect(thinkingBlock).toBeDefined();
    expect(serverToolBlock).toBeDefined();
  });
});
