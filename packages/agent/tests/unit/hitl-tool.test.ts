import type * as models from '@openrouter/sdk/models';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import {
  applyOnResponseReceivedHooks,
  executeHITLTool,
  executeTool,
} from '../../src/lib/tool-executor.js';
import { tool } from '../../src/lib/tool.js';
import type {
  HITLTool,
  ParsedToolCall,
  Tool,
  TurnContext,
} from '../../src/lib/tool-types.js';
import {
  isAutoResolvableTool,
  isHITLTool,
  isManualTool,
  ToolType,
} from '../../src/lib/tool-types.js';

const turnContext: TurnContext = { numberOfTurns: 1 };

function makeToolCall(name: string, id: string, args: unknown): ParsedToolCall<Tool> {
  return { id, name, arguments: args } as ParsedToolCall<Tool>;
}

describe('tool() factory — HITL tools', () => {
  it('creates a HITL tool when onToolCalled is present', () => {
    const approve = tool({
      name: 'approve_payment',
      description: 'Approve a payment',
      inputSchema: z.object({ amount: z.number() }),
      outputSchema: z.object({ ok: z.boolean() }),
      onToolCalled: async (input) => {
        return input.amount < 100 ? { ok: true } : null;
      },
      onResponseReceived: async (raw) => {
        return raw as { ok: boolean };
      },
    });

    expect(approve.type).toBe(ToolType.Function);
    expect(approve.function.name).toBe('approve_payment');
    expect(isHITLTool(approve)).toBe(true);
    expect(isManualTool(approve)).toBe(false);
    expect(isAutoResolvableTool(approve)).toBe(true);
    expect('execute' in approve.function).toBe(false);
  });

  it('omits onResponseReceived when not provided', () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({ x: z.number() }),
      onToolCalled: async () => ({ ok: true }),
    });
    expect('onResponseReceived' in t.function).toBe(false);
  });

  it('isManualTool returns true only for tools with neither execute nor onToolCalled', () => {
    const manual = tool({
      name: 'manual',
      inputSchema: z.object({ x: z.number() }),
      execute: false,
    });
    const hitl = tool({
      name: 'hitl',
      inputSchema: z.object({ x: z.number() }),
      onToolCalled: async () => null,
    });
    const regular = tool({
      name: 'regular',
      inputSchema: z.object({ x: z.number() }),
      execute: async () => ({ y: 1 }),
    });

    expect(isManualTool(manual)).toBe(true);
    expect(isManualTool(hitl)).toBe(false);
    expect(isManualTool(regular)).toBe(false);
  });
});

describe('executeHITLTool', () => {
  it('returns a ToolExecutionResult when onToolCalled returns a value', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({ amount: z.number() }),
      outputSchema: z.object({ ok: z.boolean() }),
      onToolCalled: async (input) => ({ ok: input.amount < 100 }),
    });

    const result = await executeHITLTool(t, makeToolCall('approve', 'c1', { amount: 5 }), turnContext);
    expect(result).not.toBeNull();
    expect(result?.error).toBeUndefined();
    expect(result?.result).toEqual({ ok: true });
  });

  it('returns null when onToolCalled returns null (pause)', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({ amount: z.number() }),
      onToolCalled: async () => null,
    });

    const result = await executeHITLTool(t, makeToolCall('approve', 'c2', { amount: 5 }), turnContext);
    expect(result).toBeNull();
  });

  it('captures thrown errors into the ToolExecutionResult', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({ amount: z.number() }),
      onToolCalled: async () => {
        throw new Error('boom');
      },
    });

    const result = await executeHITLTool(t, makeToolCall('approve', 'c3', { amount: 5 }), turnContext);
    expect(result).not.toBeNull();
    expect(result?.error).toBeInstanceOf(Error);
    expect(result?.error?.message).toBe('boom');
  });

  it('validates onToolCalled return value against outputSchema', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({ amount: z.number() }),
      outputSchema: z.object({ ok: z.boolean() }),
      // Return value doesn't match schema to force validation error
      onToolCalled: async () => ({ ok: 'yes' as unknown as boolean }),
    });

    const result = await executeHITLTool(t, makeToolCall('approve', 'c4', { amount: 5 }), turnContext);
    expect(result?.error).toBeDefined();
  });
});

describe('executeTool dispatcher with HITL tools', () => {
  it('routes HITL tools through executeHITLTool', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({ amount: z.number() }),
      onToolCalled: async () => ({ approved: true }),
    });

    const result = await executeTool(t, makeToolCall('approve', 'c1', { amount: 5 }), turnContext);
    expect(result).not.toBeNull();
    expect(result?.result).toEqual({ approved: true });
  });

  it('returns null for HITL pause through the dispatcher', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({ amount: z.number() }),
      onToolCalled: async () => null,
    });

    const result = await executeTool(t, makeToolCall('approve', 'c1', { amount: 5 }), turnContext);
    expect(result).toBeNull();
  });
});

