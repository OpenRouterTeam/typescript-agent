import type * as models from '@openrouter/sdk/models';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import {
  buildNextTurnParamsContext,
  executeNextTurnParamsFunctions,
} from '../../src/lib/next-turn-params.js';
import { tool } from '../../src/lib/tool.js';
import type { ParsedToolCall, Tool } from '../../src/lib/tool-types.js';

function createRequest(overrides?: Partial<models.ResponsesRequest>): models.ResponsesRequest {
  return {
    model: 'openai/gpt-4',
    input: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
    ...overrides,
  } as unknown as models.ResponsesRequest;
}

function createToolCall(name: string, args: unknown): ParsedToolCall<Tool> {
  return {
    id: `call_${name}`,
    name,
    arguments: args,
  } as ParsedToolCall<Tool>;
}

describe('buildNextTurnParamsContext', () => {
  it('extracts all fields from a fully populated request', () => {
    const request = createRequest({
      models: [
        'openai/gpt-4',
        'anthropic/claude',
      ],
      temperature: 0.7,
      maxOutputTokens: 500,
      topP: 0.9,
      topK: 40,
      instructions: 'Be terse',
    } as Partial<models.ResponsesRequest>);

    const context = buildNextTurnParamsContext(request);

    expect(context).toEqual({
      input: request.input,
      model: 'openai/gpt-4',
      models: [
        'openai/gpt-4',
        'anthropic/claude',
      ],
      temperature: 0.7,
      maxOutputTokens: 500,
      topP: 0.9,
      topK: 40,
      instructions: 'Be terse',
    });
  });

  it('applies defaults for missing fields', () => {
    const context = buildNextTurnParamsContext({} as models.ResponsesRequest);

    expect(context).toEqual({
      input: [],
      model: '',
      models: [],
      temperature: null,
      maxOutputTokens: null,
      topP: null,
      topK: undefined,
      instructions: null,
    });
  });
});

