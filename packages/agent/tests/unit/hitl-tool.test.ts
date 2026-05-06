import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import {
  applyOnResponseReceivedHooks,
  executeHITLTool,
  executeTool,
} from '../../src/lib/tool-executor.js';
import type {
  ConversationState,
  HITLTool,
  ParsedToolCall,
  StateAccessor,
  Tool,
  TurnContext,
} from '../../src/lib/tool-types.js';
import {
  isAutoResolvableTool,
  isHITLTool,
  isManualTool,
  ToolType,
} from '../../src/lib/tool-types.js';

// Hoisted mock for the SDK's API transport. Any test that imports
// ModelResult below will go through this mock instead of hitting the
// network. Individual tests provide per-call canned responses with
// `mockResolvedValueOnce`.
const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

// Import ModelResult AFTER vi.mock so the mock is wired in.
const { ModelResult } = await import('../../src/lib/model-result.js');

const turnContext: TurnContext = {
  numberOfTurns: 1,
};

function makeToolCall(name: string, id: string, args: unknown): ParsedToolCall<Tool> {
  return {
    id,
    name,
    arguments: args,
  } as ParsedToolCall<Tool>;
}

describe('tool() factory — HITL tools', () => {
  it('creates a HITL tool when onToolCalled is present', () => {
    const approve = tool({
      name: 'approve_payment',
      description: 'Approve a payment',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async (input) => {
        return input.amount < 100
          ? {
              ok: true,
            }
          : null;
      },
      onResponseReceived: async (raw) => {
        return raw as {
          ok: boolean;
        };
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
      inputSchema: z.object({
        x: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => ({
        ok: true,
      }),
    });
    expect('onResponseReceived' in t.function).toBe(false);
  });

  it('throws when a HITL tool is created without an outputSchema', () => {
    expect(() =>
      tool({
        name: 'approve',
        inputSchema: z.object({
          x: z.number(),
        }),
        // @ts-expect-error outputSchema is now required for HITL tools
        onToolCalled: async () => ({
          ok: true,
        }),
      }),
    ).toThrow(/outputSchema/);
  });

  it('isManualTool returns true only for tools with neither execute nor onToolCalled', () => {
    const manual = tool({
      name: 'manual',
      inputSchema: z.object({
        x: z.number(),
      }),
      execute: false,
    });
    const hitl = tool({
      name: 'hitl',
      inputSchema: z.object({
        x: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => null,
    });
    const regular = tool({
      name: 'regular',
      inputSchema: z.object({
        x: z.number(),
      }),
      execute: async () => ({
        y: 1,
      }),
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
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async (input) => ({
        ok: input.amount < 100,
      }),
    });

    const result = await executeHITLTool(
      t,
      makeToolCall('approve', 'c1', {
        amount: 5,
      }),
      turnContext,
    );
    expect(result).not.toBeNull();
    expect(result?.error).toBeUndefined();
    expect(result?.result).toEqual({
      ok: true,
    });
  });

  it('returns null when onToolCalled returns null (pause)', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => null,
    });

    const result = await executeHITLTool(
      t,
      makeToolCall('approve', 'c2', {
        amount: 5,
      }),
      turnContext,
    );
    expect(result).toBeNull();
  });

  it('captures thrown errors into the ToolExecutionResult', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => {
        throw new Error('boom');
      },
    });

    const result = await executeHITLTool(
      t,
      makeToolCall('approve', 'c3', {
        amount: 5,
      }),
      turnContext,
    );
    expect(result).not.toBeNull();
    expect(result?.error).toBeInstanceOf(Error);
    expect(result?.error?.message).toBe('boom');
  });

  it('validates onToolCalled return value against outputSchema', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      // Return value doesn't match schema to force validation error
      onToolCalled: async () => ({
        ok: 'yes' as unknown as boolean,
      }),
    });

    const result = await executeHITLTool(
      t,
      makeToolCall('approve', 'c4', {
        amount: 5,
      }),
      turnContext,
    );
    expect(result?.error).toBeDefined();
  });
});

describe('executeTool dispatcher with HITL tools', () => {
  it('routes HITL tools through executeHITLTool', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        approved: z.boolean(),
      }),
      onToolCalled: async () => ({
        approved: true,
      }),
    });

    const result = await executeTool(
      t,
      makeToolCall('approve', 'c1', {
        amount: 5,
      }),
      turnContext,
    );
    expect(result).not.toBeNull();
    expect(result?.result).toEqual({
      approved: true,
    });
  });

  it('returns null for HITL pause through the dispatcher', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => null,
    });

    const result = await executeTool(
      t,
      makeToolCall('approve', 'c1', {
        amount: 5,
      }),
      turnContext,
    );
    expect(result).toBeNull();
  });
});