describe('applyOnResponseReceivedHooks', () => {
  function callItem(
    callId: string,
    name: string,
    args = '{}',
  ): models.OutputFunctionCallItem {
    return {
      type: 'function_call',
      id: `fc_${callId}`,
      callId,
      name,
      arguments: args,
      status: 'completed',
    };
  }

  function outputItem(callId: string, output: string): models.FunctionCallOutputItem {
    return {
      type: 'function_call_output',
      id: `output_${callId}`,
      callId,
      output,
    };
  }

  it('transforms a FunctionCallOutputItem when its tool has onResponseReceived', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({ amount: z.number() }),
      onToolCalled: async () => null,
      onResponseReceived: async (raw) => {
        const obj = raw as { ok: boolean };
        return { ...obj, reviewedAt: 1234 };
      },
    });

    const input: models.InputsUnion = [
      callItem('c1', 'approve'),
      outputItem('c1', JSON.stringify({ ok: true })),
    ];

    const result = await applyOnResponseReceivedHooks(input, [t], turnContext);
    expect(Array.isArray(result)).toBe(true);
    const arr = result as unknown[];
    const out = arr[1] as models.FunctionCallOutputItem;
    expect(out.type).toBe('function_call_output');
    expect(out.output).toBe(JSON.stringify({ ok: true, reviewedAt: 1234 }));
  });

  it('leaves output unchanged when no matching tool has a hook', async () => {
    const t = tool({
      name: 'regular',
      inputSchema: z.object({ x: z.number() }),
      execute: async () => ({ y: 1 }),
    });

    const input: models.InputsUnion = [
      callItem('c1', 'regular'),
      outputItem('c1', JSON.stringify({ y: 1 })),
    ];

    const result = await applyOnResponseReceivedHooks(input, [t], turnContext);
    expect(result).toBe(input); // same reference, no rewrite
  });

  it('replaces output with an error object when the hook throws', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({ amount: z.number() }),
      onToolCalled: async () => null,
      onResponseReceived: async () => {
        throw new Error('invalid result');
      },
    });

    const input: models.InputsUnion = [
      callItem('c1', 'approve'),
      outputItem('c1', JSON.stringify({ ok: true })),
    ];

    const result = await applyOnResponseReceivedHooks(input, [t], turnContext);
    const arr = result as unknown[];
    const out = arr[1] as models.FunctionCallOutputItem;
    const parsed = JSON.parse(out.output as string) as { error: string };
    expect(parsed.error).toBe('invalid result');
  });

  it('passes the parsed raw result (not the raw string) to the hook', async () => {
    const spy = vi.fn(async (raw: unknown) => raw);
    const t: HITLTool = tool({
      name: 'approve',
      inputSchema: z.object({ amount: z.number() }),
      onToolCalled: async () => null,
      onResponseReceived: spy,
    });

    const payload = { ok: true, note: 'hi' };
    const input: models.InputsUnion = [
      callItem('c1', 'approve'),
      outputItem('c1', JSON.stringify(payload)),
    ];

    await applyOnResponseReceivedHooks(input, [t], turnContext);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toEqual(payload);
  });

  it('passes the raw string through to the hook when output is not JSON', async () => {
    const spy = vi.fn(async (raw: unknown) => raw);
    const t: HITLTool = tool({
      name: 'approve',
      inputSchema: z.object({ amount: z.number() }),
      onToolCalled: async () => null,
      onResponseReceived: spy,
    });

    const input: models.InputsUnion = [
      callItem('c1', 'approve'),
      outputItem('c1', 'not-json'),
    ];

    await applyOnResponseReceivedHooks(input, [t], turnContext);
    expect(spy.mock.calls[0]?.[0]).toBe('not-json');
  });

  it('leaves outputs whose callId has no matching function_call untouched', async () => {
    const t: HITLTool = tool({
      name: 'approve',
      inputSchema: z.object({ amount: z.number() }),
      onToolCalled: async () => null,
      onResponseReceived: async (raw) => ({ ...(raw as object), tagged: true }),
    });

    // No function_call in the input at all — just an orphan output
    const input: models.InputsUnion = [outputItem('orphan', JSON.stringify({ ok: true }))];

    const result = await applyOnResponseReceivedHooks(input, [t], turnContext);
    expect(result).toBe(input);
  });

  it('ignores tools without onResponseReceived even if they are HITL', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({ amount: z.number() }),
      onToolCalled: async () => null,
    });

    const input: models.InputsUnion = [
      callItem('c1', 'approve'),
      outputItem('c1', JSON.stringify({ ok: true })),
    ];

    const result = await applyOnResponseReceivedHooks(input, [t], turnContext);
    expect(result).toBe(input);
  });
});