describe('executeNextTurnParamsFunctions', () => {
  it('returns an empty object when no tools have nextTurnParams', async () => {
    const plainTool = tool({
      name: 'plain',
      inputSchema: z.object({
        q: z.string(),
      }),
      execute: async () => 'done',
    });

    const result = await executeNextTurnParamsFunctions(
      [
        createToolCall('plain', {
          q: 'x',
        }),
      ],
      [
        plainTool,
      ],
      createRequest(),
    );

    expect(result).toEqual({});
  });

  it('computes parameters from tool call arguments and context', async () => {
    const searchTool = tool({
      name: 'search',
      inputSchema: z.object({
        depth: z.number(),
      }),
      execute: async () => 'done',
      nextTurnParams: {
        temperature: (params) => (params.depth > 3 ? 0.1 : 0.9),
        instructions: (params, context) => `${context.instructions ?? ''} depth=${params.depth}`,
      },
    });

    const result = await executeNextTurnParamsFunctions(
      [
        createToolCall('search', {
          depth: 5,
        }),
      ],
      [
        searchTool,
      ],
      createRequest({
        instructions: 'Base.',
      } as Partial<models.ResponsesRequest>),
    );

    expect(result.temperature).toBe(0.1);
    expect(result.instructions).toBe('Base. depth=5');
  });

  it('composes: later tools see modifications made by earlier tools', async () => {
    const firstTool = tool({
      name: 'first',
      inputSchema: z.object({}),
      execute: async () => 'done',
      nextTurnParams: {
        temperature: () => 0.5,
      },
    });
    const secondTool = tool({
      name: 'second',
      inputSchema: z.object({}),
      execute: async () => 'done',
      nextTurnParams: {
        temperature: (_params, context) => (context.temperature ?? 0) + 0.3,
      },
    });

    const result = await executeNextTurnParamsFunctions(
      [
        createToolCall('first', {}),
        createToolCall('second', {}),
      ],
      [
        firstTool,
        secondTool,
      ],
      createRequest({
        temperature: 0.7,
      } as Partial<models.ResponsesRequest>),
    );

    // first sets 0.5; second sees 0.5 (not the original 0.7) and adds 0.3
    expect(result.temperature).toBeCloseTo(0.8);
  });

  it('awaits async nextTurnParams functions', async () => {
    const asyncTool = tool({
      name: 'async_tool',
      inputSchema: z.object({}),
      execute: async () => 'done',
      nextTurnParams: {
        model: async () => 'openai/gpt-5',
      },
    });

    const result = await executeNextTurnParamsFunctions(
      [
        createToolCall('async_tool', {}),
      ],
      [
        asyncTool,
      ],
      createRequest(),
    );

    expect(result.model).toBe('openai/gpt-5');
  });

  it('runs a tool once per call when it was called multiple times', async () => {
    let invocations = 0;
    const countingTool = tool({
      name: 'counter',
      inputSchema: z.object({}),
      execute: async () => 'done',
      nextTurnParams: {
        maxOutputTokens: () => ++invocations,
      },
    });

    const result = await executeNextTurnParamsFunctions(
      [
        createToolCall('counter', {}),
        createToolCall('counter', {}),
      ],
      [
        countingTool,
      ],
      createRequest(),
    );

    expect(invocations).toBe(2);
    expect(result.maxOutputTokens).toBe(2);
  });

  it('ignores tools that were not called', async () => {
    const calledTool = tool({
      name: 'called',
      inputSchema: z.object({}),
      execute: async () => 'done',
      nextTurnParams: {
        temperature: () => 0.1,
      },
    });
    const uncalledTool = tool({
      name: 'uncalled',
      inputSchema: z.object({}),
      execute: async () => 'done',
      nextTurnParams: {
        temperature: () => 0.9,
      },
    });

    const result = await executeNextTurnParamsFunctions(
      [
        createToolCall('called', {}),
      ],
      [
        calledTool,
        uncalledTool,
      ],
      createRequest(),
    );

    expect(result.temperature).toBe(0.1);
  });

  it('skips server tools entirely', async () => {
    const serverTool = {
      _brand: 'server-tool',
      function: {
        name: 'server_search',
        nextTurnParams: {
          temperature: () => 0.0,
        },
      },
    } as unknown as Tool;

    const result = await executeNextTurnParamsFunctions(
      [
        createToolCall('server_search', {}),
      ],
      [
        serverTool,
      ],
      createRequest({
        temperature: 0.7,
      } as Partial<models.ResponsesRequest>),
    );

    expect(result).toEqual({});
  });

  it('throws a descriptive error when tool call arguments are not an object', async () => {
    const strictTool = tool({
      name: 'strict',
      inputSchema: z.object({}),
      execute: async () => 'done',
      nextTurnParams: {
        temperature: () => 0.5,
      },
    });

    await expect(
      executeNextTurnParamsFunctions(
        [
          createToolCall('strict', [
            'not',
            'an',
            'object',
          ]),
        ],
        [
          strictTool,
        ],
        createRequest(),
      ),
    ).rejects.toThrow('Tool call arguments for strict must be an object, got array');

    await expect(
      executeNextTurnParamsFunctions(
        [
          createToolCall('strict', 'a-string'),
        ],
        [
          strictTool,
        ],
        createRequest(),
      ),
    ).rejects.toThrow('Tool call arguments for strict must be an object, got string');
  });

  it('warns and skips invalid nextTurnParams keys outside production', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const oddTool = tool({
      name: 'odd',
      inputSchema: z.object({}),
      execute: async () => 'done',
      nextTurnParams: {
        bogusKey: () => 42,
        temperature: () => 0.3,
      } as never,
    });

    const result = await executeNextTurnParamsFunctions(
      [
        createToolCall('odd', {}),
      ],
      [
        oddTool,
      ],
      createRequest(),
    );

    expect(result).toEqual({
      temperature: 0.3,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid nextTurnParams key "bogusKey" in tool "odd"'),
    );
    warnSpy.mockRestore();
  });

  it('ignores non-function values in nextTurnParams', async () => {
    const weirdTool = tool({
      name: 'weird',
      inputSchema: z.object({}),
      execute: async () => 'done',
      nextTurnParams: {
        temperature: 0.5,
      } as never,
    });

    const result = await executeNextTurnParamsFunctions(
      [
        createToolCall('weird', {}),
      ],
      [
        weirdTool,
      ],
      createRequest(),
    );

    expect(result).toEqual({});
  });
});
