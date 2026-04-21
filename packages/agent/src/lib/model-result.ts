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
import {
  applyNextTurnParamsToRequest,
  executeNextTurnParamsFunctions,
} from './next-turn-params.js';
import { ReusableReadableStream } from './reusable-stream.js';
import { isStopConditionMet, stepCountIs } from './stop-conditions.js';
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
import { executeTool } from './tool-executor.js';
import type {
  ConversationState,
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
  hasExecuteFunction,
  isClientTool,
  isServerTool,
  isToolCallOutputEvent,
} from './tool-types.js';

/**
 * Default maximum number of tool execution steps if no stopWhen is specified.
 * This prevents infinite loops in tool execution.
 */
const DEFAULT_MAX_STEPS = 5;

/**
 * Typeguard for plain-object records (non-null, non-array).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard for stream event with toReadableStream method
 * Checks constructor name, prototype, and method availability
 */
function isEventStream(value: unknown): value is EventStream<models.StreamEvents> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  // Check constructor name for EventStream
  const constructorName = Object.getPrototypeOf(value)?.constructor?.name;
  if (constructorName === 'EventStream') {
    return true;
  }

  // Fallback: check for toReadableStream method (may be on prototype)
  const maybeStream = value as {
    toReadableStream?: unknown;
  };
  return typeof maybeStream.toReadableStream === 'function';
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
   * Push a tool result event to both the legacy tool event broadcaster
   * and the unified turn broadcaster.
   */
  private broadcastToolResult(
    toolCallId: string,
    result: InferToolOutputsUnion<TTools>,
    preliminaryResults?: InferToolEventsUnion<TTools>[],
  ): void {
    this.toolEventBroadcaster?.push({
      type: 'tool_result' as const,
      toolCallId,
      result,
      ...(preliminaryResults?.length && {
        preliminaryResults,
      }),
    });
    this.turnBroadcaster?.push({
      type: 'tool.result' as const,
      toolCallId,
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
   * Only requires 'output' field and absence of 'toReadableStream' method
   */
  private isNonStreamingResponse(value: unknown): value is models.OpenResponsesResult {
    return (
      value !== null &&
      typeof value === 'object' &&
      'output' in value &&
      !('toReadableStream' in value)
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

    await this.saveStateSafely({
      messages: appendToMessages(
        this.currentState.messages,
        outputItems as models.BaseInputsUnion[],
      ),
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
   * Default: stepCountIs(DEFAULT_MAX_STEPS) if no stopWhen is specified.
   * This evaluates stop conditions against the complete step history.
   */
  private async shouldStopExecution(): Promise<boolean> {
    const stopWhen = this.options.stopWhen ?? stepCountIs(DEFAULT_MAX_STEPS);

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
        toolResults: round.toolResults.filter(isFunctionCallOutput).map((tr) => ({
          toolCallId: tr.callId,
          toolName: round.toolCalls.find((tc) => tc.id === tr.callId)?.name ?? '',
          result: typeof tr.output === 'string' ? JSON.parse(tr.output) : tr.output,
        })),
        serverToolResults: round.toolResults.filter(isServerToolResult),
        response: round.response,
        usage: round.response.usage,
        finishReason: undefined,
      })),
    });
  }

  /**
   * Check if any tool calls have execute functions.
   * Used to determine if automatic tool execution should be attempted.
   *
   * @param toolCalls - The tool calls to check
   * @returns True if at least one tool call has an executable function
   */
  private hasExecutableToolCalls(toolCalls: ParsedToolCall<Tool>[]): boolean {
    return toolCalls.some((toolCall) => {
      const tool = this.options.tools?.find(
        (t) => isClientTool(t) && t.function.name === toolCall.name,
      );
      return tool && hasExecuteFunction(tool);
    });
  }

  private isManualToolCall(item: models.OutputFunctionCallItem): boolean {
    const tool = this.options.tools?.find((t) => isClientTool(t) && t.function.name === item.name);
    return !!tool && !hasExecuteFunction(tool);
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
    let effectiveToolCall = toolCall;

    // Emit PreToolUse hook -- can block or mutate input.
    if (this.hooksManager) {
      const preResult = await this.hooksManager.emit(
        'PreToolUse',
        {
          toolName: toolCall.name,
          toolInput: (toolCall.arguments ?? {}) as Record<string, unknown>,
          sessionId: this.currentState?.id ?? '',
        },
        {
          toolName: toolCall.name,
        },
      );

      if (preResult.blocked) {
        const blockResult = preResult.results.find(
          (r) => r && typeof r === 'object' && 'block' in r && r.block,
        );
        const reason =
          blockResult && typeof blockResult.block === 'string'
            ? blockResult.block
            : 'Blocked by PreToolUse hook';
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

      // Apply mutated input if present.
      const finalInput = preResult.finalPayload.toolInput;
      if (finalInput !== toolCall.arguments) {
        effectiveToolCall = {
          ...toolCall,
          arguments: finalInput,
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

    // Emit PostToolUse or PostToolUseFailure.
    if (this.hooksManager) {
      if (result.error) {
        await this.hooksManager.emit(
          'PostToolUseFailure',
          {
            toolName: effectiveToolCall.name,
            toolInput: (effectiveToolCall.arguments ?? {}) as Record<string, unknown>,
            error: result.error,
            sessionId: this.currentState?.id ?? '',
          },
          {
            toolName: effectiveToolCall.name,
          },
        );
      } else {
        await this.hooksManager.emit(
          'PostToolUse',
          {
            toolName: effectiveToolCall.name,
            toolInput: (effectiveToolCall.arguments ?? {}) as Record<string, unknown>,
            toolOutput: result.result,
            durationMs,
            sessionId: this.currentState?.id ?? '',
          },
          {
            toolName: effectiveToolCall.name,
          },
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

    // Derive risk level from the tool's requireApproval shape: function => 'high'
    // (caller actively decides), blanket true => 'medium', otherwise 'low'.
    const tool = this.options.tools?.find(
      (t) => isClientTool(t) && t.function.name === toolCall.name,
    );
    const requireApproval = tool && isClientTool(tool) ? tool.function.requireApproval : undefined;
    const riskLevel: 'low' | 'medium' | 'high' =
      typeof requireApproval === 'function' ? 'high' : requireApproval === true ? 'medium' : 'low';

    const emit = await this.hooksManager.emit(
      'PermissionRequest',
      {
        toolName: toolCall.name,
        toolInput: (toolCall.arguments ?? {}) as Record<string, unknown>,
        riskLevel,
        sessionId: this.currentState?.id ?? '',
      },
      {
        toolName: toolCall.name,
      },
    );

    // Last-wins: if multiple handlers disagree, the most recently registered
    // handler dictates the outcome. This is documented and intentional —
    // callers that want stricter semantics should register a single final
    // handler (or use `throwOnHandlerError` to surface conflicts in tests).
    const last = emit.results.at(-1);
    if (
      last &&
      typeof last === 'object' &&
      'decision' in last &&
      (last.decision === 'allow' || last.decision === 'deny' || last.decision === 'ask_user')
    ) {
      const out: {
        decision: 'allow' | 'deny' | 'ask_user';
        reason?: string;
      } = {
        decision: last.decision,
      };
      if ('reason' in last && typeof last.reason === 'string') {
        out.reason = last.reason;
      }
      return out;
    }
    return {
      decision: 'ask_user',
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

    const emit = await this.hooksManager.emit('UserPromptSubmit', {
      prompt,
      sessionId: this.currentState?.id ?? '',
    });

    if (emit.blocked) {
      const rejectResult = emit.results.find(
        (r) => r && typeof r === 'object' && 'reject' in r && r.reject,
      );
      const reason =
        rejectResult && typeof rejectResult.reject === 'string'
          ? rejectResult.reject
          : 'Prompt rejected by hook';
      throw new Error(reason);
    }

    const mutated = emit.finalPayload.prompt;
    if (mutated === prompt) {
      return undefined;
    }

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
      if (!tool || !hasExecuteFunction(tool)) {
        return null;
      }

      // Route through runToolWithHooks so PreToolUse/PostToolUse fire even on
      // the auto-approve path.
      const hookOutcome = await this.runToolWithHooks(
        tool,
        tc as ParsedToolCall<Tool>,
        turnContext,
      );

      if (hookOutcome.type === 'hook_blocked') {
        return createRejectedResult(tc.id, String(tc.name), hookOutcome.reason);
      }

      const result = hookOutcome.result;

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

    const { requiresApproval: needsApproval, autoExecute: autoExecuteInitial } =
      await partitionToolCalls(
        toolCalls as ParsedToolCall<TTools[number]>[],
        this.options.tools,
        turnContext,
        this.requireApprovalFn ?? undefined,
      );

    // Seed the auto-execute list with anything that didn't need approval. The
    // PermissionRequest hook may promote more calls into this bucket (allow)
    // or synthesize pre-denied results (deny) below.
    const autoExecute: ParsedToolCall<TTools[number]>[] = [
      ...autoExecuteInitial,
    ];
    const preDeniedResults: UnsentToolResult<TTools>[] = [];
    const stillPending: ParsedToolCall<TTools[number]>[] = [];

    // Run the PermissionRequest hook for each tool that needs approval.
    // This lets hooks short-circuit the approval flow in either direction.
    if (this.hooksManager && needsApproval.length > 0) {
      for (const tc of needsApproval) {
        const { decision, reason } = await this.emitPermissionRequest(tc as ParsedToolCall<Tool>);
        if (decision === 'allow') {
          autoExecute.push(tc);
        } else if (decision === 'deny') {
          preDeniedResults.push(
            createRejectedResult(
              tc.id,
              String(tc.name),
              reason ?? 'Denied by PermissionRequest hook',
            ) as UnsentToolResult<TTools>,
          );
        } else {
          stillPending.push(tc);
        }
      }
    } else {
      stillPending.push(...needsApproval);
    }

    // Validate: approval requires state accessor when any tool needs a gate
    // or is being pre-denied by the hook.
    if (!this.stateAccessor && (stillPending.length > 0 || preDeniedResults.length > 0)) {
      const toolNames = stillPending.map((tc) => tc.name).join(', ');
      throw new Error(
        `Tool(s) require approval but no state accessor is configured: ${toolNames || '(hook-denied tools)'}. ` +
          'Provide a StateAccessor via the "state" parameter to enable approval workflows.',
      );
    }

    // Execute auto-approve tools (includes any promoted by hook "allow").
    const unsentResults = await this.executeAutoApproveTools(autoExecute, turnContext);

    // Combine pre-denied results (from hook "deny") with executed results.
    const combinedResults: UnsentToolResult<TTools>[] = [
      ...unsentResults,
      ...preDeniedResults,
    ];

    if (stillPending.length === 0) {
      // Nothing needs human approval. Persist the results we already have so
      // the caller's normal flow can pick them up on the next turn without
      // re-executing the tools. This path can be reached even when no tool
      // originally required approval (the hook said "allow" on everything)
      // or when the hook denied everything.
      if (this.stateAccessor && combinedResults.length > 0) {
        await this.saveStateSafely({
          unsentToolResults: combinedResults,
        });
      }
      return false;
    }

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
   * Execute all tools in a single round in parallel.
   * Emits tool.result events after tool execution completes.
   *
   * @param toolCalls - The tool calls to execute
   * @param turnContext - The current turn context
   * @returns Array of function call outputs formatted for the API
   */
  private async executeToolRound(
    toolCalls: ParsedToolCall<Tool>[],
    turnContext: TurnContext,
  ): Promise<models.FunctionCallOutputItem[]> {
    const toolCallPromises = toolCalls.map(async (toolCall) => {
      const tool = this.options.tools?.find(
        (t) => isClientTool(t) && t.function.name === toolCall.name,
      );
      if (!tool || !hasExecuteFunction(tool)) {
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

        this.broadcastToolResult(toolCall.id, {
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

      // Run the tool through the full Pre/Post lifecycle hooks.
      const executed = await this.runToolWithHooks(
        tool,
        toolCall,
        turnContext,
        onPreliminaryResult,
      );
      if (executed.type === 'hook_blocked') {
        return executed;
      }

      return {
        type: 'execution' as const,
        toolCall: executed.effectiveToolCall,
        tool,
        result: executed.result,
        preliminaryResultsForCall,
      };
    });

    const settledResults = await Promise.allSettled(toolCallPromises);
    const toolResults: models.FunctionCallOutputItem[] = [];

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
        this.broadcastToolResult(originalToolCall.id, {
          error: errorMessage,
        } as InferToolOutputsUnion<TTools>);

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

      const toolResult = (
        value.result.error
          ? {
              error: value.result.error.message,
            }
          : value.result.result
      ) as InferToolOutputsUnion<TTools>;
      this.broadcastToolResult(
        value.toolCall.id,
        toolResult,
        value.preliminaryResultsForCall.length > 0 ? value.preliminaryResultsForCall : undefined,
      );

      let outputForModel: string | models.FunctionCallOutputItemOutputUnion1[];

      if (value.result.error) {
        outputForModel = JSON.stringify({
          error: value.result.error.message,
        });
      } else if (value.tool.function.toModelOutput) {
        // toModelOutput exists - call it (may throw, which surfaces the error).
        // Arguments have already been validated upstream by the tool's Zod
        // inputSchema (which must be a ZodObject), so the runtime shape is
        // always a record here. The `Tool` union widening loses the specific
        // InferToolInput type, so we re-narrow defensively — a non-record
        // value here signals a real upstream bug we want surfaced, not a
        // case to paper over with `{}`.
        const rawArgs: unknown = value.toolCall.arguments;
        if (!isRecord(rawArgs)) {
          throw new Error(
            `toolCall.arguments for "${value.toolCall.name}" must be an object after Zod validation, got ${rawArgs === null ? 'null' : Array.isArray(rawArgs) ? 'array' : typeof rawArgs}`,
          );
        }
        const modelOutputResult = await value.tool.function.toModelOutput({
          output: value.result.result,
          input: rawArgs,
        });
        outputForModel =
          modelOutputResult.type === 'content'
            ? modelOutputResult.value
            : JSON.stringify(value.result.result);
      } else {
        outputForModel = JSON.stringify(value.result.result);
      }

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

    return toolResults;
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

          // Check if we're resuming from awaiting_approval with decisions
          if (
            loadedState.status === 'awaiting_approval' &&
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

      // Emit SessionStart hook. The `config` payload carries a stable, small
      // summary of session-level options so handlers can make routing/auditing
      // decisions without the SDK having to promise more than it can deliver.
      // If future session config becomes available, extend this object rather
      // than introducing a new payload field.
      if (this.hooksManager) {
        const sessionId = this.currentState?.id ?? '';
        this.hooksManager.setSessionId(sessionId);
        await this.hooksManager.emit('SessionStart', {
          sessionId,
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
        });
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

      // If we have state with existing messages, use those as input
      if (
        this.currentState?.messages &&
        Array.isArray(this.currentState.messages) &&
        this.currentState.messages.length > 0
      ) {
        // Append new input to existing messages
        const newInput = baseRequest.input;
        if (newInput) {
          const inputArray = Array.isArray(newInput)
            ? newInput
            : [
                newInput,
              ];
          baseRequest = {
            ...baseRequest,
            input: appendToMessages(
              this.currentState.messages,
              inputArray as models.BaseInputsUnion[],
            ),
          };
        } else {
          baseRequest = {
            ...baseRequest,
            input: this.currentState.messages,
          };
        }
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
      if (!tool || !hasExecuteFunction(tool)) {
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

      if (hookOutcome.type === 'hook_blocked') {
        unsentResults.push(createRejectedResult(callId, String(toolCall.name), hookOutcome.reason));
        continue;
      }

      const result = hookOutcome.result;
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

    // Remove processed calls from pending
    const processedIds = new Set([
      ...this.approvedToolCalls,
      ...this.rejectedToolCalls,
    ]);
    const remainingPending = pendingCalls.filter((tc) => !processedIds.has(tc.id));

    // Update state - conditionally include optional properties only if they have values
    const stateUpdates: Partial<Omit<ConversationState<TTools>, 'id' | 'createdAt' | 'updatedAt'>> =
      {
        status: remainingPending.length > 0 ? 'awaiting_approval' : 'in_progress',
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

    // If we still have pending approvals, stop here
    if (remainingPending.length > 0) {
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

    // Build new input with tool results
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
    // numberOfTurns represents the current turn number (1-indexed after initial)
    const turnContext: TurnContext = {
      numberOfTurns: this.allToolExecutionRounds.length + 1,
    };

    const baseRequest = await this.resolveRequestForContext(turnContext);

    // Create request with the accumulated messages
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
      // SessionEnd/drain must fire on every exit path (success, early return,
      // approval pause, interruption, and exceptions), so wrap the body in
      // try/catch/finally and track the session-end reason as we go.
      // Approval pauses keep reason='complete' because the run hasn't failed —
      // it's simply paused awaiting user decisions.
      let sessionEndReason: 'user' | 'error' | 'max_turns' | 'complete' = 'complete';
      try {
        await this.initStream();

        // If resuming from approval and still pending, don't continue
        if (this.isResumingFromApproval && this.currentState?.status === 'awaiting_approval') {
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
        // Cap consecutive forceResume overrides so a misbehaving Stop hook
        // cannot spin the loop forever. We pick 3 as a conservative upper bound
        // -- it's enough to let a hook gather a couple of follow-up actions but
        // small enough that a buggy handler fails fast with a visible warning.
        const MAX_FORCE_RESUME_OVERRIDES = 3;
        let forceResumeCount = 0;

        while (true) {
          // Check for external interruption
          if (await this.checkForInterruption(currentResponse)) {
            sessionEndReason = 'user';
            return;
          }

          // Check stop conditions
          if (await this.shouldStopExecution()) {
            // Emit Stop hook -- can force resume or inject prompt.
            // shouldStopExecution() is driven by stopWhen conditions (default
            // stepCountIs), so 'max_turns' is the semantically accurate reason.
            if (this.hooksManager) {
              const stopResult = await this.hooksManager.emit('Stop', {
                reason: 'max_turns' as const,
                sessionId: this.currentState?.id ?? '',
              });

              // Honor forceResume if ANY handler returns it, not just the last.
              const shouldForceResume = stopResult.results.some(
                (r) => r && typeof r === 'object' && 'forceResume' in r && r.forceResume === true,
              );

              // Collect every appendPrompt the handlers supplied (concatenated
              // with newlines). appendPrompt is honored independently of
              // forceResume so a handler can nudge the next turn without
              // forcing a resume.
              const appendParts: string[] = [];
              for (const r of stopResult.results) {
                if (
                  r &&
                  typeof r === 'object' &&
                  'appendPrompt' in r &&
                  typeof r.appendPrompt === 'string' &&
                  r.appendPrompt.length > 0
                ) {
                  appendParts.push(r.appendPrompt);
                }
              }
              const appendPrompt = appendParts.join('\n');

              if (appendPrompt) {
                await this.injectAppendPromptMessage(appendPrompt);
              }

              if (shouldForceResume) {
                if (forceResumeCount >= MAX_FORCE_RESUME_OVERRIDES) {
                  // Don't let the hook loop the engine forever. Log and stop.
                  console.warn(
                    `[Stop hook] forceResume honored ${MAX_FORCE_RESUME_OVERRIDES} times without new progress; stopping to prevent an infinite loop.`,
                  );
                  sessionEndReason = 'max_turns';
                  break;
                }
                forceResumeCount++;
                // Continue the loop. If appendPrompt was supplied we already
                // injected it, which advances state so the stop condition may
                // no longer fire on the next iteration.
                continue;
              }
            }
            // Stop condition fired and the hook (if any) did not force resume
            // -- this is a max_turns-style exit, not a natural completion.
            sessionEndReason = 'max_turns';
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
          const toolResults = await this.executeToolRound(currentToolCalls, turnContext);

          // A tool round with observable progress resets the consecutive
          // forceResume counter so a legitimate override earlier in the run
          // does not count against a later, independent one.
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

        // Validate and finalize
        this.validateFinalResponse(currentResponse);
        this.finalResponse = currentResponse;
        await this.markStateComplete();
      } catch (error) {
        sessionEndReason = 'error';
        throw error;
      } finally {
        // Only emit SessionEnd if SessionStart actually succeeded. Otherwise
        // initStream threw before emit, and a dangling SessionEnd would break
        // handlers that pair Start/End (audit logs, acquired resources).
        if (this.hooksManager && this.sessionStartEmitted) {
          await this.hooksManager.emit('SessionEnd', {
            sessionId: this.currentState?.id ?? '',
            reason: sessionEndReason,
          });
          await this.hooksManager.drain();
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
    return async function* (this: ModelResult<TTools>) {
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
    return async function* (this: ModelResult<TTools>) {
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

    return async function* (this: ModelResult<TTools>) {
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
    return async function* (this: ModelResult<TTools>) {
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
    return async function* (this: ModelResult<TTools>) {
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
    return async function* (this: ModelResult<TTools>) {
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
    return async function* (this: ModelResult<TTools>) {
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
   * Check if the conversation requires human approval to continue.
   * Returns true if there are pending tool calls awaiting approval.
   */
  async requiresApproval(): Promise<boolean> {
    await this.initStream();

    // If we have pending tool calls in state, approval is required
    if (this.currentState?.status === 'awaiting_approval') {
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
