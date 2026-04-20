import { describe, expect, it } from 'vitest';
import { resolveAsyncFunctions } from '../../src/lib/async-params.js';
import { buildTurnContext } from '../../src/lib/turn-context.js';
import { makeCallModelInput, TEST_MODEL, TEST_MODEL_ALT } from '../test-constants.js';

describe('buildTurnContext -> resolveAsyncFunctions', () => {
  it('parameter function receives TurnContext with correct numberOfTurns', async () => {
    const turnCtx = buildTurnContext({
      numberOfTurns: 5,
    });
    const result = await resolveAsyncFunctions(
      makeCallModelInput({
        model: TEST_MODEL,
        temperature: (ctx: { numberOfTurns: number }) => ctx.numberOfTurns * 0.1,
      }),
      turnCtx,
    );
    expect(result.temperature).toBe(0.5);
  });

  it('parameter function can read toolCall from context when provided', async () => {
    const toolCall = {
      id: 'tc_1',
      name: 'search',
      arguments: {
        q: 'test',
      },
    };
    const turnCtx = buildTurnContext({
      numberOfTurns: 1,
      toolCall: toolCall,
    });
    const result = await resolveAsyncFunctions(
      makeCallModelInput({
        model: (ctx: { toolCall?: unknown }) => (ctx.toolCall ? TEST_MODEL_ALT : TEST_MODEL),
      }),
      turnCtx,
    );
    expect(result.model).toBe(TEST_MODEL_ALT);
  });
});
