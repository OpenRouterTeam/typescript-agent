import { describe, expect, it } from 'vitest';

import { fromClaudeMessages } from '../../src/lib/anthropic-compat.js';

describe('fromClaudeMessages - each block type maps distinctly', () => {
  it('text blocks -> EasyInputMessage (not function_call_output, not function_call)', () => {
    const result = fromClaudeMessages([
      {
        role: 'user',
        content: [
          {
            type: 'text' as const,
            text: 'Hello',
          },
        ],
      },
    ]);
    const items = result as any[];
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveProperty('role');
    expect(items[0]).toHaveProperty('content', 'Hello');
    expect(items[0]).not.toHaveProperty('type');
  });

  it('tool_use blocks -> FunctionCallItem (not EasyInputMessage, not function_call_output)', () => {
    const result = fromClaudeMessages([
      {
        role: 'assistant',
        content: [
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
    ]);
    const items = result as any[];
    const toolItem = items.find((i: any) => i.type === 'function_call');
    expect(toolItem).toBeDefined();
    expect(toolItem.name).toBe('search');
    expect(toolItem.callId).toBe('tu_1');
  });

  it('tool_result blocks -> FunctionCallOutputItem (not EasyInputMessage, not function_call)', () => {
    const result = fromClaudeMessages([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tu_1',
            content: 'Search result',
          },
        ],
      },
    ]);
    const items = result as any[];
    const outputItem = items.find((i: any) => i.type === 'function_call_output');
    expect(outputItem).toBeDefined();
    expect(outputItem.callId).toBe('tu_1');
    expect(outputItem.output).toBe('Search result');
  });

  it('image blocks -> structured content EasyInputMessage (not input_image alone)', () => {
    const result = fromClaudeMessages([
      {
        role: 'user',
        content: [
          {
            type: 'image' as const,
            source: {
              type: 'url' as const,
              url: 'https://example.com/img.png',
            },
          },
        ],
      },
    ]);
    const items = result as any[];
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveProperty('role');
    expect(items[0]).toHaveProperty('content');
    expect(Array.isArray(items[0].content)).toBe(true);
    expect(items[0].content[0].type).toBe('input_image');
  });
});
