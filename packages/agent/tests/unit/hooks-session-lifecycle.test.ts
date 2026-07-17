/**
 * End-to-end session lifecycle tests for the hooks system, driven through the
 * public callModel surface with betaResponsesSend mocked at the module level.
 *
 * Covers:
 * - SessionStart is emitted by ModelResult itself with a populated config
 * - SessionStart/SessionEnd pair on the no-tools getText() path
 * - SessionStart/SessionEnd pair on the no-tools getTextStream() path
 * - SessionEnd reason 'max_turns' when a stop condition halts the loop
 * - teardown never masks the original error when a SessionEnd handler throws
 */
import type * as models from '@openrouter/sdk/models';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import type { OpenRouterCore } from '@openrouter/sdk/core';
import { callModel } from '../../src/inner-loop/call-model.js';
import { HooksManager } from '../../src/lib/hooks-manager.js';
import { ModelResult } from '../../src/lib/model-result.js';
import { stepCountIs } from '../../src/lib/stop-conditions.js';
import type { ConversationState, StateAccessor, Tool } from '../../src/lib/tool-types.js';
import { ToolType } from '../../src/lib/tool-types.js';

afterEach(() => {
  mockBetaResponsesSend.mockReset();
  vi.restoreAllMocks();
});

function textResponse(id = 'resp_text'): models.OpenResponsesResult {
  return {
    id,
    output: [
      {
        type: 'message',
        id: `msg_${id}`,
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'hello back',
          },
        ],
        status: 'completed',
      },
    ],
  } as unknown as models.OpenResponsesResult;
}

function toolCallResponse(id = 'resp_tool'): models.OpenResponsesResult {
  return {
    id,
    output: [
      {
        type: 'function_call',
        id: `out_${id}`,
        callId: `call_${id}`,
        name: 'echo',
        arguments: '{}',
        status: 'completed',
      },
    ],
  } as unknown as models.OpenResponsesResult;
}

function makeEchoTool() {
  return {
    type: ToolType.Function,
    function: {
      name: 'echo',
      description: 'echo',
      inputSchema: z.object({}).loose(),
      outputSchema: z.unknown(),
      execute: async () => ({
        ok: true,
      }),
    },
  };
}

const client = {} as unknown as OpenRouterCore;

