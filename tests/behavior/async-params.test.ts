import { describe, expect, it } from 'vitest';
import { hasAsyncFunctions, resolveAsyncFunctions } from '../../src/lib/async-params.js';
import type { TurnContext } from '../../src/lib/tool-types.js';

const turnCtx: TurnContext = {
  numberOfTurns: 2,
};

describe('async params - resolveAsyncFunctions', () => {
  it('passes through static values unchanged', async () => {
    const input = {
      model: 'gpt-4',
      temperature: 0.7,
      input: 'hi',
    } as any;
    const result = await resolveAsyncFunctions(input, turnCtx);
    expect(result.model).toBe('gpt-4');
    expect(result.temperature).toBe(0.7);
  });

  it('resolves sync function fields with turnContext', async () => {
    const input = {
      model: 'gpt-4',
      temperature: (ctx: TurnContext) => ctx.numberOfTurns * 0.1,
      input: 'test',
    } as any;
    const result = await resolveAsyncFunctions(input, turnCtx);
    expect(result.temperature).toBeCloseTo(0.2);
  });

  it('resolves async function fields with turnContext', async () => {
    const input = {
      model: 'gpt-4',
      temperature: async (ctx: TurnContext) => ctx.numberOfTurns * 0.15,
      input: 'test',
    } as any;
    const result = await resolveAsyncFunctions(input, turnCtx);
    expect(result.temperature).toBeCloseTo(0.3);
  });

  it('strips client-only fields (stopWhen, state, requireApproval, context, etc.)', async () => {
    const input = {
      model: 'gpt-4',
      input: 'test',
      stopWhen: () => true,
      state: {},
      requireApproval: () => false,
      context: {},
    } as any;
    const result = await resolveAsyncFunctions(input, turnCtx);
    expect(result).not.toHaveProperty('stopWhen');
    expect(result).not.toHaveProperty('state');
    expect(result).not.toHaveProperty('requireApproval');
    expect(result).not.toHaveProperty('context');
  });

  it('wraps field resolution errors with field name', async () => {
    const input = {
      model: 'gpt-4',
      temperature: () => {
        throw new Error('compute failed');
      },
      input: 'test',
    } as any;
    await expect(resolveAsyncFunctions(input, turnCtx)).rejects.toThrow(/temperature/);
  });
});

describe('async params - hasAsyncFunctions', () => {
  it('returns true when any field is a function', () => {
    expect(
      hasAsyncFunctions({
        model: 'gpt-4',
        temperature: () => 0.5,
      }),
    ).toBe(true);
  });

  it('returns false when all fields are static values', () => {
    expect(
      hasAsyncFunctions({
        model: 'gpt-4',
        temperature: 0.5,
      }),
    ).toBe(false);
  });

  it('returns false for null input', () => {
    expect(hasAsyncFunctions(null)).toBe(false);
  });

  it('returns false for undefined input', () => {
    expect(hasAsyncFunctions(undefined)).toBe(false);
  });

  it('returns false for non-object input', () => {
    expect(hasAsyncFunctions('string')).toBe(false);
  });

  it('returns true when nested function detected', () => {
    expect(
      hasAsyncFunctions({
        a: 1,
        b: () => 2,
      }),
    ).toBe(true);
  });

  it('returns false for empty object', () => {
    expect(hasAsyncFunctions({})).toBe(false);
  });
});