describe('applyOnResponseReceivedHooks', () => {
  function callItem(callId: string, name: string, args = '{}'): models.OutputFunctionCallItem {
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
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
        reviewedAt: z.number(),
      }),
      onToolCalled: async () => null,
      onResponseReceived: async (raw) => {
        if (!isRawRecord(raw)) {
          return {
            ok: false,
            reviewedAt: 1234,
          };
        }
        return {
          ...raw,
          reviewedAt: 1234,
        };
      },
    });

    const input: models.InputsUnion = [
      callItem('c1', 'approve'),
      outputItem(
        'c1',
        JSON.stringify({
          ok: true,
        }),
      ),
    ];

    const result = await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    expect(Array.isArray(result)).toBe(true);
    const arr = result as unknown[];
    const out = arr[1] as models.FunctionCallOutputItem;
    expect(out.type).toBe('function_call_output');
    expect(out.output).toBe(
      JSON.stringify({
        ok: true,
        reviewedAt: 1234,
      }),
    );
  });

  it('leaves output unchanged when no matching tool has a hook', async () => {
    const t = tool({
      name: 'regular',
      inputSchema: z.object({
        x: z.number(),
      }),
      execute: async () => ({
        y: 1,
      }),
    });

    const input: models.InputsUnion = [
      callItem('c1', 'regular'),
      outputItem(
        'c1',
        JSON.stringify({
          y: 1,
        }),
      ),
    ];

    const result = await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    expect(result).toBe(input); // same reference, no rewrite
  });

  it('replaces output with an error object preserving the original output when the hook throws', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => null,
      onResponseReceived: async () => {
        throw new Error('invalid result');
      },
    });

    const originalPayload = {
      ok: true,
      note: 'carry-me-through',
    };
    const input: models.InputsUnion = [
      callItem('c1', 'approve'),
      outputItem('c1', JSON.stringify(originalPayload)),
    ];

    const result = await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    const arr = result as unknown[];
    const out = arr[1] as models.FunctionCallOutputItem;
    const parsed = JSON.parse(out.output as string) as {
      error: string;
      originalOutput: unknown;
    };
    expect(parsed.error).toBe('invalid result');
    // Original caller-supplied output must be preserved (parsed form) so the
    // model can distinguish a hook failure from a tool-reported error.
    expect(parsed.originalOutput).toEqual(originalPayload);
  });

  it('preserves the raw string as originalOutput when the output is not JSON and the hook throws', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => null,
      onResponseReceived: async () => {
        throw new Error('invalid result');
      },
    });

    const input: models.InputsUnion = [
      callItem('c1', 'approve'),
      outputItem('c1', 'not-json'),
    ];

    const result = await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    const arr = result as unknown[];
    const out = arr[1] as models.FunctionCallOutputItem;
    const parsed = JSON.parse(out.output as string) as {
      error: string;
      originalOutput: unknown;
    };
    expect(parsed.error).toBe('invalid result');
    expect(parsed.originalOutput).toBe('not-json');
  });

  it('passes the parsed raw result (not the raw string) to the hook', async () => {
    // Loose outputSchema accepting any object keeps the focus of this
    // test on argument propagation, not schema validation.
    const spy = vi.fn(async (raw: unknown) => {
      if (!isRawRecord(raw)) {
        return {};
      }
      return raw;
    });
    const t: HITLTool = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.record(z.string(), z.unknown()),
      onToolCalled: async () => null,
      onResponseReceived: spy,
    });

    const payload = {
      ok: true,
      note: 'hi',
    };
    const input: models.InputsUnion = [
      callItem('c1', 'approve'),
      outputItem('c1', JSON.stringify(payload)),
    ];

    await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toEqual(payload);
  });

  it('passes the raw string through to the hook when output is not JSON', async () => {
    // Permissive outputSchema so the string hook-return passes validation.
    const spy = vi.fn(async (raw: unknown) => {
      if (typeof raw !== 'string') {
        return 'fallback';
      }
      return raw;
    });
    const t: HITLTool = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.string(),
      onToolCalled: async () => null,
      onResponseReceived: spy,
    });

    const input: models.InputsUnion = [
      callItem('c1', 'approve'),
      outputItem('c1', 'not-json'),
    ];

    await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    expect(spy.mock.calls[0]?.[0]).toBe('not-json');
  });

  it('leaves outputs whose callId has no matching function_call untouched', async () => {
    const t: HITLTool = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.record(z.string(), z.unknown()),
      onToolCalled: async () => null,
      onResponseReceived: async (raw) => {
        if (!isRawRecord(raw)) {
          return {
            tagged: true,
          };
        }
        return {
          ...raw,
          tagged: true,
        };
      },
    });

    // No function_call in the input at all — just an orphan output
    const input: models.InputsUnion = [
      outputItem(
        'orphan',
        JSON.stringify({
          ok: true,
        }),
      ),
    ];

    const result = await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    expect(result).toBe(input);
  });

  it('validates raw output against outputSchema when no onResponseReceived hook is defined (passes)', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => null,
    });

    const input: models.InputsUnion = [
      callItem('c1', 'approve'),
      outputItem(
        'c1',
        JSON.stringify({
          ok: true,
        }),
      ),
    ];

    // Schema-conformant raw outputs should leave the item (and the array
    // reference) untouched.
    const result = await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    expect(result).toBe(input);
  });

  it('replaces output with an error object when raw does not match outputSchema and no hook is defined', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => null,
    });

    const badPayload = {
      ok: 'nope',
    };
    const input: models.InputsUnion = [
      callItem('c1', 'approve'),
      outputItem('c1', JSON.stringify(badPayload)),
    ];

    const result = await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    const arr = result as unknown[];
    const out = arr[1] as models.FunctionCallOutputItem;
    const parsed = JSON.parse(out.output as string) as {
      error: string;
      originalOutput: unknown;
    };
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error.length).toBeGreaterThan(0);
    expect(parsed.originalOutput).toEqual(badPayload);
  });

  it('replaces output with an error object when the hook return does not match outputSchema', async () => {
    const t = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => null,
      // Intentionally return a value that does not match outputSchema.
      onResponseReceived: async () => ({
        ok: 'yes' as unknown as boolean,
      }),
    });

    const originalPayload = {
      ok: true,
    };
    const input: models.InputsUnion = [
      callItem('c1', 'approve'),
      outputItem('c1', JSON.stringify(originalPayload)),
    ];

    const result = await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    const arr = result as unknown[];
    const out = arr[1] as models.FunctionCallOutputItem;
    const parsed = JSON.parse(out.output as string) as {
      error: string;
      originalOutput: unknown;
    };
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error.length).toBeGreaterThan(0);
    expect(parsed.originalOutput).toEqual(originalPayload);
  });

  it('preserves a content-array hook return verbatim (no JSON.stringify)', async () => {
    const contentArray = [
      {
        type: 'input_text' as const,
        text: 'hello',
      },
      {
        type: 'input_image' as const,
        detail: 'auto' as const,
        imageUrl: 'https://example.com/img.png',
      },
    ];

    const t = tool({
      name: 'describe',
      inputSchema: z.object({
        id: z.string(),
      }),
      // Loose schema — we care about shape preservation, not the schema type.
      outputSchema: z.array(z.record(z.string(), z.unknown())),
      onToolCalled: async () => null,
      onResponseReceived: async () => contentArray,
    });

    const input: models.InputsUnion = [
      callItem('c1', 'describe'),
      outputItem(
        'c1',
        JSON.stringify({
          ok: true,
        }),
      ),
    ];

    const result = await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    const arr = result as unknown[];
    const out = arr[1] as models.FunctionCallOutputItem;
    // output should be the content-array verbatim, not a JSON string.
    expect(Array.isArray(out.output)).toBe(true);
    expect(out.output).toEqual(contentArray);
  });

  it('preserves a caller-supplied content-array output across no-hook validation', async () => {
    const contentArray = [
      {
        type: 'input_text' as const,
        text: 'plain text',
      },
    ];

    const t = tool({
      name: 'describe',
      inputSchema: z.object({
        id: z.string(),
      }),
      outputSchema: z.array(z.record(z.string(), z.unknown())),
      onToolCalled: async () => null,
    });

    const input: models.InputsUnion = [
      callItem('c1', 'describe'),
      {
        type: 'function_call_output',
        id: 'output_c1',
        callId: 'c1',
        output: contentArray,
      },
    ];

    const result = await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    // Schema-conformant content-array output should be untouched.
    expect(result).toBe(input);
  });

  it('preserves a caller-supplied content-array in originalOutput when the hook throws', async () => {
    const contentArray = [
      {
        type: 'input_text' as const,
        text: 'caller payload',
      },
    ];

    const t = tool({
      name: 'describe',
      inputSchema: z.object({
        id: z.string(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => null,
      onResponseReceived: async () => {
        throw new Error('bad hook');
      },
    });

    const input: models.InputsUnion = [
      callItem('c1', 'describe'),
      {
        type: 'function_call_output',
        id: 'output_c1',
        callId: 'c1',
        output: contentArray,
      },
    ];

    const result = await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    const arr = result as unknown[];
    const out = arr[1] as models.FunctionCallOutputItem;
    // A content-array originalOutput cannot be embedded inside a JSON
    // wrapper (the output union is a content array of visible blocks, not
    // arbitrary JSON). The replacement uses a content-array form: the
    // error as an input_text block followed by the original blocks.
    if (!Array.isArray(out.output)) {
      throw new Error('Expected content-array output on hook failure');
    }
    const errBlock = out.output[0];
    expect(errBlock?.type).toBe('input_text');
    if (!errBlock || errBlock.type !== 'input_text') {
      throw new Error('Expected first block to be input_text');
    }
    const errPayload = JSON.parse(errBlock.text) as {
      error: string;
    };
    expect(errPayload.error).toBe('bad hook');
    // Remaining blocks are the caller's original content-array payload.
    expect(out.output.slice(1)).toEqual(contentArray);
  });

  it('ignores manual tools (no onToolCalled) — they are not HITL', async () => {
    const t = tool({
      name: 'manual',
      inputSchema: z.object({
        x: z.number(),
      }),
      execute: false,
    });

    const input: models.InputsUnion = [
      callItem('c1', 'manual'),
      outputItem(
        'c1',
        JSON.stringify({
          y: 1,
        }),
      ),
    ];

    const result = await applyOnResponseReceivedHooks(
      input,
      [
        t,
      ],
      turnContext,
    );
    expect(result).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — full HITL flow through ModelResult
// ---------------------------------------------------------------------------
//
// These tests drive the HITL loop end-to-end: onToolCalled fires from
// ModelResult.executeToolsIfNeeded, and the follow-up turn sends the
// tool output (possibly transformed by onResponseReceived) back to the
// mocked API. Everything below the describe block uses the vi.hoisted
// mock for `@openrouter/sdk/funcs/betaResponsesSend` declared at the
// top of this file.

/**
 * Build a completed OpenResponsesResult with the given output items.
 * Intentionally fills only the fields ModelResult actually reads — the
 * full schema is huge and any missing fields would fail the SDK's own
 * inbound validation, but we never push through that path from a mock.
 */
function makeResponse(
  id: string,
  output: models.OpenResponsesResult['output'],
): models.OpenResponsesResult {
  return {
    id,
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output,
    error: null,
    incompleteDetails: null,
    temperature: null,
    topP: null,
    presencePenalty: null,
    frequencyPenalty: null,
    metadata: null,
    instructions: null,
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: false,
  };
}

/**
 * Wrap a completed response in a one-shot ReadableStream of StreamEvents,
 * mirroring what betaResponsesSend returns when stream: true is requested.
 * Note: the single event satisfies `StreamEventsResponseCompleted` which
 * is a member of the `StreamEvents` union — no cast needed.
 */
function makeCompletedStream(
  response: models.OpenResponsesResult,
): ReadableStream<models.StreamEvents> {
  const completedEvent: models.StreamEventsResponseCompleted = {
    type: 'response.completed',
    response,
    sequenceNumber: 0,
  };
  return new ReadableStream<models.StreamEvents>({
    start(controller) {
      controller.enqueue(completedEvent);
      controller.close();
    },
  });
}

function makeFunctionCallItem(
  callId: string,
  name: string,
  args: string,
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

function makeMessageItem(id: string, text: string): models.OutputMessage {
  return {
    id,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text,
        annotations: [],
      },
    ],
  };
}

/**
 * Typeguard for a completed betaResponsesSend invocation — narrows the
 * loosely-typed `vi.fn()` mock call payload to the subset we need
 * (the `responsesRequest` wrapper with the `input` / `tools` fields).
 */
function isSendCallArg(value: unknown): value is {
  responsesRequest: {
    input?: models.InputsUnion;
    tools?: models.ResponsesRequestToolUnion[];
  };
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('responsesRequest' in value)) {
    return false;
  }
  const rr = value.responsesRequest;
  return typeof rr === 'object' && rr !== null;
}

/**
 * Typeguard narrowing an InputsUnion array element to a function_call_output.
 */
function isFunctionCallOutput(item: unknown): item is models.FunctionCallOutputItem {
  if (typeof item !== 'object' || item === null) {
    return false;
  }
  if (!('type' in item)) {
    return false;
  }
  return item.type === 'function_call_output';
}

/**
 * Typeguard for a plain-object record (used to narrow the raw tool
 * output inside onResponseReceived without a type assertion).
 */
function isRawRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('HITL flow through ModelResult (integration)', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('auto-resolve: onToolCalled returning a value feeds the model on the next turn', async () => {
    // Turn 0: model invokes the HITL tool.
    const turn0 = makeResponse('resp_turn_0', [
      makeFunctionCallItem(
        'c1',
        'approve',
        JSON.stringify({
          amount: 5,
        }),
      ),
    ]);
    // Turn 1: model replies after seeing the tool output.
    const turn1 = makeResponse('resp_turn_1', [
      makeMessageItem('msg_1', 'approved'),
    ]);

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeCompletedStream(turn0),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeCompletedStream(turn1),
      });

    const approve = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => ({
        ok: true,
      }),
    });

    const tools = [
      approve,
    ] as const;

    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'approve 5',
        tools: [
          {
            type: 'function',
            name: 'approve',
            description: null,
            strict: null,
            parameters: {},
          },
        ],
      },
      client: {} as OpenRouterCore,
      tools,
    });

    const finalResponse = await result.getResponse();

    // Both turns should have fired — pause did NOT trigger because
    // onToolCalled returned a value.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    expect(finalResponse.id).toBe('resp_turn_1');

    // Second request's input must contain the function_call_output with
    // the hook's return value.
    const secondCallArg = mockBetaResponsesSend.mock.calls[1]?.[1];
    if (!isSendCallArg(secondCallArg)) {
      throw new Error('Second send call arg did not match expected shape');
    }
    const input = secondCallArg.responsesRequest.input;
    if (!Array.isArray(input)) {
      throw new Error('Expected second-turn input to be an array');
    }
    const output = input.find(isFunctionCallOutput);
    if (!output) {
      throw new Error('Expected a function_call_output in second-turn input');
    }
    expect(output.callId).toBe('c1');
    const rawOutput = output.output;
    if (typeof rawOutput !== 'string') {
      throw new Error('Expected function_call_output.output to be a string');
    }
    expect(JSON.parse(rawOutput)).toEqual({
      ok: true,
    });
  });

  it('pause: onToolCalled returning null breaks the loop cleanly', async () => {
    // Turn 0: model invokes the HITL tool. No turn 1 should follow.
    const turn0 = makeResponse('resp_turn_0', [
      makeFunctionCallItem(
        'c1',
        'approve',
        JSON.stringify({
          amount: 5,
        }),
      ),
    ]);

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeCompletedStream(turn0),
    });

    const approve = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => null,
    });

    const tools = [
      approve,
    ] as const;

    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'approve 5',
        tools: [
          {
            type: 'function',
            name: 'approve',
            description: null,
            strict: null,
            parameters: {},
          },
        ],
      },
      client: {} as OpenRouterCore,
      tools,
    });

    const finalResponse = await result.getResponse();

    // The loop must NOT have made a follow-up request — the caller is
    // expected to resume by invoking callModel again with a
    // function_call_output they produce externally.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);

    // The final response surfaces the pending function_call so the
    // caller can see what needs to be resolved.
    const toolCalls = await result.getToolCalls();
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.id).toBe('c1');
    expect(toolCalls[0]?.name).toBe('approve');

    // The response output should retain the paused function_call item.
    const outputs = Array.isArray(finalResponse.output)
      ? finalResponse.output
      : [
          finalResponse.output,
        ];
    const pendingCall = outputs.find(
      (item): item is models.OutputFunctionCallItem =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'function_call',
    );
    expect(pendingCall).toBeDefined();
    expect(pendingCall?.callId).toBe('c1');
  });

  it('resume: caller-supplied function_call_output is transformed by onResponseReceived before the model sees it', async () => {
    // Single turn: the caller resumes by supplying both the prior
    // function_call and its function_call_output; the model replies
    // after the hook rewrites the output.
    const resumedTurn = makeResponse('resp_resumed', [
      makeMessageItem('msg_1', 'approved after review'),
    ]);

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeCompletedStream(resumedTurn),
    });

    const onToolCalled = vi.fn(async () => null);
    const approve = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
        reviewedAt: z.number(),
      }),
      onToolCalled,
      onResponseReceived: async (raw) => {
        // Transform the caller's raw output before the model sees it.
        if (!isRawRecord(raw)) {
          return {
            ok: false,
            reviewedAt: 1234,
          };
        }
        return {
          ok: raw.ok === true,
          reviewedAt: 1234,
        };
      },
    });

    const tools = [
      approve,
    ] as const;

    // Caller-supplied input: the prior function_call plus the caller's
    // raw function_call_output for c1.
    const resumeInput: models.InputsUnion = [
      makeFunctionCallItem(
        'c1',
        'approve',
        JSON.stringify({
          amount: 5,
        }),
      ),
      {
        type: 'function_call_output',
        id: 'output_c1',
        callId: 'c1',
        output: JSON.stringify({
          ok: true,
        }),
      },
    ];

    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: resumeInput,
        tools: [
          {
            type: 'function',
            name: 'approve',
            description: null,
            strict: null,
            parameters: {},
          },
        ],
      },
      client: {} as OpenRouterCore,
      tools,
    });

    const text = await result.getText();

    // Only one API call — resume is a single turn because the caller
    // pre-baked the function_call_output.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);

    // onToolCalled should NOT fire on resume — we are not reacting to a
    // fresh function_call from the model, we are supplying a prior one.
    expect(onToolCalled).not.toHaveBeenCalled();

    // The request shipped to the mocked API must carry the hook's
    // transformed output, not the caller's raw payload.
    const firstCallArg = mockBetaResponsesSend.mock.calls[0]?.[1];
    if (!isSendCallArg(firstCallArg)) {
      throw new Error('First send call arg did not match expected shape');
    }
    const input = firstCallArg.responsesRequest.input;
    if (!Array.isArray(input)) {
      throw new Error('Expected resume input to be an array');
    }
    const output = input.find(isFunctionCallOutput);
    if (!output) {
      throw new Error('Expected a function_call_output in the resume input');
    }
    const rawOutput = output.output;
    if (typeof rawOutput !== 'string') {
      throw new Error('Expected function_call_output.output to be a string');
    }
    const parsed: unknown = JSON.parse(rawOutput);
    expect(parsed).toEqual({
      ok: true,
      reviewedAt: 1234,
    });

    // The final text reflects the model's reply after it saw the
    // transformed tool output.
    expect(text).toBe('approved after review');
  });
});

