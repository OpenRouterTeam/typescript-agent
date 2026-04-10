import { describe, expect, it } from 'vitest';
import { resolveAsyncFunctions } from '../../src/lib/async-params.js';
import { buildTurnContext } from '../../src/lib/turn-context.js';

describe('buildTurnContext -> resolveAsyncFunctions', () => {
  it('parameter function receives TurnContext with correct numberOfTurns', async () => {
    const turnCtx = buildTurnContext({
      numberOfTurns: 5,
    });
    const result = await resolveAsyncFunctions(
      {
        model: 'gpt-4',
        temperature: (ctx: any) => ctx.numberOfTurns * 0.1,
      } as any,
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
      toolCall: toolCall as any,
    });
    const result = await resolveAsyncFunctions(
      {
        model: (ctx: any) => (ctx.toolCall ? 'gpt-4-turbo' : 'gpt-4'),
      } as any,
      turnCtx,
    );
    expect(result.model).toBe('gpt-4-turbo');
  });
});