describe('session lifecycle end-to-end', () => {
  it('emits SessionStart with a populated config and SessionEnd(complete) on getText()', async () => {
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: textResponse(),
    });

    const hooks = new HooksManager();
    const starts: unknown[] = [];
    const ends: unknown[] = [];
    hooks.on('SessionStart', {
      handler: (payload) => {
        starts.push(payload);
      },
    });
    hooks.on('SessionEnd', {
      handler: (payload) => {
        ends.push(payload);
      },
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        makeEchoTool(),
      ],
      hooks,
    });
    const text = await result.getText();

    expect(text).toBe('hello back');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      config: {
        hasTools: true,
        hasApproval: false,
        hasState: false,
      },
    });
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      reason: 'complete',
    });
  });

  it('pairs SessionStart/SessionEnd on the no-tools getText() path', async () => {
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: textResponse(),
    });

    const hooks = new HooksManager();
    const events: string[] = [];
    hooks.on('SessionStart', {
      handler: () => {
        events.push('start');
      },
    });
    hooks.on('SessionEnd', {
      handler: () => {
        events.push('end');
      },
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      hooks,
    });
    await result.getText();

    expect(events).toEqual([
      'start',
      'end',
    ]);
  });

  it('pairs SessionStart/SessionEnd on the no-tools getTextStream() path', async () => {
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: textResponse(),
    });

    const hooks = new HooksManager();
    const events: string[] = [];
    hooks.on('SessionStart', {
      handler: () => {
        events.push('start');
      },
    });
    hooks.on('SessionEnd', {
      handler: () => {
        events.push('end');
      },
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      hooks,
    });
    const chunks: string[] = [];
    for await (const chunk of result.getTextStream()) {
      chunks.push(chunk);
    }

    expect(events).toEqual([
      'start',
      'end',
    ]);
  });

  it('emits SessionEnd(max_turns) when a stop condition halts a tool loop', async () => {
    // Every response contains a tool call, so only stepCountIs(1) ends the run.
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('r1'),
      })
      .mockResolvedValue({
        ok: true,
        value: toolCallResponse('r2'),
      });

    const hooks = new HooksManager();
    const ends: unknown[] = [];
    hooks.on('SessionEnd', {
      handler: (payload) => {
        ends.push(payload);
      },
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        makeEchoTool(),
      ],
      stopWhen: stepCountIs(1),
      hooks,
    });
    await result.getResponse();

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      reason: 'max_turns',
    });
  });

  it('inline hook config (plain object) fires through callModel end-to-end', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('r1'),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: textResponse('r2'),
      });

    const preToolUse = vi.fn();
    const filteredOut = vi.fn();
    const sessionStart = vi.fn();

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        makeEchoTool(),
      ],
      hooks: {
        SessionStart: [
          {
            handler: sessionStart,
          },
        ],
        PreToolUse: [
          {
            matcher: /^ech/,
            handler: preToolUse,
          },
          {
            matcher: 'not-a-real-tool',
            handler: filteredOut,
          },
        ],
      },
    });
    await result.getText();

    expect(sessionStart).toHaveBeenCalledTimes(1);
    expect(preToolUse).toHaveBeenCalledTimes(1);
    expect(preToolUse.mock.calls[0]?.[0]).toMatchObject({
      toolName: 'echo',
    });
    expect(filteredOut).not.toHaveBeenCalled();
  });

  it('emits SessionEnd(user) when the run is interrupted via state', async () => {
    // Every response carries a tool call so the loop keeps going until the
    // interruption flag is observed at the top of an iteration.
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: toolCallResponse('r'),
    });

    // State accessor that reports interruptedBy on the SECOND load (the
    // first happens during initStream; checkForInterruption loads fresh
    // state at the top of each loop iteration).
    let state: ConversationState<readonly Tool[]> = {
      id: 'conv_interrupt',
      messages: [],
      status: 'in_progress',
      createdAt: 0,
      updatedAt: 0,
    } as ConversationState<readonly Tool[]>;
    let loads = 0;
    const accessor: StateAccessor<readonly Tool[]> = {
      load: async () => {
        loads++;
        if (loads >= 2) {
          return {
            ...state,
            interruptedBy: 'user',
          } as ConversationState<readonly Tool[]>;
        }
        return state;
      },
      save: async (s) => {
        state = s;
      },
    };

    const hooks = new HooksManager();
    const ends: unknown[] = [];
    hooks.on('SessionEnd', {
      handler: (payload) => {
        ends.push(payload);
      },
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        makeEchoTool(),
      ],
      state: accessor,
      hooks,
    });
    await result.getResponse();

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      reason: 'user',
    });
  });

  it('emits SessionEnd(error) when initStream fails after SessionStart on the no-tools stream path', async () => {
    // The initial API call fails AFTER SessionStart was emitted inside
    // initStream. The streaming getters must still tear the session down
    // (SessionEnd + drain) instead of leaving a dangling SessionStart.
    mockBetaResponsesSend.mockResolvedValue({
      ok: false,
      error: new Error('initial api call failed'),
    });

    const hooks = new HooksManager();
    const starts: unknown[] = [];
    const ends: {
      reason?: string;
    }[] = [];
    hooks.on('SessionStart', {
      handler: (payload) => {
        starts.push(payload);
      },
    });
    hooks.on('SessionEnd', {
      handler: (payload) => {
        ends.push(
          payload as {
            reason?: string;
          },
        );
      },
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      hooks,
    });

    await expect(async () => {
      for await (const _chunk of result.getTextStream()) {
        // no-op: the stream should throw before yielding
      }
    }).rejects.toThrow('initial api call failed');

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      reason: 'error',
    });
  });

  it('emits SessionEnd(error) when the no-tools stream errors mid-iteration', async () => {
    // Stream delivers one event then errors (network drop mid-stream). The
    // no-tools streaming path must still fire SessionEnd with reason 'error'
    // and drain pending hook work.
    const erroringStream = new ReadableStream<models.StreamEvents>({
      start(controller) {
        controller.enqueue({
          type: 'response.output_text.delta',
          delta: 'partial',
          sequenceNumber: 0,
        } as unknown as models.StreamEvents);
        controller.error(new Error('network dropped mid-stream'));
      },
    });
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: erroringStream,
    });

    const hooks = new HooksManager();
    const events: string[] = [];
    const ends: {
      reason?: string;
    }[] = [];
    hooks.on('SessionStart', {
      handler: () => {
        events.push('start');
      },
    });
    hooks.on('SessionEnd', {
      handler: (payload) => {
        events.push('end');
        ends.push(
          payload as {
            reason?: string;
          },
        );
      },
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      hooks,
    });

    await expect(async () => {
      for await (const _chunk of result.getTextStream()) {
        // consume until the mid-stream error propagates
      }
    }).rejects.toThrow('network dropped mid-stream');

    expect(events).toEqual([
      'start',
      'end',
    ]);
    expect(ends[0]).toMatchObject({
      reason: 'error',
    });
  });

  it('emits SessionEnd(error) when initStream fails on secondary (non-streaming) entry points', async () => {
    // getToolCalls / getState / getPendingToolCalls / requiresApproval /
    // getContextUpdates / getNewMessagesStream / getToolCallsStream may be
    // the FIRST method called on a ModelResult. If the initial API call
    // fails after SessionStart, they must tear the session down too —
    // same contract as the primary streaming getters.
    const entryPoints: Array<{
      name: string;
      invoke: (result: ReturnType<typeof callModel>) => Promise<unknown>;
    }> = [
      {
        name: 'getToolCalls',
        invoke: (r) => r.getToolCalls(),
      },
      {
        name: 'getState',
        invoke: (r) => r.getState(),
      },
      {
        name: 'getPendingToolCalls',
        invoke: (r) => r.getPendingToolCalls(),
      },
      {
        name: 'requiresApproval',
        invoke: (r) => r.requiresApproval(),
      },
      {
        name: 'getContextUpdates',
        invoke: async (r) => {
          for await (const _u of r.getContextUpdates()) {
            // consume
          }
        },
      },
      {
        name: 'getNewMessagesStream',
        invoke: async (r) => {
          for await (const _m of r.getNewMessagesStream()) {
            // consume
          }
        },
      },
      {
        name: 'getToolCallsStream',
        invoke: async (r) => {
          for await (const _c of r.getToolCallsStream()) {
            // consume
          }
        },
      },
    ];

    for (const entry of entryPoints) {
      mockBetaResponsesSend.mockReset();
      mockBetaResponsesSend.mockResolvedValue({
        ok: false,
        error: new Error(`api failed for ${entry.name}`),
      });

      const hooks = new HooksManager();
      const starts: unknown[] = [];
      const ends: {
        reason?: string;
      }[] = [];
      hooks.on('SessionStart', {
        handler: (payload) => {
          starts.push(payload);
        },
      });
      hooks.on('SessionEnd', {
        handler: (payload) => {
          ends.push(
            payload as {
              reason?: string;
            },
          );
        },
      });

      const result = callModel(client, {
        model: 'test-model',
        input: 'hi',
        hooks,
      });

      await expect(entry.invoke(result)).rejects.toThrow(`api failed for ${entry.name}`);

      expect(starts, `${entry.name}: SessionStart count`).toHaveLength(1);
      expect(ends, `${entry.name}: SessionEnd count`).toHaveLength(1);
      expect(ends[0], `${entry.name}: SessionEnd reason`).toMatchObject({
        reason: 'error',
      });
    }
  });

  it('teardown does not mask the original error when a SessionEnd handler throws', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse('r1'),
      })
      // Follow-up request fails -> the loop throws the original error.
      .mockResolvedValueOnce({
        ok: false,
        error: new Error('api exploded'),
      });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hooks = new HooksManager(undefined, {
      throwOnHandlerError: true,
    });
    hooks.on('SessionEnd', {
      handler: () => {
        throw new Error('teardown handler boom');
      },
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        makeEchoTool(),
      ],
      hooks,
    });

    // The ORIGINAL error must surface, not the SessionEnd handler's throw.
    await expect(result.getResponse()).rejects.toThrow('api exploded');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('session teardown'),
      expect.any(Error),
    );
  });

  it('strips hooks from the outgoing API request on both request-resolution paths', async () => {
    // `hooks` is a client-only field. callModel destructures it before the
    // request reaches ModelResult, but ModelResult is publicly exported and
    // its constructor accepts a request that may still carry `hooks` (e.g.
    // direct construction). Both resolveRequestForContext branches -- the
    // non-async destructuring path and the async clientOnlyFields path --
    // must strip it so a HooksManager object is never sent to the API.
    mockBetaResponsesSend.mockResolvedValue({
      ok: true,
      value: textResponse(),
    });

    const hooks = new HooksManager();

    // Path 1: non-async request (manual destructuring branch), constructed
    // directly so `hooks` is still present on the request object.
    const direct = new ModelResult({
      client,
      request: {
        model: 'test-model',
        input: 'hi',
        hooks,
      },
      hooks,
    } as unknown as ConstructorParameters<typeof ModelResult>[0]);
    await direct.getText();

    // Path 2: async request (clientOnlyFields branch in async-params).
    const withAsync = new ModelResult({
      client,
      request: {
        model: 'test-model',
        input: 'hi',
        temperature: async () => 0.5,
        hooks,
      },
      hooks,
    } as unknown as ConstructorParameters<typeof ModelResult>[0]);
    await withAsync.getText();

    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    for (const call of mockBetaResponsesSend.mock.calls) {
      const sentRequest = (
        call[1] as {
          responsesRequest: Record<string, unknown>;
        }
      ).responsesRequest;
      expect(sentRequest).not.toHaveProperty('hooks');
    }
  });
});
