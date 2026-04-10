import { describe, expect, it } from 'vitest';

import { resolveAsyncFunctions } from '../../src/lib/async-params.js';
import { stepCountIs } from '../../src/lib/stop-conditions.js';

describe('Async resolution + clean API request', () => {
  it('mixed input: static model, function temperature, client-only stopWhen -> three paths verified in one call', async () => {
    const turnCtx = {
      numberOfTurns: 2,
    } as any;

    const result = await resolveAsyncFunctions(
      {
        model: 'gpt-4',
        temperature: (ctx: any) => ctx.numberOfTurns * 0.1,
        stopWhen: stepCountIs(5),
        input: 'hello',
      } as any,
      turnCtx,
    );

    // Static: preserved
    expect(result.model).toBe('gpt-4');
    // Function: resolved
    expect(result.temperature).toBe(0.2);
    // Client-only: stripped
    expect(result).not.toHaveProperty('stopWhen');
    // Static: preserved
    expect(result.input).toBe('hello');
  });
});
