import { describe, expect, it } from 'vitest';

import {
  createRejectedResult,
  createUnsentResult,
  unsentResultsToAPIFormat,
} from '../../src/lib/conversation-state.js';

describe('Conversation state utilities - distinct result types', () => {
  it('createUnsentResult output has output (value) but no error', () => {
    const result = createUnsentResult('c1', 'search', {
      data: 'found',
    });
    expect(result.output).toEqual({
      data: 'found',
    });
    expect(result).not.toHaveProperty('error');
  });

  it('createRejectedResult output has output: null AND error string', () => {
    const result = createRejectedResult('c1', 'delete');
    expect(result.output).toBeNull();
    expect(result.error).toBe('Tool call rejected by user');
  });

  it('unsentResultsToAPIFormat: success result -> output is JSON.stringify(output)', () => {
    const unsent = createUnsentResult('c1', 'search', {
      data: 'found',
    });
    const formatted = unsentResultsToAPIFormat([
      unsent,
    ]);
    expect(formatted[0]!.output).toBe(
      JSON.stringify({
        data: 'found',
      }),
    );
  });

  it('unsentResultsToAPIFormat: error result -> output is JSON.stringify({ error })', () => {
    const rejected = createRejectedResult('c1', 'delete', 'Not allowed');
    const formatted = unsentResultsToAPIFormat([
      rejected,
    ]);
    expect(formatted[0]!.output).toBe(
      JSON.stringify({
        error: 'Not allowed',
      }),
    );
  });
});
