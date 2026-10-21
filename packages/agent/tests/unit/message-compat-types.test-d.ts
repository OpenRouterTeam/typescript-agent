import type { InputsUnion } from '@openrouter/sdk/models';
import { describe, expectTypeOf, it } from 'vitest';
import type { ChatMessages, Item } from '../../src/index.js';
import { fromChatMessages, fromClaudeMessages } from '../../src/index.js';

type ClaudeMessages = Parameters<typeof fromClaudeMessages>[0];

describe('message compatibility declarations', () => {
  it('returns input arrays accepted by both public input types', () => {
    const chatMessages = [] as ChatMessages[];
    const claudeMessages = [] as ClaudeMessages;

    const chatItems: Item[] = fromChatMessages(chatMessages);
    const chatInput: InputsUnion = fromChatMessages(chatMessages);
    const claudeItems: Item[] = fromClaudeMessages(claudeMessages);
    const claudeInput: InputsUnion = fromClaudeMessages(claudeMessages);

    expectTypeOf(chatItems).toMatchTypeOf<Item[]>();
    expectTypeOf(chatInput).toMatchTypeOf<InputsUnion>();
    expectTypeOf(claudeItems).toMatchTypeOf<Item[]>();
    expectTypeOf(claudeInput).toMatchTypeOf<InputsUnion>();
  });
});
