import type {
  OpenResponsesStreamEvent,
  OpenResponsesStreamEventResponseCompleted,
  OpenResponsesStreamEventResponseFunctionCallArgumentsDelta,
  OpenResponsesStreamEventResponseFunctionCallArgumentsDone,
  OpenResponsesStreamEventResponseOutputItemAdded,
  OpenResponsesStreamEventResponseOutputItemDone,
} from '@openrouter/sdk/models/openresponsesstreamevent';
import type { OutputFunctionCallItem } from '@openrouter/sdk/models/outputfunctioncallitem';
import type { OpenRouterCore } from '@openrouter/sdk/core';
import type { StreamableOutputItem } from '../../src/lib/stream-transformers.js';
import type { OpenResponsesResult } from '@openrouter/sdk/models/openresponsesresult';

import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import { ModelResult } from '../../src/lib/model-result.js';
import { ToolType } from '../../src/lib/tool-types.js';
import { isFunctionCallItem } from '../../src/lib/stream-type-guards.js';

// ============================================================================
// Helpers
// ============================================================================

function createImmediateStream(
  events: OpenResponsesStreamEvent[],
): ReusableReadableStream<OpenResponsesStreamEvent> {
  const readable = new ReadableStream<OpenResponsesStreamEvent>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    },
  });
  return new ReusableReadableStream(readable);
}

function makeFunctionCallItem(
  callId: string,
  name: string,
  args: string,
  itemId: string,
  status: 'completed' | 'in_progress' = 'completed',
): OutputFunctionCallItem {
  return { type: 'function_call', id: itemId, callId, name, arguments: args, status };
}

function outputItemAddedEvent(
  callId: string,
  name: string,
  itemId: string,
): OpenResponsesStreamEventResponseOutputItemAdded {
  return {
    type: 'response.output_item.added',
    outputIndex: 0,
    item: { type: 'function_call', id: itemId, callId, name, arguments: '', status: 'in_progress' },
    sequenceNumber: 0,
  };
}

function argsDeltaEvent(
  delta: string,
  itemId: string,
): OpenResponsesStreamEventResponseFunctionCallArgumentsDelta {
  return {
    type: 'response.function_call_arguments.delta',
    itemId,
    outputIndex: 0,
    delta,
    sequenceNumber: 0,
  };
}

function argsDoneEvent(
  args: string,
  name: string,
  itemId: string,
): OpenResponsesStreamEventResponseFunctionCallArgumentsDone {
  return {
    type: 'response.function_call_arguments.done',
    itemId,
    outputIndex: 0,
    name,
    arguments: args,
    sequenceNumber: 0,
  };
}

function outputItemDoneEvent(
  callId: string,
  name: string,
  args: string,
  itemId: string,
): OpenResponsesStreamEventResponseOutputItemDone {
  return {
    type: 'response.output_item.done',
    outputIndex: 0,
    item: { type: 'function_call', id: itemId, callId, name, arguments: args, status: 'completed' },
    sequenceNumber: 0,
  };
}

function responseCompletedEvent(
  output: OpenResponsesResult['output'],
): OpenResponsesStreamEventResponseCompleted {
  return {
    type: 'response.completed',
    response: {
      id: 'resp_test',
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
    },
    sequenceNumber: 0,
  };
}

