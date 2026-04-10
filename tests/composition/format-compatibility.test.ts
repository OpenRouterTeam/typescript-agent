import { describe, expect, it } from 'vitest';
import { toClaudeMessage } from '../../src/lib/anthropic-compat.js';
import { toChatMessage } from '../../src/lib/chat-compat.js';
import { TEST_MODEL } from '../test-constants.js';

function makeResponse(text: string) {
  return {
    id: 'r1',
    output: [
      {
        type: 'message' as const,
        id: 'm1',
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
    model: TEST_MODEL,
    usage: {
      totalTokens: 100,
      inputTokens: 50,
      outputTokens: 50,
    },
  };
}

describe('Format compatibility: compat layers -> stream-transformers', () => {
  it('toChatMessage delegates to extractMessageFromResponse -> returns ChatAssistantMessage', () => {
    const response = makeResponse('Hello world');
    const chatMsg = toChatMessage(response as any);
    expect(chatMsg.role).toBe('assistant');
    expect(chatMsg.content).toBe('Hello world');
  });

  it('toClaudeMessage delegates to convertToClaudeMessage -> returns ClaudeMessage', () => {
    const response = makeResponse('Hello world');
    const claudeMsg = toClaudeMessage(response as any);
    expect(claudeMsg.role).toBe('assistant');
    expect(claudeMsg.content).toBeDefined();
    expect(Array.isArray(claudeMsg.content)).toBe(true);
  });
});
