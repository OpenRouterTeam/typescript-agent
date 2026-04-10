import { describe, expect, it } from 'vitest';

import { appendToMessages } from '../../src/lib/conversation-state.js';

describe('Conversation state -> format conversion', () => {
  it('appendToMessages with normalizeInputToArray -> string input produces correct array for API', () => {
    const existing = [
      {
        role: 'user' as const,
        content: 'first message',
      },
    ];

    const newItem = {
      role: 'user' as const,
      content: 'second message',
    };
    const result = appendToMessages(
      existing as any,
      [
        newItem,
      ] as any,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      role: 'user',
      content: 'first message',
    });
    expect(result[1]).toHaveProperty('role', 'user');
    expect(result[1]).toHaveProperty('content', 'second message');
  });
});