// ---------------------------------------------------------------------------
// ModelResult state-machine tests for HITL pause + resume fixes
// (verify ConversationStatus transitions and pendingToolCalls visibility)
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory StateAccessor for driving ModelResult through
 * awaiting_approval / awaiting_hitl transitions without a real DB.
 */
function createMemoryAccessor<TTools extends readonly Tool[]>(
  initial: ConversationState<TTools> | null = null,
): {
  accessor: StateAccessor<TTools>;
  get: () => ConversationState<TTools> | null;
} {
  let state = initial;
  const accessor: StateAccessor<TTools> = {
    load: async () => state,
    save: async (next) => {
      state = next;
    },
  };
  return {
    accessor,
    get: () => state,
  };
}

describe('HITL pause persists state (Fix #2)', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('HITL pause sets status=awaiting_hitl and populates pendingToolCalls', async () => {
    const turn0 = makeResponse('resp_turn_0', [
      makeFunctionCallItem(
        'c1',
        'approve',
        JSON.stringify({
          amount: 5,
        }),
      ),
    ]);

    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeCompletedStream(turn0),
    });

    const approve = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => null,
    });

    const tools = [
      approve,
    ] as const;

    const { accessor, get } = createMemoryAccessor<typeof tools>();

    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'approve 5',
        tools: [
          {
            type: 'function',
            name: 'approve',
            description: null,
            strict: null,
            parameters: {},
          },
        ],
      },
      client: {} as OpenRouterCore,
      tools,
      state: accessor,
    });

    // Drive the loop to completion (pause).
    await result.getResponse();

    // Only the initial turn was sent — no follow-up after pause.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);

    const saved = get();
    expect(saved).not.toBeNull();
    expect(saved?.status).toBe('awaiting_hitl');
    expect(saved?.pendingToolCalls).toHaveLength(1);
    expect(saved?.pendingToolCalls?.[0]?.id).toBe('c1');

    // getPendingToolCalls() surfaces paused calls to the caller.
    const pending = await result.getPendingToolCalls();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('c1');

    // requiresApproval() returns true for HITL pauses too.
    expect(await result.requiresApproval()).toBe(true);
  });
});

