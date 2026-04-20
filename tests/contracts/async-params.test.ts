import { describe, expect, it } from 'vitest';

import { resolveAsyncFunctions } from '../../src/lib/async-params.js';
import { makeCallModelInput, makeTurnContext, TEST_MODEL } from '../test-constants.js';

describe('resolveAsyncFunctions - three field types handled distinctly', () => {
  const turnCtx = makeTurnContext({
    numberOfTurns: 2,
  });

  it('static values (model, temperature as literals) -> passed through unchanged', async () => {
    const result = await resolveAsyncFunctions(
      makeCallModelInput({
        model: TEST_MODEL,
        temperature: 0.7,
      }),
      turnCtx,
    );
    expect(result.model).toBe(TEST_MODEL);
    expect(result.temperature).toBe(0.7);
  });

  it('function values -> resolved by calling with context, result stored', async () => {
    const result = await resolveAsyncFunctions(
      makeCallModelInput({
        temperature: (ctx: { numberOfTurns: number }) => ctx.numberOfTurns * 0.1,
      }),
      turnCtx,
    );
    expect(result.temperature).toBe(0.2);
  });

  it('client-only fields (stopWhen, state, requireApproval, context, onTurnStart, onTurnEnd) -> stripped entirely', async () => {
    const result = await resolveAsyncFunctions(
      makeCallModelInput({
        model: TEST_MODEL,
        stopWhen: () => true,
        state: {
          get: () => null,
        },
        requireApproval: () => false,
        context: {
          shared: {},
        },
        onTurnStart: () => {},
        onTurnEnd: () => {},
      }),
      turnCtx,
    );
    expect(result).not.toHaveProperty('stopWhen');
    expect(result).not.toHaveProperty('state');
    expect(result).not.toHaveProperty('requireApproval');
    expect(result).not.toHaveProperty('context');
    expect(result).not.toHaveProperty('onTurnStart');
    expect(result).not.toHaveProperty('onTurnEnd');
    expect(result.model).toBe(TEST_MODEL);
  });

  it('tools field -> preserved (exception to client-only stripping)', async () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'test',
        },
      },
    ];
    const result = await resolveAsyncFunctions(
      makeCallModelInput({
        model: TEST_MODEL,
        tools,
      }),
      turnCtx,
    );
    expect(result).toHaveProperty('tools');
  });

  it('function error -> wraps with field name context', async () => {
    await expect(
      resolveAsyncFunctions(
        makeCallModelInput({
          temperature: () => {
            throw new Error('boom');
          },
        }),
        turnCtx,
      ),
    ).rejects.toThrow('Failed to resolve async function for field "temperature"');
  });

  it('mix of static + function + client-only in one call -> all handled correctly', async () => {
    const result = await resolveAsyncFunctions(
      makeCallModelInput({
        model: TEST_MODEL,
        temperature: (ctx: { numberOfTurns: number }) => ctx.numberOfTurns * 0.1,
        stopWhen: () => true,
        input: 'hello',
      }),
      turnCtx,
    );
    expect(result.model).toBe(TEST_MODEL);
    expect(result.temperature).toBe(0.2);
    expect(result).not.toHaveProperty('stopWhen');
    expect(result.input).toBe('hello');
  });
});
