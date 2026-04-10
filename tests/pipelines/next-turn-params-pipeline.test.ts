import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { tool } from '../../src/index.js';
import {
  applyNextTurnParamsToRequest,
  buildNextTurnParamsContext,
  executeNextTurnParamsFunctions,
} from '../../src/lib/next-turn-params.js';
import { TEST_MODEL } from '../test-constants.js';

describe('Next-turn parameter adjustment pipeline', () => {
  it('dynamic temperature: search tool with nextTurnParams.temperature -> context -> execute -> apply -> request updated', async () => {
    const searchTool = tool({
      name: 'search',
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: async (args) => `Results for: ${args.query}`,
      nextTurnParams: {
        temperature: (input: { query?: string }) => (input.query?.includes('creative') ? 0.9 : 0.1),
      },
    });

    const request = {
      model: TEST_MODEL,
      temperature: 0.5,
      input: 'hello',
    };

    // Step 1: Build context from request
    const ctx = buildNextTurnParamsContext(request);
    expect(ctx.model).toBe(TEST_MODEL);
    expect(ctx.temperature).toBe(0.5);

    // Step 2: Execute nextTurnParams functions
    // The tool was called with { query: 'creative writing' }
    const tools = [
      searchTool,
    ];
    const toolCalls = [
      {
        id: 'tc_1',
        name: 'search',
        arguments: {
          query: 'creative writing',
        },
      },
    ];
    const params = await executeNextTurnParamsFunctions(toolCalls, tools, request);

    expect(params).toHaveProperty('temperature', 0.9);

    // Step 3: Apply to request
    const modified = applyNextTurnParamsToRequest(request, params);
    expect(modified.temperature).toBe(0.9);
    expect(modified.model).toBe(TEST_MODEL);
    expect(modified.input).toBe('hello');
  });
});
