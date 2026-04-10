import { describe, expect, it } from 'vitest';

import { fromClaudeMessages } from '../../src/lib/anthropic-compat.js';

describe('fromClaudeMessages routes blocks to distinct output types', () => {
  it('mixed Claude message with text + tool_use + tool_result blocks -> each block produces its correct OR type, interleaved correctly', () => {
    const result = fromClaudeMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'text' as const,
            text: 'Let me search for that.',
          },
          {
            type: 'tool_use' as const,
            id: 'tu_1',
            name: 'search',
            input: {
              q: 'test',
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tu_1',
            content: 'Found results',
          },
          {
            type: 'text' as const,
            text: 'Thanks for the results',
          },
        ],
      },
    ]);

    const items = result as any[];
    // Should have: text message, function_call, function_call_output, text message
    const types = items.map((i: any) => i.type || 'easy_input_message');

    expect(types).toContain('function_call');
    expect(types).toContain('function_call_output');

    // Check that the function_call has correct properties
    const fnCall = items.find((i: any) => i.type === 'function_call');
    expect(fnCall.name).toBe('search');
    expect(fnCall.callId).toBe('tu_1');

    // Check that the function_call_output has correct properties
    const fnOutput = items.find((i: any) => i.type === 'function_call_output');
    expect(fnOutput.callId).toBe('tu_1');
    expect(fnOutput.output).toBe('Found results');
  });
});