function makeResponse(output: OpenResponsesResult['output']): OpenResponsesResult {
  return {
    id: 'resp_test',
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

function manualTool(name: string) {
  return {
    type: ToolType.Function,
    function: {
      name,
      description: `Manual tool: ${name}`,
      inputSchema: z.object({ data: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
    },
  } as const;
}

function autoTool(name: string) {
  return {
    type: ToolType.Function,
    function: {
      name,
      description: `Auto tool: ${name}`,
      inputSchema: z.object({ data: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    },
  } as const;
}

type InternalModelResult = Record<string, unknown>;

function setupModelResult(
  tools: readonly ReturnType<typeof manualTool | typeof autoTool>[],
  events: OpenResponsesStreamEvent[],
  overrides?: {
    finalResponse?: OpenResponsesResult | null;
    allToolExecutionRounds?: Array<{
      round: number;
      toolCalls: Array<{ id: string; name: string; arguments: string }>;
      response: OpenResponsesResult;
      toolResults: Array<{ type: 'function_call_output'; callId: string; output: string }>;
    }>;
  },
) {
  const modelResult = new ModelResult({
    request: { model: 'test-model', input: 'test' },
    client: {} as unknown as OpenRouterCore,
    tools,
  });

  const internal = modelResult as unknown as InternalModelResult;
  internal['reusableStream'] = createImmediateStream(events);
  internal['initPromise'] = Promise.resolve();

  if (overrides?.finalResponse !== undefined) {
    internal['finalResponse'] = overrides.finalResponse;
  }
  if (overrides?.allToolExecutionRounds) {
    internal['allToolExecutionRounds'] = overrides.allToolExecutionRounds;
    // Prevent executeToolsIfNeeded from running the actual tool execution loop
    internal['toolExecutionPromise'] = Promise.resolve();
  }

  return modelResult;
}

function streamEventsForToolCall(callId: string, name: string, args: string, itemId: string) {
  return [
    outputItemAddedEvent(callId, name, itemId),
    argsDeltaEvent(args, itemId),
    argsDoneEvent(args, name, itemId),
    outputItemDoneEvent(callId, name, args, itemId),
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe('manual tool calls — adversarial edge cases', () => {
  // -------------------------------------------------------------------------
  // getNewMessagesStream: duplicate suppression
  // -------------------------------------------------------------------------
  describe('getNewMessagesStream duplicate suppression', () => {
    it('should NOT double-yield a manual tool call that was already yielded via allToolExecutionRounds', async () => {
      // Scenario: A mixed-tools response where the model called both an auto
      // and a manual tool. The auto tool executed, creating a round whose
      // response.output contains BOTH the auto AND manual function_call items.
      // The manual call also appears in finalResponse.
      // getNewMessagesStream yields from rounds AND from yieldManualToolCalls —
      // the manual call must appear exactly once.
      const manualFc = makeFunctionCallItem('call_m1', 'submit', '{"data":"x"}', 'fc_m1');
      const autoFc = makeFunctionCallItem('call_a1', 'fetch_data', '{"data":"y"}', 'fc_a1');

      const roundResponse = makeResponse([autoFc, manualFc]);
      const finalResp = makeResponse([manualFc]);

      const modelResult = setupModelResult(
        [autoTool('fetch_data'), manualTool('submit')],
        [], // no stream events needed — we drive via rounds + finalResponse
        {
          finalResponse: finalResp,
          allToolExecutionRounds: [
            {
              round: 1,
              toolCalls: [
                { id: 'call_a1', name: 'fetch_data', arguments: '{"data":"y"}' },
              ],
              response: roundResponse,
              toolResults: [
                { type: 'function_call_output', callId: 'call_a1', output: '{"ok":true}' },
              ],
            },
          ],
        },
      );

      const items: unknown[] = [];
      for await (const item of modelResult.getNewMessagesStream()) {
        items.push(item);
      }

      // Both function_call items from the round are yielded (auto + manual),
      // PLUS yieldManualToolCalls may try to yield the manual one again from finalResponse.
      // Count how many times the manual tool call appears.
      const manualCalls = items.filter(
        (i) => typeof i === 'object' && i !== null && 'type' in i &&
          (i as OutputFunctionCallItem).type === 'function_call' &&
          (i as OutputFunctionCallItem).name === 'submit',
      );

      // With callId-based dedup, the manual tool call should appear exactly once
      expect(manualCalls).toHaveLength(1);
    });

    it('should yield manual tool calls from finalResponse when no rounds executed (pure manual scenario)', async () => {
      const manualFc = makeFunctionCallItem('call_m1', 'submit', '{"data":"x"}', 'fc_m1');
      const finalResp = makeResponse([manualFc]);

      const modelResult = setupModelResult(
        [manualTool('submit')],
        [], // no stream events — finalResponse only
        {
          finalResponse: finalResp,
          allToolExecutionRounds: [], // no auto-execute happened
        },
      );

      const items: unknown[] = [];
      for await (const item of modelResult.getNewMessagesStream()) {
        items.push(item);
      }

      const manualCalls = items.filter(
        (i) => typeof i === 'object' && i !== null && 'type' in i &&
          (i as OutputFunctionCallItem).type === 'function_call' &&
          (i as OutputFunctionCallItem).name === 'submit',
      );

      expect(manualCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple manual tools in a single response
  // -------------------------------------------------------------------------
  describe('multiple manual tools in single response', () => {
    it('should yield all manual tool calls when model invokes several manual tools at once', async () => {
      const fc1 = makeFunctionCallItem('call_1', 'tool_a', '{"data":"a"}', 'fc_1');
      const fc2 = makeFunctionCallItem('call_2', 'tool_b', '{"data":"b"}', 'fc_2');
      const fc3 = makeFunctionCallItem('call_3', 'tool_c', '{"data":"c"}', 'fc_3');

      const finalResp = makeResponse([fc1, fc2, fc3]);

      const modelResult = setupModelResult(
        [manualTool('tool_a'), manualTool('tool_b'), manualTool('tool_c')],
        [],
        { finalResponse: finalResp, allToolExecutionRounds: [] },
      );

      const items: unknown[] = [];
      for await (const item of modelResult.getNewMessagesStream()) {
        items.push(item);
      }

      const calls = items.filter(
        (i) => typeof i === 'object' && i !== null && 'type' in i &&
          (i as OutputFunctionCallItem).type === 'function_call',
      );

      expect(calls).toHaveLength(3);
      const names = calls.map((c) => (c as OutputFunctionCallItem).name);
      expect(names).toEqual(['tool_a', 'tool_b', 'tool_c']);
    });
  });

  // -------------------------------------------------------------------------
  // Unknown tool name in response (not in tools list)
  // -------------------------------------------------------------------------
  describe('unknown tool name handling', () => {
    it('should NOT yield function_call for a tool name that does not exist in the tools list', async () => {
      // Model hallucinated a tool name that isn't registered
      const unknownFc = makeFunctionCallItem('call_u1', 'nonexistent_tool', '{"data":"x"}', 'fc_u1');
      const finalResp = makeResponse([unknownFc]);

      const modelResult = setupModelResult(
        [manualTool('real_tool')],
        [],
        { finalResponse: finalResp, allToolExecutionRounds: [] },
      );

      const items: unknown[] = [];
      for await (const item of modelResult.getNewMessagesStream()) {
        items.push(item);
      }

      const calls = items.filter(
        (i) => typeof i === 'object' && i !== null && 'type' in i &&
          (i as OutputFunctionCallItem).type === 'function_call',
      );

      // isManualToolCall requires the tool to be in the tools list, so unknown tools
      // should NOT be yielded by yieldManualToolCalls
      expect(calls).toHaveLength(0);
    });

    it('should NOT yield auto-execute tools via yieldManualToolCalls', async () => {
      // An auto-execute tool in finalResponse should not be yielded as a manual call.
      // We set allToolExecutionRounds to simulate that the auto tool already ran,
      // and finalResponse contains the auto tool's function_call.
      const autoFc = makeFunctionCallItem('call_a1', 'auto_fetch', '{"data":"x"}', 'fc_a1');
      const roundResponse = makeResponse([autoFc]);
      const finalResp = makeResponse([autoFc]);

      const modelResult = setupModelResult(
        [autoTool('auto_fetch')],
        [],
        {
          finalResponse: finalResp,
          allToolExecutionRounds: [
            {
              round: 1,
              toolCalls: [{ id: 'call_a1', name: 'auto_fetch', arguments: '{"data":"x"}' }],
              response: roundResponse,
              toolResults: [
                { type: 'function_call_output', callId: 'call_a1', output: '{"ok":true}' },
              ],
            },
          ],
        },
      );

      const items: unknown[] = [];
      for await (const item of modelResult.getNewMessagesStream()) {
        items.push(item);
      }

      // yieldManualToolCalls should NOT yield auto_fetch because it has an execute function.
      // The only function_calls should come from the round iteration, not from yieldManualToolCalls.
      const manualCalls = items.filter(
        (i) => typeof i === 'object' && i !== null && 'type' in i &&
          (i as OutputFunctionCallItem).type === 'function_call' &&
          (i as OutputFunctionCallItem).name === 'auto_fetch',
      );

      // The round yields it once. yieldManualToolCalls should NOT add a second.
      expect(manualCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Empty / null finalResponse
  // -------------------------------------------------------------------------
  describe('null and empty finalResponse', () => {
    it('should not crash when finalResponse is null and stream has a completion event', async () => {
      // Provide a valid completion event so the stream doesn't throw
      const completionEvent = responseCompletedEvent([]);

      const modelResult = setupModelResult(
        [manualTool('submit')],
        [completionEvent],
        { finalResponse: null, allToolExecutionRounds: [] },
      );

      const items: unknown[] = [];
      for await (const item of modelResult.getNewMessagesStream()) {
        items.push(item);
      }

      expect(items).toHaveLength(0);
    });

    it('should not crash when finalResponse.output is empty', async () => {
      const finalResp = makeResponse([]);

      const modelResult = setupModelResult(
        [manualTool('submit')],
        [],
        { finalResponse: finalResp, allToolExecutionRounds: [] },
      );

      const items: unknown[] = [];
      for await (const item of modelResult.getNewMessagesStream()) {
        items.push(item);
      }

      expect(items).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Non-function_call items in finalResponse should be ignored
  // -------------------------------------------------------------------------
  describe('non-function_call items in finalResponse', () => {
    it('should only yield function_call items from yieldManualToolCalls, ignoring messages and other types', async () => {
      const manualFc = makeFunctionCallItem('call_m1', 'submit', '{"data":"x"}', 'fc_m1');
      const messageItem = {
        type: 'message' as const,
        id: 'msg_1',
        role: 'assistant' as const,
        status: 'completed' as const,
        content: [{ type: 'output_text' as const, text: 'Here is your result', annotations: [] }],
      };

      const finalResp = makeResponse([messageItem, manualFc]);

      const modelResult = setupModelResult(
        [manualTool('submit')],
        [],
        { finalResponse: finalResp, allToolExecutionRounds: [] },
      );

      const items: unknown[] = [];
      for await (const item of modelResult.getNewMessagesStream()) {
        items.push(item);
      }

      const calls = items.filter(
        (i) => typeof i === 'object' && i !== null && 'type' in i &&
          (i as OutputFunctionCallItem).type === 'function_call',
      );

      // Only the manual function_call should be yielded — message items are
      // handled separately by the final message extraction logic, not by yieldManualToolCalls
      expect(calls).toHaveLength(1);
      expect((calls[0] as OutputFunctionCallItem).name).toBe('submit');
    });
  });

  // -------------------------------------------------------------------------
  // getItemsStream: mixed auto + manual — no duplication
  // -------------------------------------------------------------------------
  describe('getItemsStream with only manual tools — no duplication', () => {
    it('should yield exactly one completed function_call per manual tool call', async () => {
      const manualName = 'submit';
      const manualArgs = '{"data":"manual"}';

      const manualFc = makeFunctionCallItem('call_m1', manualName, manualArgs, 'fc_m1');

      const events: OpenResponsesStreamEvent[] = [
        ...streamEventsForToolCall('call_m1', manualName, manualArgs, 'fc_m1'),
        responseCompletedEvent([manualFc]),
      ];

      const modelResult = setupModelResult(
        [manualTool(manualName)],
        events,
      );

      const items: StreamableOutputItem[] = [];
      for await (const item of modelResult.getItemsStream()) {
        items.push(item);
      }

      const completedFunctionCalls = items.filter(
        (item) => isFunctionCallItem(item) && item.status === 'completed',
      );

      // The existing PR test already covers this, but here we also verify
      // that the tool name and arguments are correct
      expect(completedFunctionCalls).toHaveLength(1);
      expect((completedFunctionCalls[0] as OutputFunctionCallItem).name).toBe(manualName);
      expect((completedFunctionCalls[0] as OutputFunctionCallItem).arguments).toBe(manualArgs);
    });

    it('should yield multiple manual tools without duplication in getItemsStream', async () => {
      const fc1 = makeFunctionCallItem('call_1', 'tool_a', '{"data":"a"}', 'fc_1');
      const fc2 = makeFunctionCallItem('call_2', 'tool_b', '{"data":"b"}', 'fc_2');

      const events: OpenResponsesStreamEvent[] = [
        ...streamEventsForToolCall('call_1', 'tool_a', '{"data":"a"}', 'fc_1'),
        ...streamEventsForToolCall('call_2', 'tool_b', '{"data":"b"}', 'fc_2'),
        responseCompletedEvent([fc1, fc2]),
      ];

      const modelResult = setupModelResult(
        [manualTool('tool_a'), manualTool('tool_b')],
        events,
      );

      const items: StreamableOutputItem[] = [];
      for await (const item of modelResult.getItemsStream()) {
        items.push(item);
      }

      const completedFunctionCalls = items.filter(
        (item) => isFunctionCallItem(item) && item.status === 'completed',
      );

      expect(completedFunctionCalls).toHaveLength(2);
      const names = completedFunctionCalls.map(
        (fc) => (fc as OutputFunctionCallItem).name,
      );
      expect(names).toContain('tool_a');
      expect(names).toContain('tool_b');
    });
  });

  // -------------------------------------------------------------------------
  // Tool with empty arguments
  // -------------------------------------------------------------------------
  describe('edge case: empty arguments string', () => {
    it('should yield manual tool call even when arguments is an empty string', async () => {
      const fc = makeFunctionCallItem('call_1', 'no_args_tool', '', 'fc_1');
      const finalResp = makeResponse([fc]);

      const modelResult = setupModelResult(
        [manualTool('no_args_tool')],
        [],
        { finalResponse: finalResp, allToolExecutionRounds: [] },
      );

      const items: unknown[] = [];
      for await (const item of modelResult.getNewMessagesStream()) {
        items.push(item);
      }

      const calls = items.filter(
        (i) => typeof i === 'object' && i !== null && 'type' in i &&
          (i as OutputFunctionCallItem).type === 'function_call',
      );

      expect(calls).toHaveLength(1);
      expect((calls[0] as OutputFunctionCallItem).arguments).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // in_progress status tool call in finalResponse
  // -------------------------------------------------------------------------
  describe('edge case: in_progress function_call in finalResponse', () => {
    it('should still yield manual tool calls even with in_progress status', async () => {
      // Sometimes the API may return items with unexpected statuses
      const fc = makeFunctionCallItem('call_1', 'submit', '{"data":"x"}', 'fc_1', 'in_progress');
      const finalResp = makeResponse([fc]);

      const modelResult = setupModelResult(
        [manualTool('submit')],
        [],
        { finalResponse: finalResp, allToolExecutionRounds: [] },
      );

      const items: unknown[] = [];
      for await (const item of modelResult.getNewMessagesStream()) {
        items.push(item);
      }

      const calls = items.filter(
        (i) => typeof i === 'object' && i !== null && 'type' in i &&
          (i as OutputFunctionCallItem).type === 'function_call',
      );

      // yieldManualToolCalls checks isFunctionCallItem (type === 'function_call')
      // and isManualToolCall but does NOT filter by status,
      // so in_progress items should still be yielded
      expect(calls).toHaveLength(1);
      expect((calls[0] as OutputFunctionCallItem).status).toBe('in_progress');
    });
  });

  // -------------------------------------------------------------------------
  // No tools configured at all
  // -------------------------------------------------------------------------
  describe('edge case: no tools configured', () => {
    it('should not crash when tools array is empty and finalResponse has function_calls', async () => {
      const fc = makeFunctionCallItem('call_1', 'ghost_tool', '{"data":"x"}', 'fc_1');
      const finalResp = makeResponse([fc]);

      const modelResult = new ModelResult({
        request: { model: 'test-model', input: 'test' },
        client: {} as unknown as OpenRouterCore,
        tools: [],
      });

      const internal = modelResult as unknown as InternalModelResult;
      internal['reusableStream'] = createImmediateStream([]);
      internal['initPromise'] = Promise.resolve();
      internal['finalResponse'] = finalResp;
      internal['allToolExecutionRounds'] = [];

      const items: unknown[] = [];
      for await (const item of modelResult.getNewMessagesStream()) {
        items.push(item);
      }

      // No tools registered, so isManualToolCall returns false for everything
      const calls = items.filter(
        (i) => typeof i === 'object' && i !== null && 'type' in i &&
          (i as OutputFunctionCallItem).type === 'function_call',
      );
      expect(calls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Ordering: manual tool calls should appear BEFORE the final message
  // -------------------------------------------------------------------------
  describe('ordering: manual tool calls before final message', () => {
    it('should yield manual tool function_calls before the final message in getNewMessagesStream', async () => {
      const manualFc = makeFunctionCallItem('call_m1', 'submit', '{"data":"x"}', 'fc_m1');
      const autoFc = makeFunctionCallItem('call_a1', 'fetch_data', '{"data":"y"}', 'fc_a1');
      const messageItem = {
        type: 'message' as const,
        id: 'msg_1',
        role: 'assistant' as const,
        status: 'completed' as const,
        content: [{ type: 'output_text' as const, text: 'Done!', annotations: [] }],
      };

      const roundResponse = makeResponse([autoFc]);
      const finalResp = makeResponse([manualFc, messageItem]);

      const modelResult = setupModelResult(
        [autoTool('fetch_data'), manualTool('submit')],
        [],
        {
          finalResponse: finalResp,
          allToolExecutionRounds: [
            {
              round: 1,
              toolCalls: [{ id: 'call_a1', name: 'fetch_data', arguments: '{"data":"y"}' }],
              response: roundResponse,
              toolResults: [
                { type: 'function_call_output', callId: 'call_a1', output: '{"ok":true}' },
              ],
            },
          ],
        },
      );

      const items: unknown[] = [];
      for await (const item of modelResult.getNewMessagesStream()) {
        items.push(item);
      }

      // Find indices of manual function_call and message
      const manualIdx = items.findIndex(
        (i) => typeof i === 'object' && i !== null && 'type' in i &&
          (i as OutputFunctionCallItem).type === 'function_call' &&
          (i as OutputFunctionCallItem).name === 'submit',
      );
      const messageIdx = items.findIndex(
        (i) => typeof i === 'object' && i !== null && 'type' in i &&
          (i as { type: string }).type === 'message',
      );

      // Manual tool calls must come before the message
      expect(manualIdx).toBeGreaterThanOrEqual(0);
      expect(messageIdx).toBeGreaterThanOrEqual(0);
      expect(manualIdx).toBeLessThan(messageIdx);
    });
  });
});
