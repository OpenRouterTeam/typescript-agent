import type { OpenRouterCore } from '@openrouter/sdk/core';
import { betaResponsesSend } from '@openrouter/sdk/funcs/betaResponsesSend';
import type { EventStream } from '@openrouter/sdk/lib/event-streams';
import type { RequestOptions } from '@openrouter/sdk/lib/sdks';
import type * as models from '@openrouter/sdk/models';
import type { $ZodObject, $ZodShape } from 'zod/v4/core';
import type { CallModelInput, ResolvedCallModelInput } from './async-params.js';
import { hasAsyncFunctions, resolveAsyncFunctions } from './async-params.js';
import {
  appendToMessages,
  createInitialState,
  createRejectedResult,
  createUnsentResult,
  extractTextFromResponse as extractTextFromResponseState,
  partitionToolCalls,
  unsentResultsToAPIFormat,
  updateState,
} from './conversation-state.js';
import type { HooksManager } from './hooks-manager.js';
import type { ModelCallUsage, PostModelCallPayload } from './hooks-types.js';
import {
  applyNextTurnParamsToRequest,
  executeNextTurnParamsFunctions,
} from './next-turn-params.js';
import { ReusableReadableStream } from './reusable-stream.js';
import { isStopConditionMet } from './stop-conditions.js';
import type { ItemInProgress, StreamableOutputItem } from './stream-transformers.js';
import {
  buildItemsStream,
  buildResponsesMessageStream,
  buildToolCallStream,
  consumeStreamForCompletion,
  extractReasoningDeltas,
  extractResponsesMessageFromResponse,
  extractTextDeltas,
  extractTextFromResponse,
  extractToolCallsFromResponse,
  extractToolDeltas,
  itemsStreamHandlers,
  streamTerminationEvents,
} from './stream-transformers.js';
import {
  hasTypeProperty,
  isFunctionCallItem,
  isFunctionCallOutputItem,
  isOutputTextDeltaEvent,
  isReasoningDeltaEvent,
  isResponseCompletedEvent,
  isResponseFailedEvent,
  isResponseIncompleteEvent,
  isServerToolResultItem,
} from './stream-type-guards.js';
import type { ContextInput } from './tool-context.js';
import { resolveContext, ToolContextStore } from './tool-context.js';
import { ToolEventBroadcaster } from './tool-event-broadcaster.js';
import { applyOnResponseReceivedHooks, executeTool } from './tool-executor.js';
import type {
  ConversationState,
  ConversationStatus,
  InferToolEventsUnion,
  InferToolOutputsUnion,
  ParsedToolCall,
  ResponseStreamEvent,
  ServerToolResultItem,
  StateAccessor,
  StopWhen,
  Tool,
  ToolCallOutputEvent,
  ToolContextMapWithShared,
  ToolResultItem,
  ToolStreamEvent,
  TurnContext,
  TurnEndEvent,
  TurnStartEvent,
  UnsentToolResult,
} from './tool-types.js';
import {
  isAutoResolvableTool,
  isClientTool,
  isMcpTool,
  isServerTool,
  isToolCallOutputEvent,
} from './tool-types.js';
import { normalizeInputToArray } from './turn-context.js';

/**
 * Typeguard for plain-object records (non-null, non-array).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Cap consecutive Stop-hook forceResume overrides so a misbehaving handler
// cannot spin the loop forever. 3 is a conservative upper bound -- enough to
// let a hook gather a couple of follow-up actions but small enough that a
// buggy handler fails fast with a visible warning.
const MAX_FORCE_RESUME_OVERRIDES = 3;

/**
 * Human-readable label for a value that failed the `isRecord` check. Used
 * exclusively to make `toModelOutput` misuse errors specific.
 */
function describeNonRecord(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Type guard for stream event responses
 * Checks constructor name and readable stream behavior
 */
function isEventStream(value: unknown): value is EventStream<models.StreamEvents> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) {
    return true;
  }

  const maybeStream = value as {
    getReader?: unknown;
  };
  return typeof maybeStream.getReader === 'function';
}

/**
 * Map the server's usage block onto the hook-facing ModelCallUsage shape.
 * Returns undefined when the response carried no usage accounting.
 */
function extractModelCallUsage(usage: models.Usage | null | undefined): ModelCallUsage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedTokens: usage.inputTokensDetails?.cachedTokens ?? 0,
    reasoningTokens: usage.outputTokensDetails?.reasoningTokens ?? 0,
    ...(usage.cost !== null &&
      usage.cost !== undefined && {
        cost: usage.cost,
      }),
  };
}

/**
 * Type guard for an input message with a user role and a string `content`.
 * These are the messages we can safely surface to UserPromptSubmit hooks.
 */
function isUserStringMessage(value: unknown): value is {
  role: 'user';
  content: string;
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as {
    role?: unknown;
    content?: unknown;
  };
  return obj.role === 'user' && typeof obj.content === 'string';
}

/**
 * Find the index of the last user-role, string-content message in an input
 * array. Returns -1 when no such message exists.
 */
function findLatestUserStringIndex(arr: readonly unknown[]): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (isUserStringMessage(arr[i])) {
      return i;
    }
  }
  return -1;
}

/**
 * Extract a user-facing prompt string from an input (string or message array),
 * and return an applier that writes a mutated prompt back into the same shape.
 *
 * For structured inputs we look at the LAST user message with a string
 * content — this is the most common shape emitted by the SDK's own helpers
 * (`normalizeInputToArray`) and matches what a handler would reasonably
 * expect to mutate.
 *
 * Returns `{ prompt: undefined }` when no usable prompt can be extracted; the
 * caller should skip the hook in that case.
 */
function extractPromptAndApplier(input: models.InputsUnion): {
  prompt: string | undefined;
  applyMutated: (mutated: string, original: models.InputsUnion | undefined) => models.InputsUnion;
} {
  if (typeof input === 'string') {
    return {
      prompt: input,
      applyMutated: (mutated) => mutated,
    };
  }

  if (Array.isArray(input)) {
    const targetIndex = findLatestUserStringIndex(input);

    if (targetIndex === -1) {
      return {
        prompt: undefined,
        applyMutated: (_mutated, original) => original ?? input,
      };
    }

    const target = input[targetIndex];
    if (!isUserStringMessage(target)) {
      return {
        prompt: undefined,
        applyMutated: (_mutated, original) => original ?? input,
      };
    }

    return {
      prompt: target.content,
      applyMutated: (mutated, original) => {
        // Re-derive the target index from the effective base array so an
        // arbitrary `original` shape lands the mutation in the correct slot
        // rather than the closed-over index from the initial extraction.
        const base = Array.isArray(original) ? original : input;
        const idx = findLatestUserStringIndex(base);
        if (idx === -1) {
          return base;
        }
        const out = [
          ...base,
        ];
        const existing = out[idx];
        if (isUserStringMessage(existing)) {
          out[idx] = {
            ...existing,
            content: mutated,
          };
        }
        return out;
      },
    };
  }

  return {
    prompt: undefined,
    applyMutated: (_mutated, original) => original ?? input,
  };
}

export interface GetResponseOptions<
  TTools extends readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, never>,
> {
  // Request can have async functions that will be resolved before sending to API
  request: CallModelInput<TTools, TShared>;
  client: OpenRouterCore;
  options?: RequestOptions;
  tools?: TTools;
  stopWhen?: StopWhen<TTools>;
  // State management for multi-turn conversations
  state?: StateAccessor<TTools>;
  /** Typed context data passed to tools via contextSchema. `shared` key for shared context. */
  context?: ContextInput<ToolContextMapWithShared<TTools, TShared>>;
  /** Zod schema for shared context validation */
  sharedContextSchema?: $ZodObject<$ZodShape>;

  /**
   * Call-level approval check - overrides tool-level requireApproval setting
   * Receives the tool call and turn context, can be sync or async
   */
  requireApproval?: (
    toolCall: ParsedToolCall<TTools[number]>,
    context: TurnContext,
  ) => boolean | Promise<boolean>;
  approveToolCalls?: string[];
  rejectToolCalls?: string[];

  /** Callback invoked at the start of each tool execution turn */
  onTurnStart?: (context: TurnContext) => void | Promise<void>;
  /** Callback invoked at the end of each tool execution turn */
  onTurnEnd?: (context: TurnContext, response: models.OpenResponsesResult) => void | Promise<void>;
  /**
   * When the loop exits because `stopWhen` was met and the last response
   * still contained tool calls, make one more model request with no tools so
   * the model produces a final text response. A string value is appended as
   * a final user message.
   */
  allowFinalResponse?: boolean | string;
  /**
   * When true, always throw if the final response has an empty `output` array
   * (legacy behavior). Default false: after at least one completed tool
   * execution round, an empty final turn is retried once and then accepted
   * so tool-terminal runs are not reported as failures.
   */
  strictFinalResponse?: boolean;
  /** Hook system for lifecycle events */
  hooks?: HooksManager;
}

/**
 * A wrapper around a streaming response that provides multiple consumption patterns.
 *
 * Allows consuming the response in multiple ways:
 * - `await result.getText()` - Get just the text
 * - `await result.getResponse()` - Get the full response object
 * - `for await (const delta of result.getTextStream())` - Stream text deltas
 * - `for await (const msg of result.getNewMessagesStream())` - Stream cumulative message snapshots
 * - `for await (const event of result.getFullResponsesStream())` - Stream all response events
 *
 * For message format conversion, use the helper functions:
 * - `toChatMessage(response)` for OpenAI chat format
 * - `toClaudeMessage(response)` for Anthropic Claude format
 *
 * All consumption patterns can be used concurrently thanks to the underlying
 * ReusableReadableStream implementation.
 *
 * @template TTools - The tools array type to enable typed tool calls and results
 * @template TShared - The shape of the shared context (inferred from sharedContextSchema)
 */
export class ModelResult<
  TTools extends readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, never>,
