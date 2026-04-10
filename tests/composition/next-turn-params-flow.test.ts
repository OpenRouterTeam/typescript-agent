import { describe, expect, it } from 'vitest';

import {
  applyNextTurnParamsToRequest,
  buildNextTurnParamsContext,
  executeNextTurnParamsFunctions,
} from '../../src/lib/next-turn-params.js';

describe('Next-turn params: tools -> computation -> request modification', () => {
  it('executeNextTurnParamsFunctions output accepted by applyNextTurnParamsToRequest -> modified request', async () => {
    const toolsWithNextTurnParams = [
      {
        type: 'function',
        function: {
          name: 'search',
          nextTurnParams: {
            temperature: () => 0.5,
          },
        },
      },
    ];

    const toolCalls = [
      {
        id: 'tc_1',
        name: 'search',
        arguments: {
          q: 'test',
        },
      },
    ];
    const request = {
      model: 'gpt-4',
      temperature: 0.7,
    };

    const params = await executeNextTurnParamsFunctions(
      toolCalls as any,
      toolsWithNextTurnParams as any,
      request as any,
    );

    expect(params).toHaveProperty('temperature', 0.5);

    const modified = applyNextTurnParamsToRequest(request as any, params);
    expect(modified.temperature).toBe(0.5);
    expect(modified.model).toBe('gpt-4');
  });

  it('buildNextTurnParamsContext extracts from request -> context passed to nextTurnParams functions', () => {
    const request = {
      model: 'gpt-4',
      temperature: 0.7,
      input: 'hello',
    };

    const ctx = buildNextTurnParamsContext(request as any);
    expect(ctx.model).toBe('gpt-4');
    expect(ctx.temperature).toBe(0.7);
    expect(ctx.input).toBe('hello');
  });
});
