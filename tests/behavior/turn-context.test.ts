import { describe, expect, it } from 'vitest';
import { buildTurnContext, normalizeInputToArray } from '../../src/lib/turn-context.js';

describe('turn context - buildTurnContext', () => {
  it('sets numberOfTurns from options', () => {
    const ctx = buildTurnContext({
      numberOfTurns: 3,
    });
    expect(ctx.numberOfTurns).toBe(3);
  });

  it('includes toolCall when provided', () => {
    const toolCall = {
      type: 'function_call' as const,
      callId: 'c1',
      name: 'test',
      arguments: '{}',
      id: 'c1',
      status: 'completed' as const,
    };
    const ctx = buildTurnContext({
      numberOfTurns: 1,
      toolCall,
    });
    expect(ctx.toolCall).toBe(toolCall);
  });

  it('includes turnRequest when provided', () => {
    const request = {
      model: 'gpt-4',
      input: 'hello',
    } as any;
    const ctx = buildTurnContext({
      numberOfTurns: 1,
      turnRequest: request,
    });
    expect(ctx.turnRequest).toBe(request);
  });

  it('omits toolCall and turnRequest when not provided', () => {
    const ctx = buildTurnContext({
      numberOfTurns: 0,
    });
    expect(ctx).not.toHaveProperty('toolCall');
    expect(ctx).not.toHaveProperty('turnRequest');
  });
});

describe('turn context - normalizeInputToArray', () => {
  it('converts string input to array with user message', () => {
    const result = normalizeInputToArray('Hello!');
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('role', 'user');
    expect(result[0]).toHaveProperty('content', 'Hello!');
  });

  it('returns array input as-is', () => {
    const input = [
      {
        role: 'user' as const,
        content: 'hi',
      },
    ];
    const result = normalizeInputToArray(input);
    expect(result).toBe(input);
  });
});
