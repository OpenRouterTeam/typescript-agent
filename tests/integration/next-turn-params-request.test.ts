import { describe, expect, it } from 'vitest';

import {
  applyNextTurnParamsToRequest,
  executeNextTurnParamsFunctions,
} from '../../src/lib/next-turn-params.js';
import { TEST_MODEL } from '../test-constants.js';

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
      model: TEST_MODEL,
      temperature: 0.7,
      input: 'hello',
    };
    const params = await executeNextTurnParamsFunctions(toolCalls, tools, request);

    const modified = applyNextTurnParamsToRequest(request, params);
    expect(modified.temperature).toBe(0.3);
    expect(modified.model).toBe(TEST_MODEL);
    expect(modified.input).toBe('hello');
  });
});