describe('Approved HITL pauses retain pendingToolCalls (Fix #9)', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('resume: approved HITL that returns null stays in pendingToolCalls with status awaiting_hitl', async () => {
    // This tool pauses every time — simulating a caller that must
    // explicitly supply the output externally later.
    const onToolCalled = vi.fn(async () => null);
    const approve = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      requireApproval: true,
      onToolCalled,
    });

    const tools = [
      approve,
    ] as const;

    // Pre-populate state as if the prior run left us awaiting_approval
    // with one pending call c1.
    const pending: ParsedToolCall<(typeof tools)[number]> = {
      id: 'c1',
      name: 'approve',
      arguments: {
        amount: 5,
      },
    };
    const savedState: ConversationState<typeof tools> = {
      id: 'conv_test',
      messages: [
        makeFunctionCallItem(
          'c1',
          'approve',
          JSON.stringify({
            amount: 5,
          }),
        ),
      ],
      pendingToolCalls: [
        pending,
      ],
      status: 'awaiting_approval',
      createdAt: 0,
      updatedAt: 0,
    };

    const { accessor, get } = createMemoryAccessor<typeof tools>(savedState);

    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'approve 5',
        tools: [
          {
            type: 'function',
            name: 'approve',
            description: null,
            strict: null,
            parameters: {},
          },
        ],
      },
      client: {} as OpenRouterCore,
      tools,
      state: accessor,
      // Caller approves c1 — but onToolCalled returns null, so the call
      // must STAY on pendingToolCalls instead of silently disappearing.
      approveToolCalls: [
        'c1',
      ],
    });

    // Drive initStream + processApprovalDecisions.
    const pausedCalls = await result.getPendingToolCalls();

    // The approved HITL call paused, so onToolCalled should have been
    // invoked once during processApprovalDecisions.
    expect(onToolCalled).toHaveBeenCalledTimes(1);

    // No API request should have been made — we paused before any
    // follow-up turn.
    expect(mockBetaResponsesSend).not.toHaveBeenCalled();

    // The call must remain in pendingToolCalls (Fix #9).
    expect(pausedCalls).toHaveLength(1);
    expect(pausedCalls[0]?.id).toBe('c1');

    const saved = get();
    expect(saved?.status).toBe('awaiting_hitl');
    expect(saved?.pendingToolCalls).toHaveLength(1);
    expect(saved?.pendingToolCalls?.[0]?.id).toBe('c1');
  });
});

