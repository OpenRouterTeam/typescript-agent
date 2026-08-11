import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
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

  it('converts the StandardJSONSchemaV1 trait without inputJsonSchema', () => {
    const schema = toStandardJsonSchema(inputSchema);
    const valibotTool = tool({
      name: 'standard_json_schema',
      inputSchema: schema,
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
  });

  it('falls through when the trait converter throws', () => {
    const schema = {
      ...inputSchema,
      '~standard': {
        ...inputSchema['~standard'],
        jsonSchema: {
          input: () => {
            throw new Error('not convertible');
          },
          output: () => {
            throw new Error('not convertible');
          },
        },
      },
    } satisfies typeof inputSchema & StandardJSONSchemaV1;
    const valibotTool = tool({
      name: 'throwing_standard_json_schema',
      inputSchema: schema,
      execute: () => null,
    });

    expect(() =>
      convertToolsToAPIFormat([
        valibotTool,
      ]),
    ).toThrow('must implement StandardJSONSchemaV1 or provide inputJsonSchema');
  });

  it('accepts explicit inputJsonSchema when the trait converter would throw', () => {
    const schema = {
      ...inputSchema,
      '~standard': {
        ...inputSchema['~standard'],
        jsonSchema: {
          input: () => {
            throw new Error('not convertible');
          },
          output: () => {
            throw new Error('not convertible');
          },
        },
      },
    } satisfies typeof inputSchema & StandardJSONSchemaV1;
    const valibotTool = tool({
      name: 'throwing_standard_json_schema',
      inputSchema: schema,
      inputJsonSchema,
      execute: () => null,
    });

    const [apiTool] = convertToolsToAPIFormat([
      valibotTool,
    ]);
    expect(apiTool).toMatchObject({
      parameters: {
        required: [
          'name',
        ],
      },
    });
  });

  it('prefers explicit inputJsonSchema over the trait', () => {
    let converted = false;
    const schema = {
      ...inputSchema,
      '~standard': {
        ...inputSchema['~standard'],
        jsonSchema: {
          input: () => {
            converted = true;
            return {
              type: 'object',
              title: 'trait',
            };
          },
          output: () => ({
            type: 'object',
          }),
        },
      },
    } satisfies typeof inputSchema & StandardJSONSchemaV1;
    const valibotTool = tool({
      name: 'overridden_standard_json_schema',
      inputSchema: schema,
      inputJsonSchema: {
        type: 'object',
        title: 'explicit',
      },
      execute: () => null,
    });

    const [apiTool] = convertToolsToAPIFormat([
      valibotTool,
    ]);
    expect(apiTool).toMatchObject({
      parameters: {
        title: 'explicit',
      },
    });
    expect(converted).toBe(false);
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

  it('requires raw JSON Schema for non-Zod input validators at runtime', () => {
    const valibotTool = {
      type: 'function',
      function: {
        name: 'valibot_tool',
        inputSchema,
        execute: () => null,
      },
    } as unknown as Tool;

    expect(() =>
      convertToolsToAPIFormat([
        valibotTool,
      ]),
    ).toThrow('must implement StandardJSONSchemaV1 or provide inputJsonSchema');
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

  it('awaits async Standard Schema context validation during execution', async () => {
    const contextSchema: StandardSchemaV1<
      unknown,
      {
        token: string;
      }
    > = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (value) => {
          const token = (
            value as {
              token?: unknown;
            }
          ).token;
          return typeof token === 'string'
            ? {
                value: {
                  token,
                },
              }
            : {
                issues: [
                  {
                    message: 'Expected token',
                    path: [
                      'token',
                    ],
                  },
                ],
              };
        },
        types: undefined,
      },
    };
    const contextTool = tool({
      name: 'async_context',
      inputSchema,
      inputJsonSchema,
      contextSchema,
      execute: (_input, ctx) => ctx!.local.token,
    });
    const store = new ToolContextStore({
      async_context: {
        token: 'secret',
      },
    });

    const result = await executeRegularTool(
      contextTool,
      call('async_context', {
        name: 'luke',
      }),
      context,
      store,
    );
    expect(result.result).toBe('secret');
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
