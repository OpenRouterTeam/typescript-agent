import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import type { GetResponseOptions } from '../../src/lib/model-result.js';
import { ModelResult } from '../../src/lib/model-result.js';
import { tool } from '../../src/lib/tool.js';
import type { Tool } from '../../src/lib/tool-types.js';
import { isToolPreliminaryResultEvent, isToolResultEvent } from '../../src/lib/tool-types.js';

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
  makeFollowupRequest: (...args: unknown[]) => Promise<models.OpenResponsesResult>;
  shouldStopExecution: () => Promise<boolean>;
  executeToolsIfNeeded: () => Promise<void>;
  turnBroadcaster: {
    createConsumer: () => AsyncIterableIterator<unknown>;
  } | null;
  toolEventBroadcaster: {
    createConsumer: () => AsyncIterableIterator<unknown>;
    push: (event: unknown) => void;
    complete: () => void;
  } | null;
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

function buildModelResult(tools: readonly Tool[]): {
  result: ModelResult<readonly Tool[]>;
  internal: Internal;
} {
  const config: GetResponseOptions<readonly Tool[]> = {
    request: {
      model: 'test-model',
      input: 'hello',
    },
    client: {} as OpenRouterCore,
    tools,
  };
  const result = new ModelResult<readonly Tool[]>(config);
  const internal = result as unknown as Internal;
  internal.currentState = {
    id: 'conv',
    messages: [],
    status: 'in_progress',
    createdAt: 0,
    updatedAt: 0,
  };
  internal.initPromise = Promise.resolve();
  internal.shouldStopExecution = async () => false;
  return {
    result,
    internal,
  };
}

async function collectAsyncIterable(consumer: AsyncIterableIterator<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of consumer) {
    events.push(event);
  }
  return events;
}

