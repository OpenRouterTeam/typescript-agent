import { describe, expect, it } from 'vitest';

import { convertToClaudeMessage } from '../../src/lib/stream-transformers.js';
import { TEST_MODEL } from '../test-constants.js';

describe('convertToClaudeMessage routes multi-item response via output item guards', () => {
  it('multi-item response: message + function_call + reasoning + web_search -> each guard routes to distinct block', () => {
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
        {
          type: 'reasoning' as const,
          id: 'r_1',
          status: 'completed' as const,
          summary: [
            {
              type: 'summary_text' as const,
              text: 'thinking',
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
      outputText: 'Hello',
      model: TEST_MODEL,
      usage: {
        totalTokens: 200,
        inputTokens: 100,
        outputTokens: 100,
      },
    };

    const claude = convertToClaudeMessage(response);
    const types = claude.content.map((b: { type: string }) => b.type);

    expect(types).toContain('text');
    expect(types).toContain('tool_use');
    expect(types).toContain('thinking');
    expect(types).toContain('server_tool_use');
  });
});
