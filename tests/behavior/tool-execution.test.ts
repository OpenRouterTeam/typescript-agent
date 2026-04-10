import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import {
  convertToolsToAPIFormat,
  convertZodToJsonSchema,
  executeGeneratorTool,
  executeRegularTool,
  executeTool,
  findToolByName,
  formatToolExecutionError,
  formatToolResultForModel,
  parseToolCallArguments,
  sanitizeJsonSchema,
  validateToolInput,
  validateToolOutput,
} from '../../src/lib/tool-executor.js';
import type { ParsedToolCall, Tool, TurnContext } from '../../src/lib/tool-types.js';

const turnCtx: TurnContext = {
  numberOfTurns: 1,
};

describe('tool execution - input validation', () => {
  const schema = z.object({
    name: z.string(),
    age: z.number(),
  });

  it('validateToolInput with valid args returns validated data', () => {
    const result = validateToolInput(schema, {
      name: 'Alice',
      age: 30,
    });
    expect(result).toEqual({
      name: 'Alice',
      age: 30,
    });
  });

  it('validateToolInput with invalid args throws ZodError', () => {
    expect(() =>
      validateToolInput(schema, {
        name: 123,
      }),
    ).toThrow();
  });

  it('validateToolOutput with valid result returns validated data', () => {
    const outSchema = z.object({
      sum: z.number(),
    });
    const result = validateToolOutput(outSchema, {
      sum: 42,
    });
    expect(result).toEqual({
      sum: 42,
    });
  });

  it('validateToolOutput with invalid result throws ZodError', () => {
    const outSchema = z.object({
      sum: z.number(),
    });
    expect(() =>
      validateToolOutput(outSchema, {
        sum: 'not a number',
      }),
    ).toThrow();
  });
});

describe('tool execution - argument parsing', () => {
  it('parseToolCallArguments with valid JSON returns parsed object', () => {
    expect(parseToolCallArguments('{"a":1}')).toEqual({
      a: 1,
    });
  });

  it('parseToolCallArguments with empty string returns empty object', () => {
    expect(parseToolCallArguments('')).toEqual({});
  });

  it('parseToolCallArguments with whitespace-only string returns empty object', () => {
    expect(parseToolCallArguments('   ')).toEqual({});
  });

  it('parseToolCallArguments with invalid JSON throws descriptive error', () => {
    expect(() => parseToolCallArguments('bad json')).toThrow(/failed to parse/i);
  });
});

