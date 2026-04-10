import { describe, expect, it } from 'vitest';

import {
  applyNextTurnParamsToRequest,
  executeNextTurnParamsFunctions,
} from '../../src/lib/next-turn-params.js';

describe('Next-turn params -> request modification -> API readiness', () => {
  it('executeNextTurnParamsFunctions computes new temperature -> applyNextTurnParamsToRequest produces request with updated temperature', async () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'search',
          nextTurnParams: {
            temperature: () => 0.3,
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
      input: 'hello',
    };
    const params = await executeNextTurnParamsFunctions(
      toolCalls as any,
      tools as any,
      request as any,
    );

    const modified = applyNextTurnParamsToRequest(request as any, params);
    expect(modified.temperature).toBe(0.3);
    expect(modified.model).toBe('gpt-4');
    expect(modified.input).toBe('hello');
  });
});
