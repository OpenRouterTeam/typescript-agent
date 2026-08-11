import type * as models from '@openrouter/sdk/models';
import { describe, expect, it } from 'vitest';
import { buildTurnContext, normalizeInputToArray } from '../../src/lib/turn-context.js';

describe('buildTurnContext', () => {
  it('builds a minimal context with only numberOfTurns', () => {
    const context = buildTurnContext({
      numberOfTurns: 0,
    });

    expect(context.numberOfTurns).toBe(0);
    expect(context.toolCall).toBeUndefined();
    expect(context.turnRequest).toBeUndefined();
  });

  it('includes the tool call when provided', () => {
    const toolCall = {
      type: 'function_call',
      callId: 'call_1',
      name: 'search',
      arguments: '{}',
      id: 'call_1',
    } as models.FunctionCallItem;

    const context = buildTurnContext({
      numberOfTurns: 2,
      toolCall,
    });

    expect(context.numberOfTurns).toBe(2);
    expect(context.toolCall).toBe(toolCall);
    expect(context.turnRequest).toBeUndefined();
  });

  it('includes the turn request when provided', () => {
    const turnRequest = {
      model: 'openai/gpt-4',
      input: [],
    } as unknown as models.ResponsesRequest;

    const context = buildTurnContext({
      numberOfTurns: 1,
      turnRequest,
    });

    expect(context.turnRequest).toBe(turnRequest);
  });

  it('includes both toolCall and turnRequest together', () => {
    const toolCall = {
      type: 'function_call',
      callId: 'call_2',
      name: 'browse',
      arguments: '{}',
      id: 'call_2',
    } as models.FunctionCallItem;
    const turnRequest = {
      model: 'openai/gpt-4',
    } as models.ResponsesRequest;

    const context = buildTurnContext({
      numberOfTurns: 3,
      toolCall,
      turnRequest,
    });

    expect(context).toEqual({
      numberOfTurns: 3,
      toolCall,
      turnRequest,
    });
  });
});

describe('normalizeInputToArray', () => {
  it('converts string input to a single user message', () => {
    const result = normalizeInputToArray('Hello!');

    expect(result).toEqual([
      {
        role: 'user',
        content: 'Hello!',
      },
    ]);
  });

  it('passes array input through unchanged (same reference)', () => {
    const input = [
      {
        role: 'user',
        content: 'hi',
      },
      {
        role: 'assistant',
        content: 'hello',
      },
    ] as unknown as models.InputsUnion;

    const result = normalizeInputToArray(input);

    expect(result).toBe(input);
  });

  it('handles empty string input', () => {
    const result = normalizeInputToArray('');

    expect(result).toEqual([
      {
        role: 'user',
        content: '',
      },
    ]);
  });
});
