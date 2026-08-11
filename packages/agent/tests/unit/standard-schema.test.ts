import type { StandardSchemaV1 } from '@standard-schema/spec';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import { buildToolExecuteContext, ToolContextStore } from '../../src/lib/tool-context.js';
import {
  convertToolsToAPIFormat,
  executeGeneratorTool,
  executeRegularTool,
  formatToolExecutionError,
} from '../../src/lib/tool-executor.js';
import type { ParsedToolCall, Tool, TurnContext } from '../../src/lib/tool-types.js';

const context: TurnContext = {
  numberOfTurns: 1,
};

const inputSchema = v.object({
  name: v.pipe(
    v.string(),
    v.transform((name) => name.toUpperCase()),
  ),
});
const outputSchema = v.object({
  greeting: v.string(),
});
const inputJsonSchema = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
    },
  },
  required: [
    'name',
  ],
  '~standard': {
    vendor: 'remove-me',
  },
};

function call(name: string, args: unknown): ParsedToolCall<Tool> {
  return {
    id: 'call-1',
    name,
    arguments: args,
  };
}

describe('Standard Schema tool support', () => {
  it('keeps Zod validation and JSON Schema generation unchanged', async () => {
    const zodTool = tool({
      name: 'zod_tool',
      inputSchema: z.object({
        value: z.string(),
      }),
      outputSchema: z.object({
        length: z.number(),
      }),
      execute: ({ value }) => ({
        length: value.length,
      }),
    });

    const result = await executeRegularTool(
      zodTool,
      call('zod_tool', {
        value: 'abc',
      }),
      context,
    );
    const [apiTool] = convertToolsToAPIFormat([
      zodTool,
    ]);

    expect(result.result).toEqual({
      length: 3,
    });
    expect(apiTool).toMatchObject({
      type: 'function',
      parameters: {
        type: 'object',
        required: [
          'value',
        ],
      },
    });
  });

  it('validates and transforms Valibot input and output', async () => {
    const valibotTool = tool({
      name: 'valibot_tool',
      inputSchema,
      inputJsonSchema,
      outputSchema,
      execute: ({ name }) => ({
        greeting: `Hello ${name}`,
      }),
    });

    const result = await executeRegularTool(
      valibotTool,
      call('valibot_tool', {
        name: 'luke',
      }),
      context,
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      greeting: 'Hello LUKE',
    });
  });

  it('maps Standard Schema issues into existing validation errors', async () => {
    const valibotTool = tool({
      name: 'valibot_tool',
      inputSchema,
      inputJsonSchema,
      execute: () => null,
    });

    const result = await executeRegularTool(
      valibotTool,
      call('valibot_tool', {
        name: 123,
      }),
      context,
    );

    expect(result.error).toBeDefined();
    expect(formatToolExecutionError(result.error!, call('valibot_tool', {}))).toContain(
      '"path": "name"',
    );
  });

  it('uses and sanitizes the explicit JSON Schema escape hatch', () => {
    const valibotTool = tool({
      name: 'valibot_tool',
      inputSchema,
      inputJsonSchema,
      execute: () => null,
    });

    const [apiTool] = convertToolsToAPIFormat([
      valibotTool,
    ]);
    expect(apiTool).toMatchObject({
      parameters: {
        type: 'object',
        required: [
          'name',
        ],
      },
    });
    expect(
      (
        apiTool as {
          parameters: Record<string, unknown>;
        }
      ).parameters,
    ).not.toHaveProperty('~standard');
  });

  it('requires raw JSON Schema for non-Zod input validators', () => {
    const valibotTool = tool({
      name: 'valibot_tool',
      inputSchema,
      execute: () => null,
    });

    expect(() =>
      convertToolsToAPIFormat([
        valibotTool,
      ]),
    ).toThrow('requires inputJsonSchema');
  });

  it('awaits async Standard Schema validation', async () => {
    const asyncSchema: StandardSchemaV1<string, number> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (value) =>
          typeof value === 'string'
            ? {
                value: value.length,
              }
            : {
                issues: [
                  {
                    message: 'Expected string',
                  },
                ],
              },
        types: undefined,
      },
    };

    const asyncTool = tool({
      name: 'async_validator',
      inputSchema: asyncSchema,
      inputJsonSchema: {
        type: 'string',
      },
      execute: (length) => length * 2,
    });

    const result = await executeRegularTool(asyncTool, call('async_validator', 'hello'), context);
    expect(result.result).toBe(10);
  });

  it('rejects invalid output with Standard Schema issues', async () => {
    const invalidOutputTool = tool({
      name: 'invalid_output',
      inputSchema,
      inputJsonSchema,
      outputSchema,
      execute: () => ({
        greeting: 123 as unknown as string,
      }),
    });

    const result = await executeRegularTool(
      invalidOutputTool,
      call('invalid_output', {
        name: 'luke',
      }),
      context,
    );
    expect(result.error?.message).toContain('Invalid type');
  });

  it('validates and updates Standard Schema context', () => {
    const store = new ToolContextStore({
      standard: {
        token: 'initial',
      },
    });
    const ctx = buildToolExecuteContext<
      'standard',
      {
        token: string;
      }
    >(
      context,
      store,
      'standard',
      v.object({
        token: v.string(),
      }),
    );

    ctx.setContext({
      token: 'updated',
    });
    expect(ctx.local).toEqual({
      token: 'updated',
    });
    expect(() =>
      ctx.setContext({
        token: 123 as unknown as string,
      }),
    ).toThrow('Invalid type');
  });

  it('validates generator events through Standard Schema', async () => {
    const generator = tool({
      name: 'generator',
      inputSchema,
      inputJsonSchema,
      eventSchema: v.object({
        progress: v.number(),
      }),
      outputSchema,
      execute: async function* ({ name }) {
        yield {
          progress: 1,
        };
        return {
          greeting: `Hello ${name}`,
        };
      },
    });

    const result = await executeGeneratorTool(
      generator,
      call('generator', {
        name: 'luke',
      }),
      context,
    );
    expect(result.preliminaryResults).toEqual([
      {
        progress: 1,
      },
    ]);
    expect(result.result).toEqual({
      greeting: 'Hello LUKE',
    });
  });
});
