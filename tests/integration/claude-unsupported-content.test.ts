import { describe, expect, it } from 'vitest';

import {
  convertToClaudeMessage,
  getUnsupportedContentSummary,
  hasUnsupportedContent,
} from '../../src/lib/stream-transformers.js';
import { TEST_MODEL } from '../test-constants.js';

describe('convertToClaudeMessage -> unsupported content utilities', () => {
  it('unsupported content round-trip: refusal + image_generation -> convertToClaudeMessage -> unsupported_content utilities work', () => {
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
              type: 'refusal' as const,
              refusal: 'I cannot do that',
            },
          ],
        },
        {
          type: 'image_generation_call' as const,
          id: 'ig_1',
          result: 'base64data',
          status: 'completed' as const,
        },
      ],
      status: 'completed' as const,
      outputText: '',
      model: TEST_MODEL,
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
      },
    };

    const claude = convertToClaudeMessage(response);
    // unsupported_content is a property on the message, not content blocks
    expect(hasUnsupportedContent(claude)).toBe(true);
    const summary = getUnsupportedContentSummary(claude);
    expect(summary).toBeDefined();
    // refusal and image_generation_call should both appear as unsupported
    expect(Object.keys(summary).length).toBeGreaterThan(0);
  });
});
