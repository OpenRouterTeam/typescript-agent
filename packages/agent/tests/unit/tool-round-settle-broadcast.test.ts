import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import type { GetResponseOptions } from '../../src/lib/model-result.js';
import { ModelResult } from '../../src/lib/model-result.js';
import { tool } from '../../src/lib/tool.js';
import type { Tool } from '../../src/lib/tool-types.js';
import { isToolResultEvent } from '../../src/lib/tool-types.js';

type Internal = {
  currentState: {
    id: string;
    messages: models.BaseInputsUnion[];
    status: 'in_progress';
    createdAt: number;
    updatedAt: number;
  } | null;
  initPromise: Promise<void> | null;
  getInitialResponse: () => Promise<models.OpenResponsesResult>;
  makeFollowupRequest: (
    currentResponse: models.OpenResponsesResult,
    toolResults: models.FunctionCallOutputItem[],
    turnNumber: number,
  ) => Promise<models.OpenResponsesResult>;
  shouldStopExecution: () => Promise<boolean>;
  executeToolsIfNeeded: () => Promise<void>;
  ensureTurnBroadcaster: () => {
    createConsumer: () => AsyncIterableIterator<unknown>;
    push: (event: unknown) => void;
    complete: () => void;
  };
};

function makeResponseWithToolCalls(
  calls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>,
): models.OpenResponsesResult {
  return {
    id: 'resp_test',
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    output: calls.map((c) => ({
      type: 'function_call' as const,
      id: c.id,
      callId: c.id,
      name: c.name,
      arguments: c.arguments,
      status: 'completed' as const,
    })),
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  } as unknown as models.OpenResponsesResult;
}

function makeFinalResponse(): models.OpenResponsesResult {
  return {
    id: 'resp_final',
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'done',
          },
        ],
      },
    ],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  } as unknown as models.OpenResponsesResult;
}

function buildModelResult(tools: readonly Tool[]): Internal {
  const config: GetResponseOptions<readonly Tool[]> = {
    request: {
      model: 'test-model',
      input: 'hello',
    },
    client: {} as OpenRouterCore,
    tools,
  };
  const internal = new ModelResult<readonly Tool[]>(config) as unknown as Internal;
  internal.currentState = {
    id: 'conv',
    messages: [],
    status: 'in_progress',
    createdAt: 0,
    updatedAt: 0,
  };
  internal.initPromise = Promise.resolve();
  internal.shouldStopExecution = async () => false;
  return internal;
}

async function drainInto(
  consumer: AsyncIterableIterator<unknown>,
  events: unknown[],
): Promise<void> {
  for await (const event of consumer) {
    events.push(event);
  }
}

function isToolCallOutputEvent(event: unknown): event is {
  type: 'tool.call_output';
  output: models.FunctionCallOutputItem;
} {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'tool.call_output'
  );
}

/**
 * DEV-1067 regression: when a round has multiple tool calls, each call's
 * tool.result / tool.call_output must be broadcast the moment THAT call
 * settles — not held until the whole round's Promise.allSettled resolves —
 * while the model-facing outputs stay in call order.
 */