describe('tool execution - executeRegularTool', () => {
  it('executes and returns { toolCallId, toolName, result }', async () => {
    const t = tool({
      name: 'add',
      inputSchema: z.object({
        a: z.number(),
        b: z.number(),
      }),
      execute: async (params) => ({
        sum: params.a + params.b,
      }),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'call_1',
      name: 'add',
      arguments: {
        a: 2,
        b: 3,
      },
    };
    const result = await executeRegularTool(t, tc, turnCtx);
    expect(result.toolCallId).toBe('call_1');
    expect(result.toolName).toBe('add');
    expect(result.result).toEqual({
      sum: 5,
    });
    expect(result.error).toBeUndefined();
  });

  it('returns error when input validation fails', async () => {
    const t = tool({
      name: 'strict',
      inputSchema: z.object({
        x: z.number(),
      }),
      execute: async () => ({
        ok: true,
      }),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'call_2',
      name: 'strict',
      arguments: {
        x: 'not_num',
      },
    };
    const result = await executeRegularTool(t, tc, turnCtx);
    expect(result.error).toBeDefined();
    expect(result.result).toBeNull();
  });

  it('validates output when outputSchema provided', async () => {
    const t = tool({
      name: 'typed_out',
      inputSchema: z.object({}),
      outputSchema: z.object({
        value: z.number(),
      }),
      execute: async () => ({
        value: 42,
      }),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'call_3',
      name: 'typed_out',
      arguments: {},
    };
    const result = await executeRegularTool(t, tc, turnCtx);
    expect(result.result).toEqual({
      value: 42,
    });
  });

  it('returns raw result when no outputSchema', async () => {
    const t = tool({
      name: 'raw_out',
      inputSchema: z.object({}),
      execute: async () => ({
        anything: 'goes',
      }),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'call_4',
      name: 'raw_out',
      arguments: {},
    };
    const result = await executeRegularTool(t, tc, turnCtx);
    expect(result.result).toEqual({
      anything: 'goes',
    });
  });

  it('catches thrown error and returns { error, result: null }', async () => {
    const t = tool({
      name: 'failing',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('boom');
      },
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'call_5',
      name: 'failing',
      arguments: {},
    };
    const result = await executeRegularTool(t, tc, turnCtx);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toBe('boom');
    expect(result.result).toBeNull();
  });
});

describe('tool execution - executeGeneratorTool', () => {
  it('yields events then returns final result with preliminaryResults', async () => {
    const t = tool({
      name: 'gen',
      inputSchema: z.object({}),
      eventSchema: z.object({
        progress: z.number(),
      }),
      outputSchema: z.object({
        result: z.string(),
      }),
      execute: async function* () {
        yield {
          progress: 50,
        };
        yield {
          progress: 100,
        };
        return {
          result: 'done',
        };
      },
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'call_6',
      name: 'gen',
      arguments: {},
    };
    const result = await executeGeneratorTool(t, tc, turnCtx);
    expect(result.result).toEqual({
      result: 'done',
    });
    expect(result.preliminaryResults).toHaveLength(2);
  });

  it('calls onPreliminaryResult for each yielded event', async () => {
    const events: unknown[] = [];
    const t = tool({
      name: 'gen_cb',
      inputSchema: z.object({}),
      eventSchema: z.object({
        step: z.number(),
      }),
      outputSchema: z.object({
        done: z.boolean(),
      }),
      execute: async function* () {
        yield {
          step: 1,
        };
        yield {
          step: 2,
        };
        return {
          done: true,
        };
      },
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'call_7',
      name: 'gen_cb',
      arguments: {},
    };
    await executeGeneratorTool(t, tc, turnCtx, (_id, ev) => events.push(ev));
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      step: 1,
    });
  });

  it('returns final result with empty preliminaryResults when only return value', async () => {
    const t = tool({
      name: 'gen_ret',
      inputSchema: z.object({}),
      eventSchema: z.object({
        ev: z.string(),
      }),
      outputSchema: z.object({
        val: z.number(),
      }),
      execute: async function* () {
        return {
          val: 42,
        };
      },
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'call_8',
      name: 'gen_ret',
      arguments: {},
    };
    const result = await executeGeneratorTool(t, tc, turnCtx);
    expect(result.result).toEqual({
      val: 42,
    });
    expect(result.preliminaryResults).toHaveLength(0);
  });

  it('returns error when generator throws', async () => {
    const t = tool({
      name: 'gen_err',
      inputSchema: z.object({}),
      eventSchema: z.object({
        ev: z.string(),
      }),
      outputSchema: z.object({
        val: z.number(),
      }),
      execute: async function* () {
        throw new Error('gen boom');
      },
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'call_9',
      name: 'gen_err',
      arguments: {},
    };
    const result = await executeGeneratorTool(t, tc, turnCtx);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toBe('gen boom');
  });

  it('returns error when generator emits nothing', async () => {
    const t = tool({
      name: 'gen_empty',
      inputSchema: z.object({}),
      eventSchema: z.object({
        ev: z.string(),
      }),
      outputSchema: z.object({
        val: z.number(),
      }),
      execute: async function* () {
        // yields nothing, returns nothing
      },
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'call_10',
      name: 'gen_empty',
      arguments: {},
    };
    const result = await executeGeneratorTool(t, tc, turnCtx);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('without emitting');
  });
});

describe('tool execution - executeTool dispatch', () => {
  it('dispatches regular tool to executeRegularTool', async () => {
    const t = tool({
      name: 'reg',
      inputSchema: z.object({
        x: z.number(),
      }),
      execute: async (p) => ({
        doubled: p.x * 2,
      }),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'reg',
      arguments: {
        x: 5,
      },
    };
    const result = await executeTool(t, tc, turnCtx);
    expect(result.result).toEqual({
      doubled: 10,
    });
  });

  it('dispatches generator tool to executeGeneratorTool', async () => {
    const t = tool({
      name: 'gen',
      inputSchema: z.object({}),
      eventSchema: z.object({
        ev: z.number(),
      }),
      outputSchema: z.object({
        done: z.boolean(),
      }),
      execute: async function* () {
        yield {
          ev: 1,
        };
        return {
          done: true,
        };
      },
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'c2',
      name: 'gen',
      arguments: {},
    };
    const result = await executeTool(t, tc, turnCtx);
    expect(result.result).toEqual({
      done: true,
    });
    expect(result.preliminaryResults).toHaveLength(1);
  });

  it('throws for manual tool (no execute function)', async () => {
    const t = tool({
      name: 'manual',
      inputSchema: z.object({}),
      execute: false,
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'c3',
      name: 'manual',
      arguments: {},
    };
    await expect(executeTool(t, tc, turnCtx)).rejects.toThrow(/no execute function/i);
  });
});

describe('tool execution - utility functions', () => {
  it('findToolByName returns matching tool', () => {
    const t = tool({
      name: 'x',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    expect(
      findToolByName(
        [
          t,
        ],
        'x',
      ),
    ).toBe(t);
  });

  it('findToolByName returns undefined for missing tool', () => {
    const t = tool({
      name: 'x',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    expect(
      findToolByName(
        [
          t,
        ],
        'missing',
      ),
    ).toBeUndefined();
  });

  it('formatToolResultForModel with success returns JSON of result', () => {
    const json = formatToolResultForModel({
      toolCallId: 'c1',
      toolName: 'test',
      result: {
        data: 42,
      },
    });
    expect(JSON.parse(json)).toEqual({
      data: 42,
    });
  });

  it('formatToolResultForModel with error returns JSON with error message', () => {
    const json = formatToolResultForModel({
      toolCallId: 'c2',
      toolName: 'test',
      result: null,
      error: new Error('fail'),
    });
    const parsed = JSON.parse(json);
    expect(parsed.error).toBe('fail');
    expect(parsed.toolName).toBe('test');
  });

  it('formatToolExecutionError with ZodError includes validation details', () => {
    try {
      z.parse(
        z.object({
          x: z.number(),
        }),
        {
          x: 'bad',
        },
      );
    } catch (e) {
      const tc: ParsedToolCall<Tool> = {
        id: 'c3',
        name: 'myTool',
        arguments: {},
      };
      const msg = formatToolExecutionError(e as Error, tc);
      expect(msg).toContain('myTool');
      expect(msg).toContain('validation error');
    }
  });

  it('formatToolExecutionError with generic Error includes message', () => {
    const tc: ParsedToolCall<Tool> = {
      id: 'c4',
      name: 'myTool',
      arguments: {},
    };
    const msg = formatToolExecutionError(new Error('something went wrong'), tc);
    expect(msg).toContain('myTool');
    expect(msg).toContain('something went wrong');
  });

  it('convertToolsToAPIFormat returns correct API shape array', () => {
    const t = tool({
      name: 'api_tool',
      description: 'Does stuff',
      inputSchema: z.object({
        x: z.number(),
      }),
      execute: async () => ({}),
    });
    const apiTools = convertToolsToAPIFormat([
      t,
    ]);
    expect(apiTools).toHaveLength(1);
    expect(apiTools[0]!.type).toBe('function');
    expect(apiTools[0]!.name).toBe('api_tool');
    expect(apiTools[0]!.description).toBe('Does stuff');
    expect(apiTools[0]!.parameters).toBeDefined();
  });

  it('convertZodToJsonSchema produces valid JSON schema from Zod', () => {
    const schema = z.object({
      x: z.number(),
      y: z.string(),
    });
    const jsonSchema = convertZodToJsonSchema(schema);
    expect(jsonSchema).toHaveProperty('type', 'object');
    expect(jsonSchema).toHaveProperty('properties');
  });

  it('sanitizeJsonSchema removes ~prefixed keys recursively', () => {
    const input = {
      type: 'object',
      '~standard': {
        meta: true,
      },
      properties: {
        x: {
          type: 'number',
          '~standard': {},
        },
      },
    };
    const result = sanitizeJsonSchema(input);
    expect(result).not.toHaveProperty('~standard');
    expect((result as Record<string, unknown>).type).toBe('object');
  });

  it('sanitizeJsonSchema handles primitives, null, arrays', () => {
    expect(sanitizeJsonSchema(null)).toBeNull();
    expect(sanitizeJsonSchema(42)).toBe(42);
    expect(
      sanitizeJsonSchema([
        {
          '~meta': 1,
          val: 2,
        },
      ]),
    ).toEqual([
      {
        val: 2,
      },
    ]);
  });
});
