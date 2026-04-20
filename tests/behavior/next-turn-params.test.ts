import type * as models from '@openrouter/sdk/models';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  applyNextTurnParamsToRequest,
  buildNextTurnParamsContext,
  executeNextTurnParamsFunctions,
} from '../../src/lib/next-turn-params.js';
import { tool } from '../../src/lib/tool.js';
import type { ParsedToolCall, Tool } from '../../src/lib/tool-types.js';
import { makeRequest, TEST_MODEL } from '../test-constants.js';

describe('next-turn params - buildNextTurnParamsContext', () => {
  it('extracts relevant fields from request', () => {
    const request: models.ResponsesRequest = {
      model: TEST_MODEL,
      input: 'hello',
      temperature: 0.7,
      maxOutputTokens: 1000,
    };
    const ctx = buildNextTurnParamsContext(request);
    expect(ctx.model).toBe(TEST_MODEL);
    expect(ctx.input).toBe('hello');
    expect(ctx.temperature).toBe(0.7);
    expect(ctx.maxOutputTokens).toBe(1000);
  });

  it('defaults missing fields to null/empty', () => {
    const request = makeRequest({
      model: undefined,
      input: undefined,
    });
    const ctx = buildNextTurnParamsContext(request);
    expect(ctx.model).toBe('');
    expect(ctx.temperature).toBeNull();
    expect(ctx.maxOutputTokens).toBeNull();
    expect(ctx.models).toEqual([]);
  });
});

describe('next-turn params - executeNextTurnParamsFunctions', () => {
  it('executes temperature function and returns computed value', async () => {
    const t = tool({
      name: 'search',
      inputSchema: z.object({
        query: z.string(),
      }),
      nextTurnParams: {
        temperature: () => 0.2 as number | null,
      },
      execute: async () => ({}),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'search',
      arguments: {
        query: 'test',
      },
    };
    const request = makeRequest({
      model: TEST_MODEL,
      input: 'hello',
    });
    const result = await executeNextTurnParamsFunctions(
      [
        tc,
      ],
      [
        t,
      ],
      request,
    );
    expect(result.temperature).toBe(0.2);
  });

  it('returns empty object when no tools have nextTurnParams', async () => {
    const t = tool({
      name: 'basic',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'basic',
      arguments: {},
    };
    const result = await executeNextTurnParamsFunctions(
      [
        tc,
      ],
      [
        t,
      ],
      makeRequest({}),
    );
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('skips tools not in toolCalls array', async () => {
    const t1 = tool({
      name: 'a',
      inputSchema: z.object({}),
      nextTurnParams: {
        temperature: () => 0.1 as number | null,
      },
      execute: async () => ({}),
    });
    const t2 = tool({
      name: 'b',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'b',
      arguments: {},
    };
    const result = await executeNextTurnParamsFunctions(
      [
        tc,
      ],
      [
        t1,
        t2,
      ],
      makeRequest({}),
    );
    expect(result.temperature).toBeUndefined();
  });

  it('composes functions from multiple tools in order', async () => {
    const t1 = tool({
      name: 'first',
      inputSchema: z.object({}),
      nextTurnParams: {
        temperature: (_p, ctx) => (ctx.temperature ?? 0) + 0.1,
      },
      execute: async () => ({}),
    });
    const t2 = tool({
      name: 'second',
      inputSchema: z.object({}),
      nextTurnParams: {
        temperature: (_p, ctx) => (ctx.temperature ?? 0) + 0.2,
      },
      execute: async () => ({}),
    });
    const tc1: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'first',
      arguments: {},
    };
    const tc2: ParsedToolCall<Tool> = {
      id: 'c2',
      name: 'second',
      arguments: {},
    };
    const request = {
      temperature: 0.5,
    };
    const result = await executeNextTurnParamsFunctions(
      [
        tc1,
        tc2,
      ],
      [
        t1,
        t2,
      ],
      request,
    );
    expect(result.temperature).toBeCloseTo(0.8);
  });
});

describe('next-turn params - applyNextTurnParamsToRequest', () => {
  it('merges computed params into request', () => {
    const request = makeRequest({
      model: TEST_MODEL,
      temperature: 0.7,
      input: 'test',
    });
    const computed = {
      temperature: 0.2 as number | null,
    };
    const result = applyNextTurnParamsToRequest(request, computed);
    expect(result.temperature).toBe(0.2);
    expect(result.model).toBe(TEST_MODEL);
  });

  it('converts null values to undefined for API compatibility', () => {
    const request = makeRequest({
      model: TEST_MODEL,
    });
    const computed = {
      temperature: null,
    };
    const result = applyNextTurnParamsToRequest(request, computed);
    expect(result.temperature).toBeUndefined();
  });

  it('returns new object without mutating original', () => {
    const request = makeRequest({
      model: TEST_MODEL,
      temperature: 0.7,
    });
    const result = applyNextTurnParamsToRequest(request, {
      temperature: 0.2,
    });
    expect(request.temperature).toBe(0.7);
    expect(result.temperature).toBe(0.2);
  });

  it('handles empty computed params', () => {
    const request = makeRequest({
      model: TEST_MODEL,
      temperature: 0.7,
    });
    const result = applyNextTurnParamsToRequest(request, {});
    expect(result.temperature).toBe(0.7);
  });
});