describe('hasExecutableToolCalls treats HITL tools as auto-resolvable (Fix #1)', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('HITL-only tool calls invoke onToolCalled instead of being classified as manual', async () => {
    // If hasExecutableToolCalls still used hasExecuteFunction, the loop
    // would exit immediately without invoking onToolCalled and no
    // follow-up turn would be made. This test locks in that HITL tools
    // DO drive the loop forward.
    const onToolCalled = vi.fn(async () => ({
      ok: true,
    }));

    const turn0 = makeResponse('resp_turn_0', [
      makeFunctionCallItem(
        'c1',
        'approve',
        JSON.stringify({
          amount: 5,
        }),
      ),
    ]);
    const turn1 = makeResponse('resp_turn_1', [
      makeMessageItem('msg_1', 'approved'),
    ]);

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: makeCompletedStream(turn0),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: makeCompletedStream(turn1),
      });

    const approve = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled,
    });

    const tools = [
      approve,
    ] as const;

    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'approve 5',
        tools: [
          {
            type: 'function',
            name: 'approve',
            description: null,
            strict: null,
            parameters: {},
          },
        ],
      },
      client: {} as OpenRouterCore,
      tools,
    });

    const final = await result.getResponse();

    // Two turns means the HITL tool WAS recognized as executable.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    expect(onToolCalled).toHaveBeenCalledTimes(1);
    expect(final.id).toBe('resp_turn_1');
  });
});

