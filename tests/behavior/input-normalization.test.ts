import { describe, expect, it } from 'vitest';

import { appendToMessages } from '../../src/lib/conversation-state.js';

describe('Input normalization: turn-context -> conversation-state', () => {
  it('appendToMessages with string input normalizes to array before append', () => {
    const existing = 'first message';
    const newItem = {
      role: 'user' as const,
      content: 'second message',
    };
    const result = appendToMessages(existing, [
      newItem,
    ]);

    expect(result.length).toBeGreaterThan(1);
    // First item is normalized from string
    const firstItem = result[0]!;
    expect(firstItem).toHaveProperty('role', 'user');
    expect(firstItem).toHaveProperty('content', 'first message');
    // Second item is the appended message
    const lastItem = result[result.length - 1]!;
    expect(lastItem).toHaveProperty('role', 'user');
    expect(lastItem).toHaveProperty('content', 'second message');
  });
});
