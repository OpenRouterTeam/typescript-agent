import type { OpenRouterCore } from '@openrouter/sdk/core';
import type {
  OpenResponsesStreamEvent,
  OpenResponsesStreamEventResponseCompleted,
  OpenResponsesStreamEventResponseFunctionCallArgumentsDelta,
  OpenResponsesStreamEventResponseFunctionCallArgumentsDone,
  OpenResponsesStreamEventResponseOutputItemAdded,
  OpenResponsesStreamEventResponseOutputItemDone,
} from '@openrouter/sdk/models/openresponsesstreamevent';
import type { OutputFunctionCallItem } from '@openrouter/sdk/models/outputfunctioncallitem';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { ModelResult } from '../../src/lib/model-result.js';
import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import type { StreamableOutputItem } from '../../src/lib/stream-transformers.js';
import { isFunctionCallItem } from '../../src/lib/stream-type-guards.js';
import { ToolType } from '../../src/lib/tool-types.js';

// ============================================================================
// Synthetic event factories
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

function outputItemAddedFunctionCallEvent(
  callId: string,
  name: string,
  itemId: string,
): OpenResponsesStreamEventResponseOutputItemAdded {
  return {
    type: 'response.output_item.added',
    outputIndex: 0,
    item: {
      type: 'function_call',
      id: itemId,
      callId,
      name,
      arguments: '',
      status: 'in_progress',
    },
    sequenceNumber: 0,
  };
}

function functionCallArgsDeltaEvent(
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

function functionCallArgsDoneEvent(
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

// biome-ignore lint: test helper function
function outputItemDoneFunctionCallEvent(
  callId: string,
  name: string,
  args: string,
  itemId: string,
): OpenResponsesStreamEventResponseOutputItemDone {
  return {
    type: 'response.output_item.done',
    outputIndex: 0,
    item: {
      type: 'function_call',
      id: itemId,
      callId,
      name,
      arguments: args,
      status: 'completed',
    },
    sequenceNumber: 0,
  };
}

function responseCompletedEvent(
  functionCallItem: OutputFunctionCallItem,
): OpenResponsesStreamEventResponseCompleted {
  return {
    type: 'response.completed',
    response: {
      id: 'resp_test_1',
      object: 'response',
      createdAt: 0,
      model: 'test-model',
      status: 'completed',
      completedAt: 0,
      output: [
        functionCallItem,
      ],
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

// ============================================================================
// Tests
// ============================================================================

describe('getItemsStream with manual tools — duplicate detection', () => {
  const CALL_ID = 'call_test_1';
  const ITEM_ID = 'fc_test_1';
  const TOOL_NAME = 'submit_report';
  const ARGS = '{"summary":"Tokyo weather is sunny"}';

  const completedFunctionCallItem: OutputFunctionCallItem = {
    type: 'function_call',
    id: ITEM_ID,
    callId: CALL_ID,
    name: TOOL_NAME,
    arguments: ARGS,
    status: 'completed',
  };

  const streamEvents: OpenResponsesStreamEvent[] = [
    outputItemAddedFunctionCallEvent(CALL_ID, TOOL_NAME, ITEM_ID),
    functionCallArgsDeltaEvent('{"summary":', ITEM_ID),
    functionCallArgsDeltaEvent('"Tokyo weather is sunny"}', ITEM_ID),
    functionCallArgsDoneEvent(ARGS, TOOL_NAME, ITEM_ID),
    outputItemDoneFunctionCallEvent(CALL_ID, TOOL_NAME, ARGS, ITEM_ID),
    responseCompletedEvent(completedFunctionCallItem),
  ];

  it('should not yield duplicate function_call items when only manual tools are present', async () => {
    const manualTool = {
      type: ToolType.Function,
      function: {
        name: TOOL_NAME,
        description: 'Submit a weather report summary.',
        inputSchema: z.object({
          summary: z.string(),
        }),
        outputSchema: z.object({
          success: z.boolean(),
        }),
      },
    } as const;

    const modelResult = new ModelResult({
      request: {
        model: 'test-model',
        input: 'test',
      },
      client: {} as unknown as OpenRouterCore,
      tools: [
        manualTool,
      ],
    });

    // Bypass initStream by directly setting private fields.
    // Double-cast required to access private properties for test setup.
    const internal = modelResult as unknown as Record<string, unknown>;
    internal['reusableStream'] = createImmediateStream(streamEvents);
    internal['initPromise'] = Promise.resolve();

    // Consume getItemsStream and collect all items
    const items: StreamableOutputItem[] = [];
    for await (const item of modelResult.getItemsStream()) {
      items.push(item);
    }

    // Filter to completed function_call items only
    const completedFunctionCalls = items.filter(
      (item) => isFunctionCallItem(item) && item.status === 'completed',
    );

    // If the bug exists, this will be 2 (once from buildItemsStream, once from yieldManualToolCalls).
    // Correct behavior: exactly 1 completed function_call per tool call.
    expect(completedFunctionCalls).toHaveLength(1);
  });
});
