import type * as models from '@openrouter/sdk/models';
import { describe, expect, it } from 'vitest';
import {
  appendToMessages,
  createInitialState,
  createRejectedResult,
  createUnsentResult,
  extractTextFromResponse,
  generateConversationId,
  unsentResultsToAPIFormat,
  updateState,
} from '../../src/lib/conversation-state.js';
import { makeResponse } from '../test-constants.js';

describe('conversation state - createInitialState', () => {
  it('creates state with generated id, empty messages, in_progress status', () => {
    const state = createInitialState();
    expect(state.id).toMatch(/^conv_/);
    expect(state.messages).toEqual([]);
    expect(state.status).toBe('in_progress');
    expect(state.createdAt).toBeTypeOf('number');
    expect(state.updatedAt).toBeTypeOf('number');
  });

  it('uses provided custom id', () => {
    const state = createInitialState('custom_123');
    expect(state.id).toBe('custom_123');
  });
});

describe('conversation state - updateState', () => {
  it('merges updates and bumps updatedAt timestamp', () => {
    const state = createInitialState('s1');
    const before = state.updatedAt;
    const updated = updateState(state, {
      status: 'completed',
    });
    expect(updated.status).toBe('completed');
    expect(updated.id).toBe('s1');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('preserves id and createdAt from original state', () => {
    const state = createInitialState('s2');
    const updated = updateState(state, {
      messages: [
        {
          role: 'user',
          content: 'hi',
        },
      ],
    });
    expect(updated.id).toBe('s2');
    expect(updated.createdAt).toBe(state.createdAt);
  });
});

describe('conversation state - appendToMessages', () => {
  it('appends new items to existing array input', () => {
    const current: models.InputsUnion = [
      {
        role: 'user',
        content: 'hello',
      },
    ];
    const result = appendToMessages(current, [
      {
        role: 'assistant',
        content: 'hi',
      },
    ]);
    expect(result).toHaveLength(2);
  });

  it('converts string input to array then appends', () => {
    const result = appendToMessages('hello', [
      {
        role: 'assistant',
        content: 'hi',
      },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty('role', 'user');
  });
});

describe('conversation state - generateConversationId', () => {
  it('returns string starting with conv_', () => {
    const id = generateConversationId();
    expect(id).toMatch(/^conv_/);
  });

  it('generates unique ids on successive calls', () => {
    const ids = new Set(
      Array.from(
        {
          length: 10,
        },
        () => generateConversationId(),
      ),
    );
    expect(ids.size).toBe(10);
  });
});

describe('conversation state - unsent results', () => {
  it('createUnsentResult builds valid result with callId, name, output', () => {
    const result = createUnsentResult('c1', 'test', {
      data: 42,
    });
    expect(result.callId).toBe('c1');
    expect(result.name).toBe('test');
    expect(result.output).toEqual({
      data: 42,
    });
  });

  it('createRejectedResult builds result with error message', () => {
    const result = createRejectedResult('c2', 'test', 'not allowed');
    expect(result.callId).toBe('c2');
    expect(result.output).toBeNull();
    expect(result.error).toBe('not allowed');
  });

  it('createRejectedResult uses default rejection message', () => {
    const result = createRejectedResult('c3', 'test');
    expect(result.error).toContain('rejected');
  });

  it('unsentResultsToAPIFormat converts to FunctionCallOutputItem array', () => {
    const results = [
      createUnsentResult('c1', 'test', {
        data: 1,
      }),
    ];
    const api = unsentResultsToAPIFormat(results);
    expect(api).toHaveLength(1);
    expect(api[0]!.type).toBe('function_call_output');
    expect(api[0]!.callId).toBe('c1');
    expect(typeof api[0]!.output).toBe('string');
  });
});

describe('conversation state - response extraction', () => {
  it('extractTextFromResponse extracts text from message output items', () => {
    const response = makeResponse({
      id: 'r1',
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Hello ',
            },
          ],
        },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'World',
            },
          ],
        },
      ],
      parallel_tool_calls: false,
      status: 'completed',
      usage: null,
      error: null,
      incomplete_details: null,
      created_at: 0,
    });
    expect(extractTextFromResponse(response)).toBe('Hello World');
  });

  it('extractTextFromResponse returns empty string for no output', () => {
    const response = makeResponse({
      id: 'r1',
      output: [],
      parallel_tool_calls: false,
      status: 'completed',
      usage: null,
      error: null,
      incomplete_details: null,
      created_at: 0,
    });
    expect(extractTextFromResponse(response)).toBe('');
  });
});