describe('per-call broadcast on settlement (DEV-1067)', () => {
  it('broadcasts a fast call before a slow sibling in the same round finishes', async () => {
    let releaseSlow: () => void = () => undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const slow = tool({
      name: 'slow',
      inputSchema: z.object({}),
      outputSchema: z.object({
        done: z.boolean(),
      }),
      execute: async () => {
        await slowGate;
        return {
          done: true,
        };
      },
    });
    const fast = tool({
      name: 'fast',
      inputSchema: z.object({}),
      outputSchema: z.object({
        done: z.boolean(),
      }),
      execute: async () => ({
        done: true,
      }),
    });

    const internal = buildModelResult([
      slow,
      fast,
    ]);
    // Call order: slow FIRST, fast second — so the fast call settling early
    // is only observable if broadcasts are per-call, and the ordered
    // model-facing assembly is only correct if it re-sorts to call order.
    internal.getInitialResponse = async () =>
      makeResponseWithToolCalls([
        {
          id: 'call_slow',
          name: 'slow',
          arguments: '{}',
        },
        {
          id: 'call_fast',
          name: 'fast',
          arguments: '{}',
        },
      ]);

    let followupToolResults: models.FunctionCallOutputItem[] | null = null;
    internal.makeFollowupRequest = async (_currentResponse, toolResults) => {
      followupToolResults = toolResults;
      return makeFinalResponse();
    };

    const broadcaster = internal.ensureTurnBroadcaster();
    const events: unknown[] = [];
    const consumer = broadcaster.createConsumer();
    const drainPromise = drainInto(consumer, events);

    const executionPromise = internal.executeToolsIfNeeded();

    // The fast call's completion must appear on the wire while the slow
    // call is still running (its gate is unreleased).
    await vi.waitFor(() => {
      const toolResults = events.filter(isToolResultEvent);
      expect(toolResults.some((e) => e.toolCallId === 'call_fast')).toBe(true);
    });
    expect(events.filter(isToolResultEvent).some((e) => e.toolCallId === 'call_slow')).toBe(false);
    const fastOutputs = events.filter(isToolCallOutputEvent);
    expect(fastOutputs.some((e) => e.output.callId === 'call_fast')).toBe(true);
    expect(fastOutputs.some((e) => e.output.callId === 'call_slow')).toBe(false);

    releaseSlow();
    await executionPromise;
    broadcaster.complete();
    await drainPromise;

    // Both calls completed on the wire, fast before slow (settlement order).
    const toolResultIds = events.filter(isToolResultEvent).map((e) => e.toolCallId);
    expect(toolResultIds).toEqual([
      'call_fast',
      'call_slow',
    ]);

    // Model-facing outputs stay in CALL order regardless of settlement
    // order (prompt-cache stability).
    expect(followupToolResults).not.toBeNull();
    expect(followupToolResults?.map((o) => o.callId)).toEqual([
      'call_slow',
      'call_fast',
    ]);
  });

  it('broadcasts a rejected call as it settles without waiting for the round', async () => {
    let releaseSlow: () => void = () => undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const slow = tool({
      name: 'slow',
      inputSchema: z.object({}),
      outputSchema: z.object({
        done: z.boolean(),
      }),
      execute: async () => {
        await slowGate;
        return {
          done: true,
        };
      },
    });
    const boom = tool({
      name: 'boom',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      execute: async () => {
        throw new Error('explode');
      },
    });

    const internal = buildModelResult([
      slow,
      boom,
    ]);
    internal.getInitialResponse = async () =>
      makeResponseWithToolCalls([
        {
          id: 'call_slow',
          name: 'slow',
          arguments: '{}',
        },
        {
          id: 'call_boom',
          name: 'boom',
          arguments: '{}',
        },
      ]);
    internal.makeFollowupRequest = async () => makeFinalResponse();

    const broadcaster = internal.ensureTurnBroadcaster();
    const events: unknown[] = [];
    const consumer = broadcaster.createConsumer();
    const drainPromise = drainInto(consumer, events);

    const executionPromise = internal.executeToolsIfNeeded();

    await vi.waitFor(() => {
      const toolResults = events.filter(isToolResultEvent);
      expect(toolResults.some((e) => e.toolCallId === 'call_boom')).toBe(true);
    });
    const boomResult = events.filter(isToolResultEvent).find((e) => e.toolCallId === 'call_boom');
    expect(boomResult).toMatchObject({
      result: {
        error: 'explode',
      },
    });
    expect(events.filter(isToolResultEvent).some((e) => e.toolCallId === 'call_slow')).toBe(false);

    releaseSlow();
    await executionPromise;
    broadcaster.complete();
    await drainPromise;
  });
});
