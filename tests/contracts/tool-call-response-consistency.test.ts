import { describe, expect, it } from 'vitest';

import {
  extractToolCallsFromResponse,
  responseHasToolCalls,
} from '../../src/lib/stream-transformers.js';
import { TEST_MODEL } from '../test-constants.js';

describe('responseHasToolCalls and extractToolCallsFromResponse produce consistent results', () => {
  it('responseHasToolCalls returning true <-> extractToolCallsFromResponse returning non-empty', () => {
    const responseWithTools = {
      id: 'r1',
      output: [
        {
          type: 'function_call' as const,
          id: 'fc1',
          callId: 'fc1',
          name: 'search',
          arguments: '{"q":"test"}',
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

    const hasTools = responseHasToolCalls(responseWithTools);
    const extracted = extractToolCallsFromResponse(responseWithTools);

    expect(hasTools).toBe(true);
    expect(extracted.length).toBeGreaterThan(0);

    const responseNoTools = {
      id: 'r2',
      output: [
        {
          type: 'message' as const,
          id: 'm1',
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
      ],
      status: 'completed' as const,
      outputText: 'Hello',
      model: TEST_MODEL,
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
      },
    };

    const hasTools2 = responseHasToolCalls(responseNoTools);
    const extracted2 = extractToolCallsFromResponse(responseNoTools);

    expect(hasTools2).toBe(false);
    expect(extracted2).toEqual([]);
  });
});
