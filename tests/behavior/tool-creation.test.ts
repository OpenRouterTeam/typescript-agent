import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import { ToolType } from '../../src/lib/tool-types.js';

// Tests 1-9: Tool creation via tool() factory

describe('tool creation - tool() factory', () => {
  it('regular tool returns full shape: type, name, inputSchema, execute, description, outputSchema', () => {
    const t = tool({
      name: 'greet',
      description: 'Say hello',
      inputSchema: z.object({
        name: z.string(),
      }),
      outputSchema: z.object({
        greeting: z.string(),
      }),
      execute: async (params) => ({
        greeting: `Hi ${params.name}`,
      }),
    });

    expect(t.type).toBe(ToolType.Function);
    expect(t.function.name).toBe('greet');
    expect(t.function.description).toBe('Say hello');
    expect(t.function.inputSchema).toBeDefined();
    expect(t.function.outputSchema).toBeDefined();
    expect(t.function.execute).toBeTypeOf('function');
  });

  it('generator tool with eventSchema returns tool with eventSchema + outputSchema + execute', () => {
    const t = tool({
      name: 'stream_tool',
      inputSchema: z.object({
        query: z.string(),
      }),
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
        return {
          result: 'done',
        };
      },
    });

    expect(t.type).toBe(ToolType.Function);
    expect(t.function.name).toBe('stream_tool');
    expect(t.function.eventSchema).toBeDefined();
    expect(t.function.outputSchema).toBeDefined();
    expect(t.function.execute).toBeTypeOf('function');
  });

  it('manual tool (execute: false) returns tool with no execute, no outputSchema, no eventSchema', () => {
    const t = tool({
      name: 'manual',
      description: 'Needs manual handling',
      inputSchema: z.object({
        action: z.string(),
      }),
      execute: false,
    });

    expect(t.type).toBe(ToolType.Function);
    expect(t.function.name).toBe('manual');
    expect(t.function).not.toHaveProperty('execute');
    expect(t.function).not.toHaveProperty('eventSchema');
  });

  it('tool with contextSchema preserves schema on function.contextSchema', () => {
    const ctxSchema = z.object({
      apiKey: z.string(),
    });
    const t = tool({
      name: 'ctx_tool',
      inputSchema: z.object({}),
      contextSchema: ctxSchema,
      execute: async () => ({}),
    });

    expect(t.function.contextSchema).toBe(ctxSchema);
  });

  it('tool with requireApproval: true preserves flag on function', () => {
    const t = tool({
      name: 'approval_tool',
      inputSchema: z.object({}),
      requireApproval: true,
      execute: async () => ({}),
    });

    expect(t.function.requireApproval).toBe(true);
  });

  it('tool with requireApproval function preserves function on function', () => {
    const check = () => true;
    const t = tool({
      name: 'fn_approval',
      inputSchema: z.object({}),
      requireApproval: check,
      execute: async () => ({}),
    });

    expect(t.function.requireApproval).toBe(check);
  });

  it('tool with nextTurnParams preserves them on function', () => {
    const ntp = {
      temperature: () => 0.5 as number | null,
    };
    const t = tool({
      name: 'ntp_tool',
      inputSchema: z.object({}),
      nextTurnParams: ntp,
      execute: async () => ({}),
    });

    expect(t.function.nextTurnParams).toBeDefined();
  });

  it('tool named "shared" throws (reserved for shared context)', () => {
    expect(() =>
      tool({
        name: 'shared',
        inputSchema: z.object({}),
        execute: async () => ({}),
      }),
    ).toThrow(/reserved/i);
  });

  it('tool with no description has description absent from function object', () => {
    const t = tool({
      name: 'no_desc',
      inputSchema: z.object({
        x: z.number(),
      }),
      execute: async () => ({}),
    });

    expect(t.function.description).toBeUndefined();
  });
});