> {
  private reusableStream: ReusableReadableStream<models.StreamEvents> | null = null;
  private textPromise: Promise<string> | null = null;
  private options: GetResponseOptions<TTools, TShared>;
  private initPromise: Promise<void> | null = null;
  private toolExecutionPromise: Promise<void> | null = null;
  private finalResponse: models.OpenResponsesResult | null = null;
  private toolEventBroadcaster: ToolEventBroadcaster<
    | {
        type: 'preliminary_result';
        toolCallId: string;
        result: InferToolEventsUnion<TTools>;
      }
    | {
        type: 'tool_result';
        toolCallId: string;
        source: 'client' | 'mcp';
        result: InferToolOutputsUnion<TTools>;
        preliminaryResults?: InferToolEventsUnion<TTools>[];
      }
  > | null = null;
  private allToolExecutionRounds: Array<{
    round: number;
    toolCalls: ParsedToolCall<Tool>[];
    response: models.OpenResponsesResult;
    /**
     * All tool outputs from this round — both client function outputs we send
     * back AND server-tool output items emitted by OpenRouter (web_search_call,
     * image_generation_call, file_search_call, openrouter:datetime, generic
     * OutputServerToolItem, etc.). Type derived from the SDK's OutputItems
     * union so new server-tool variants appear automatically.
     */
    toolResults: Array<ToolResultItem>;
  }> = [];
  // Track resolved request after async function resolution
  private resolvedRequest: models.ResponsesRequest | null = null;
  // Fresh user items to persist atomically with the assistant response
  private pendingFreshItems: models.BaseInputsUnion[] | undefined;
  private resumingFromClientTools = false;

  // State management for multi-turn conversations
  private stateAccessor: StateAccessor<TTools> | null = null;
  private currentState: ConversationState<TTools> | null = null;
  private requireApprovalFn:
    | ((
        toolCall: ParsedToolCall<TTools[number]>,
        context: TurnContext,
      ) => boolean | Promise<boolean>)
    | null = null;
  private approvedToolCalls: string[] = [];
  private rejectedToolCalls: string[] = [];
  private isResumingFromApproval = false;

  // Unified turn broadcaster for multi-turn streaming
  private turnBroadcaster: ToolEventBroadcaster<
    ResponseStreamEvent<InferToolEventsUnion<TTools>, InferToolOutputsUnion<TTools>>
  > | null = null;
  private initialStreamPipeStarted = false;
  private initialPipePromise: Promise<void> | null = null;

  // Context store for typed tool context (persists across turns)
  private contextStore: ToolContextStore | null = null;

  // Hook system
  private readonly hooksManager: HooksManager | undefined;
  // Tracks whether SessionStart has already been emitted, so SessionEnd can be
  // guarded to fire only when a matching SessionStart actually succeeded.
  // Without this, an exception in initStream before SessionStart would lead to
  // a dangling SessionEnd (breaking audit-log / resource-pair contracts).
  private sessionStartEmitted = false;
  // Pairs with sessionStartEmitted: guards emitSessionEndOnce so the
  // tool-execution path and the no-tools stream paths can both attempt the
  // emit without double-firing.
  private sessionEndEmitted = false;
  // Tool call ids the PermissionRequest hook denied without pausing. The
  // normal tool round consults this to synthesize rejected outputs instead of
  // executing the calls.
  private readonly hookDeniedCalls = new Map<string, string>();
  // Telemetry for the PostModelCall hook: the initial/resume request is
  // dispatched in initStream but its response is materialized later (stream
  // consumption), so the dispatch time and turn labeling are parked here
  // until a completed response is available. Cleared on emit.
  private pendingModelCall:
    | {
        startedAt: number;
        turnType: 'initial' | 'resume';
        turnNumber: number;
      }
    | undefined;
  // Running aggregate across every PostModelCall emit; surfaced as
  // SessionEnd.totalUsage.
  private readonly sessionUsage = {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    hasCost: false,
  };

  constructor(options: GetResponseOptions<TTools, TShared>) {
    this.options = options;
    this.hooksManager = options.hooks;

    // Runtime validation: approval decisions require state
    const hasApprovalDecisions =
      (options.approveToolCalls && options.approveToolCalls.length > 0) ||
      (options.rejectToolCalls && options.rejectToolCalls.length > 0);

    if (hasApprovalDecisions && !options.state) {
      throw new Error(
        'approveToolCalls and rejectToolCalls require a state accessor. ' +
          'Provide a StateAccessor via the "state" parameter to persist approval decisions.',
      );
    }

    // Initialize state management
    this.stateAccessor = options.state ?? null;
    this.requireApprovalFn = options.requireApproval ?? null;
    this.approvedToolCalls = options.approveToolCalls ?? [];
    this.rejectedToolCalls = options.rejectToolCalls ?? [];
  }

  /**
   * Get or create the unified turn broadcaster (lazy initialization).
   * Broadcasts all API stream events, tool events, and turn delimiters across turns.
   */
  private ensureTurnBroadcaster(): ToolEventBroadcaster<
    ResponseStreamEvent<InferToolEventsUnion<TTools>, InferToolOutputsUnion<TTools>>
  > {
    if (!this.turnBroadcaster) {
      this.turnBroadcaster = new ToolEventBroadcaster();
    }
    return this.turnBroadcaster;
  }

  /**
   * Start piping the initial stream into the turn broadcaster.
   * Idempotent — only starts once even if called multiple times.
   * Wraps the initial stream events with turn.start(0) / turn.end(0) delimiters.
   */
  private startInitialStreamPipe(): void {
    if (this.initialStreamPipeStarted) {
      return;
    }
    this.initialStreamPipeStarted = true;

    const broadcaster = this.ensureTurnBroadcaster();

    if (!this.reusableStream) {
      return;
    }

    const stream = this.reusableStream;

    // biome-ignore lint: IIFE used for fire-and-forget async pipe
    this.initialPipePromise = (async () => {
      broadcaster.push({
        type: 'turn.start',
        turnNumber: 0,
        timestamp: Date.now(),
      } satisfies TurnStartEvent);

      const consumer = stream.createConsumer();
      for await (const event of consumer) {
        broadcaster.push(event);
      }

      broadcaster.push({
        type: 'turn.end',
        turnNumber: 0,
        timestamp: Date.now(),
      } satisfies TurnEndEvent);
    })().catch((error) => {
      broadcaster.complete(error instanceof Error ? error : new Error(String(error)));
    });
  }

  /**
   * Pipe a follow-up stream into the turn broadcaster and capture the completed response.
   * Emits turn.start / turn.end delimiters around the stream events.
   */
  private async pipeAndConsumeStream(
    stream: ReusableReadableStream<models.StreamEvents>,
    turnNumber: number,
  ): Promise<models.OpenResponsesResult> {
    const broadcaster = this.turnBroadcaster!;

    broadcaster.push({
      type: 'turn.start',
      turnNumber,
      timestamp: Date.now(),
    } satisfies TurnStartEvent);

    const consumer = stream.createConsumer();
    let completedResponse: models.OpenResponsesResult | null = null;

    for await (const event of consumer) {
      broadcaster.push(event);
      if (isResponseCompletedEvent(event)) {
        completedResponse = event.response;
      }
      if (isResponseFailedEvent(event)) {
        const errorMsg = 'message' in event ? String(event.message) : 'Response failed';
        throw new Error(errorMsg);
      }
      if (isResponseIncompleteEvent(event)) {
        completedResponse = event.response;
      }
    }

    broadcaster.push({
      type: 'turn.end',
      turnNumber,
      timestamp: Date.now(),
    } satisfies TurnEndEvent);

    if (!completedResponse) {
      throw new Error('Follow-up stream ended without a completed response');
    }

    return completedResponse;
  }

  /**
   * Resolve a tool's result `source` from its call name by looking it up in the
   * configured tools. Used where the concrete tool reference isn't in scope
   * (e.g. a rejected execution). Defaults to `'client'` when not found.
   */
  private toolSourceByName(name: string): 'client' | 'mcp' {
    const matched = this.options.tools?.find((t) => isClientTool(t) && t.function.name === name);
    return matched !== undefined && isMcpTool(matched) ? 'mcp' : 'client';
  }

  /**
   * Push a tool result event to both the legacy tool event broadcaster
   * and the unified turn broadcaster.
   */
  private broadcastToolResult(
    toolCallId: string,
    source: 'client' | 'mcp',
    result: InferToolOutputsUnion<TTools>,
    preliminaryResults?: InferToolEventsUnion<TTools>[],
  ): void {
    this.toolEventBroadcaster?.push({
      type: 'tool_result' as const,
      toolCallId,
      source,
      result,
      ...(preliminaryResults?.length && {
        preliminaryResults,
      }),
    });
    this.turnBroadcaster?.push({
      type: 'tool.result' as const,
      toolCallId,
      source,
      result,
      timestamp: Date.now(),
      ...(preliminaryResults?.length && {
        preliminaryResults,
      }),
    });
  }

  /**
   * Push a preliminary result event to both the legacy tool event broadcaster
   * and the unified turn broadcaster.
   */
  private broadcastPreliminaryResult(
    toolCallId: string,
    result: InferToolEventsUnion<TTools>,
  ): void {
    this.toolEventBroadcaster?.push({
      type: 'preliminary_result' as const,
      toolCallId,
      result,
    });
    this.turnBroadcaster?.push({
      type: 'tool.preliminary_result' as const,
      toolCallId,
      result,
      timestamp: Date.now(),
    });
  }

  /**
   * Set up the turn broadcaster with tool execution and return the consumer.
   * Used by stream methods that need to iterate over all turns.
   */
  private startTurnBroadcasterExecution(): {
    consumer: AsyncIterableIterator<
      ResponseStreamEvent<InferToolEventsUnion<TTools>, InferToolOutputsUnion<TTools>>
    >;
    executionPromise: Promise<void>;
  } {
    const broadcaster = this.ensureTurnBroadcaster();
    this.startInitialStreamPipe();
    const consumer = broadcaster.createConsumer();
    const executionPromise = this.executeToolsIfNeeded().finally(async () => {
      // Wait for the initial stream pipe to finish pushing all events
      // (including turn.end) before marking the broadcaster as complete.
      // Without this, turn.end can be silently dropped if the pipe hasn't
      // finished when executeToolsIfNeeded completes.
      if (this.initialPipePromise) {
        await this.initialPipePromise;
      }
      broadcaster.complete();
    });
    return {
      consumer,
      executionPromise,
    };
  }

  /**
   * Type guard to check if a value is a non-streaming response
   * Only requires 'output' field and absence of readable stream behavior
   */
  private isNonStreamingResponse(value: unknown): value is models.OpenResponsesResult {
    return (
      value !== null && typeof value === 'object' && 'output' in value && !isEventStream(value)
    );
  }

  /**
   * Materialize a betaResponsesSend result value into a completed response:
   * streaming values are consumed to completion (through the turn
   * broadcaster when one is attached), non-streaming values pass through.
   */
  private async materializeResponse(
    value: unknown,
    turnNumber: number,
  ): Promise<models.OpenResponsesResult> {
    if (isEventStream(value)) {
      const stream = new ReusableReadableStream(value);
      if (this.turnBroadcaster) {
        return this.pipeAndConsumeStream(stream, turnNumber);
      }
      return consumeStreamForCompletion(stream);
    }
    if (this.isNonStreamingResponse(value)) {
      return value;
    }
    throw new Error('Unexpected response type from API');
  }

  // =========================================================================
  // Extracted Helper Methods for executeToolsIfNeeded
  // =========================================================================

  /**
   * Get initial response from stream or cached final response.
   * Consumes the stream to completion if needed to extract the response.
   *
   * @returns The complete non-streaming response
   * @throws Error if neither stream nor response has been initialized
   */
  private async getInitialResponse(): Promise<models.OpenResponsesResult> {
    if (this.finalResponse) {
      return this.finalResponse;
    }
    if (this.reusableStream) {
      const response = await consumeStreamForCompletion(this.reusableStream);
      await this.emitPendingModelCallOnce(response);
      return response;
    }
    throw new Error('Neither stream nor response initialized');
  }

  /**
   * Save response output to state.
   * Appends the response output to the message history and records the response ID.
   *
   * @param response - The API response to save
   */
  private async saveResponseToState(response: models.OpenResponsesResult): Promise<void> {
    if (!this.stateAccessor || !this.currentState) {
      return;
    }

    const outputItems = Array.isArray(response.output)
      ? response.output
      : [
          response.output,
        ];

    // Persist pending fresh user items together with the assistant output
    // so they land atomically — if the stream failed before reaching here
    // neither the user turn nor the assistant turn is written to state.
    let messages = this.currentState.messages;
    if (this.pendingFreshItems && this.pendingFreshItems.length > 0) {
      messages = appendToMessages(messages, this.pendingFreshItems);
      this.pendingFreshItems = undefined;
    }

    const stateUpdates: Partial<Omit<ConversationState<TTools>, 'id' | 'createdAt' | 'updatedAt'>> =
      {
        messages: appendToMessages(messages, outputItems as models.BaseInputsUnion[]),
        previousResponseId: response.id,
      };
    if (this.resumingFromClientTools) {
      this.currentState = {
        ...this.currentState,
      };
      this.clearOptionalStateProperties([
        'pendingToolCalls',
      ]);
      this.resumingFromClientTools = false;
      stateUpdates.status = 'in_progress';
    }

    await this.saveStateSafely(stateUpdates);
  }

  /**
   * Mark state as complete.
   * Sets the conversation status to 'complete' indicating no further tool execution is needed.
   */
  private async markStateComplete(): Promise<void> {
    await this.saveStateSafely({
      status: 'complete',
    });
  }

  /**
   * Save tool results to state.
   * Appends tool execution results to the message history for multi-turn context.
   *
   * @param toolResults - The tool execution results to save
   */
  private async saveToolResultsToState(
    toolResults: models.FunctionCallOutputItem[],
  ): Promise<void> {
    if (!this.currentState) {
      return;
    }
    await this.saveStateSafely({
      messages: appendToMessages(this.currentState.messages, toolResults),
    });
  }

  /**
   * Check if execution should be interrupted by external signal.
   * Polls the state accessor for interruption flags set by external processes.
   *
   * @param currentResponse - The current response to save as partial state
   * @returns True if interrupted and caller should exit, false to continue
   */
  private async checkForInterruption(
    currentResponse: models.OpenResponsesResult,
  ): Promise<boolean> {
    if (!this.stateAccessor) {
      return false;
    }

    const freshState = await this.stateAccessor.load();
    if (!freshState?.interruptedBy) {
      return false;
    }

    // Save partial state
    if (this.currentState) {
      const currentToolCalls = extractToolCallsFromResponse(currentResponse);
      await this.saveStateSafely({
        status: 'interrupted',
        partialResponse: {
          text: extractTextFromResponseState(currentResponse),
          toolCalls: currentToolCalls as ParsedToolCall<TTools[number]>[],
        },
      });
    }

    this.finalResponse = currentResponse;
    return true;
  }

  /**
   * Inject a user-role message into the conversation state and into the
   * accumulated request input, so the next turn picks it up. Used by the
   * Stop hook's `appendPrompt` to nudge the model without forcing a resume.
   *
   * This advances observable state (messages/input change) so the next
   * iteration of the execution loop is not a no-op.
   */
  private async injectAppendPromptMessage(prompt: string): Promise<void> {
    const injectedMessage: models.BaseInputsUnion = {
      role: 'user',
      content: prompt,
    } as models.BaseInputsUnion;

    if (this.currentState) {
      // Mutate the in-memory state directly so loop progress is observable
      // even when no StateAccessor is configured (forceResume needs state to
      // change to avoid looping). Persist when an accessor is available.
      const nextMessages = appendToMessages(this.currentState.messages, [
        injectedMessage,
      ]);
      this.currentState = updateState(this.currentState, {
        messages: nextMessages,
      });
      if (this.stateAccessor) {
        await this.saveStateSafely();
      }
    }

    if (this.resolvedRequest) {
      const currentInput = this.resolvedRequest.input;
      const nextInput: models.InputsUnion = Array.isArray(currentInput)
        ? [
            ...currentInput,
            injectedMessage,
          ]
        : currentInput
          ? [
              {
                role: 'user',
                content: currentInput,
              } as models.BaseInputsUnion,
              injectedMessage,
            ]
          : [
              injectedMessage,
            ];
      this.resolvedRequest = {
        ...this.resolvedRequest,
        input: nextInput,
      };
    }
  }

  /**
   * Check if stop conditions are met.
   * Returns true if execution should stop.
   *
   * @remarks
   * When no `stopWhen` is specified, this returns false and execution stops
   * only when the model produces a turn without tool calls. Pass an explicit
   * `stopWhen` (e.g. `stepCountIs(n)`, `maxCost(...)`) to bound the loop.
   * This evaluates stop conditions against the complete step history.
   */
  private async shouldStopExecution(): Promise<boolean> {
    const { stopWhen } = this.options;
    if (stopWhen === undefined) {
      return false;
    }

    const stopConditions = Array.isArray(stopWhen)
      ? stopWhen
      : [
          stopWhen,
        ];

    const isFunctionCallOutput = (tr: ToolResultItem): tr is models.FunctionCallOutputItem =>
      tr.type === 'function_call_output';
    const isServerToolResult = (tr: ToolResultItem): tr is ServerToolResultItem =>
      tr.type !== 'function_call_output';

    return isStopConditionMet({
      stopConditions,
      steps: this.allToolExecutionRounds.map((round) => ({
        stepType: 'continue' as const,
        text: extractTextFromResponse(round.response),
        toolCalls: round.toolCalls,
        // `toolResults` is client-tool-centric; server-tool output items are
        // surfaced on `serverToolResults` so stop conditions can react to
        // either class of result.
        toolResults: round.toolResults.filter(isFunctionCallOutput).map((tr) => {
          const toolName = round.toolCalls.find((tc) => tc.id === tr.callId)?.name ?? '';
          const matchedTool = this.options.tools?.find(
            (t) => isClientTool(t) && t.function.name === toolName,
          );
          return {
            toolCallId: tr.callId,
            toolName,
            source:
              matchedTool !== undefined && isMcpTool(matchedTool)
                ? ('mcp' as const)
                : ('client' as const),
            result: typeof tr.output === 'string' ? JSON.parse(tr.output) : tr.output,
          };
        }),
        serverToolResults: round.toolResults.filter(isServerToolResult),
        response: round.response,
        usage: round.response.usage,
        finishReason: undefined,
      })),
    });
  }

  /**
   * Check if any tool calls can be auto-resolved in the current turn.
   * Used to determine if automatic tool execution should be attempted.
   *
   * A tool call is auto-resolvable if its tool has either an `execute` function
   * (regular or generator) or an `onToolCalled` hook (HITL). HITL tools are
   * included here because their hook fires before the model's follow-up request,
   * even when the hook ultimately decides to pause by returning `null`.
   *
   * @param toolCalls - The tool calls to check
   * @returns True if at least one tool call is auto-resolvable
   */
  private hasExecutableToolCalls(toolCalls: ParsedToolCall<Tool>[]): boolean {
    return toolCalls.some((toolCall) => {
      const tool = this.options.tools?.find(
        (t) => isClientTool(t) && t.function.name === toolCall.name,
      );
      return tool && isAutoResolvableTool(tool);
    });
  }

  /**
   * A manual tool call is one whose tool has neither an `execute` function nor
   * an `onToolCalled` hook — i.e. the caller is expected to produce the output
   * externally. HITL tools are auto-resolvable even when they pause, so they
   * are not classified as manual here.
   */
  private isManualToolCall(item: models.OutputFunctionCallItem): boolean {
    const tool = this.options.tools?.find((t) => isClientTool(t) && t.function.name === item.name);
    return !!tool && !isAutoResolvableTool(tool);
  }

  /**
   * Shared helper: execute a single tool and emit the full Pre/Post lifecycle
   * hooks around it.
   *
   * Every code path that ultimately calls `executeTool()` for a user-visible
   * tool call funnels through here so that PreToolUse/PostToolUse/
   * PostToolUseFailure fire consistently — regardless of whether the tool was
   * auto-executed, required approval, or was approved later.
   *
   * Return shape:
   * - `parse_error`: `toolCall.arguments` was a raw JSON string the model
   *   failed to produce valid JSON for. The caller should use the prebuilt
   *   FunctionCallOutputItem and not execute the tool. No hooks fire.
   * - `hook_blocked`: PreToolUse returned `block` (boolean true or a reason
   *   string). The caller should synthesize a denied result without invoking
   *   the tool. The FunctionCallOutputItem is prebuilt for convenience.
   * - `execution`: The tool ran. `result` is the ToolExecutionResult.
   *   `effectiveToolCall` reflects any `mutatedInput` piped by PreToolUse.
   */
  private async runToolWithHooks(
    tool: Tool,
    toolCall: ParsedToolCall<Tool>,
    turnContext: TurnContext,
    onPreliminaryResult?: (toolCallId: string, result: unknown) => void,
  ): Promise<
    | {
        type: 'parse_error';
        toolCall: ParsedToolCall<Tool>;
        errorMessage: string;
        output: models.FunctionCallOutputItem;
      }
    | {
        type: 'hook_blocked';
        toolCall: ParsedToolCall<Tool>;
        reason: string;
        output: models.FunctionCallOutputItem;
      }
    | {
        type: 'execution';
        effectiveToolCall: ParsedToolCall<Tool>;
        result: Awaited<ReturnType<typeof executeTool>>;
      }
  > {
    // Reject raw-string arguments before any hook fires. When the model
    // produces invalid JSON, the parser leaves `toolCall.arguments` as the
    // raw string; handing that to PreToolUse would either fail payload
    // validation (silent no-op in non-strict mode) or deliver a malformed
    // `toolInput` to handlers. Fail closed here so every execution path
    // (auto-approve, manual approval, approved-on-resume) gets a consistent
    // synthetic error without running the tool or firing hooks.
    const rawArgs: unknown = toolCall.arguments;
    if (typeof rawArgs === 'string') {
      const errorMessage =
        `Failed to parse tool call arguments for "${toolCall.name}": The model provided invalid JSON. ` +
        `Raw arguments received: "${rawArgs}". ` +
        'Please provide valid JSON arguments for this tool call.';
      return {
        type: 'parse_error',
        toolCall,
        errorMessage,
        output: {
          type: 'function_call_output' as const,
          id: `output_${toolCall.id}`,
          callId: toolCall.id,
          output: JSON.stringify({
            error: errorMessage,
          }),
        },
      };
    }

    let effectiveToolCall = toolCall;

    // Emit PreToolUse hook -- can block or mutate input.
    if (this.hooksManager) {
      // The hook payload coerces null/undefined arguments to {} for schema
      // validation, but `effectiveToolCall.arguments` only changes when the
      // chain reports an actual mutation (`emit.mutated`), so tools that
      // legitimately distinguish "no args" from "empty args" are unaffected.
      const originalToolInput = (toolCall.arguments ?? {}) as Record<string, unknown>;
      const preResult = await this.hooksManager.emit(
        'PreToolUse',
        {
          toolName: toolCall.name,
          toolInput: originalToolInput,
        },
        this.hookEmitContext(toolCall.name),
      );

      if (preResult.blocked) {
        // Every entry in `results` passed the PreToolUseResult schema (see
        // EmitResult.results invariant), so no structural re-narrowing needed.
        const block = preResult.results.find((r) => r.block)?.block;
        const reason = typeof block === 'string' ? block : 'Blocked by PreToolUse hook';
        return {
          type: 'hook_blocked',
          toolCall,
          reason,
          output: {
            type: 'function_call_output' as const,
            id: `output_${toolCall.id}`,
            callId: toolCall.id,
            output: JSON.stringify({
              error: reason,
            }),
          },
        };
      }

      // Apply mutated input only when a handler actually piped a replacement
      // (`emit.mutated`). Payload validation clones the object, so a
      // reference comparison against the original would false-positive and
      // coerce legitimately-null arguments to {}.
      if (preResult.mutated) {
        effectiveToolCall = {
          ...toolCall,
          arguments: preResult.finalPayload.toolInput,
        };
      }
    }

    // performance.now() gives monotonic, sub-ms precision and is immune to
    // system clock jumps, unlike Date.now().
    const startTime = performance.now();
    const result = await executeTool(
      tool,
      effectiveToolCall,
      turnContext,
      onPreliminaryResult,
      this.contextStore ?? undefined,
      this.options.sharedContextSchema,
    );
    const durationMs = performance.now() - startTime;

    // HITL tools may pause (executeTool returns null). No output was produced
    // yet, so neither PostToolUse nor PostToolUseFailure fires; they will fire
    // if/when the tool is resumed and actually executes.
    // Emit PostToolUse or PostToolUseFailure.
    if (this.hooksManager && result !== null) {
      if (result.error) {
        await this.hooksManager.emit(
          'PostToolUseFailure',
          {
            toolName: effectiveToolCall.name,
            toolInput: (effectiveToolCall.arguments ?? {}) as Record<string, unknown>,
            error: result.error,
          },
          this.hookEmitContext(effectiveToolCall.name),
        );
      } else {
        await this.hooksManager.emit(
          'PostToolUse',
          {
            toolName: effectiveToolCall.name,
            toolInput: (effectiveToolCall.arguments ?? {}) as Record<string, unknown>,
            toolOutput: result.result,
            durationMs,
          },
          this.hookEmitContext(effectiveToolCall.name),
        );
      }
    }

    return {
      type: 'execution',
      effectiveToolCall,
      result,
    };
  }

  /**
   * Build the per-emit context for lifecycle hook emits. Threads this run's
   * session identity into `context.sessionId` on every emit, so a
   * `HooksManager` instance shared across concurrent runs never leaks one
   * run's id into another's handlers (the manager-level `setSessionId`
   * default is a single mutable field and would be clobbered by the last
   * run to start).
   */
  private hookEmitContext(toolName?: string): {
    toolName?: string;
    sessionId?: string;
  } {
    return {
      ...(toolName !== undefined && {
        toolName,
      }),
      sessionId: this.currentState?.id ?? '',
    };
  }

  /**
   * Emit SessionEnd exactly once, and only when a matching SessionStart
   * actually succeeded. Safe to call from multiple teardown paths.
   */
  private async emitSessionEndOnce(
    reason: 'user' | 'error' | 'max_turns' | 'complete',
  ): Promise<void> {
    if (!this.hooksManager || !this.sessionStartEmitted || this.sessionEndEmitted) {
      return;
    }
    this.sessionEndEmitted = true;
    await this.hooksManager.emit(
      'SessionEnd',
      {
        reason,
        ...(this.sessionUsage.modelCalls > 0 && {
          totalUsage: {
            modelCalls: this.sessionUsage.modelCalls,
            inputTokens: this.sessionUsage.inputTokens,
            outputTokens: this.sessionUsage.outputTokens,
            totalTokens: this.sessionUsage.totalTokens,
            cachedTokens: this.sessionUsage.cachedTokens,
            reasoningTokens: this.sessionUsage.reasoningTokens,
            ...(this.sessionUsage.hasCost && {
              cost: this.sessionUsage.cost,
            }),
          },
        }),
      },
      this.hookEmitContext(),
    );
  }

  /**
   * Emit PostModelCall for a completed model response and fold its usage
   * into the session aggregate. One emit per materialized response.
   */
  private async emitPostModelCall(
    response: models.OpenResponsesResult,
    startedAt: number,
    turnType: PostModelCallPayload['turnType'],
    turnNumber: number,
  ): Promise<void> {
    if (!this.hooksManager) {
      return;
    }
    const usage = extractModelCallUsage(response.usage);
    this.sessionUsage.modelCalls++;
    if (usage) {
      this.sessionUsage.inputTokens += usage.inputTokens;
      this.sessionUsage.outputTokens += usage.outputTokens;
      this.sessionUsage.totalTokens += usage.totalTokens;
      this.sessionUsage.cachedTokens += usage.cachedTokens;
      this.sessionUsage.reasoningTokens += usage.reasoningTokens;
      if (usage.cost !== undefined) {
        this.sessionUsage.cost += usage.cost;
        this.sessionUsage.hasCost = true;
      }
    }
    await this.hooksManager.emit(
      'PostModelCall',
      {
        sessionId: this.currentState?.id ?? '',
        responseId: response.id,
        model: response.model ?? '',
        durationMs: performance.now() - startedAt,
        turnType,
        turnNumber,
        ...(usage && {
          usage,
        }),
      },
      this.hookEmitContext(),
    );
  }

  /**
   * Emit the parked initial/resume PostModelCall once its response has been
   * materialized. No-ops when nothing is parked (e.g. the non-streaming
   * branch already emitted). Safe to call from multiple materialization
   * sites; the first wins.
   */
  private async emitPendingModelCallOnce(response: models.OpenResponsesResult): Promise<void> {
    const pending = this.pendingModelCall;
    if (!pending) {
      return;
    }
    this.pendingModelCall = undefined;
    await this.emitPostModelCall(response, pending.startedAt, pending.turnType, pending.turnNumber);
  }

  /**
   * Emit the Stop hook when a stopWhen condition halts the loop, and decide
   * whether the loop should resume.
   *
   * - `appendPrompt` values from all handlers are concatenated (newline
   *   separated) and injected as a user message. Honored independently of
   *   forceResume so a handler can nudge the next turn without resuming.
   * - `forceResume` is honored if ANY handler returns it, capped at
   *   MAX_FORCE_RESUME_OVERRIDES consecutive overrides without tool
   *   progress (the caller resets its counter when a tool round or a fresh
   *   response lands).
   *
   * Returns 'resume' when the loop should continue, 'stop' otherwise.
   */
  private async runStopHook(forceResumeCount: number): Promise<'resume' | 'stop'> {
    if (!this.hooksManager) {
      return 'stop';
    }

    // shouldStopExecution() is driven by stopWhen conditions (default
    // stepCountIs), so 'max_turns' is the semantically accurate reason.
    const stopResult = await this.hooksManager.emit(
      'Stop',
      {
        reason: 'max_turns' as const,
      },
      this.hookEmitContext(),
    );

    // Every entry in `results` passed the StopResult schema (see
    // EmitResult.results invariant), so the fields can be read directly.
    const shouldForceResume = stopResult.results.some((r) => r.forceResume === true);

    const appendPrompt = stopResult.results
      .map((r) => r.appendPrompt)
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .join('\n');
    if (appendPrompt) {
      await this.injectAppendPromptMessage(appendPrompt);
    }

    if (!shouldForceResume) {
      return 'stop';
    }
    if (forceResumeCount >= MAX_FORCE_RESUME_OVERRIDES) {
      // Don't let the hook loop the engine forever. Log and stop.
      console.warn(
        `[Stop hook] forceResume honored ${MAX_FORCE_RESUME_OVERRIDES} times without new progress; stopping to prevent an infinite loop.`,
      );
      return 'stop';
    }
    return 'resume';
  }

  /**
   * Session teardown for the no-tools stream paths, which bypass
   * executeToolsIfNeeded (the normal SessionEnd site). Emits SessionEnd once
   * and drains pending hook work. Never throws: teardown must not mask the
   * stream's own outcome.
   */
  private async finishHooksSessionForStream(
    reason: 'complete' | 'error' = 'complete',
  ): Promise<void> {
    if (!this.hooksManager) {
      return;
    }
    try {
      // Materialize the parked initial-call telemetry when the stream fully
      // completed (the retained buffer replays without touching the source).
      // A failed/errored stream skips it: no materialized response exists.
      // (`response.incomplete` responses DO emit — they are materialized, have
      // a generation id, and consumed tokens.)
      // Isolated try: a telemetry failure (e.g. a buffer without a completion
      // event, or a throwing strict-mode handler) must not skip SessionEnd or
      // the drain below — those are contractual on every exit path.
      try {
        if (this.pendingModelCall) {
          if (this.finalResponse) {
            await this.emitPendingModelCallOnce(this.finalResponse);
          } else if (this.reusableStream?.isComplete) {
            await this.emitPendingModelCallOnce(
              await consumeStreamForCompletion(this.reusableStream),
            );
          }
        }
      } catch (telemetryError) {
        console.warn('[PostModelCall] error during stream teardown:', telemetryError);
      }
      await this.emitSessionEndOnce(reason);
      await this.hooksManager.drain();
    } catch (teardownError) {
      console.warn('[SessionEnd] error during stream teardown:', teardownError);
    }
  }

  /**
   * initStream wrapper for the streaming getters. initStream can throw
   * after SessionStart was emitted (e.g. the initial API call fails), and
   * the "Stream not initialized" guard can throw right after it — on both
   * paths the hook session must still be torn down (SessionEnd + drain),
   * otherwise Start/End handlers that treat the pair as a contract see a
   * dangling Start. Teardown is emit-once, so the tools path (which runs
   * its own teardown in executeToolsIfNeeded) is unaffected.
   */
  private async initStreamGuarded(options?: { requireStream?: boolean }): Promise<void> {
    // The not-initialized invariant applies to streaming getters only:
    // state-inspection methods (getPendingToolCalls/getState/...) are valid
    // on paused resumes (awaiting_hitl/awaiting_approval) where initStream
    // returns early with neither a stream nor a finalResponse.
    const requireStream = options?.requireStream ?? true;
    try {
      await this.initStream();
      if (requireStream && !this.reusableStream && !this.finalResponse) {
        throw new Error('Stream not initialized');
      }
    } catch (error) {
      await this.finishHooksSessionForStream('error');
      throw error;
    }
  }

  /**
   * Emit the PermissionRequest hook before the SDK blocks for user approval.
   *
   * Returns the hook's collective decision:
   * - `allow`: the tool should proceed as if auto-approved (skip approval gate)
   * - `deny`: the tool should NOT run; caller should produce a denied result
   * - `ask_user`: fall through to the existing approval flow (the default)
   *
   * Last-wins when multiple handlers return conflicting decisions.
   */
  private async emitPermissionRequest(toolCall: ParsedToolCall<Tool>): Promise<{
    decision: 'allow' | 'deny' | 'ask_user';
    reason?: string;
  }> {
    if (!this.hooksManager) {
      return {
        decision: 'ask_user',
      };
    }

    // Raw-string arguments mean the model produced invalid JSON. Fail closed
    // (fall through to the human approval flow) rather than emitting a
    // malformed payload the schema would reject anyway -- mirrors the guard
    // in runToolWithHooks.
    if (typeof toolCall.arguments === 'string') {
      return {
        decision: 'ask_user',
      };
    }

    // Derive risk level from the approval gate's shape: a callback (tool- or
    // call-level requireApproval function) => 'high' (caller actively
    // decides per call), blanket true => 'medium', otherwise 'low'.
    const tool = this.options.tools?.find(
      (t) => isClientTool(t) && t.function.name === toolCall.name,
    );
    const requireApproval = tool && isClientTool(tool) ? tool.function.requireApproval : undefined;
    const riskLevel: 'low' | 'medium' | 'high' =
      typeof requireApproval === 'function' || this.requireApprovalFn
        ? 'high'
        : requireApproval === true
          ? 'medium'
          : 'low';

    const emit = await this.hooksManager.emit(
      'PermissionRequest',
      {
        toolName: toolCall.name,
        toolInput: (toolCall.arguments ?? {}) as Record<string, unknown>,
        riskLevel,
      },
      this.hookEmitContext(toolCall.name),
    );

    // Last-wins: if multiple handlers disagree, the most recently registered
    // handler dictates the outcome. This is documented and intentional —
    // callers that want stricter semantics should register a single final
    // handler (or use `throwOnHandlerError` to surface conflicts in tests).
    // Every entry in `results` passed the PermissionRequestResult schema
    // (`decision` is a required enum), so it can be read directly.
    const last = emit.results.at(-1);
    if (!last) {
      return {
        decision: 'ask_user',
      };
    }
    return {
      decision: last.decision,
      ...(last.reason !== undefined && {
        reason: last.reason,
      }),
    };
  }

  /**
   * Run the UserPromptSubmit hook, supporting both string and structured
   * inputs. If a handler returns a mutated prompt, the returned object
   * applies the mutation back to the original input shape (string in =
   * string out, message array in = message array out with the latest user
   * text replaced).
   *
   * Throws if any handler rejects the prompt.
   *
   * Returns `undefined` when the hook does nothing, or when no usable prompt
   * could be extracted from a structured input (handler is skipped and a
   * one-time `console.warn` in dev builds explains why).
   */
  private async maybeRunUserPromptSubmit(currentInput: models.InputsUnion | undefined): Promise<
    | {
        applyTo: (original: models.InputsUnion | undefined) => models.InputsUnion;
      }
    | undefined
  > {
    if (!this.hooksManager || currentInput === undefined) {
      return undefined;
    }

    const { prompt, applyMutated } = extractPromptAndApplier(currentInput);
    if (prompt === undefined) {
      if (process.env['NODE_ENV'] !== 'production') {
        console.warn(
          '[UserPromptSubmit] Could not extract a user prompt from structured input; skipping hook.',
        );
      }
      return undefined;
    }

    const emit = await this.hooksManager.emit(
      'UserPromptSubmit',
      {
        prompt,
      },
      this.hookEmitContext(),
    );

    if (emit.blocked) {
      // Every entry in `results` passed the UserPromptSubmitResult schema.
      const reject = emit.results.find((r) => r.reject)?.reject;
      throw new Error(typeof reject === 'string' ? reject : 'Prompt rejected by hook');
    }

    if (!emit.mutated) {
      return undefined;
    }

    const mutated = emit.finalPayload.prompt;
    return {
      applyTo: (original: models.InputsUnion | undefined) => applyMutated(mutated, original),
    };
  }

  /**
   * Execute tools that can auto-execute (don't require approval) in parallel.
   *
   * @param toolCalls - The tool calls to execute
   * @param turnContext - The current turn context
   * @returns Array of unsent tool results for later submission
   */
  private async executeAutoApproveTools(
    toolCalls: ParsedToolCall<TTools[number]>[],
    turnContext: TurnContext,
  ): Promise<UnsentToolResult<TTools>[]> {
    const toolCallPromises = toolCalls.map(async (tc) => {
      const tool = this.options.tools?.find((t) => isClientTool(t) && t.function.name === tc.name);
      if (!tool || !isAutoResolvableTool(tool)) {
        return null;
      }

      // Route through runToolWithHooks so PreToolUse/PostToolUse fire even on
      // the auto-approve path. `runToolWithHooks` also fails closed on raw
      // JSON-parse failures so hooks never see a malformed payload.
      const hookOutcome = await this.runToolWithHooks(
        tool,
        tc as ParsedToolCall<Tool>,
        turnContext,
      );

      if (hookOutcome.type === 'parse_error') {
        this.broadcastToolResult(tc.id, isMcpTool(tool) ? 'mcp' : 'client', {
          error: hookOutcome.errorMessage,
        } as InferToolOutputsUnion<TTools>);
        return createRejectedResult(tc.id, String(tc.name), hookOutcome.errorMessage);
      }

      if (hookOutcome.type === 'hook_blocked') {
        return createRejectedResult(tc.id, String(tc.name), hookOutcome.reason);
      }

      const result = hookOutcome.result;

      if (result === null) {
        // HITL tool paused — no unsent result for this call in this round
        return null;
      }

      if (result.error) {
        return createRejectedResult(tc.id, String(tc.name), result.error.message);
      }
      return createUnsentResult(tc.id, String(tc.name), result.result);
    });

    const settledResults = await Promise.allSettled(toolCallPromises);

    const results: UnsentToolResult<TTools>[] = [];
    for (let i = 0; i < settledResults.length; i++) {
      const settled = settledResults[i];
      const tc = toolCalls[i];
      if (!settled || !tc) {
        continue;
      }

      if (settled.status === 'rejected') {
        const errorMessage =
          settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        results.push(
          createRejectedResult(tc.id, String(tc.name), errorMessage) as UnsentToolResult<TTools>,
        );
        continue;
      }

      if (settled.value) {
        results.push(settled.value as UnsentToolResult<TTools>);
      }
    }

    return results;
  }

  /**
   * Check for tools requiring approval and handle accordingly.
   * Partitions tool calls into those needing approval and those that can auto-execute.
   *
   * @param toolCalls - The tool calls to check
   * @param currentRound - The current execution round (1-indexed)
   * @param currentResponse - The current response to save if pausing
   * @returns True if execution should pause for approval, false to continue
   * @throws Error if approval is required but no state accessor is configured
   */
  private async handleApprovalCheck(
    toolCalls: ParsedToolCall<Tool>[],
    currentRound: number,
    currentResponse: models.OpenResponsesResult,
  ): Promise<boolean> {
    if (!this.options.tools) {
      return false;
    }

    const turnContext: TurnContext = {
      numberOfTurns: currentRound,
      // context is handled via contextStore, not on TurnContext
    };

    const { requiresApproval: needsApproval, autoExecute } = await partitionToolCalls(
      toolCalls as ParsedToolCall<TTools[number]>[],
      this.options.tools,
      turnContext,
      this.requireApprovalFn ?? undefined,
    );

    // Nothing needs an approval gate: return immediately WITHOUT executing
    // anything. The main loop's executeToolRound runs every call exactly
    // once; pre-executing here would double-run side-effecting tools.
    if (needsApproval.length === 0) {
      return false;
    }

    // Run the PermissionRequest hook for each tool that needs approval.
    // This lets hooks short-circuit the approval flow in either direction:
    // 'allow' promotes the call past the gate (executed once by the normal
    // round), 'deny' synthesizes a rejection (recorded so the round emits a
    // rejected output instead of executing), 'ask_user' falls through to the
    // human approval flow.
    const denied: {
      tc: ParsedToolCall<TTools[number]>;
      reason: string;
    }[] = [];
    const stillPending: ParsedToolCall<TTools[number]>[] = [];

    if (this.hooksManager) {
      for (const tc of needsApproval) {
        const { decision, reason } = await this.emitPermissionRequest(tc as ParsedToolCall<Tool>);
        if (decision === 'allow') {
          // Promoted past the gate; the normal tool round executes it once.
        } else if (decision === 'deny') {
          denied.push({
            tc,
            reason: reason ?? 'Denied by PermissionRequest hook',
          });
        } else {
          stillPending.push(tc);
        }
      }
    } else {
      stillPending.push(...needsApproval);
    }

    if (stillPending.length === 0) {
      // The hook resolved every gated call, so we do not pause. Record denied
      // calls so executeToolRound synthesizes rejections instead of running
      // them; allowed calls execute once via the normal round.
      for (const d of denied) {
        this.hookDeniedCalls.set(d.tc.id, d.reason);
      }
      return false;
    }

    // Validate: pausing for approval requires a state accessor.
    if (!this.stateAccessor) {
      const toolNames = stillPending.map((tc) => tc.name).join(', ');
      throw new Error(
        `Tool(s) require approval but no state accessor is configured: ${toolNames}. ` +
          'Provide a StateAccessor via the "state" parameter to enable approval workflows.',
      );
    }

    // We are pausing: the normal tool round will NOT run for this response,
    // so execute the auto-approved calls now and persist their results as
    // unsent so the resume path can pick them up without re-executing.
    const unsentResults = await this.executeAutoApproveTools(
      autoExecute as ParsedToolCall<TTools[number]>[],
      turnContext,
    );

    // Combine pre-denied results (from hook "deny") with executed results.
    const combinedResults: UnsentToolResult<TTools>[] = [
      ...unsentResults,
      ...denied.map(
        (d) =>
          createRejectedResult(d.tc.id, String(d.tc.name), d.reason) as UnsentToolResult<TTools>,
      ),
    ];

    // Save state with pending approvals (only reached when stillPending > 0).
    const stateUpdates: Partial<Omit<ConversationState<TTools>, 'id' | 'createdAt' | 'updatedAt'>> =
      {
        pendingToolCalls: stillPending,
        status: 'awaiting_approval',
      };
    if (combinedResults.length > 0) {
      stateUpdates.unsentToolResults = combinedResults;
    }
    await this.saveStateSafely(stateUpdates);

    this.finalResponse = currentResponse;
    return true; // Pause for approval
  }

  /**
   * Persist state when one or more HITL tools paused during a round.
   *
   * Mirrors `handleApprovalCheck` so paused HITL calls are surfaced through
   * `pendingToolCalls` (visible via `getPendingToolCalls()` / `getState()`).
   * Sets the status to `awaiting_hitl` so the caller can discriminate HITL
   * pauses from approval pauses.
   *
   * Already-executed results from the same round are persisted on the turn's
   * message history via `saveToolResultsToState` (called by the outer loop
   * before this helper) — no need to duplicate them in `unsentToolResults`.
   *
   * @param currentResponse - The response that produced the paused tool calls
   * @param pausedCalls - HITL tool calls whose `onToolCalled` returned `null`
   */
  private async persistHitlPause(
    currentResponse: models.OpenResponsesResult,
    pausedCalls: ParsedToolCall<Tool>[],
  ): Promise<void> {
    this.finalResponse = currentResponse;

    if (!this.stateAccessor) {
      return;
    }

    const stateUpdates: Partial<Omit<ConversationState<TTools>, 'id' | 'createdAt' | 'updatedAt'>> =
      {
        pendingToolCalls: pausedCalls as ParsedToolCall<TTools[number]>[],
        status: 'awaiting_hitl',
      };
    await this.saveStateSafely(stateUpdates);
  }

  /**
   * Persist state when the loop stops due to unresolved manual (client-executed)
   * tool calls — tools with neither `execute` nor `onToolCalled`.
   *
   * Mirrors `persistHitlPause` so callers can read the unresolved calls via
   * `getPendingToolCalls()` / `getState()` after the loop ends. Uses the
   * distinct status `awaiting_client_tools` so consumers can discriminate
   * manual pauses from HITL pauses (`awaiting_hitl`).
   *
   * Resume behavior: `awaiting_client_tools` is intentionally NOT treated as a
   * resumable status for `processApprovalDecisions` — manual tools are not
   * approved/rejected via call IDs; the caller executes them externally and
   * typically supplies `function_call_output` items as new input on the next
   * `callModel`. The paused status and calls remain durable until that request
   * produces a response; they are then cleared atomically with the response.
   *
   * Without a `StateAccessor` nothing is persisted (mirroring
   * `persistHitlPause`): `getPendingToolCalls()` returns `[]` and the caller
   * must read the unresolved `function_call` items off `getResponse().output`.
   * Manual tools require a StateAccessor to be recoverable across processes.
   *
   * @param currentResponse - The response that produced the unresolved calls
   * @param unresolvedCalls - Manual (or otherwise non-auto-resolvable) tool calls
   */
  private async persistClientToolsPause(
    currentResponse: models.OpenResponsesResult,
    unresolvedCalls: ParsedToolCall<Tool>[],
  ): Promise<void> {
    this.finalResponse = currentResponse;

    if (!this.stateAccessor || unresolvedCalls.length === 0) {
      return;
    }

    const stateUpdates: Partial<Omit<ConversationState<TTools>, 'id' | 'createdAt' | 'updatedAt'>> =
      {
        pendingToolCalls: unresolvedCalls as ParsedToolCall<TTools[number]>[],
        status: 'awaiting_client_tools',
      };
    await this.saveStateSafely(stateUpdates);
  }

  /**
   * Compute the `output` payload sent to the model for a successfully
   * settled tool execution. Routes through `toModelOutput` when the tool
   * defines one (which may itself throw to surface an error), falls back to
   * `JSON.stringify(result)` otherwise, and emits an error envelope when the
   * executor itself reported an error.
   */
  private async computeToolOutputForModel(value: {
    toolCall: ParsedToolCall<Tool>;
    tool: Tool;
    result: {
      result: unknown;
      error?: Error;
    };
  }): Promise<string | models.FunctionCallOutputItemOutputUnion1[]> {
    if (value.result.error) {
      return JSON.stringify({
        error: value.result.error.message,
      });
    }

    if (!isAutoResolvableTool(value.tool) || !value.tool.function.toModelOutput) {
      return JSON.stringify(value.result.result);
    }

    // Arguments have already been validated upstream by the tool's Zod
    // inputSchema (which must be a ZodObject), so the runtime shape is
    // always a record here. A non-record value here signals a real upstream
    // bug we want surfaced, not a case to paper over with `{}`.
    const rawArgs: unknown = value.toolCall.arguments;
    if (!isRecord(rawArgs)) {
      throw new Error(
        `toolCall.arguments for "${value.toolCall.name}" must be an object after Zod validation, got ${describeNonRecord(rawArgs)}`,
      );
    }

    const modelOutputResult = await value.tool.function.toModelOutput({
      output: value.result.result,
      input: rawArgs,
    });
    if (modelOutputResult.type === 'content') {
      return modelOutputResult.value;
    }
    return JSON.stringify(value.result.result);
  }

  /**
   * Execute all tools in a single round in parallel.
   * Emits tool.result events after tool execution completes.
   *
   * @param toolCalls - The tool calls to execute
   * @param turnContext - The current turn context
   * @returns Object with the function call outputs formatted for the API and
   *   the list of HITL tool calls that paused (returned `null` from
   *   `onToolCalled`). Callers should break out of the execution loop when
   *   `pausedCalls` is non-empty rather than sending an incomplete set of
   *   outputs back to the model.
   */
  /**
   * Execute one tool call for a round: resolve the tool, honor any pending
   * PermissionRequest denial, wire preliminary-result broadcasting, and run
   * the tool through the full Pre/Post lifecycle hooks. Returns a tagged
   * outcome consumed by `executeToolRound`'s aggregation loop.
   */
  private async executeSingleToolCall(
    toolCall: ParsedToolCall<Tool>,
    turnContext: TurnContext,
  ): Promise<
    | null
    | {
        type: 'parse_error';
        output: models.FunctionCallOutputItem;
      }
    | {
        type: 'hook_blocked';
        output: models.FunctionCallOutputItem;
      }
    | {
        type: 'paused';
        toolCall: ParsedToolCall<Tool>;
      }
    | {
        type: 'execution';
        toolCall: ParsedToolCall<Tool>;
        tool: Tool;
        result: {
          result: unknown;
          error?: Error;
        };
        preliminaryResultsForCall: InferToolEventsUnion<TTools>[];
      }
  > {
    const tool = this.options.tools?.find(
      (t) => isClientTool(t) && t.function.name === toolCall.name,
    );
    if (!tool || !isAutoResolvableTool(tool)) {
      return null;
    }

    // PermissionRequest hook denied this call without pausing: synthesize a
    // rejection instead of executing. Consume the entry so a later round
    // with a reused id is not affected.
    const denialReason = this.hookDeniedCalls.get(toolCall.id);
    if (denialReason !== undefined) {
      this.hookDeniedCalls.delete(toolCall.id);
      return {
        type: 'hook_blocked' as const,
        output: {
          type: 'function_call_output' as const,
          id: `output_${toolCall.id}`,
          callId: toolCall.id,
          output: JSON.stringify({
            error: denialReason,
          }),
        },
      };
    }

    const preliminaryResultsForCall: InferToolEventsUnion<TTools>[] = [];

    const hasBroadcaster = this.toolEventBroadcaster || this.turnBroadcaster;
    const onPreliminaryResult = hasBroadcaster
      ? (callId: string, resultValue: unknown) => {
          const typedResult = resultValue as InferToolEventsUnion<TTools>;
          preliminaryResultsForCall.push(typedResult);
          this.broadcastPreliminaryResult(callId, typedResult);
        }
      : undefined;

    // Run the tool through the full Pre/Post lifecycle hooks. The helper
    // fails closed on a JSON-parse failure in toolCall.arguments so hooks
    // never see a malformed payload; the caller handles that case via the
    // shared `parse_error` / `hook_blocked` branch.
    const executed = await this.runToolWithHooks(tool, toolCall, turnContext, onPreliminaryResult);
    if (executed.type === 'parse_error') {
      this.broadcastToolResult(toolCall.id, isMcpTool(tool) ? 'mcp' : 'client', {
        error: executed.errorMessage,
      } as InferToolOutputsUnion<TTools>);
      return executed;
    }
    if (executed.type === 'hook_blocked') {
      return executed;
    }

    const result = executed.result;
    if (result === null) {
      // HITL tool paused — surface as manual (no output this round)
      return {
        type: 'paused' as const,
        toolCall,
      };
    }

    return {
      type: 'execution' as const,
      toolCall: executed.effectiveToolCall,
      tool,
      result,
      preliminaryResultsForCall,
    };
  }

  private async executeToolRound(
    toolCalls: ParsedToolCall<Tool>[],
    turnContext: TurnContext,
  ): Promise<{
    toolResults: models.FunctionCallOutputItem[];
    pausedCalls: ParsedToolCall<Tool>[];
  }> {
    const toolCallPromises = toolCalls.map((toolCall) =>
      this.executeSingleToolCall(toolCall, turnContext),
    );

    const settledResults = await Promise.allSettled(toolCallPromises);
    const toolResults: models.FunctionCallOutputItem[] = [];
    const pausedCalls: ParsedToolCall<Tool>[] = [];

    for (let i = 0; i < settledResults.length; i++) {
      const settled = settledResults[i];
      const originalToolCall = toolCalls[i];
      if (!settled || !originalToolCall) {
        continue;
      }

      if (settled.status === 'rejected') {
        const errorMessage =
          settled.reason instanceof Error ? settled.reason.message : String(settled.reason);

        // `runToolWithHooks` is the single point of emission for PostToolUseFailure.
        this.broadcastToolResult(
          originalToolCall.id,
          this.toolSourceByName(originalToolCall.name),
          {
            error: errorMessage,
          } as InferToolOutputsUnion<TTools>,
        );

        const rejectedOutput: models.FunctionCallOutputItem = {
          type: 'function_call_output' as const,
          id: `output_${originalToolCall.id}`,
          callId: originalToolCall.id,
          output: JSON.stringify({
            error: errorMessage,
          }),
        };
        toolResults.push(rejectedOutput);
        this.turnBroadcaster?.push({
          type: 'tool.call_output' as const,
          output: rejectedOutput,
          timestamp: Date.now(),
        } satisfies ToolCallOutputEvent);
        continue;
      }

      const value = settled.value;
      if (!value) {
        continue;
      }

      if (value.type === 'parse_error' || value.type === 'hook_blocked') {
        toolResults.push(value.output);
        this.turnBroadcaster?.push({
          type: 'tool.call_output' as const,
          output: value.output,
          timestamp: Date.now(),
        } satisfies ToolCallOutputEvent);
        continue;
      }

      if (value.type === 'paused') {
        // HITL tool returned null — record the pause so the caller can break
        // out of the outer loop before attempting a follow-up request with an
        // incomplete set of outputs. The call will be surfaced via state
        // (pendingToolCalls + status='awaiting_hitl') for manual resume.
        pausedCalls.push(value.toolCall);
        continue;
      }

      const toolResult = (
        value.result.error
          ? {
              error: value.result.error.message,
            }
          : value.result.result
      ) as InferToolOutputsUnion<TTools>;
      this.broadcastToolResult(
        value.toolCall.id,
        isMcpTool(value.tool) ? 'mcp' : 'client',
        toolResult,
        value.preliminaryResultsForCall.length > 0 ? value.preliminaryResultsForCall : undefined,
      );

      const outputForModel = await this.computeToolOutputForModel(value);

      const executedOutput: models.FunctionCallOutputItem = {
        type: 'function_call_output' as const,
        id: `output_${value.toolCall.id}`,
        callId: value.toolCall.id,
        output: outputForModel,
      };
      toolResults.push(executedOutput);
      this.turnBroadcaster?.push({
        type: 'tool.call_output' as const,
        output: executedOutput,
        timestamp: Date.now(),
      } satisfies ToolCallOutputEvent);
    }

    return {
      toolResults,
      pausedCalls,
    };
  }

  /**
   * Resolve async functions for the current turn.
   * Updates the resolved request with turn-specific parameter values.
   *
   * @param turnContext - The turn context for parameter resolution
   */
  private async resolveAsyncFunctionsForTurn(turnContext: TurnContext): Promise<void> {
    if (hasAsyncFunctions(this.options.request)) {
      const resolved = await resolveAsyncFunctions(this.options.request, turnContext);
      // Preserve accumulated input from previous turns
      const preservedInput = this.resolvedRequest?.input;
      const preservedStream = this.resolvedRequest?.stream;
      this.resolvedRequest = {
        ...resolved,
        stream: preservedStream ?? true,
        ...(preservedInput !== undefined && {
          input: preservedInput,
        }),
      };
    }
  }

  /**
   * Apply nextTurnParams from executed tools.
   * Allows tools to modify request parameters for subsequent turns.
   *
   * @param toolCalls - The tool calls that were just executed
   */
  private async applyNextTurnParams(toolCalls: ParsedToolCall<Tool>[]): Promise<void> {
    if (!this.options.tools || toolCalls.length === 0 || !this.resolvedRequest) {
      return;
    }

    const computedParams = await executeNextTurnParamsFunctions(
      toolCalls,
      this.options.tools,
      this.resolvedRequest,
    );

    if (Object.keys(computedParams).length > 0) {
      this.resolvedRequest = applyNextTurnParamsToRequest(this.resolvedRequest, computedParams);
    }
  }

  /**
   * Make a follow-up API request with tool results.
   * Uses streaming and pipes events through the turn broadcaster when available.
   */
  private async makeFollowupRequest(
    currentResponse: models.OpenResponsesResult,
    toolResults: models.FunctionCallOutputItem[],
    turnNumber: number,
  ): Promise<models.OpenResponsesResult> {
    const originalInput = this.resolvedRequest?.input;
    const normalizedOriginalInput: models.BaseInputsUnion[] = Array.isArray(originalInput)
      ? originalInput
      : originalInput
        ? [
            {
              role: 'user',
              content: originalInput,
            },
          ]
        : [];

    const newInput: models.InputsUnion = [
      ...normalizedOriginalInput,
      ...(Array.isArray(currentResponse.output)
        ? currentResponse.output
        : [
            currentResponse.output,
          ]),
      ...toolResults,
    ];

    if (!this.resolvedRequest) {
      throw new Error('Request not initialized');
    }

    // Update resolvedRequest.input with accumulated conversation for next turn
    this.resolvedRequest = {
      ...this.resolvedRequest,
      input: newInput,
    };

    const newRequest: models.ResponsesRequest = {
      ...this.resolvedRequest,
      stream: true,
    };

    const startedAt = performance.now();
    const newResult = await betaResponsesSend(
      this.options.client,
      {
        responsesRequest: newRequest,
      },
      this.options.options,
    );

    if (!newResult.ok) {
      throw newResult.error;
    }

    const response = await this.materializeResponse(newResult.value, turnNumber);
    await this.emitPostModelCall(response, startedAt, 'tool_round', turnNumber);
    return response;
  }

  /**
   * Make a final no-tools request to coerce a text response after the loop
   * was halted by `stopWhen` mid-tool-call. Reuses the resolved request so
   * `instructions`, `model`, and other API fields ride along unchanged.
   * `tools`, `toolChoice`, and `parallelToolCalls` are stripped — the whole
   * point is to force a text turn. The caller is expected to have already
   * executed the pending tool calls and to pass their outputs in
   * `toolOutputs` so every function_call in the input has a matching output.
   */
  private async makeFinalResponseRequest(
    currentResponse: models.OpenResponsesResult,
    toolOutputs: models.FunctionCallOutputItem[],
    allowFinalResponse: boolean | string,
    turnNumber: number,
  ): Promise<models.OpenResponsesResult> {
    if (!this.resolvedRequest) {
      throw new Error('Request not initialized');
    }

    const originalInput = this.resolvedRequest.input;
    const normalizedOriginalInput: models.BaseInputsUnion[] = Array.isArray(originalInput)
      ? originalInput
      : originalInput
        ? [
            {
              role: 'user',
              content: originalInput,
            },
          ]
        : [];

    const newInput: models.InputsUnion = [
      ...normalizedOriginalInput,
      ...(Array.isArray(currentResponse.output)
        ? currentResponse.output
        : [
            currentResponse.output,
          ]),
      ...toolOutputs,
      ...(typeof allowFinalResponse === 'string' && allowFinalResponse.length > 0
        ? [
            {
              role: 'user' as const,
              content: allowFinalResponse,
            },
          ]
        : []),
    ];

    const {
      tools: _tools,
      toolChoice: _toolChoice,
      parallelToolCalls: _parallelToolCalls,
      ...rest
    } = this.resolvedRequest;

    const finalRequest: models.ResponsesRequest = {
      ...rest,
      input: newInput,
      stream: true,
    };
    this.resolvedRequest = finalRequest;

    const startedAt = performance.now();
    const result = await betaResponsesSend(
      this.options.client,
      {
        responsesRequest: finalRequest,
      },
      this.options.options,
    );

    if (!result.ok) {
      throw result.error;
    }

    const response = await this.materializeResponse(result.value, turnNumber);
    await this.emitPostModelCall(response, startedAt, 'final', turnNumber);
    return response;
  }

  /**
   * Validate the final response has required fields.
   *
   * @param response - The response to validate
   * @param allowEmptyOutput - When true, tolerate an empty (but present) output array
   * @throws Error if response is missing required fields or has invalid output
   */
  private validateFinalResponse(
    response: models.OpenResponsesResult,
    allowEmptyOutput = false,
  ): void {
    if (!response?.id || !response?.output) {
      throw new Error('Invalid final response: missing required fields');
    }
    if (!Array.isArray(response.output) || response.output.length === 0) {
      if (allowEmptyOutput) {
        return;
      }
      throw new Error('Invalid final response: empty or invalid output');
    }
  }

  /**
   * Re-send the current resolved request (same accumulated input) once.
   * Used when a follow-up after tool execution returned an empty `output`.
   *
   * `tools`, `toolChoice`, and `parallelToolCalls` are stripped (mirroring
   * `makeFinalResponseRequest`) so the retry coerces a text turn: on the
   * natural-loop-completion path the resolved request still carries tools,
   * and a retry that emitted a fresh `function_call` would pass
   * `validateFinalResponse` but never be executed — silently dropping a
   * proposed tool call.
   */
  private async retryCurrentRequest(turnNumber: number): Promise<models.OpenResponsesResult> {
    if (!this.resolvedRequest) {
      throw new Error('Request not initialized');
    }

    const {
      tools: _tools,
      toolChoice: _toolChoice,
      parallelToolCalls: _parallelToolCalls,
      ...rest
    } = this.resolvedRequest;

    const newRequest: models.ResponsesRequest = {
      ...rest,
      stream: true,
    };

    const startedAt = performance.now();
    const newResult = await betaResponsesSend(
      this.options.client,
      {
        responsesRequest: newRequest,
      },
      this.options.options,
    );

    if (!newResult.ok) {
      throw newResult.error;
    }

    const response = await this.materializeResponse(newResult.value, turnNumber);
    await this.emitPostModelCall(response, startedAt, 'retry', turnNumber);
    return response;
  }

  /**
   * Resolve async functions in the request for a given turn context.
   * Extracts non-function fields and resolves any async parameter functions.
   *
   * @param context - The turn context for parameter resolution
   * @returns The resolved request without async functions
   */
  private async resolveRequestForContext(context: TurnContext): Promise<ResolvedCallModelInput> {
    if (hasAsyncFunctions(this.options.request)) {
      return resolveAsyncFunctions(this.options.request, context);
    }
    // Already resolved, extract non-function fields.
    // Strip ALL client-only fields — keep this list in sync with
    // `clientOnlyFields` in async-params.ts, which handles the async path.
    // (`sharedContextSchema` is absent here: call-model.ts destructures it
    // before the request reaches ModelResult.)
    const {
      stopWhen: _,
      state: _s,
      requireApproval: _r,
      approveToolCalls: _a,
      rejectToolCalls: _rj,
      context: _c,
      onTurnStart: _ots,
      onTurnEnd: _ote,
      allowFinalResponse: _afr,
      strictFinalResponse: _sfr,
      hooks: _h,
      ...rest
    } = this.options.request;
    return rest as ResolvedCallModelInput;
  }

  /**
   * Apply `onResponseReceived` hooks to the freshly-supplied input items
   * only, without re-hooking historical items that live in
   * `currentState.messages`. Historical `function_call` items are passed to
   * `applyOnResponseReceivedHooks` purely as callId → toolName
   * name-resolution context and are dropped from the returned array.
   *
   * This keeps hooks idempotent across `callModel` invocations on the same
   * conversation: the first call hooks the caller-supplied output, and
   * subsequent calls (which rehydrate state) do not re-fire it.
   *
   * @param freshItems - Items newly supplied this turn (not yet hooked).
   *   May contain any mix of InputsUnion array members — only
   *   `function_call_output` items are affected by hooks; everything else
   *   is returned unchanged.
   * @param historicalItems - Existing messages from loaded state. Only
   *   `function_call` entries are consulted for name resolution; no other
   *   items are inspected and none are mutated.
   * @param turnContext - Turn context for hook invocation
   * @returns The fresh items in original order, with `output` rewritten on
   *   any `function_call_output` whose matching HITL tool defines
   *   `onResponseReceived`.
   */
  private async applyHooksToFreshItems(
    freshItems: models.BaseInputsUnion[],
    historicalItems: models.InputsUnion,
    turnContext: TurnContext,
  ): Promise<models.BaseInputsUnion[]> {
    if (freshItems.length === 0) {
      return freshItems;
    }

    // Collect function_call items from history so the hook executor can
    // resolve callId -> toolName without us having to mirror that logic.
    const historyArray = Array.isArray(historicalItems)
      ? historicalItems
      : [
          historicalItems,
        ];
    const functionCallItems: models.BaseInputsUnion[] = [];
    for (const item of historyArray) {
      if (isFunctionCallItem(item)) {
        functionCallItems.push(item);
      }
    }

    // Build a synthetic input that puts the historical function_calls
    // BEFORE the fresh items. `applyOnResponseReceivedHooks` only rewrites
    // function_call_output items, so the function_call items are seen only
    // as name-resolution context.
    const syntheticInput: models.InputsUnion = [
      ...functionCallItems,
      ...freshItems,
    ];

    const hookedInput = await applyOnResponseReceivedHooks(
      syntheticInput,
      this.options.tools,
      turnContext,
      this.contextStore ?? undefined,
      this.options.sharedContextSchema,
    );

    if (hookedInput === syntheticInput) {
      // No rewrites; return the originals unchanged.
      return freshItems;
    }

    // Drop the leading function_call items we prepended; what remains is
    // the fresh items in their original order (some with rewritten outputs).
    const hookedArray = Array.isArray(hookedInput)
      ? hookedInput
      : [
          hookedInput,
        ];
    if (hookedArray.length !== syntheticInput.length) {
      // Shouldn't happen (hooks only rewrite in-place), but be conservative.
      return freshItems;
    }
    return hookedArray.slice(functionCallItems.length);
  }

  /**
   * Safely persist state with error handling.
   * Wraps state save operations to ensure failures are properly reported.
   *
   * @param updates - Optional partial state updates to apply before saving
   * @throws Error if state persistence fails
   */
  private async saveStateSafely(
    updates?: Partial<Omit<ConversationState<TTools>, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<void> {
    if (!this.stateAccessor || !this.currentState) {
      return;
    }

    if (updates) {
      this.currentState = updateState(this.currentState, updates);
    }

    try {
      await this.stateAccessor.save(this.currentState);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to persist conversation state: ${message}`);
    }
  }

  /**
   * Remove optional properties from state when they should be cleared.
   * Uses delete to properly remove optional properties rather than setting undefined.
   *
   * @param props - Array of property names to remove from current state
   */
  private clearOptionalStateProperties(
    props: Array<'pendingToolCalls' | 'unsentToolResults' | 'interruptedBy' | 'partialResponse'>,
  ): void {
    if (!this.currentState) {
      return;
    }
    for (const prop of props) {
      delete this.currentState[prop];
    }
  }

  // =========================================================================
  // Core Methods
  // =========================================================================

  /**
   * Initialize the stream if not already started
   * This is idempotent - multiple calls will return the same promise
   */
  private initStream(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    // biome-ignore lint: IIFE used for lazy initialization pattern
    this.initPromise = (async () => {
      // Load or create state if accessor provided
      if (this.stateAccessor) {
        const loadedState = await this.stateAccessor.load();
        if (loadedState) {
          this.currentState = loadedState;

          // Check if we're resuming from awaiting_approval or awaiting_hitl
          // with decisions. `awaiting_hitl` reuses `processApprovalDecisions`
          // because the resume mechanism is identical — the caller supplies
          // `approveToolCalls`/`rejectToolCalls` for paused call IDs, and we
          // re-invoke `executeTool` on approved calls (which re-runs
          // `onToolCalled` for HITL tools).
          const isResumableStatus =
            loadedState.status === 'awaiting_approval' || loadedState.status === 'awaiting_hitl';
          if (
            isResumableStatus &&
            (this.approvedToolCalls.length > 0 || this.rejectedToolCalls.length > 0)
          ) {
            // Initialize context store before resuming so tools have access
            if (this.options.context !== undefined) {
              const approvalContext: TurnContext = {
                numberOfTurns: 0,
              };
              const resolvedCtx = await resolveContext(this.options.context, approvalContext);
              this.contextStore = new ToolContextStore(resolvedCtx);
            }

            this.isResumingFromApproval = true;
            // This path bypasses the SessionStart block below but still fires
            // tool hooks (PreToolUse/PostToolUse) during the resume. Those
            // emits thread the session id per emit via hookEmitContext();
            // priming the manager-level default here covers direct emit()
            // callers on a shared manager.
            this.hooksManager?.setSessionId(loadedState.id);
            await this.processApprovalDecisions();
            return; // Skip normal initialization, we're resuming
          }

          // Check for interruption flag and handle
          if (loadedState.interruptedBy) {
            // Clear interruption flag and continue from saved state
            this.currentState = updateState(loadedState, {
              status: 'in_progress',
            });
            this.clearOptionalStateProperties([
              'interruptedBy',
            ]);
            await this.saveStateSafely();
          }

          // Keep manual calls durable until the resumed request produces a
          // response. Clearing before the API call would lose the only copy if
          // that request failed.
          this.resumingFromClientTools = loadedState.status === 'awaiting_client_tools';
        } else {
          this.currentState = createInitialState<TTools>();
        }

        if (!this.resumingFromClientTools) {
          await this.saveStateSafely({
            status: 'in_progress',
          });
        }
      }

      // Resolve async functions before initial request
      // Build initial turn context (turn 0 for initial request)
      const initialContext: TurnContext = {
        numberOfTurns: 0,
      };

      // Initialize context store from the context option
      if (this.options.context !== undefined) {
        const resolvedCtx = await resolveContext(this.options.context, initialContext);
        this.contextStore = new ToolContextStore(resolvedCtx);
      }

      // Resolve any async functions first
      let baseRequest = await this.resolveRequestForContext(initialContext);

      // Emit SessionStart hook. The `config` payload carries a stable, small
      // summary of session-level options so handlers can make routing/auditing
      // decisions without the SDK having to promise more than it can deliver.
      // If future session config becomes available, extend this object rather
      // than introducing a new payload field.
      if (this.hooksManager) {
        // Prime the manager-level default for callers that emit custom hooks
        // on a shared manager; the engine's own emits thread the session id
        // per emit via hookEmitContext() so concurrent runs sharing one
        // manager can't clobber each other's context.sessionId.
        this.hooksManager.setSessionId(this.currentState?.id ?? '');
        await this.hooksManager.emit(
          'SessionStart',
          {
            config: {
              hasTools: !!this.options.tools?.length,
              hasApproval:
                !!this.requireApprovalFn ||
                !!(this.options.tools ?? []).some(
                  (t) =>
                    isClientTool(t) &&
                    (t.function.requireApproval === true ||
                      typeof t.function.requireApproval === 'function'),
                ),
              hasState: !!this.stateAccessor,
            },
          },
          this.hookEmitContext(),
        );
        this.sessionStartEmitted = true;
      }

      // Emit UserPromptSubmit hook BEFORE the stateful input-wrapping block so
      // the handler sees the original user-supplied prompt string (and can
      // reject or mutate it before any messages are appended). For structured
      // (non-string) inputs we extract the latest user-role text content so
      // handlers still get a chance to intercept; if nothing suitable is
      // found we skip silently and document the limitation in the log below.
      if (this.hooksManager) {
        const promptResult = await this.maybeRunUserPromptSubmit(baseRequest.input);
        if (promptResult) {
          baseRequest = {
            ...baseRequest,
            input: promptResult.applyTo(baseRequest.input),
          };
        }
      }

      // Split input into "historical" (already in state.messages) and "fresh"
      // (newly supplied this turn). `onResponseReceived` must fire only for
      // fresh items — re-hooking historical outputs on every callModel call
      // would double-invoke non-idempotent hooks.
      //
      // Fresh items are tracked locally and persisted to state only after the
      // API call succeeds, avoiding duplication when a caller retries after a
      // transient API failure.
      const hasLoadedHistory =
        !!this.currentState?.messages &&
        Array.isArray(this.currentState.messages) &&
        this.currentState.messages.length > 0;

      let freshItemsForState: models.BaseInputsUnion[] | undefined;

      if (hasLoadedHistory && this.currentState) {
        // `currentState.messages` is InputsUnion — keep it as that union so
        // appendToMessages (which expects InputsUnion) accepts it directly.
        const historicalMessages: models.InputsUnion = this.currentState.messages;

        // Normalize the caller-supplied input for this turn into an array of
        // fresh items. Undefined stays undefined (no new items). The widening
        // to BaseInputsUnion[] matches the signature of appendToMessages and
        // mirrors the pre-existing pattern elsewhere in this file; the two
        // union shapes (InputsUnion1 vs BaseInputsUnion1) describe the same
        // SDK input items with different nominal types, and BaseInputsUnion
        // already includes `any` in its element type, so the runtime shape
        // is preserved either way.
        // Normalize (not just wrap): bare strings must become EasyInputMessage
        // items, exactly as the no-history branch does via
        // normalizeInputToArray. Passing a raw string through to the request
        // input array is rejected by OpenResponses validation (400).
        const newInput = baseRequest.input;
        const freshItems: models.BaseInputsUnion[] | undefined =
          newInput !== undefined ? normalizeInputToArray(newInput) : undefined;

        // Hook fresh items only (historical function_calls serve as
        // name-resolution context). Leave historical items untouched.
        const hookedFresh = freshItems
          ? await this.applyHooksToFreshItems(freshItems, historicalMessages, initialContext)
          : undefined;

        freshItemsForState = hookedFresh;

        baseRequest = {
          ...baseRequest,
          input: hookedFresh
            ? appendToMessages(historicalMessages, hookedFresh)
            : historicalMessages,
        };
      } else if (baseRequest.input !== undefined) {
        // No loaded history — everything in input is fresh. Hook the whole
        // thing (non-array inputs pass through applyOnResponseReceivedHooks
        // unchanged).
        const hookedInput = await applyOnResponseReceivedHooks(
          baseRequest.input,
          this.options.tools,
          initialContext,
          this.contextStore ?? undefined,
          this.options.sharedContextSchema,
        );

        freshItemsForState = normalizeInputToArray(hookedInput);

        baseRequest = {
          ...baseRequest,
          input: hookedInput,
        };
      }

      // Store resolved request with stream mode
      this.resolvedRequest = {
        ...baseRequest,
        stream: true as const,
      };

      // Force stream mode for initial request
      const request = this.resolvedRequest;

      // Park PostModelCall telemetry for this dispatch: the response is
      // materialized later (getInitialResponse or the no-tools stream
      // teardown), which completes the emit with the true duration.
      this.pendingModelCall = {
        startedAt: performance.now(),
        turnType: 'initial',
        turnNumber: 0,
      };

      // Make the API request
      const apiResult = await betaResponsesSend(
        this.options.client,
        {
          responsesRequest: request,
        },
        this.options.options,
      );

      if (!apiResult.ok) {
        throw apiResult.error;
      }

      // Stash fresh user items so saveResponseToState can persist them
      // atomically with the assistant output. Writing them here would leave
      // an orphaned user turn if the stream fails after ok:true — on retry
      // the same input would be appended again, producing duplicates.
      if (freshItemsForState && freshItemsForState.length > 0) {
        this.pendingFreshItems = freshItemsForState;
      }

      // Handle both streaming and non-streaming responses
      // The API may return a non-streaming response even when stream: true is requested
      if (isEventStream(apiResult.value)) {
        this.reusableStream = new ReusableReadableStream(apiResult.value);
      } else if (this.isNonStreamingResponse(apiResult.value)) {
        // API returned a complete response directly - use it as the final response
        this.finalResponse = apiResult.value;
        await this.emitPendingModelCallOnce(this.finalResponse);
      } else {
        throw new Error('Unexpected response type from API');
      }
    })();

    return this.initPromise;
  }

  /**
   * Process approval/rejection decisions and resume execution
   */
  private async processApprovalDecisions(): Promise<void> {
    if (!this.currentState || !this.stateAccessor) {
      throw new Error('Cannot process approval decisions without state');
    }

    const pendingCalls = this.currentState.pendingToolCalls ?? [];
    const unsentResults = [
      ...(this.currentState.unsentToolResults ?? []),
    ];

    // Build turn context - numberOfTurns represents the current turn (1-indexed after initial)
    const turnContext: TurnContext = {
      numberOfTurns: this.allToolExecutionRounds.length + 1,
      // context is handled via contextStore, not on TurnContext
    };

    // Track approved HITL calls that paused (onToolCalled returned null) —
    // these stay in pendingToolCalls so the caller can resume them later.
    const hitlPausedIds = new Set<string>();

    // Process approvals - execute the approved tools. Route through
    // runToolWithHooks so PreToolUse/PostToolUse fire even on this path.
    for (const callId of this.approvedToolCalls) {
      const toolCall = pendingCalls.find((tc) => tc.id === callId);
      if (!toolCall) {
        continue;
      }

      const tool = this.options.tools?.find(
        (t) => isClientTool(t) && t.function.name === toolCall.name,
      );
      if (!tool || !isAutoResolvableTool(tool)) {
        // Can't execute, create error result
        unsentResults.push(
          createRejectedResult(callId, String(toolCall.name), 'Tool not found or not executable'),
        );
        continue;
      }

      const hookOutcome = await this.runToolWithHooks(
        tool,
        toolCall as ParsedToolCall<Tool>,
        turnContext,
      );

      if (hookOutcome.type === 'parse_error') {
        this.broadcastToolResult(callId, this.toolSourceByName(String(toolCall.name)), {
          error: hookOutcome.errorMessage,
        } as InferToolOutputsUnion<TTools>);
        unsentResults.push(
          createRejectedResult(callId, String(toolCall.name), hookOutcome.errorMessage),
        );
        continue;
      }

      if (hookOutcome.type === 'hook_blocked') {
        unsentResults.push(createRejectedResult(callId, String(toolCall.name), hookOutcome.reason));
        continue;
      }

      const result = hookOutcome.result;

      if (result === null) {
        // HITL tool paused on approval — keep the call visible to the caller
        // via pendingToolCalls (status becomes 'awaiting_hitl' below).
        hitlPausedIds.add(callId);
        continue;
      }

      if (result.error) {
        unsentResults.push(
          createRejectedResult(callId, String(toolCall.name), result.error.message),
        );
      } else {
        unsentResults.push(createUnsentResult(callId, String(toolCall.name), result.result));
      }
    }

    // Process rejections
    for (const callId of this.rejectedToolCalls) {
      const toolCall = pendingCalls.find((tc) => tc.id === callId);
      if (!toolCall) {
        continue;
      }

      unsentResults.push(createRejectedResult(callId, String(toolCall.name), 'Rejected by user'));
    }

    // Remove processed calls from pending. Approved HITL calls that paused are
    // NOT considered processed — they stay on pendingToolCalls so getPendingToolCalls()
    // still surfaces them to the caller on resume.
    const processedIds = new Set(
      [
        ...this.approvedToolCalls,
        ...this.rejectedToolCalls,
      ].filter((id) => !hitlPausedIds.has(id)),
    );
    const remainingPending = pendingCalls.filter((tc) => !processedIds.has(tc.id));

    // Determine status:
    //   - Any still-unprocessed approval-required call keeps us in 'awaiting_approval'
    //   - Otherwise, any HITL paused call moves us to 'awaiting_hitl'
    //   - Otherwise, we continue with 'in_progress'
    const remainingUnresolvedApprovals = remainingPending.filter((tc) => !hitlPausedIds.has(tc.id));
    let nextStatus: ConversationStatus;
    if (remainingUnresolvedApprovals.length > 0) {
      nextStatus = 'awaiting_approval';
    } else if (hitlPausedIds.size > 0) {
      nextStatus = 'awaiting_hitl';
    } else {
      nextStatus = 'in_progress';
    }

    // Update state - conditionally include optional properties only if they have values
    const stateUpdates: Partial<Omit<ConversationState<TTools>, 'id' | 'createdAt' | 'updatedAt'>> =
      {
        status: nextStatus,
      };
    if (remainingPending.length > 0) {
      stateUpdates.pendingToolCalls = remainingPending;
    }
    if (unsentResults.length > 0) {
      stateUpdates.unsentToolResults = unsentResults as UnsentToolResult<TTools>[];
    }
    await this.saveStateSafely(stateUpdates);

    // Clear optional properties if they should be empty
    const propsToClear: Array<'pendingToolCalls' | 'unsentToolResults'> = [];
    if (remainingPending.length === 0) {
      propsToClear.push('pendingToolCalls');
    }
    if (unsentResults.length === 0) {
      propsToClear.push('unsentToolResults');
    }
    if (propsToClear.length > 0) {
      this.clearOptionalStateProperties(propsToClear);
      await this.saveStateSafely();
    }

    // If we are paused (for approval or for HITL), stop here
    if (nextStatus !== 'in_progress') {
      return;
    }

    // Otherwise, continue with tool execution using unsent results
    await this.continueWithUnsentResults();
  }

  /**
   * Continue execution with unsent tool results
   */
  private async continueWithUnsentResults(): Promise<void> {
    if (!this.currentState || !this.stateAccessor) {
      return;
    }

    const unsentResults = this.currentState.unsentToolResults ?? [];
    if (unsentResults.length === 0) {
      return;
    }

    // Convert to API format
    const toolOutputs = unsentResultsToAPIFormat(unsentResults);

    // Build turn context for hook resolution
    // numberOfTurns represents the current turn number (1-indexed after initial)
    const turnContext: TurnContext = {
      numberOfTurns: this.allToolExecutionRounds.length + 1,
    };

    // Append SDK-generated tool outputs directly — `onResponseReceived` is
    // reserved for caller-supplied outputs (the resume-with-function-call-
    // output path, hooked during init). SDK-produced outputs from auto-
    // executed tools already went through the tool's own execute/generator
    // pipeline and must not be mutated by the resume hook.
    const currentMessages = this.currentState.messages;
    const newInput = appendToMessages(currentMessages, toolOutputs);

    // Clear unsent results from state
    this.currentState = updateState(this.currentState, {
      messages: newInput,
    });
    this.clearOptionalStateProperties([
      'unsentToolResults',
    ]);
    await this.saveStateSafely();

    // Build request with the updated input
    const baseRequest = await this.resolveRequestForContext(turnContext);

    // No hooking here: SDK-generated outputs are appended as-is and any
    // caller-supplied items in `newInput` (carried over from init) were
    // already hooked during `initStream` — re-hooking would double-fire
    // non-idempotent hooks.
    const request: models.ResponsesRequest = {
      ...baseRequest,
      input: newInput,
      stream: true,
    };

    this.resolvedRequest = request;

    // Park PostModelCall telemetry for the resume dispatch (see initStream).
    this.pendingModelCall = {
      startedAt: performance.now(),
      turnType: 'resume',
      turnNumber: turnContext.numberOfTurns,
    };

    // Make the API request
    const apiResult = await betaResponsesSend(
      this.options.client,
      {
        responsesRequest: request,
      },
      this.options.options,
    );

    if (!apiResult.ok) {
      throw apiResult.error;
    }

    // Handle both streaming and non-streaming responses
    if (isEventStream(apiResult.value)) {
      this.reusableStream = new ReusableReadableStream(apiResult.value);
    } else if (this.isNonStreamingResponse(apiResult.value)) {
      this.finalResponse = apiResult.value;
      await this.emitPendingModelCallOnce(this.finalResponse);
    } else {
      throw new Error('Unexpected response type from API');
    }
  }

  /**
   * Execute tools automatically if they are provided and have execute functions
   * This is idempotent - multiple calls will return the same promise
   */
  private async executeToolsIfNeeded(): Promise<void> {
    if (this.toolExecutionPromise) {
      return this.toolExecutionPromise;
    }

    // biome-ignore lint: IIFE used for lazy initialization pattern
    this.toolExecutionPromise = (async () => {
      // SessionEnd/drain must fire on every exit path (success, early return,
      // approval pause, interruption, and exceptions), so wrap the body in
      // try/catch/finally and track the session-end reason as we go.
      // Approval pauses keep reason='complete' because the run hasn't failed —
      // it's simply paused awaiting user decisions.
      let sessionEndReason: 'user' | 'error' | 'max_turns' | 'complete' = 'complete';
      try {
        await this.initStream();

        // If resuming from approval or HITL pause and still pending, don't continue.
        // `processApprovalDecisions` runs in initStream for resumes; if it left us
        // paused (any remaining pending calls), the outer loop should not execute.
        if (
          this.isResumingFromApproval &&
          (this.currentState?.status === 'awaiting_approval' ||
            this.currentState?.status === 'awaiting_hitl')
        ) {
          return;
        }

        // Get initial response
        let currentResponse = await this.getInitialResponse();

        // Save initial response to state
        await this.saveResponseToState(currentResponse);

        // Check if tools should be executed
        const hasToolCalls = currentResponse.output.some(
          (item) => hasTypeProperty(item) && item.type === 'function_call',
        );

        if (!this.options.tools?.length || !hasToolCalls) {
          // No tool work: keep hard throw on empty/invalid final output.
          this.validateFinalResponse(currentResponse);
          this.finalResponse = currentResponse;
          await this.markStateComplete();
          return;
        }

        // Extract and check tool calls
        const toolCalls = extractToolCallsFromResponse(currentResponse);

        // Check for approval requirements
        if (await this.handleApprovalCheck(toolCalls, 0, currentResponse)) {
          return; // Paused for approval
        }

        // All tool calls are manual (no execute / no onToolCalled) or
        // otherwise non-auto-resolvable — stop and surface them as pending
        // client tools instead of marking the conversation complete with
        // empty pendings.
        if (!this.hasExecutableToolCalls(toolCalls)) {
          await this.persistClientToolsPause(currentResponse, toolCalls);
          return;
        }

        // Main execution loop
        let currentRound = 0;
        let stoppedByStopWhen = false;
        // Counts consecutive Stop-hook forceResume overrides without tool
        // progress; reset when a tool round or fresh response lands. See
        // runStopHook for the cap.
        let forceResumeCount = 0;

        while (true) {
          // Check for external interruption
          if (await this.checkForInterruption(currentResponse)) {
            sessionEndReason = 'user';
            return;
          }

          // Check stop conditions
          if (await this.shouldStopExecution()) {
            // Emit the Stop hook -- handlers can force resume or inject a
            // prompt. The helper enforces the consecutive-override cap so a
            // misbehaving handler cannot spin the loop forever.
            const stopDecision = await this.runStopHook(forceResumeCount);
            if (stopDecision === 'resume') {
              forceResumeCount++;
              // Continue the loop. If appendPrompt was supplied it was
              // already injected, which advances state so the stop condition
              // may no longer fire on the next iteration.
              continue;
            }
            // Stop condition fired and the hook (if any) did not force resume
            // -- this is a max_turns-style exit, not a natural completion.
            sessionEndReason = 'max_turns';
            stoppedByStopWhen = true;
            break;
          }

          const currentToolCalls = extractToolCallsFromResponse(currentResponse);
          if (currentToolCalls.length === 0) {
            break;
          }

          // Check for approval requirements
          if (await this.handleApprovalCheck(currentToolCalls, currentRound + 1, currentResponse)) {
            return;
          }

          // All-manual (or otherwise non-auto-resolvable) mid-loop round: stop
          // and persist the unresolved calls the same way the first-round
          // guard does above, so getPendingToolCalls() surfaces them after
          // loop end.
          if (!this.hasExecutableToolCalls(currentToolCalls)) {
            await this.persistClientToolsPause(currentResponse, currentToolCalls);
            return;
          }

          // Build turn context
          const turnNumber = currentRound + 1;
          const turnContext: TurnContext = {
            numberOfTurns: turnNumber,
          };

          await this.options.onTurnStart?.(turnContext);

          // Resolve async functions for this turn
          await this.resolveAsyncFunctionsForTurn(turnContext);

          // Execute tools
          const { toolResults, pausedCalls } = await this.executeToolRound(
            currentToolCalls,
            turnContext,
          );

          // A tool round with observable progress resets the consecutive
          // forceResume counter so a legitimate override earlier in the run
          // does not count against a later, independent one.
          // Hook-blocked / rejected outputs deliberately count as progress:
          // the model receives the block or denial as feedback and can change
          // course on the next turn, which is observable forward motion even
          // though no tool body executed. A PreToolUse hook that blocks every
          // call therefore keeps resetting this counter -- acceptable,
          // because each reset requires a full model round trip (the loop
          // cannot spin hot) and stopWhen conditions still bound the run.
          if (toolResults.length > 0) {
            forceResumeCount = 0;
          }

          // Server-tool output items are already-executed results in the
          // response; collect them so toolResults presents a unified list.
          const serverToolItems: ToolResultItem[] = [];
          for (const item of currentResponse.output) {
            if (!hasTypeProperty(item)) {
              continue;
            }
            if (
              item.type === 'message' ||
              item.type === 'reasoning' ||
              item.type === 'function_call'
            ) {
              continue;
            }
            // Everything else is a server-tool output item (web_search_call,
            // image_generation_call, file_search_call, or generic
            // OutputServerToolItem covering openrouter:datetime and any new
            // SDK server tool types).
            if (isServerToolResultItem(item)) {
              serverToolItems.push(item);
            }
          }

          // Track execution round
          this.allToolExecutionRounds.push({
            round: currentRound,
            toolCalls: currentToolCalls,
            response: currentResponse,
            toolResults: [
              ...toolResults,
              ...serverToolItems,
            ],
          });

          // Save tool results to state
          await this.saveToolResultsToState(toolResults);

          // If any HITL tools paused this round, stop here without making a
          // follow-up request — sending an incomplete set of outputs would be
          // incorrect. Persist the paused calls so the caller can resume later.
          if (pausedCalls.length > 0) {
            await this.persistHitlPause(currentResponse, pausedCalls);
            return;
          }

          // Manual (client-executed) tools produce no output this round —
          // `executeToolRound` returns nothing for them — so a mixed round of
          // auto-executed and manual calls would otherwise send a follow-up
          // request whose input contains a `function_call` with no matching
          // `function_call_output`. Providers reject that history with a 400
          // ("No tool output found for function call ..."). Stop the loop and
          // surface the response instead, so the caller can execute the manual
          // calls and continue — mirroring the all-manual behavior of the
          // `hasExecutableToolCalls` guards. Also covers calls to tool names
          // not present in `options.tools` at all.
          const resolvedCallIds = new Set(toolResults.map((r) => r.callId));
          const unresolvedToolCalls = currentToolCalls.filter((tc) => !resolvedCallIds.has(tc.id));
          if (unresolvedToolCalls.length > 0) {
            // Mixed auto + manual (or unknown-name) round — regular tool
            // outputs were already persisted via saveToolResultsToState above;
            // surface the unresolved calls on pendingToolCalls and stop.
            await this.persistClientToolsPause(currentResponse, unresolvedToolCalls);
            return;
          }

          // Apply nextTurnParams
          await this.applyNextTurnParams(currentToolCalls);

          currentResponse = await this.makeFollowupRequest(
            currentResponse,
            toolResults,
            turnNumber,
          );
          // A fresh response replaces the prior one -- that's new progress,
          // so reset consecutive forceResume counting.
          forceResumeCount = 0;

          await this.options.onTurnEnd?.(turnContext, currentResponse);

          // Save new response to state
          await this.saveResponseToState(currentResponse);

          currentRound++;
        }

        // If stopWhen broke the loop while the model was still emitting tool
        // calls, execute those tool calls so they have matching outputs, then
        // make one more no-tools request to coerce a final text response. An
        // empty string still counts as "on" — it just means "don't append a
        // user message."
        const allowFinalResponse = this.options.allowFinalResponse;
        const finalResponseEnabled =
          allowFinalResponse === true || typeof allowFinalResponse === 'string';
        const pendingToolCalls = stoppedByStopWhen
          ? extractToolCallsFromResponse(currentResponse)
          : [];
        if (
          stoppedByStopWhen &&
          finalResponseEnabled &&
          pendingToolCalls.length > 0 &&
          this.hasExecutableToolCalls(pendingToolCalls)
        ) {
          const turnNumber = currentRound + 1;
          const turnContext: TurnContext = {
            numberOfTurns: turnNumber,
          };

          if (await this.handleApprovalCheck(pendingToolCalls, turnNumber, currentResponse)) {
            return;
          }

          await this.options.onTurnStart?.(turnContext);
          await this.resolveAsyncFunctionsForTurn(turnContext);

          const { toolResults, pausedCalls } = await this.executeToolRound(
            pendingToolCalls,
            turnContext,
          );

          // Track the executed round and persist real outputs BEFORE the HITL
          // pause check — mirrors the in-loop ordering at executeToolsIfNeeded
          // so a partial batch (HITL + regular tools) doesn't drop the regular
          // tool's output from state on resume.
          this.allToolExecutionRounds.push({
            round: currentRound,
            toolCalls: pendingToolCalls,
            response: currentResponse,
            toolResults: [
              ...toolResults,
            ],
          });
          await this.saveToolResultsToState(toolResults);

          if (pausedCalls.length > 0) {
            // HITL paused — persist and exit without making the final no-tools
            // request. The conversation will resume via the normal awaiting_hitl
            // flow.
            await this.persistHitlPause(currentResponse, pausedCalls);
            return;
          }

          // Apply any nextTurnParams from the executed tools so they affect the
          // final no-tools request (mirrors the in-loop behavior).
          await this.applyNextTurnParams(pendingToolCalls);

          // Pair any manual tool calls (no execute fn) with stub outputs so
          // every function_call in the *request* has a matching output. Stubs
          // are NOT persisted to state — only real tool outputs are — so a
          // resumed conversation doesn't see "Tool execution skipped" as if it
          // were a real result.
          const executedCallIds = new Set(toolResults.map((r) => r.callId));
          const stubOutputs: models.FunctionCallOutputItem[] = pendingToolCalls
            .filter((tc) => !executedCallIds.has(tc.id))
            .map((tc) => ({
              type: 'function_call_output' as const,
              callId: tc.id,
              output: 'Tool execution skipped: step limit reached.',
            }));
          const requestOutputs = [
            ...toolResults,
            ...stubOutputs,
          ];

          currentResponse = await this.makeFinalResponseRequest(
            currentResponse,
            requestOutputs,
            allowFinalResponse,
            turnNumber,
          );

          await this.options.onTurnEnd?.(turnContext, currentResponse);
          await this.saveResponseToState(currentResponse);
        }

        // Validate and finalize. Mini-class models intermittently return an
        // empty final turn after a successful tool round (the tool call was
        // the answer). Retry once, then tolerate empty output so a completed
        // run isn't reported as failure — unless `strictFinalResponse` is set.
        const canTolerateEmptyFinal =
          this.allToolExecutionRounds.length > 0 && this.options.strictFinalResponse !== true;
        const isEmptyOutput =
          Array.isArray(currentResponse.output) && currentResponse.output.length === 0;

        if (canTolerateEmptyFinal && isEmptyOutput) {
          const turnNumber = this.allToolExecutionRounds.length + 1;
          currentResponse = await this.retryCurrentRequest(turnNumber);
          // Persist the retried response like every other response in the
          // loop — otherwise stateful conversations silently lose the final
          // turn's content on resume.
          await this.saveResponseToState(currentResponse);
        }

        const allowEmptyOutput =
          canTolerateEmptyFinal &&
          Array.isArray(currentResponse.output) &&
          currentResponse.output.length === 0;

        this.validateFinalResponse(currentResponse, allowEmptyOutput);
        this.finalResponse = currentResponse;
        await this.markStateComplete();
      } catch (error) {
        sessionEndReason = 'error';
        throw error;
      } finally {
        // Session teardown must never mask the original error: a throw from
        // a `finally` block replaces the in-flight exception, so a throwing
        // SessionEnd handler (strict mode) would silently swallow the real
        // root cause. Log teardown failures instead.
        //
        // drain() runs unconditionally (not gated on SessionStart) so
        // fire-and-forget hook work from paths that skip SessionStart --
        // e.g. approval resume, which runs Pre/PostToolUse in initStream --
        // is still awaited before the run settles.
        try {
          await this.emitSessionEndOnce(sessionEndReason);
          if (this.hooksManager) {
            await this.hooksManager.drain();
          }
        } catch (teardownError) {
          console.warn('[SessionEnd] error during session teardown:', teardownError);
        }
      }
    })();

    return this.toolExecutionPromise;
  }

  /**
   * Internal helper to get the text after tool execution
   */
  private async getTextInternal(): Promise<string> {
    await this.executeToolsIfNeeded();

    if (!this.finalResponse) {
      throw new Error('Response not available');
    }

    return extractTextFromResponse(this.finalResponse);
  }

  /**
   * Get just the text content from the response.
   * This will consume the stream until completion, execute any tools, and extract the text.
   */
  getText(): Promise<string> {
    if (this.textPromise) {
      return this.textPromise;
    }

    this.textPromise = this.getTextInternal();
    return this.textPromise;
  }

  /**
   * Get the complete response object including usage information.
   * This will consume the stream until completion and execute any tools.
   * Returns the full OpenResponsesResult with usage data (inputTokens, outputTokens, cachedTokens, etc.)
   */
  async getResponse(): Promise<models.OpenResponsesResult> {
    await this.executeToolsIfNeeded();

    if (!this.finalResponse) {
      throw new Error('Response not available');
    }

    return this.finalResponse;
  }

  /**
   * Stream all response events as they arrive across all turns.
   * Multiple consumers can iterate over this stream concurrently.
   * Includes API events, tool events, and turn.start/turn.end delimiters.
   */
  getFullResponsesStream(): AsyncIterableIterator<
    ResponseStreamEvent<InferToolEventsUnion<TTools>, InferToolOutputsUnion<TTools>>
  > {
    return async function* (this: ModelResult<TTools, TShared>) {
      await this.initStreamGuarded();

      if (!this.options.tools?.length) {
        let streamFailed = false;
        try {
          if (this.reusableStream) {
            const consumer = this.reusableStream.createConsumer();
            for await (const event of consumer) {
              yield event;
            }
          }
        } catch (error) {
          streamFailed = true;
          throw error;
        } finally {
          await this.finishHooksSessionForStream(streamFailed ? 'error' : 'complete');
        }
        return;
      }

      const { consumer, executionPromise } = this.startTurnBroadcasterExecution();

      for await (const event of consumer) {
        yield event;
      }

      await executionPromise;
    }.call(this);
  }

  /**
   * Stream only text deltas as they arrive from all turns.
   * This filters the full event stream to only yield text content,
   * including text from follow-up responses in multi-turn tool loops.
   */
  getTextStream(): AsyncIterableIterator<string> {
    return async function* (this: ModelResult<TTools, TShared>) {
      await this.initStreamGuarded();

      if (!this.options.tools?.length) {
        let streamFailed = false;
        try {
          if (this.reusableStream) {
            yield* extractTextDeltas(this.reusableStream);
          }
        } catch (error) {
          streamFailed = true;
          throw error;
        } finally {
          await this.finishHooksSessionForStream(streamFailed ? 'error' : 'complete');
        }
        return;
      }

      const { consumer, executionPromise } = this.startTurnBroadcasterExecution();

      for await (const event of consumer) {
        if (isOutputTextDeltaEvent(event as models.StreamEvents)) {
          yield (event as models.TextDeltaEvent).delta;
        }
      }

      await executionPromise;
    }.call(this);
  }

  /**
   * Stream all output items cumulatively as they arrive.
   * Items are emitted with the same ID but progressively updated content as streaming progresses.
   * Also yields tool results (function_call_output) after tool execution completes.
   *
   * Item types include:
   * - message: Assistant text responses (emitted cumulatively as text streams)
   * - function_call: Tool calls (emitted cumulatively as arguments stream)
   * - reasoning: Model reasoning (emitted cumulatively as thinking streams)
   * - web_search_call: Web search operations
   * - file_search_call: File search operations
   * - image_generation_call: Image generation operations
   * - function_call_output: Results from executed tools
   */
  getItemsStream(): AsyncIterableIterator<StreamableOutputItem<TTools>> {
    // Build the allowed-item-type scope from the tools actually passed to
    // callModel, mirroring the compile-time rules that produce
    // StreamableOutputItem<TTools>. A runtime predicate then drops items
    // whose type isn't reachable in the narrowed union. The predicate's
    // claim (`item is StreamableOutputItem<TTools>`) is sound because:
    //   - `allowed` is constructed from the same tools that produced TTools
    //   - `OutputServerToolItem.type` is `string` (open), so any non-client
    //     item type is structurally assignable to it, covering generic /
    //     unmapped server-tool outputs.
    const scope = this.computeItemStreamScope();

    const isInScope = (item: StreamableOutputItem): item is StreamableOutputItem<TTools> => {
      if (scope.acceptAll) {
        return true;
      }
      if (scope.allowed.has(item.type)) {
        return true;
      }
      if (
        scope.acceptGenericServerItem &&
        item.type !== 'function_call' &&
        item.type !== 'function_call_output'
      ) {
        return true;
      }
      return false;
    };

    return async function* (this: ModelResult<TTools, TShared>) {
      await this.initStreamGuarded();

      // No tools — stream single turn directly (no broadcaster needed)
      if (!this.options.tools?.length) {
        let streamFailed = false;
        try {
          if (this.reusableStream) {
            for await (const item of buildItemsStream(this.reusableStream)) {
              if (isInScope(item)) {
                yield item;
              }
            }
          }
        } catch (error) {
          streamFailed = true;
          throw error;
        } finally {
          await this.finishHooksSessionForStream(streamFailed ? 'error' : 'complete');
        }
        return;
      }

      // Use turnBroadcaster (same pattern as getTextStream/getFullResponsesStream).
      // executeToolsIfNeeded() drives tool execution in the background while we
      // passively consume events from the broadcaster in real-time.
      const { consumer, executionPromise } = this.startTurnBroadcasterExecution();
      const itemsInProgress = new Map<string, ItemInProgress>();

      for await (const event of consumer) {
        // Tool call outputs → yield directly as function_call_output items
        if (isToolCallOutputEvent(event)) {
          if (isInScope(event.output)) {
            yield event.output;
          }
          continue;
        }

        // Stream termination → reset items map for next turn
        if ('type' in event && streamTerminationEvents.has(event.type)) {
          itemsInProgress.clear();
        }

        // API stream events → dispatch through item handlers
        // Cast is necessary: TypeScript cannot narrow a union via Record key lookup,
        // but `event.type in itemsStreamHandlers` guarantees the event is an
        // StreamEvents whose type matches a handler key.
        if ('type' in event && event.type in itemsStreamHandlers) {
          const handler = itemsStreamHandlers[event.type];
          if (handler) {
            const result = handler(event as models.StreamEvents, itemsInProgress);
            if (result && isInScope(result)) {
              yield result;
            }
          }
        }
      }

      await executionPromise;
    }.call(this);
  }

  /**
   * Compute the runtime allow-list of item types that `getItemsStream()`
   * may yield, derived from the tools actually passed to callModel. The
   * three return modes correspond to the compile-time narrowing:
   *
   * - `acceptAll: true` — no tools or fully-unconstrained TTools; the
   *   yielded union is the widest `StreamableOutputItem`.
   * - Specific `allowed` set — client tools contribute
   *   `function_call` / `function_call_output`; mapped server tools
   *   contribute their SDK output item type literal
   *   (`web_search_call`, `file_search_call`, `image_generation_call`).
   * - `acceptGenericServerItem: true` — at least one server tool has a
   *   type the agent SDK does not have a dedicated output mapping for
   *   (e.g. `openrouter:datetime`, `mcp`, new SDK additions). Any
   *   non-client item type is accepted because these items pass through
   *   as `OutputServerToolItem`, whose `type` field is an open `string`.
   */
  private computeItemStreamScope(): {
    acceptAll: boolean;
    allowed: ReadonlySet<string>;
    acceptGenericServerItem: boolean;
  } {
    const tools = this.options.tools ?? [];
    if (tools.length === 0) {
      // No tools passed: runtime only emits message/reasoning, but the
      // widest StreamableOutputItem<readonly Tool[]> includes every item
      // type. Accept all so the default unconstrained case matches its
      // compile-time union.
      return {
        acceptAll: true,
        allowed: new Set(),
        acceptGenericServerItem: false,
      };
    }
    const allowed = new Set<string>([
      'message',
      'reasoning',
    ]);
    let acceptGenericServerItem = false;
    for (const tool of tools) {
      if (isClientTool(tool)) {
        allowed.add('function_call');
        allowed.add('function_call_output');
        continue;
      }
      if (!isServerTool(tool)) {
        continue;
      }
      const requestType = tool.config.type;
      switch (requestType) {
        case 'web_search':
        case 'web_search_2025_08_26':
        case 'web_search_preview':
        case 'web_search_preview_2025_03_11':
          allowed.add('web_search_call');
          break;
        case 'openrouter:web_search':
          // Defensive: OpenRouter's web_search variant may emit either the
          // standard OutputWebSearchCallItem (type='web_search_call') OR be
          // wrapped in OutputServerToolItem with type='openrouter:web_search'.
          // Accept both literals so the runtime filter doesn't silently drop
          // valid items. Do NOT set acceptGenericServerItem — we know the
          // tool type and want the filter narrow.
          allowed.add('web_search_call');
          allowed.add('openrouter:web_search');
          break;
        case 'file_search':
          allowed.add('file_search_call');
          break;
        case 'image_generation':
          allowed.add('image_generation_call');
          break;
        case 'openrouter:datetime':
          // Known server tool whose SDK output item uses the same literal
          // as the request type. Mirrors `KnownServerToolOutputs` in
          // stream-transformers.ts so the runtime filter stays as narrow
          // as the compile-time union (no acceptGenericServerItem widening).
          allowed.add('openrouter:datetime');
          break;
        default:
          // Unknown / generic server tool — at runtime its output items
          // pass through as the request-type literal or as the SDK's
          // OutputServerToolItem wrapper. Accept the literal plus the
          // generic fallback. See `StreamableOutputItem` narrowing in
          // stream-transformers.ts for the matching type-level rules.
          allowed.add(requestType);
          acceptGenericServerItem = true;
          break;
      }
    }
    return {
      acceptAll: false,
      allowed,
      acceptGenericServerItem,
    };
  }

  /**
   * @deprecated Use `getItemsStream()` instead. This method only streams messages,
   * while `getItemsStream()` streams all output item types (messages, function_calls,
   * reasoning, etc.) with cumulative updates.
   *
   * Stream cumulative message snapshots as content is added in responses format.
   * Each iteration yields an updated version of the message with new content.
   * Also yields function_call items and FunctionCallOutputItem after tool execution completes.
   * Returns OutputMessage, OutputFunctionCallItem, or FunctionCallOutputItem
   * compatible with OpenAI Responses API format.
   */
  getNewMessagesStream(): AsyncIterableIterator<
    models.OutputMessage | models.FunctionCallOutputItem | models.OutputFunctionCallItem
  > {
    return async function* (this: ModelResult<TTools, TShared>) {
      // Guarded: tears down the hook session (SessionEnd + drain) if
      // initStream throws after SessionStart. Includes the not-initialized
      // guard, so the manual check below is covered too.
      await this.initStreamGuarded();

      // First yield messages from the stream in responses format
      if (this.reusableStream) {
        yield* buildResponsesMessageStream(this.reusableStream);
      }

      // Execute tools if needed
      await this.executeToolsIfNeeded();

      // Track yielded call IDs to avoid duplicates across rounds and finalResponse
      const yieldedCallIds = new Set<string>();

      // Yield function calls and their outputs for each executed tool
      for (const round of this.allToolExecutionRounds) {
        // First yield the function_call items from the response that triggered tool execution
        for (const item of round.response.output) {
          if (isFunctionCallItem(item)) {
            yieldedCallIds.add(item.callId);
            yield item;
          }
        }
        // Then yield the function_call_output results (client tools only;
        // server-tool output items are surfaced through getItemsStream).
        for (const toolResult of round.toolResults) {
          if (isFunctionCallOutputItem(toolResult)) {
            yield toolResult;
          }
        }
      }

      // Yield manual tool function_call items from finalResponse, skipping duplicates
      if (this.finalResponse) {
        for (const item of this.finalResponse.output) {
          if (
            isFunctionCallItem(item) &&
            this.isManualToolCall(item) &&
            !yieldedCallIds.has(item.callId)
          ) {
            yieldedCallIds.add(item.callId);
            yield item;
          }
        }
      }

      // If tools were executed, yield the final message from finalResponse
      if (this.finalResponse && this.allToolExecutionRounds.length > 0) {
        const hasMessage = this.finalResponse.output.some(
          (item: unknown) => hasTypeProperty(item) && item.type === 'message',
        );
        if (hasMessage) {
          yield extractResponsesMessageFromResponse(this.finalResponse);
        }
      }
    }.call(this);
  }

  /**
   * Stream only reasoning deltas as they arrive from all turns.
   * This filters the full event stream to only yield reasoning content,
   * including reasoning from follow-up responses in multi-turn tool loops.
   */
  getReasoningStream(): AsyncIterableIterator<string> {
    return async function* (this: ModelResult<TTools, TShared>) {
      await this.initStreamGuarded();

      if (!this.options.tools?.length) {
        let streamFailed = false;
        try {
          if (this.reusableStream) {
            yield* extractReasoningDeltas(this.reusableStream);
          }
        } catch (error) {
          streamFailed = true;
          throw error;
        } finally {
          await this.finishHooksSessionForStream(streamFailed ? 'error' : 'complete');
        }
        return;
      }

      const { consumer, executionPromise } = this.startTurnBroadcasterExecution();

      for await (const event of consumer) {
        if (isReasoningDeltaEvent(event as models.StreamEvents)) {
          yield (event as models.ReasoningDeltaEvent).delta;
        }
      }

      await executionPromise;
    }.call(this);
  }

  /**
   * Stream tool call argument deltas and preliminary results from all turns.
   * Preliminary results are streamed in REAL-TIME as generator tools yield.
   * - Tool call argument deltas as { type: "delta", content: string }
   * - Preliminary results as { type: "preliminary_result", toolCallId, result }
   */
  getToolStream(): AsyncIterableIterator<ToolStreamEvent<InferToolEventsUnion<TTools>>> {
    return async function* (this: ModelResult<TTools, TShared>) {
      await this.initStreamGuarded();

      if (!this.options.tools?.length) {
        let streamFailed = false;
        try {
          if (this.reusableStream) {
            for await (const delta of extractToolDeltas(this.reusableStream)) {
              yield {
                type: 'delta' as const,
                content: delta,
              };
            }
          }
        } catch (error) {
          streamFailed = true;
          throw error;
        } finally {
          await this.finishHooksSessionForStream(streamFailed ? 'error' : 'complete');
        }
        return;
      }

      const { consumer, executionPromise } = this.startTurnBroadcasterExecution();

      for await (const event of consumer) {
        if (event.type === 'response.function_call_arguments.delta') {
          yield {
            type: 'delta' as const,
            content: (
              event as {
                delta: string;
              }
            ).delta,
          };
          continue;
        }
        if (event.type === 'tool.preliminary_result') {
          yield {
            type: 'preliminary_result' as const,
            toolCallId: (
              event as {
                toolCallId: string;
              }
            ).toolCallId,
            result: (
              event as {
                result: InferToolEventsUnion<TTools>;
              }
            ).result,
          };
        }
      }

      await executionPromise;
    }.call(this);
  }

  /**
   * Get all tool calls from the completed response (before auto-execution).
   * Note: If tools have execute functions, they will be automatically executed
   * and this will return the tool calls from the initial response.
   * Returns structured tool calls with parsed arguments.
   */
  async getToolCalls(): Promise<ParsedToolCall<TTools[number]>[]> {
    await this.initStreamGuarded({
      requireStream: false,
    });

    // Handle non-streaming response case - use finalResponse directly
    if (this.finalResponse) {
      return extractToolCallsFromResponse(this.finalResponse) as ParsedToolCall<TTools[number]>[];
    }

    if (!this.reusableStream) {
      throw new Error('Stream not initialized');
    }

    const completedResponse = await consumeStreamForCompletion(this.reusableStream);
    await this.emitPendingModelCallOnce(completedResponse);
    return extractToolCallsFromResponse(completedResponse) as ParsedToolCall<TTools[number]>[];
  }

  /**
   * Stream structured tool call objects as they're completed.
   * Each iteration yields a complete tool call with parsed arguments.
   */
  getToolCallsStream(): AsyncIterableIterator<ParsedToolCall<TTools[number]>> {
    return async function* (this: ModelResult<TTools, TShared>) {
      // Guarded: hook-session teardown on init failure (see initStreamGuarded).
      await this.initStreamGuarded();

      if (this.reusableStream) {
        yield* buildToolCallStream(this.reusableStream) as AsyncIterableIterator<
          ParsedToolCall<TTools[number]>
        >;
      }
    }.call(this);
  }

  /**
   * Returns an async iterable that emits a full context snapshot every time
   * any tool calls ctx.update(). Can be consumed concurrently with getText(),
   * getToolStream(), etc.
   *
   * @example
   * ```typescript
   * for await (const snapshot of result.getContextUpdates()) {
   *   console.log('Context changed:', snapshot);
   * }
   * ```
   */
  async *getContextUpdates(): AsyncGenerator<ToolContextMapWithShared<TTools, TShared>> {
    // Ensure stream is initialized (which creates the context store).
    // Guarded: hook-session teardown on init failure.
    await this.initStreamGuarded({
      requireStream: false,
    });

    if (!this.contextStore) {
      return;
    }

    type Snapshot = ToolContextMapWithShared<TTools, TShared>;
    const store = this.contextStore;
    const queue: Snapshot[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const unsubscribe = store.subscribe((snapshot) => {
      queue.push(snapshot as Snapshot);
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    // Signal completion when tool execution finishes
    this.executeToolsIfNeeded().then(
      () => {
        done = true;
        if (resolve) {
          resolve();
          resolve = null;
        }
      },
      () => {
        done = true;
        if (resolve) {
          resolve();
          resolve = null;
        }
      },
    );

    try {
      while (!done) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          // Wait for next update or completion
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
      }
      // Drain any remaining queued snapshots
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    } finally {
      unsubscribe();
    }
  }

  /**
   * Cancel the underlying stream and all consumers
   */
  async cancel(): Promise<void> {
    if (this.reusableStream) {
      await this.reusableStream.cancel();
    }
  }

  // =========================================================================
  // Multi-Turn Conversation State Methods
  // =========================================================================

  /**
   * Check if the conversation requires human/client input to continue.
   * Returns true when the conversation is paused waiting for caller-supplied
   * decisions — approval/rejection (`awaiting_approval`), HITL tool resume
   * (`awaiting_hitl`), or client-executed manual tools (`awaiting_client_tools`).
   * Also returns true whenever `pendingToolCalls` is populated regardless of
   * status.
   */
  async requiresApproval(): Promise<boolean> {
    await this.initStreamGuarded({
      requireStream: false,
    });

    const status = this.currentState?.status;
    if (
      status === 'awaiting_approval' ||
      status === 'awaiting_hitl' ||
      status === 'awaiting_client_tools'
    ) {
      return true;
    }

    // Also check if pendingToolCalls is populated
    return (this.currentState?.pendingToolCalls?.length ?? 0) > 0;
  }

  /**
   * Get the pending tool calls that require approval.
   * Returns empty array if no approvals needed.
   */
  async getPendingToolCalls(): Promise<ParsedToolCall<TTools[number]>[]> {
    await this.initStreamGuarded({
      requireStream: false,
    });

    // Try to trigger tool execution to populate pending calls
    if (!this.isResumingFromApproval) {
      await this.executeToolsIfNeeded();
    }

    return (this.currentState?.pendingToolCalls ?? []) as ParsedToolCall<TTools[number]>[];
  }

  /**
   * Get the current conversation state.
   * Useful for inspection, debugging, or custom persistence.
   * Note: This returns the raw ConversationState for inspection only.
   * To resume a conversation, use the StateAccessor pattern.
   */
  async getState(): Promise<ConversationState<TTools>> {
    await this.initStreamGuarded({
      requireStream: false,
    });

    // Ensure tool execution has been attempted (to populate final state)
    if (!this.isResumingFromApproval) {
      await this.executeToolsIfNeeded();
    }

    if (!this.currentState) {
      throw new Error(
        'State not initialized. Make sure a StateAccessor was provided to callModel.',
      );
    }

    return this.currentState;
  }
}