describe('toolName on runtime tool events', () => {
  it('includes toolName on tool.result for regular execute tools', async () => {
    const regular = tool({
      name: 'echo',
      inputSchema: z.object({
        text: z.string(),
      }),
      outputSchema: z.object({
        text: z.string(),
      }),
      execute: async (params) => ({
        text: params.text,
      }),
    });

    const { internal } = buildModelResult([
      regular,
    ]);
    internal.getInitialResponse = async () =>
      makeResponseWithToolCalls([
        {
          id: 'call_echo',
          name: 'echo',
          arguments: JSON.stringify({
            text: 'hi',
          }),
        },
      ]);
    internal.makeFollowupRequest = async () => makeFinalResponse();

    const broadcaster = internal.ensureTurnBroadcaster();
    const consumer = broadcaster.createConsumer();
    const eventsPromise = collectAsyncIterable(consumer);

    await internal.executeToolsIfNeeded();
    broadcaster.complete();
    const events = await eventsPromise;

    const toolResults = events.filter(isToolResultEvent);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      type: 'tool.result',
      toolCallId: 'call_echo',
      toolName: 'echo',
      source: 'client',
      result: {
        text: 'hi',
      },
    });
  });

  it('includes toolName on preliminary and final generator events', async () => {
    const generator = tool({
      name: 'progress_tool',
      inputSchema: z.object({}),
      eventSchema: z.object({
        stage: z.string(),
      }),
      outputSchema: z.object({
        done: z.boolean(),
      }),
      execute: async function* () {
        yield {
          stage: 'one',
        };
        yield {
          stage: 'two',
        };
        yield {
          done: true,
        };
      },
    });

    const { internal } = buildModelResult([
      generator,
    ]);
    internal.getInitialResponse = async () =>
      makeResponseWithToolCalls([
        {
          id: 'call_progress',
          name: 'progress_tool',
          arguments: '{}',
        },
      ]);
    internal.makeFollowupRequest = async () => makeFinalResponse();

    const turn = internal.ensureTurnBroadcaster();
    // Mirror the legacy tool-event broadcaster path used by getToolStream consumers.
    const { ToolEventBroadcaster } = await import('../../src/lib/tool-event-broadcaster.js');
    const legacy = new ToolEventBroadcaster<{
      type: 'preliminary_result' | 'tool_result';
      toolCallId: string;
      toolName: string;
      result?: unknown;
      source?: 'client' | 'mcp';
      preliminaryResults?: unknown[];
    }>();
    internal.toolEventBroadcaster = legacy;

    const turnConsumer = turn.createConsumer();
    const legacyConsumer = legacy.createConsumer();

    const turnEventsPromise = collectAsyncIterable(turnConsumer);
    const legacyEventsPromise = collectAsyncIterable(legacyConsumer);

    await internal.executeToolsIfNeeded();
    turn.complete();
    legacy.complete();

    const turnEvents = await turnEventsPromise;
    const legacyEvents = await legacyEventsPromise;

    const prelims = turnEvents.filter(isToolPreliminaryResultEvent);
    expect(prelims).toHaveLength(2);
    expect(prelims[0]).toMatchObject({
      type: 'tool.preliminary_result',
      toolCallId: 'call_progress',
      toolName: 'progress_tool',
      result: {
        stage: 'one',
      },
    });
    expect(prelims[1]).toMatchObject({
      toolName: 'progress_tool',
      result: {
        stage: 'two',
      },
    });

    const finals = turnEvents.filter(isToolResultEvent);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      type: 'tool.result',
      toolName: 'progress_tool',
      result: {
        done: true,
      },
      preliminaryResults: [
        {
          stage: 'one',
        },
        {
          stage: 'two',
        },
      ],
    });

    const legacyPrelims = legacyEvents.filter(
      (
        e,
      ): e is {
        type: 'preliminary_result';
        toolCallId: string;
        toolName: string;
        result: unknown;
      } => e.type === 'preliminary_result',
    );
    expect(legacyPrelims).toHaveLength(2);
    expect(legacyPrelims[0]?.toolName).toBe('progress_tool');
    expect(legacyPrelims[1]?.toolName).toBe('progress_tool');

    // getToolStream-shaped projection carries toolName too
    const projected = prelims.map((event) => ({
      type: 'preliminary_result' as const,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
    }));
    expect(projected[0]?.toolName).toBe('progress_tool');
  });

  it('includes toolName on tool.result for HITL auto-resolve path', async () => {
    const hitl = tool({
      name: 'hitl_tool',
      inputSchema: z.object({
        q: z.string(),
      }),
      outputSchema: z.object({
        answer: z.string(),
      }),
      onToolCalled: async () => ({
        answer: '42',
      }),
    });

    const { internal } = buildModelResult([
      hitl,
    ]);
    internal.getInitialResponse = async () =>
      makeResponseWithToolCalls([
        {
          id: 'call_hitl',
          name: 'hitl_tool',
          arguments: JSON.stringify({
            q: 'life?',
          }),
        },
      ]);
    internal.makeFollowupRequest = async () => makeFinalResponse();

    const broadcaster = internal.ensureTurnBroadcaster();
    const consumer = broadcaster.createConsumer();
    const eventsPromise = collectAsyncIterable(consumer);

    await internal.executeToolsIfNeeded();
    broadcaster.complete();
    const events = await eventsPromise;

    const toolResults = events.filter(isToolResultEvent);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      toolName: 'hitl_tool',
      result: {
        answer: '42',
      },
    });
  });

  it('includes toolName on rejected/error tool.result events', async () => {
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

    const { internal } = buildModelResult([
      boom,
    ]);
    internal.getInitialResponse = async () =>
      makeResponseWithToolCalls([
        {
          id: 'call_boom',
          name: 'boom',
          arguments: '{}',
        },
      ]);
    internal.makeFollowupRequest = async () => makeFinalResponse();

    const broadcaster = internal.ensureTurnBroadcaster();
    const consumer = broadcaster.createConsumer();
    const eventsPromise = collectAsyncIterable(consumer);

    await internal.executeToolsIfNeeded();
    broadcaster.complete();
    const events = await eventsPromise;

    const toolResults = events.filter(isToolResultEvent);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      type: 'tool.result',
      toolCallId: 'call_boom',
      toolName: 'boom',
      result: {
        error: 'explode',
      },
    });
  });

  it('preserves literal names on manual/regular/generator/HITL factory tools', () => {
    const regular = tool({
      name: 'alpha',
      inputSchema: z.object({}),
      execute: async () => 1,
    });
    const generator = tool({
      name: 'beta',
      inputSchema: z.object({}),
      eventSchema: z.object({
        n: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      execute: async function* () {
        yield {
          ok: true,
        };
      },
    });
    const manual = tool({
      name: 'gamma',
      inputSchema: z.object({}),
      execute: false,
    });
    const hitl = tool({
      name: 'delta',
      inputSchema: z.object({}),
      outputSchema: z.object({
        done: z.boolean(),
      }),
      onToolCalled: async () => null,
    });

    expect(regular.function.name).toBe('alpha');
    expect(generator.function.name).toBe('beta');
    expect(manual.function.name).toBe('gamma');
    expect(hitl.function.name).toBe('delta');
  });
});
