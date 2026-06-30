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

  constructor(options: GetResponseOptions<TTools, TShared>) {
    this.options = options;

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
      return consumeStreamForCompletion(this.reusableStream);
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

    await this.saveStateSafely({
      messages: appendToMessages(messages, outputItems as models.BaseInputsUnion[]),
      previousResponseId: response.id,
    });
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

      const result = await executeTool(
        tool,
        tc as ParsedToolCall<Tool>,
        turnContext,
        undefined,
        this.contextStore ?? undefined,
        this.options.sharedContextSchema,
      );

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

    if (needsApproval.length === 0) {
      return false;
    }

    // Validate: approval requires state accessor
    if (!this.stateAccessor) {
      const toolNames = needsApproval.map((tc) => tc.name).join(', ');
      throw new Error(
        `Tool(s) require approval but no state accessor is configured: ${toolNames}. ` +
          'Provide a StateAccessor via the "state" parameter to enable approval workflows.',
      );
    }

    // Execute auto-approve tools
    const unsentResults = await this.executeAutoApproveTools(autoExecute, turnContext);

    // Save state with pending approvals
    const stateUpdates: Partial<Omit<ConversationState<TTools>, 'id' | 'createdAt' | 'updatedAt'>> =
      {
        pendingToolCalls: needsApproval,
        status: 'awaiting_approval',
      };
    if (unsentResults.length > 0) {
      stateUpdates.unsentToolResults = unsentResults;
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
  private async executeToolRound(
    toolCalls: ParsedToolCall<Tool>[],
    turnContext: TurnContext,
  ): Promise<{
    toolResults: models.FunctionCallOutputItem[];
    pausedCalls: ParsedToolCall<Tool>[];
  }> {
    const toolCallPromises = toolCalls.map(async (toolCall) => {
      const tool = this.options.tools?.find(
        (t) => isClientTool(t) && t.function.name === toolCall.name,
      );
      if (!tool || !isAutoResolvableTool(tool)) {
        return null;
      }

      // Check if arguments failed to parse (remained as string instead of object)
      const args: unknown = toolCall.arguments;
      if (typeof args === 'string') {
        const rawArgs = args;
        const errorMessage =
          `Failed to parse tool call arguments for "${toolCall.name}": The model provided invalid JSON. ` +
          `Raw arguments received: "${rawArgs}". ` +
          'Please provide valid JSON arguments for this tool call.';

        this.broadcastToolResult(toolCall.id, isMcpTool(tool) ? 'mcp' : 'client', {
          error: errorMessage,
        } as InferToolOutputsUnion<TTools>);

        return {
          type: 'parse_error' as const,
          toolCall,
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

      const preliminaryResultsForCall: InferToolEventsUnion<TTools>[] = [];

      const hasBroadcaster = this.toolEventBroadcaster || this.turnBroadcaster;
      const onPreliminaryResult = hasBroadcaster
        ? (callId: string, resultValue: unknown) => {
            const typedResult = resultValue as InferToolEventsUnion<TTools>;
            preliminaryResultsForCall.push(typedResult);
            this.broadcastPreliminaryResult(callId, typedResult);
          }
        : undefined;

      const result = await executeTool(
        tool,
        toolCall,
        turnContext,
        onPreliminaryResult,
        this.contextStore ?? undefined,
        this.options.sharedContextSchema,
      );

      if (result === null) {
        // HITL tool paused — surface as manual (no output this round)
        return {
          type: 'paused' as const,
          toolCall,
        };
      }

      return {
        type: 'execution' as const,
        toolCall,
        tool,
        result,
        preliminaryResultsForCall,
      };
    });

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

      if (value.type === 'parse_error') {
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

    // Handle streaming or non-streaming response
    const value = newResult.value;
    if (isEventStream(value)) {
      const followUpStream = new ReusableReadableStream(value);

      if (this.turnBroadcaster) {
        return this.pipeAndConsumeStream(followUpStream, turnNumber);
      }

      return consumeStreamForCompletion(followUpStream);
    }
    if (this.isNonStreamingResponse(value)) {
      return value;
    }
    throw new Error('Unexpected response type from API');
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

    const value = result.value;
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

  /**
   * Validate the final response has required fields.
   *
   * @param response - The response to validate
   * @throws Error if response is missing required fields or has invalid output
   */
  private validateFinalResponse(response: models.OpenResponsesResult): void {
    if (!response?.id || !response?.output) {
      throw new Error('Invalid final response: missing required fields');
    }
    if (!Array.isArray(response.output) || response.output.length === 0) {
      throw new Error('Invalid final response: empty or invalid output');
    }
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
    // Already resolved, extract non-function fields
    // Filter out stopWhen and state-related fields that aren't part of the API request
    const {
      stopWhen: _,
      state: _s,
      requireApproval: _r,
      approveToolCalls: _a,
      rejectToolCalls: _rj,
      context: _c,
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
        } else {
          this.currentState = createInitialState<TTools>();
        }

        // Update status to in_progress
        await this.saveStateSafely({
          status: 'in_progress',
        });
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
        const newInput = baseRequest.input;
        let freshItems: models.BaseInputsUnion[] | undefined;
        if (newInput !== undefined) {
          freshItems = Array.isArray(newInput)
            ? (newInput as models.BaseInputsUnion[])
            : [
                newInput,
              ];
        }

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

    // Process approvals - execute the approved tools
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

      const result = await executeTool(
        tool,
        toolCall as ParsedToolCall<Tool>,
        turnContext,
        undefined,
        this.contextStore ?? undefined,
        this.options.sharedContextSchema,
      );

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

      if (!this.hasExecutableToolCalls(toolCalls)) {
        this.finalResponse = currentResponse;
        await this.markStateComplete();
        return;
      }

      // Main execution loop
      let currentRound = 0;
      let stoppedByStopWhen = false;

      while (true) {
        // Check for external interruption
        if (await this.checkForInterruption(currentResponse)) {
          return;
        }

        // Check stop conditions
        if (await this.shouldStopExecution()) {
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

        if (!this.hasExecutableToolCalls(currentToolCalls)) {
          break;
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

        // Apply nextTurnParams
        await this.applyNextTurnParams(currentToolCalls);

        currentResponse = await this.makeFollowupRequest(currentResponse, toolResults, turnNumber);

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

      // Validate and finalize
      this.validateFinalResponse(currentResponse);
      this.finalResponse = currentResponse;
      await this.markStateComplete();
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
      await this.initStream();

      if (!this.reusableStream && !this.finalResponse) {
        throw new Error('Stream not initialized');
      }

      if (!this.options.tools?.length) {
        if (this.reusableStream) {
          const consumer = this.reusableStream.createConsumer();
          for await (const event of consumer) {
            yield event;
          }
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
      await this.initStream();

      if (!this.reusableStream && !this.finalResponse) {
        throw new Error('Stream not initialized');
      }

      if (!this.options.tools?.length) {
        if (this.reusableStream) {
          yield* extractTextDeltas(this.reusableStream);
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
      await this.initStream();

      if (!this.reusableStream && !this.finalResponse) {
        throw new Error('Stream not initialized');
      }

      // No tools — stream single turn directly (no broadcaster needed)
      if (!this.options.tools?.length) {
        if (this.reusableStream) {
          for await (const item of buildItemsStream(this.reusableStream)) {
            if (isInScope(item)) {
              yield item;
            }
          }
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
      await this.initStream();

      if (!this.reusableStream && !this.finalResponse) {
        throw new Error('Stream not initialized');
      }

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
      await this.initStream();

      if (!this.reusableStream && !this.finalResponse) {
        throw new Error('Stream not initialized');
      }

      if (!this.options.tools?.length) {
        if (this.reusableStream) {
          yield* extractReasoningDeltas(this.reusableStream);
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
      await this.initStream();

      if (!this.reusableStream && !this.finalResponse) {
        throw new Error('Stream not initialized');
      }

      if (!this.options.tools?.length) {
        if (this.reusableStream) {
          for await (const delta of extractToolDeltas(this.reusableStream)) {
            yield {
              type: 'delta' as const,
              content: delta,
            };
          }
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
    await this.initStream();

    // Handle non-streaming response case - use finalResponse directly
    if (this.finalResponse) {
      return extractToolCallsFromResponse(this.finalResponse) as ParsedToolCall<TTools[number]>[];
    }

    if (!this.reusableStream) {
      throw new Error('Stream not initialized');
    }

    const completedResponse = await consumeStreamForCompletion(this.reusableStream);
    return extractToolCallsFromResponse(completedResponse) as ParsedToolCall<TTools[number]>[];
  }

  /**
   * Stream structured tool call objects as they're completed.
   * Each iteration yields a complete tool call with parsed arguments.
   */
  getToolCallsStream(): AsyncIterableIterator<ParsedToolCall<TTools[number]>> {
    return async function* (this: ModelResult<TTools, TShared>) {
      await this.initStream();

      if (!this.reusableStream && !this.finalResponse) {
        throw new Error('Stream not initialized');
      }

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
    // Ensure stream is initialized (which creates the context store)
    await this.initStream();

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
   * Check if the conversation requires human input to continue.
   * Returns true when the conversation is paused waiting for caller-supplied
   * decisions — either approval/rejection (`awaiting_approval`) or HITL tool
   * resume (`awaiting_hitl`). Also returns true whenever `pendingToolCalls`
   * is populated regardless of status.
   */
  async requiresApproval(): Promise<boolean> {
    await this.initStream();

    const status = this.currentState?.status;
    if (status === 'awaiting_approval' || status === 'awaiting_hitl') {
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
    await this.initStream();

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
    await this.initStream();

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