describe('continueWithUnsentResults does not hook SDK-generated outputs (Fix #4)', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('onResponseReceived does NOT fire for SDK-generated outputs produced during continueWithUnsentResults', async () => {
    // Scenario: a HITL tool requires approval AND defines both onToolCalled
    // (which produces an output on approval) and onResponseReceived (which
    // is documented to apply only to CALLER-supplied outputs — i.e. the
    // resume-by-passing-a-function_call_output path). When the caller
    // approves the pending call, processApprovalDecisions invokes
    // onToolCalled, queues the result in unsentToolResults, and
    // continueWithUnsentResults stitches it onto the message history and
    // sends the follow-up request. The SDK-generated output must NOT be
    // run through onResponseReceived — that hook is reserved for outputs
    // the caller produces externally.
    const onToolCalled = vi.fn(async () => ({
      ok: true,
    }));
    const onResponseReceived = vi.fn(async (raw: unknown) => {
      // Should never run in this test. If it does, the assertion below
      // catches it; returning a distinct payload makes misbehaviour
      // easy to diagnose in the wire capture as well.
      if (!isRawRecord(raw)) {
        return {
          hooked: true,
        };
      }
      return {
        ...raw,
        hooked: true,
      };
    });

    const approve = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      requireApproval: true,
      onToolCalled,
      onResponseReceived,
    });

    const tools = [
      approve,
    ] as const;

    // Pre-populate state as if a prior run left us awaiting_approval with
    // one pending call c1. This bypasses the initial model turn (we are
    // jumping straight to the resume path) so the only invocation of a
    // hook we care about happens inside continueWithUnsentResults.
    const pending: ParsedToolCall<(typeof tools)[number]> = {
      id: 'c1',
      name: 'approve',
      arguments: {
        amount: 5,
      },
    };
    const savedState: ConversationState<typeof tools> = {
      id: 'conv_test',
      messages: [
        makeFunctionCallItem(
          'c1',
          'approve',
          JSON.stringify({
            amount: 5,
          }),
        ),
      ],
      pendingToolCalls: [
        pending,
      ],
      status: 'awaiting_approval',
      createdAt: 0,
      updatedAt: 0,
    };

    // After the approval resolves and the follow-up request fires, the
    // model replies with a plain message.
    const followupTurn = makeResponse('resp_followup', [
      makeMessageItem('msg_1', 'done'),
    ]);
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeCompletedStream(followupTurn),
    });

    const { accessor } = createMemoryAccessor<typeof tools>(savedState);

    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: 'approve 5',
        tools: [
          {
            type: 'function',
            name: 'approve',
            description: null,
            strict: null,
            parameters: {},
          },
        ],
      },
      client: {} as OpenRouterCore,
      tools,
      state: accessor,
      // Caller approves c1 — onToolCalled will produce {ok: true} and the
      // follow-up request will carry that SDK-generated output.
      approveToolCalls: [
        'c1',
      ],
    });

    await result.getResponse();

    // onToolCalled fired exactly once (during processApprovalDecisions).
    expect(onToolCalled).toHaveBeenCalledTimes(1);

    // The critical assertion: onResponseReceived must NOT have fired.
    // SDK-generated outputs are appended verbatim; the hook is reserved
    // for caller-supplied outputs only.
    expect(onResponseReceived).not.toHaveBeenCalled();

    // And the wire request must carry the raw SDK-generated output, not
    // a hook-transformed version.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
    const callArg = mockBetaResponsesSend.mock.calls[0]?.[1];
    if (!isSendCallArg(callArg)) {
      throw new Error('Send call arg did not match expected shape');
    }
    const input = callArg.responsesRequest.input;
    if (!Array.isArray(input)) {
      throw new Error('Expected follow-up input to be an array');
    }
    const output = input.find(isFunctionCallOutput);
    if (!output) {
      throw new Error('Expected a function_call_output in the follow-up input');
    }
    const rawOutput = output.output;
    if (typeof rawOutput !== 'string') {
      throw new Error('Expected function_call_output.output to be a string');
    }
    expect(JSON.parse(rawOutput)).toEqual({
      ok: true,
    });
  });
});

