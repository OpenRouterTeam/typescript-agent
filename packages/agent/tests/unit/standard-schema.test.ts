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
  executeTool,
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

  it('rejects thenable-returning validators in synchronous context mutation', async () => {
    const thenableSchema: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        // A custom thenable (not a Promise instance) must still be rejected.
        validate: () => ({
          // biome-ignore lint/suspicious/noThenProperty: intentionally testing thenable rejection
          then: (resolve: (result: { value: unknown }) => void) =>
            resolve({
              value: {},
            }),
        }),
        types: undefined,
      },
    };
    const store = new ToolContextStore({
      thenable: {
        token: 'initial',
      },
    });
    const ctx = buildToolExecuteContext(context, store, 'thenable', thenableSchema, undefined, {
      contextValidated: true,
    });

    expect(() =>
      ctx.setContext({
        token: 'updated',
      }),
    ).toThrow('Async Standard Schema validators are not supported');

    // The same validator is fine on the async execution path.
    const asyncTool = tool({
      name: 'thenable_tool',
      inputSchema: thenableSchema,
      inputJsonSchema: {
        type: 'object',
      },
      execute: () => 'ok',
    });
    const result = await executeRegularTool(asyncTool, call('thenable_tool', {}), context);
    expect(result.result).toBe('ok');
  });

  it('filters unknown keys and stores raw values on Standard Schema context updates', () => {
    const store = new ToolContextStore({
      standard: {
        count: 1,
      },
    });
    const ctx = buildToolExecuteContext<
      'standard',
      {
        count: number;
      }
    >(
      context,
      store,
      'standard',
      v.object({
        count: v.pipe(
          v.number(),
          v.transform((count) => count * 2),
        ),
      }),
    );

    ctx.setContext({
      count: 5,
      junk: 'dropped',
    } as unknown as {
      count: number;
    });
    // Raw caller-supplied value is stored (Zod parity) — storing the
    // transform's output would poison later merged validations.
    expect(ctx.local).toEqual({
      count: 5,
    });
  });

  it('keeps context usable after updates with a type-changing validator', async () => {
    const contextSchema = v.object({
      n: v.pipe(v.string(), v.transform(Number)),
    });
    const store = new ToolContextStore({
      convert: {
        n: '5',
      },
    });
    const ctx = buildToolExecuteContext<
      'convert',
      {
        n: number;
      }
    >(context, store, 'convert', contextSchema);
    ctx.setContext({
      n: '7',
    } as unknown as {
      n: number;
    });

    const contextTool = tool({
      name: 'convert',
      inputSchema,
      inputJsonSchema,
      contextSchema,
      execute: (_input, execCtx) => execCtx!.local.n,
    });
    const result = await executeRegularTool(
      contextTool,
      call('convert', {
        name: 'luke',
      }),
      context,
      store,
    );
    expect(result.error).toBeUndefined();
    // Context values are validated but never transformed (raw storage).
    expect(result.result).toBe('7');
  });

  it('filters prototype-named keys from context updates', () => {
    const zodStore = new ToolContextStore({
      zod: {
        token: 'a',
      },
    });
    const zodCtx = buildToolExecuteContext<
      'zod',
      {
        token: string;
      }
    >(
      context,
      zodStore,
      'zod',
      z.object({
        token: z.string(),
      }),
    );
    zodCtx.setContext({
      constructor: 'sneaky',
      token: 'b',
    } as unknown as {
      token: string;
    });
    expect(zodCtx.local).toEqual({
      token: 'b',
    });

    const standardStore = new ToolContextStore({
      standard: {
        token: 'a',
      },
    });
    const standardCtx = buildToolExecuteContext<
      'standard',
      {
        token: string;
      }
    >(
      context,
      standardStore,
      'standard',
      v.object({
        token: v.string(),
      }),
    );
    standardCtx.setContext({
      toString: 'sneaky',
      token: 'b',
    } as unknown as {
      token: string;
    });
    expect(standardCtx.local).toEqual({
      token: 'b',
    });
  });

  it('prefers an explicit inputJsonSchema for Zod tools too', () => {
    const zodTool = tool({
      name: 'zod_explicit',
      inputSchema: z.object({
        value: z.string(),
      }),
      inputJsonSchema: {
        type: 'object',
        title: 'explicit',
      },
      execute: () => null,
    });

    const [apiTool] = convertToolsToAPIFormat([
      zodTool,
    ]);
    expect(apiTool).toMatchObject({
      parameters: {
        title: 'explicit',
      },
    });
  });

  it('reports a unified tool failure with no error value as an error', async () => {
    const failing = tool({
      name: 'failing_unified',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      run: () => {
        throw undefined;
      },
    });

    const result = await executeTool(failing, call('failing_unified', {}), context);
    expect(result && 'error' in result && result.error).toBeInstanceOf(Error);
  });
});
