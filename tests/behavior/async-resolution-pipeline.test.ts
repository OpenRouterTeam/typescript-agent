import { describe, expect, it } from 'vitest';

import { resolveAsyncFunctions } from '../../src/lib/async-params.js';
import { stepCountIs } from '../../src/lib/stop-conditions.js';
import { makeCallModelInput, makeTurnContext, TEST_MODEL } from '../test-constants.js';

describe('Async resolution + clean API request', () => {
  it('mixed input: static model, function temperature, client-only stopWhen -> three paths verified in one call', async () => {
    const turnCtx = makeTurnContext({
      numberOfTurns: 2,
    });

    const result = await resolveAsyncFunctions(
      makeCallModelInput({
        model: TEST_MODEL,
        temperature: (ctx: { numberOfTurns: number }) => ctx.numberOfTurns * 0.1,
        stopWhen: stepCountIs(5),
        input: 'hello',
      }),
      turnCtx,
    );

    // Static: preserved
    expect(result.model).toBe(TEST_MODEL);
    // Function: resolved
    expect(result.temperature).toBe(0.2);
    // Client-only: stripped
    expect(result).not.toHaveProperty('stopWhen');
    // Static: preserved
    expect(result.input).toBe('hello');
  });
});