describe('initStream does not re-hook historical outputs (Fix #3)', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('onResponseReceived fires only for fresh caller-supplied outputs, not historical ones loaded from state', async () => {
    // Scenario: state already contains a function_call / function_call_output
    // pair from a prior run (the output was hooked when it was first
    // supplied). On a new callModel invocation, the caller passes fresh
    // input that includes ANOTHER function_call / function_call_output pair
    // for the same HITL tool. The hook must fire for the fresh output
    // ONLY — the historical output must not be re-hooked (non-idempotent
    // hooks would double-fire otherwise).
    const onResponseReceived = vi.fn(async (raw: unknown) => {
      if (!isRawRecord(raw)) {
        return {
          hooked: true,
        };
      }
      return {
        ...raw,
        hooked: true,
      };
    });

    const approve = tool({
      name: 'approve',
      inputSchema: z.object({
        amount: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: async () => null,
      onResponseReceived,
    });

    const tools = [
      approve,
    ] as const;

    // Pre-populated state: a historical function_call + function_call_output
    // pair (c0) that was already hooked on the prior run. Its `output`
    // field here simulates an already-hooked payload. If initStream
    // re-hooks it, the mock will observe a second invocation for c0.
    const historicalCall = makeFunctionCallItem(
      'c0',
      'approve',
      JSON.stringify({
        amount: 1,
      }),
    );
    const historicalOutput: models.FunctionCallOutputItem = {
      type: 'function_call_output',
      id: 'output_c0',
      callId: 'c0',
      output: JSON.stringify({
        ok: true,
        hooked: true,
      }),
    };

    const savedState: ConversationState<typeof tools> = {
      id: 'conv_test',
      messages: [
        historicalCall,
        historicalOutput,
      ],
      status: 'in_progress',
      createdAt: 0,
      updatedAt: 0,
    };

    // Fresh input: a new function_call / function_call_output pair (c1)
    // that the caller is supplying this turn. The hook should fire for
    // c1 but NOT for c0.
    const freshInput: models.InputsUnion = [
      makeFunctionCallItem(
        'c1',
        'approve',
        JSON.stringify({
          amount: 2,
        }),
      ),
      {
        type: 'function_call_output',
        id: 'output_c1',
        callId: 'c1',
        output: JSON.stringify({
          ok: true,
        }),
      },
    ];

    // After the fresh output is hooked and appended to history, the model
    // replies with a plain message.
    const replyTurn = makeResponse('resp_reply', [
      makeMessageItem('msg_1', 'noted'),
    ]);
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: makeCompletedStream(replyTurn),
    });

    const { accessor } = createMemoryAccessor<typeof tools>(savedState);

    const result = new ModelResult<typeof tools>({
      request: {
        model: 'test-model',
        input: freshInput,
        tools: [
          {
            type: 'function',
            name: 'approve',
            description: null,
            strict: null,
            parameters: {},
          },
        ],
      },
      client: {} as OpenRouterCore,
      tools,
      state: accessor,
    });

    await result.getResponse();

    // Hook fired exactly once — for the fresh c1 output — and received
    // the fresh payload, NOT the already-hooked historical one.
    expect(onResponseReceived).toHaveBeenCalledTimes(1);
    const hookArg = onResponseReceived.mock.calls[0]?.[0];
    expect(hookArg).toEqual({
      ok: true,
    });

    // The wire request must carry both outputs with the correct values:
    //   - c0: unchanged historical output (not re-hooked)
    //   - c1: hooked fresh output
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
    const callArg = mockBetaResponsesSend.mock.calls[0]?.[1];
    if (!isSendCallArg(callArg)) {
      throw new Error('Send call arg did not match expected shape');
    }
    const input = callArg.responsesRequest.input;
    if (!Array.isArray(input)) {
      throw new Error('Expected input to be an array');
    }
    const outputs = input.filter(isFunctionCallOutput);
    expect(outputs).toHaveLength(2);

    const c0Output = outputs.find((o) => o.callId === 'c0');
    if (!c0Output) {
      throw new Error('Expected c0 output to be preserved');
    }
    const c0Raw = c0Output.output;
    if (typeof c0Raw !== 'string') {
      throw new Error('Expected c0 output.output to be a string');
    }
    // c0 preserved verbatim — NOT re-hooked. The hooked: true marker is
    // from the historical (prior-run) payload, not a re-hook.
    expect(JSON.parse(c0Raw)).toEqual({
      ok: true,
      hooked: true,
    });

    const c1Output = outputs.find((o) => o.callId === 'c1');
    if (!c1Output) {
      throw new Error('Expected c1 output to be present');
    }
    const c1Raw = c1Output.output;
    if (typeof c1Raw !== 'string') {
      throw new Error('Expected c1 output.output to be a string');
    }
    // c1 was hooked — the fresh payload plus hooked: true added by the
    // onResponseReceived implementation above.
    expect(JSON.parse(c1Raw)).toEqual({
      ok: true,
      hooked: true,
    });
  });
});
