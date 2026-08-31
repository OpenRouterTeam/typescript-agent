import type { OpenRouterCore } from '@openrouter/sdk/core';
import { betaResponsesSend } from '@openrouter/sdk/funcs/betaResponsesSend';
import type { EventStream } from '@openrouter/sdk/lib/event-streams';
import type { RequestOptions } from '@openrouter/sdk/lib/sdks';
import type * as models from '@openrouter/sdk/models';
import * as z4 from 'zod/v4';
import type { $ZodObject, $ZodShape } from 'zod/v4/core';
import type { CallModelInput, ResolvedCallModelInput } from './async-params.js';
import {
  hasAsyncFunctions,
  resolveAsyncFunctions,
  stripToolSetSnapshotMetadata,
} from './async-params.js';
import type { SettledToolTask, TaskToolInput, ToolSemaphore, ToolTaskMode } from './async-tools.js';
import {
  AsyncToolRegistry,
  acquireAll,
  buildTaskToolStub,
  defaultCheckResult,
  hasTaskToolNameCollision,
  persistedTaskCheckResult,
  resolveCheckConfig,
  Semaphore,
  TASK_RESULT_BOUNDARY,
  TASK_TOOL_NAME,
  TaskToolInputSchema,
  ToolTask,
} from './async-tools.js';
import {
  appendToMessages,
  createInitialState,
  createRejectedResult,
  createUnsentResult,
  extractTextFromResponse as extractTextFromResponseState,
  normalizeInputToArray,
  partitionToolCalls,
  toolRequiresApproval,
  unsentResultsToAPIFormat,
  updateState,
} from './conversation-state.js';
import type {
  DoomLoopAction,
  DoomLoopCallRecord,
  DoomLoopOption,
  DoomLoopSerializedState,
  DoomLoopVerdict,
  LoopKeyResolution,
  ResolvedEscalationConfig,
} from './doom-loop.js';
import {
  canonicalizeKeyMaterial,
  DoomLoopMonitor,
  resolveDoomLoopOption,
  resolveLoopKeyMaterial,
} from './doom-loop.js';
import type { HooksManager } from './hooks-manager.js';
import type { ModelCallUsage, PostModelCallPayload, SessionUsageTotals } from './hooks-types.js';
import {
  applyNextTurnParamsToRequest,
  executeNextTurnParamsFunctions,
} from './next-turn-params.js';
import type { StreamReplay } from './reusable-stream.js';
import { ReusableReadableStream } from './reusable-stream.js';
import { isStopConditionMet } from './stop-conditions.js';
import type { ItemInProgress, StreamableOutputItem, UiStreamEvent } from './stream-transformers.js';
import {
  buildItemsStream,
  buildResponsesMessageStream,
  buildToolCallStream,
  consumeStreamForCompletion,
  extractCompletionFromBuffer,
  extractReasoningDeltas,
  extractResponsesMessageFromResponse,
  extractTextDeltas,
  extractTextFromResponse,
  extractToolCallsFromResponse,
  extractToolDeltas,
  itemsStreamHandlers,
  responseHasToolCalls,
  streamTerminationEvents,
  translateUiEvent,
  tryExtractCompletionFromBuffer,
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
import type { ContextInput, ToolExecutionExtras } from './tool-context.js';
import { resolveContext, ToolContextStore } from './tool-context.js';
import { ToolEventBroadcaster } from './tool-event-broadcaster.js';
import type { AsyncToolInvocation } from './tool-executor.js';
import {
  applyOnResponseReceivedHooks,
  executeTool,
  isAsyncToolInvocation,
  validateToolInput,
} from './tool-executor.js';
import type {
  ConversationState,
  ConversationStatus,
  CorrelatedResponseStreamEvent,
  CorrelatedToolStreamEvent,
  InferToolEventsUnion,
  InferToolOutputsUnion,
  ParsedToolCall,
  PendingAsyncTool,
  ServerToolResultItem,
  StateAccessor,
  StopWhen,
  Tool,
  ToolAsyncSettledEvent,
  ToolAsyncStartedEvent,
  ToolCallOutputEvent,
  ToolContextMapWithShared,
  ToolResultItem,
  ToolUiFragmentEvent,
  TurnContext,
  TurnEndEvent,
  TurnStartEvent,
  UnsentToolResult,
} from './tool-types.js';
import {
  isAgentTool,
  isAutoResolvableTool,
  isClientTool,
  isLongRunningTool,
  isMcpTool,
  isServerTool,
  isToolCallOutputEvent,
  isUnifiedTool,
} from './tool-types.js';

/**
 * Default directive appended as a final user message on the forced final
 * turn (`allowFinalResponse` defaulting to on, or explicitly `true`).
 * Forbidding tools via `toolChoice: 'none'` alone is not enough: models
 * that emit tool-call syntax as text (e.g. GLM) will attempt another call
 * and leak it into `content` as unparsed `<tool_call>…` text unless they
 * are told this is the final turn.
 * Pass a non-empty string to `allowFinalResponse` to override the wording,
 * or `''` to append no message at all (legacy behavior).
 */
export const DEFAULT_FINAL_RESPONSE_DIRECTIVE =
  'You have reached the tool-use limit, and tools are no longer available. Do not attempt to call any more tools. Using the information you already have, write your final answer now.';

/**
 * Typeguard for plain-object records (non-null, non-array).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Relax a tool choice that *forces* a tool call, for follow-up turns after a
 * tool round has executed (DEV-785).
 *
 * - `'required'` → `'auto'`
 * - a specific-tool object (`{ type: 'function', name }`, `{ type: 'shell' }`,
 *   …) → `'auto'`
 * - `allowed_tools` with `mode: 'required'` → same set with `mode: 'auto'`
 *   (the constraint on *which* tools may be used still applies; only the
 *   force-a-call part is spent)
 * - `'auto'`, `'none'`, `allowed_tools` with `mode: 'auto'`, and `undefined`
 *   pass through unchanged.
 */
function relaxForcedToolChoice(
  toolChoice: models.ResponsesRequest['toolChoice'],
): models.ResponsesRequest['toolChoice'] {
  if (toolChoice === undefined || typeof toolChoice === 'string') {
    return toolChoice === 'required' ? 'auto' : toolChoice;
  }
  if (toolChoice.type === 'allowed_tools') {
    return toolChoice.mode === 'required'
      ? {
          ...toolChoice,
          mode: 'auto',
        }
      : toolChoice;
  }
  return 'auto';
}

/** Whether a caller-configured tool choice requires this turn to call a tool. */
function isForcedToolChoice(toolChoice: models.ResponsesRequest['toolChoice']): boolean {
  if (toolChoice === undefined || typeof toolChoice === 'string') {
    return toolChoice === 'required';
  }
  return toolChoice.type !== 'allowed_tools' || toolChoice.mode === 'required';
}

/** Stable identity for a concrete forced choice; null means tools are not forced. */
function forcedToolChoiceKey(toolChoice: models.ResponsesRequest['toolChoice']): string | null {
  return isForcedToolChoice(toolChoice) ? canonicalizeKeyMaterial(toolChoice) : null;
}

type ToolChoiceStateCommit =
  | {
      type: 'clear';
    }
  | {
      type: 'consume';
      key: string;
    };

/**
 * Mutable binding between a tool call's run context and its ToolTask (which
 * is created only once the call escapes the round). See createRunBinding.
 */
interface RunBinding {
  log: (entry: unknown) => void;
  onMessage: (handler: (message: unknown) => void) => void;
  setTranscriptSource: (source: NonNullable<ToolTask['transcriptSource']>) => void;
  bind: (task: ToolTask) => void;
  task: () => ToolTask | null;
}

/**
 * Extract the call identity echoed on a server-tool output item, for
 * doom-loop fingerprinting. Server tools never pass through the client
 * execution funnel; their output items echo what was asked (a web-search
 * item carries its `action`/`query`, an MCP server-tool item its
 * `name`/`arguments`, etc.). We take every primitive/JSON field except
 * volatile per-invocation ones (ids, status, timing) and the result payload
 * itself, so identical repeated requests fingerprint identically. Returns
 * null when nothing identifying remains (item types with no echoed
 * request identity are skipped rather than collided onto `{}`).
 */
function extractServerToolIdentity(item: ServerToolResultItem): Record<string, unknown> | null {
  const record = item as unknown as Record<string, unknown>;
  // Object.create(null), not `{}`: keys come from a JSON-parsed API response, so
  // a `__proto__` key would hit the prototype setter instead of creating an own
  // property and drop out of the fingerprint. Same reasoning as the
  // Map-backed streak store.
  const identity: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (
      key === 'id' ||
      key === 'type' ||
      key === 'status' ||
      key === 'output' ||
      key === 'result' ||
      key === 'results' ||
      key === 'error'
    ) {
      continue;
    }
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      continue;
    }
    identity[key] = value;
  }
  return Object.keys(identity).length > 0 ? identity : null;
}

// Cap consecutive Stop-hook forceResume overrides so a misbehaving handler
// cannot spin the loop forever. 3 is a conservative upper bound -- enough to
// let a hook gather a couple of follow-up actions but small enough that a
// buggy handler fails fast with a visible warning.
const MAX_FORCE_RESUME_OVERRIDES = 3;

/** Maximum time a UI consumer waits for asynchronous fragment rendering. */
const DEFAULT_UI_DRAIN_TIMEOUT_MS = 30_000;

type IteratorOutcome<T> =
  | {
      source: 0 | 1;
      result: IteratorResult<T>;
    }
  | {
      source: 0 | 1;
      error: unknown;
    };

async function* mergeAsyncIterators<A, B>(
  iterators: readonly [
    AsyncIterator<A>,
    AsyncIterator<B>,
  ],
): AsyncGenerator<A | B> {
  const active = [
    true,
    true,
  ];
  const pending: Array<Promise<IteratorOutcome<A | B>> | null> = [
    null,
    null,
  ];
  let preferred: 0 | 1 = 0;
  const next = async (source: 0 | 1): Promise<IteratorOutcome<A | B>> => {
    try {
      return {
        source,
        result: await iterators[source].next(),
      };
    } catch (error) {
      return {
        source,
        error,
      };
    }
  };

  try {
    while (active[0] || active[1]) {
      for (const source of [
        0,
        1,
      ] as const) {
        if (active[source] && !pending[source]) {
          pending[source] = next(source);
        }
      }
      const other: 0 | 1 = preferred === 0 ? 1 : 0;
      const outcome: IteratorOutcome<A | B> = await Promise.race(
        [
          pending[preferred],
          pending[other],
        ].filter((promise): promise is Promise<IteratorOutcome<A | B>> => promise !== null),
      );
      pending[outcome.source] = null;
      if ('error' in outcome) {
        throw outcome.error;
      }
      if (outcome.result.done) {
        active[outcome.source] = false;
        preferred = outcome.source === 0 ? 1 : 0;
        continue;
      }
      preferred = outcome.source === 0 ? 1 : 0;
      yield outcome.result.value;
    }
  } finally {
    await Promise.allSettled(iterators.map((iterator) => iterator.return?.()));
    await Promise.all(
      pending.filter((promise): promise is Promise<IteratorOutcome<A | B>> => !!promise),
    );
  }
}

/**
 * Sentinel marking a tool-call id that appeared MORE THAN ONCE in one batch.
 * Ids are model-emitted and nothing upstream enforces uniqueness; a colliding
 * id must poison the loop-key cache entry rather than let the last write win,
 * or one call's doom-loop identity aliases onto another's and its repetition
 * becomes invisible to the per-call detector. Colliding calls fall through to
 * per-call resolution at the checkpoint.
 */
const DUPLICATE_CALL_ID = Symbol('duplicate-call-id');

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

function isTerminalResponseStreamEvent(event: models.StreamEvents): boolean {
  return (
    isResponseCompletedEvent(event) ||
    isResponseFailedEvent(event) ||
    isResponseIncompleteEvent(event)
  );
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
   * Receives normalized arguments when schema parsing succeeds and raw arguments otherwise
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
  /** Replay history retained for delayed and sequential stream consumers. */
  streamReplay?: StreamReplay;
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
  /**
   * Doom-loop detection: catch runs that repeat the same tool call with
   * identical arguments (including repeated empty or unparseable calls) or
   * emit the same text over and over, and respond with a graduated ladder
   * (observe → steer → block → stop). `true` enables recommended defaults;
   * an object tunes thresholds. Off by default.
   */
  doomLoop?: DoomLoopOption;
  /**
   * Cancel the whole run: stops the loop at the next boundary and aborts
   * the in-flight API request/stream. See `CallModelInput.signal`.
   */
  signal?: AbortSignal;
  /**
   * Default per-tool execution deadline in milliseconds. A tool-level
   * `timeoutMs` overrides it. See `BaseToolFunction.timeoutMs` for the
   * semantics (bounds the round's wait, not the tool body).
   */
  toolTimeoutMs?: number;
  /**
   * Concurrency limits for tool execution. A bare number is shorthand for
   * `{ round: n }`. `round` bounds simultaneous executions within a tool
   * round (unbounded by default — matching existing behavior); `background`
   * bounds detached background-tool work (default 16).
   */
  toolConcurrency?:
    | number
    | {
        round?: number;
        background?: number;
      };
  /**
   * Behavior for async tools (`tool.background` / `tool.deferred`).
   */
  asyncTools?: {
    /**
     * What to do when the run would end with background tasks in flight:
     * - `'drain'` (default): wait (bounded by `drainTimeoutMs`) and give the
     *   model up to `maxDrainTurns` extra turns so the final answer
     *   incorporates late results;
     * - `'detach'`: return immediately; tasks keep running and their results
     *   are dropped (persisted as `orphaned` when a StateAccessor exists);
     * - `'cancel'`: abort in-flight tasks and finish.
     */
    onRunEnd?: 'drain' | 'detach' | 'cancel';
    /** Bound on each end-of-run drain wait. Default 30_000. */
    drainTimeoutMs?: number;
    /** Max extra model turns granted to deliver drained results. Default 2. */
    maxDrainTurns?: number;
    /**
     * Model-side check-ins: whether calling a long-running tool with a
     * `taskId` answers status/logs/transcript instead of starting new work.
     * Default true. When false, placeholders revert to "do not call this
     * tool again" and the check schema is not advertised.
     */
    checkins?: boolean;
    /** Max characters for the `transcript` check view. Default 20_000. */
    maxTranscriptChars?: number;
  };
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
        toolName: string;
        result: InferToolEventsUnion<TTools>;
      }
    | {
        type: 'tool_result';
        toolCallId: string;
        toolName: string;
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
  // A forced caller-configured tool choice is one-shot until its resolved
  // semantic value changes. The consumed key survives state-backed pauses;
  // the configured key/value are refreshed whenever async parameters resolve.
  private activeConsumedForcedToolChoiceKey: string | null = null;
  private configuredForcedToolChoiceKey: string | null = null;
  private configuredToolChoice: models.ResponsesRequest['toolChoice'];
  private preparedEffectiveToolChoice: models.ResponsesRequest['toolChoice'];
  private preparedToolChoiceCommit: ToolChoiceStateCommit | null = null;
  private dispatchedToolChoiceCommit: ToolChoiceStateCommit | null = null;
  private dispatchedCallerToolChoice = false;
  // Fresh user items to persist atomically with the assistant response
  private pendingFreshItems: models.BaseInputsUnion[] | undefined;
  private resumingFromClientTools = false;
  private resumingFromAsyncTools = false;

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
  private turnBroadcaster: ToolEventBroadcaster<CorrelatedResponseStreamEvent<TTools>> | null =
    null;
  private uiBroadcaster: ToolEventBroadcaster<ToolUiFragmentEvent> | null = null;
  private pendingUiFragments = new Set<Promise<void>>();
  private queuedUiToolResults: Array<{
    callId: string;
    name: string;
    input: Record<string, unknown>;
    output: unknown;
  }> = [];
  private uiBroadcasterCompletionPromise: Promise<void> | null = null;
  private turnBroadcasterCompletionPromise: Promise<void> | null = null;
  private initialStreamPipeStarted = false;
  private initialPipePromise: Promise<void> | null = null;
  private initialResponse: models.OpenResponsesResult | null = null;
  private initialResponseError: Error | null = null;
  private readonly streamReplay: StreamReplay;

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
  // PreToolUse outcomes parked between the approval gates and execution.
  private readonly preparedToolCalls = new Map<
    string,
    | {
        type: 'ready';
        toolCall: ParsedToolCall<Tool>;
        mutated: boolean;
      }
    | {
        type: 'blocked';
        reason: string;
        output: models.FunctionCallOutputItem;
      }
  >();
  // Approval is idempotent per response object, tool-call occurrence, and phase.
  // Occurrence tokens avoid content canonicalization and distinguish duplicates.
  private readonly completedApprovalGates = new Set<string>();
  private readonly approvalResponseOccurrences = new WeakMap<object, number>();
  private readonly approvalCallOccurrences = new WeakMap<object, string[]>();
  private nextApprovalResponseOccurrence = 0;
  private nextApprovalCallOccurrence = 0;
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
  // Doom-loop detection (null when the `doomLoop` option is off). The
  // monitor is a pure, serializable state machine; this class owns the
  // engine-side consequences (hook emission, block synthesis, steer
  // injection, stopping the loop).
  private readonly doomLoopMonitor: DoomLoopMonitor | null;
  // Set when a verdict resolves to 'stop'; checked at the loop boundaries.
  // Persisted inside ConversationState.doomLoop (as `stopVerdict`) so a
  // condemned run stays condemned across decision-only resumes; cleared by
  // a fresh conversational turn (see the initStream restore site).
  private doomLoopStop: DoomLoopVerdict | null = null;
  // Steer messages queued by 'steer' verdicts, injected before the next
  // model request (same mechanism as the Stop hook's appendPrompt).
  // Persisted as `pendingSteer` so guidance queued right before a pause is
  // delivered on resume instead of silently dropped.
  private pendingDoomLoopSteer: string[] = [];
  // Monotonic round counter for doom-loop streaks. Bumped at every
  // execution-batch boundary (tool round, approval auto-approve batch,
  // approved-on-resume batch); identical calls within one batch count as
  // ONE piece of loop evidence (a streak measures the model re-issuing a
  // call after seeing its result, which requires a round trip).
  private doomLoopRound = 0;
  // Final decision for each (tool, fingerprint) in the current round.
  // Duplicates reuse the decision instead of re-incrementing the streak or
  // re-emitting the DoomLoopDetected hook; `message` carries the verdict's
  // explanation for block outputs.
  private readonly doomLoopRoundDecisions = new Map<
    string,
    {
      action: DoomLoopAction | 'proceed';
      message?: string;
    }
  >();
  // Loop-key resolutions computed while declaring the current round, keyed by
  // tool-call id. A `loopKey` function is user code that may count, log, or
  // return something different each time, so it must run at most once per
  // call: the per-call checkpoint reuses what the declaration resolved instead
  // of resolving again. Cleared with the round. An id seen twice in one batch
  // maps to DUPLICATE_CALL_ID — see the write site.
  private readonly doomLoopRoundKeyMaterial = new Map<
    string,
    LoopKeyResolution | typeof DUPLICATE_CALL_ID
  >();
  // Serialization chain for doom evaluations: parallel tool executions
  // append their evaluation here in call order (the .map() over a round's
  // calls runs synchronously to the first await), so streak recording
  // stays a pure function of the transcript even though hashing is async.
  private doomLoopChain: Promise<unknown> = Promise.resolve();
  // Armed by an 'escalate' verdict; consumed by the next follow-up request
  // as ONE-TURN overrides (model swap and/or forced openrouter:advisor).
  // Deliberately NOT persisted: an escalation is a reaction to the loop's
  // live state; a resumed run re-detects and re-escalates if still stuck
  // (the CONSUMED budget does persist, via the monitor's escalationsUsed).
  private pendingDoomLoopEscalation: DoomLoopVerdict | null = null;
  // Resolved escalation mechanism (null when unconfigured); mirrors the
  // monitor's config so the engine can build the overrides.
  private readonly doomLoopEscalation: ResolvedEscalationConfig | null;

  // Async tool support (tool.background / tool.deferred). The registry
  // tracks task identity and settled outcomes; created lazily on the first
  // async tool call so runs without async tools carry zero overhead.
  private asyncToolRegistry: AsyncToolRegistry | null = null;
  // Concurrency gates: the round gate bounds simultaneous executions within
  // a tool round; per-tool gates bound one tool across the run; the
  // background pool bounds detached background work.
  private roundGate: ToolSemaphore | null = null;
  private backgroundPool: ToolSemaphore | null = null;
  private readonly perToolGates = new Map<string, ToolSemaphore>();
  // Per-call abort controllers for in-flight tool executions, keyed by call
  // id. Aborted on run abort / cancel() so cooperative tool bodies stop.
  private readonly inflightToolControllers = new Map<string, AbortController>();

  constructor(options: GetResponseOptions<TTools, TShared>) {
    this.options = options;
    this.streamReplay = options.streamReplay ?? 'full';
    this.hooksManager = options.hooks;
    const doomLoopConfig = resolveDoomLoopOption(options.doomLoop);
    this.doomLoopMonitor = doomLoopConfig ? new DoomLoopMonitor(doomLoopConfig) : null;
    this.doomLoopEscalation = doomLoopConfig?.escalation ?? null;

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

    // Concurrency gates. Round default stays unbounded (existing behavior);
    // the background pool always has a cap (default 16 — detached work has
    // no round to bound it).
    const concurrency = options.toolConcurrency;
    const roundLimit = typeof concurrency === 'number' ? concurrency : concurrency?.round;
    if (roundLimit !== undefined) {
      this.roundGate = new Semaphore(roundLimit);
    }
    const backgroundLimit = typeof concurrency === 'object' ? (concurrency.background ?? 16) : 16;
    this.backgroundPool = new Semaphore(backgroundLimit);
  }

  /** Lazily create the async tool registry. */
  private ensureAsyncToolRegistry(): AsyncToolRegistry {
    if (!this.asyncToolRegistry) {
      this.asyncToolRegistry = new AsyncToolRegistry();
    }
    return this.asyncToolRegistry;
  }

  /** Per-tool concurrency gate, created on first use. */
  private perToolGate(toolName: string): ToolSemaphore | undefined {
    const tool = this.options.tools?.find((t) => isClientTool(t) && t.function.name === toolName);
    if (!tool || isServerTool(tool)) {
      return undefined;
    }
    const limit = tool.function.maxConcurrency;
    if (limit === undefined) {
      return undefined;
    }
    let gate = this.perToolGates.get(toolName);
    if (!gate) {
      gate = new Semaphore(limit);
      this.perToolGates.set(toolName, gate);
    }
    return gate;
  }

  /**
   * Compose the per-call abort signal for one tool execution: the run
   * signal plus a per-call controller the engine can abort independently
   * (timeout race, cancelTask, cancel()). The tool deadline deliberately
   * does NOT ride the signal here — the race in `executeSingleToolCall`
   * owns exactly one timer (which aborts the controller), so the round's
   * timeout resolution and the body's abort observation cannot disagree.
   */
  private composeToolSignal(
    toolName: string,
    callId: string,
  ): {
    controller: AbortController;
    signal: AbortSignal;
    timeoutMs: number | undefined;
  } {
    const tool = this.options.tools?.find((t) => isClientTool(t) && t.function.name === toolName);
    const timeoutMs =
      tool && !isServerTool(tool)
        ? (tool.function.timeoutMs ?? this.options.toolTimeoutMs)
        : this.options.toolTimeoutMs;

    const controller = new AbortController();
    this.inflightToolControllers.set(callId, controller);
    const signal = this.options.signal
      ? AbortSignal.any([
          controller.signal,
          this.options.signal,
        ])
      : controller.signal;
    return {
      controller,
      signal,
      timeoutMs,
    };
  }

  /** Abort every in-flight tool execution and background task. */
  private abortAllToolWork(reason?: string): void {
    const error = new Error(reason ?? 'Run aborted');
    for (const controller of this.inflightToolControllers.values()) {
      controller.abort(error);
    }
    this.inflightToolControllers.clear();
    this.asyncToolRegistry?.abortAll(reason);
  }

  /**
   * Get or create the unified turn broadcaster (lazy initialization).
   * Broadcasts all API stream events, tool events, and turn delimiters across turns.
   */
  private ensureTurnBroadcaster(): ToolEventBroadcaster<CorrelatedResponseStreamEvent<TTools>> {
    if (!this.turnBroadcaster) {
      this.turnBroadcaster = new ToolEventBroadcaster(this.streamReplay);
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
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.initialResponseError = normalizedError;
      broadcaster.complete(normalizedError);
    });
  }

  private captureInitialStreamEvent(event: models.StreamEvents): void {
    if (isResponseCompletedEvent(event) || isResponseIncompleteEvent(event)) {
      this.initialResponse = event.response;
      return;
    }

    if (isResponseFailedEvent(event)) {
      this.initialResponseError = new Error(
        `Response failed: ${JSON.stringify(event.response.error)}`,
      );
    }
  }

  private setReusableStream(stream: ReadableStream<models.StreamEvents>): void {
    this.initialResponse = null;
    this.initialResponseError = null;
    this.reusableStream = new ReusableReadableStream(stream, {
      streamReplay: this.streamReplay,
      onValue: (event) => this.captureInitialStreamEvent(event),
      isTerminalValue: isTerminalResponseStreamEvent,
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
    toolName: string,
    source: 'client' | 'mcp',
    result: InferToolOutputsUnion<TTools>,
  ): void {
    this.toolEventBroadcaster?.push({
      type: 'tool_result' as const,
      toolCallId,
      toolName,
      source,
      result,
    });
    this.turnBroadcaster?.push({
      type: 'tool.result' as const,
      toolCallId,
      toolName,
      source,
      result,
      timestamp: Date.now(),
    } as CorrelatedResponseStreamEvent<TTools>);
  }

  /**
   * Push a preliminary result event to both the legacy tool event broadcaster
   * and the unified turn broadcaster.
   */
  private broadcastPreliminaryResult(
    toolCallId: string,
    toolName: string,
    result: InferToolEventsUnion<TTools>,
  ): void {
    this.toolEventBroadcaster?.push({
      type: 'preliminary_result' as const,
      toolCallId,
      toolName,
      result,
    });
    this.turnBroadcaster?.push({
      type: 'tool.preliminary_result' as const,
      toolCallId,
      toolName,
      result,
      timestamp: Date.now(),
    } as CorrelatedResponseStreamEvent<TTools>);
  }

  /**
   * Set up the turn broadcaster with tool execution and return the consumer.
   * Used by stream methods that need to iterate over all turns.
   */
  private startTurnBroadcasterExecution(): {
    consumer: AsyncIterableIterator<CorrelatedResponseStreamEvent<TTools>>;
    executionPromise: Promise<void>;
  } {
    const broadcaster = this.ensureTurnBroadcaster();
    this.startInitialStreamPipe();
    const consumer = broadcaster.createConsumer();
    if (!this.turnBroadcasterCompletionPromise) {
      this.turnBroadcasterCompletionPromise = this.executeToolsIfNeeded().finally(async () => {
        // Preserve turn.end, but never couple non-UI stream completion to UI rendering.
        if (this.initialPipePromise) {
          await this.initialPipePromise;
        }
        broadcaster.complete();
      });
    }
    return {
      consumer,
      executionPromise: this.turnBroadcasterCompletionPromise,
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
      const stream = new ReusableReadableStream(value, {
        streamReplay: this.streamReplay,
        isTerminalValue: isTerminalResponseStreamEvent,
      });
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

    const initialPipePromise = this.initialPipePromise;
    if (initialPipePromise) {
      await initialPipePromise;
    }

    if (this.initialResponseError) {
      throw this.initialResponseError;
    }

    if (this.initialResponse) {
      await this.emitPendingModelCallOnce(this.initialResponse);
      return this.initialResponse;
    }

    if (this.reusableStream) {
      const response = await consumeStreamForCompletion(this.reusableStream);
      await this.emitPendingModelCallOnce(response);
      return response;
    }
    throw new Error('Neither stream nor response initialized');
  }

  private extractCachedCompletion(): models.OpenResponsesResult {
    if (this.initialResponseError) {
      throw this.initialResponseError;
    }
    if (this.initialResponse) {
      return this.initialResponse;
    }
    if (!this.reusableStream) {
      throw new Error('Stream not initialized');
    }
    return extractCompletionFromBuffer(this.reusableStream);
  }

  private tryExtractCachedCompletion(): models.OpenResponsesResult | undefined {
    if (this.initialResponse) {
      return this.initialResponse;
    }
    return this.reusableStream ? tryExtractCompletionFromBuffer(this.reusableStream) : undefined;
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
    if (this.resumingFromAsyncTools) {
      // The resumed request succeeded — the conversation is moving again.
      // Pending tasks that are still unresolved stay on pendingAsyncTools
      // (resumeToolResults maintains that list); only the status advances.
      this.resumingFromAsyncTools = false;
      stateUpdates.status = 'in_progress';
    }

    await this.saveStateSafely(stateUpdates);
  }

  /**
   * Mark state as complete.
   * Sets the conversation status to 'complete' indicating no further tool execution is needed.
   */
  private async markStateComplete(): Promise<void> {
    // A later conversational turn is a new logical run and may force its
    // first tool call again.
    this.resetForcedToolChoicePolicy();
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
      this.resetForcedToolChoicePolicy();
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
      // The universal task tool is engine-intercepted — always executable.
      if (toolCall.name === TASK_TOOL_NAME && this.taskToolActive()) {
        return true;
      }
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
    extras?: ToolExecutionExtras,
    runPreToolUse = true,
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

    const prepared = this.preparedToolCalls.get(toolCall.id);
    this.preparedToolCalls.delete(toolCall.id);
    if (prepared?.type === 'blocked') {
      return {
        type: 'hook_blocked',
        toolCall,
        reason: prepared.reason,
        output: prepared.output,
      };
    }

    let effectiveToolCall = prepared?.type === 'ready' ? prepared.toolCall : toolCall;

    // Emit PreToolUse here only when the approval gate has not already done
    // so (for example, an approved call resumed from older persisted state).
    if (this.hooksManager && !prepared && runPreToolUse) {
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
      extras,
    );
    const durationMs = performance.now() - startTime;

    // HITL tools may pause (executeTool returns null). No output was produced
    // yet, so neither PostToolUse nor PostToolUseFailure fires; they will fire
    // if/when the tool is resumed and actually executes.
    // Async invocations (background/deferred) haven't produced their final
    // output either — Post hooks fire at settlement via
    // emitAsyncSettledHooks (in-process delivery). Results delivered by
    // resumeToolResults in ANOTHER process have no hooksManager there;
    // that path stays uncovered and is documented on resumeToolResults.
    // Emit PostToolUse or PostToolUseFailure.
    if (this.hooksManager && result !== null && !isAsyncToolInvocation(result)) {
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
   * Advance the doom-loop round counter and declare the round's calls. Called
   * at every execution-batch boundary (main tool round, auto-approve batch
   * while pausing, approved-on-resume batch). Identical calls WITHIN one round
   * are duplicates — one piece of loop evidence, one shared decision.
   *
   * `batch` is every call the round will make. A round's identity for one tool
   * is the *set* of fingerprints it was called with, and that set has to be
   * complete before any of the round's calls is scored: accumulating it call
   * by call made a round that is a superset of the previous one transiently
   * match it, blocking calls that represented real progress, with the outcome
   * depending on emission order. Declaration is best-effort — a call whose key
   * material is exempt or unhashable is simply left out, and the per-call
   * fallback chain in `enqueueDoomLoopEvaluation` still governs identity at
   * record time.
   *
   * Only calls that the round will actually CHECK are declared. A `loopKey`
   * function is user code that may count or log, so it must not run for a call
   * the detector never evaluates: manual tool calls (no `execute`, no
   * `onToolCalled`) are handed to the caller and never recorded, and every
   * execution path skips them with the same `isAutoResolvableTool` predicate
   * used here. Their absence from the declared set is also correct on its own
   * terms — they are not evidence, so they are not part of the round.
   *
   * INVARIANT — every declared member must eventually be recorded. A call
   * that is declared but never reaches the doom-loop checkpoint is a phantom
   * member of the round's identity: the tool's streak silently resets the
   * moment the phantom stops being emitted (pinned by the "declared-but-
   * never-recorded member" test in doom-loop-fanout.test.ts). The filters
   * below therefore MIRROR every path that skips recording — unknown/manual
   * tools (`isAutoResolvableTool`, also gating executeAutoApproveTools and
   * the approval-resume loop), `hookDeniedCalls` (consumed before the
   * checkpoint in executeSingleToolCall), and `loopKey`-exempt calls (early
   * return in checkDoomLoopBeforeExecution; the same resolution is cached
   * here so both sides agree). If you add a new short-circuit between
   * declaration and the checkpoint — a pre-execution gate, a batch filter —
   * it MUST be reflected here, or fan-out detection degrades silently for
   * that tool rather than failing loudly.
   *
   * KNOWN RESIDUAL (documented, not mirrored): a per-request timeout or
   * abort can cancel a call AFTER declaration but BEFORE its checkpoint,
   * leaving a declared phantom for that round. Bounded and fail-safe: the
   * round-set streak for that tool resets when the phantom stops recurring,
   * while per-call streaks are unaffected — detection degrades to per-call
   * for the affected tool rather than being lost. Un-declaring mid-round
   * would mutate the round's identity while it is being scored, which is the
   * incremental-set order-dependence this design exists to prevent.
   */
  private async beginDoomLoopRound(batch: readonly ParsedToolCall<Tool>[] = []): Promise<void> {
    const monitor = this.doomLoopMonitor;
    if (!monitor) {
      return;
    }
    this.doomLoopRound++;
    this.doomLoopRoundDecisions.clear();
    this.doomLoopRoundKeyMaterial.clear();

    const declared: {
      toolName: string;
      keyMaterial: unknown;
    }[] = [];
    for (const toolCall of batch) {
      const tool = this.options.tools?.find(
        (t) => isClientTool(t) && t.function.name === toolCall.name,
      );
      /*
       * Never checked => never recorded => must not be declared. Declaring a
       * call that never arrives inflates the round's identity: a sibling that
       * IS recorded gets scored against a set containing a phantom member, and
       * the streak resets spuriously once the phantom stops appearing (e.g. the
       * model drops a malformed call while still repeating the valid one).
       * Keeping `loopKey` from running for such a call is the same check.
       *
       * This gate deliberately precedes the malformed-arguments branch below:
       * a raw-string call to an unknown or manual tool is still never recorded.
       */
      if (tool === undefined || !isAutoResolvableTool(tool)) {
        continue;
      }
      /*
       * Same reasoning for a call the PermissionRequest hook denied without
       * pausing: `hookDeniedCalls` is populated before the round begins, and
       * `runToolWithHooks` synthesizes the rejection before reaching the
       * doom-loop checkpoint, so the call is never recorded either.
       */
      if (this.hookDeniedCalls.has(toolCall.id)) {
        continue;
      }
      const rawArgs: unknown = toolCall.arguments;
      if (typeof rawArgs === 'string') {
        // Malformed call: its identity is the raw string (see runToolWithHooks).
        declared.push({
          toolName: String(toolCall.name),
          keyMaterial: rawArgs,
        });
        continue;
      }
      /*
       * `resolveLoopKeyMaterial` catches a throwing `loopKey`, but not every
       * throw: the field-list form reads `args[field]`, so a getter on the
       * arguments object throws out of it uncaught. Declaration runs once for
       * the whole batch, so letting that escape would fail the entire round —
       * and the run — over one odd call, breaking the invariant that detection
       * never affects a run except through its ladder actions. Skip just that
       * call; the per-call checkpoint hits the same throw inside its own
       * try/catch and applies the documented fallback chain there.
       */
      let resolution: LoopKeyResolution;
      try {
        resolution = resolveLoopKeyMaterial(
          isClientTool(tool) ? tool.function.loopKey : undefined,
          (toolCall.arguments ?? {}) as Record<string, unknown>,
        );
      } catch (error) {
        console.warn(
          `[DoomLoop] could not resolve loop identity for "${toolCall.name}" while declaring the round; ` +
            'excluding it from the round set:',
          error,
        );
        continue;
      }
      /*
       * Cache so the per-call checkpoint does not invoke `loopKey` a second
       * time; keyed by call id. Ids are MODEL-emitted strings and nothing
       * upstream enforces uniqueness, so a duplicate id must not alias one
       * call's identity onto another: overwriting here meant the first call's
       * checkpoint read the second call's key material, its true fingerprint
       * was never recorded, and a model emitting `(id=X, read a), (id=X,
       * read b_i)` each round evaded the per-call detector for `a` entirely
       * (measured: zero detections across four such rounds). On a duplicate
       * id the cache poisons that id instead: both calls fall through to
       * per-call resolution at the checkpoint, costing at most a duplicate
       * `loopKey` invocation for the colliding calls — correctness over the
       * single-invocation economy, for protocol-malformed input only.
       */
      if (this.doomLoopRoundKeyMaterial.has(toolCall.id)) {
        this.doomLoopRoundKeyMaterial.set(toolCall.id, DUPLICATE_CALL_ID);
      } else {
        this.doomLoopRoundKeyMaterial.set(toolCall.id, resolution);
      }
      if (resolution.kind === 'exempt') {
        continue;
      }
      declared.push({
        toolName: String(toolCall.name),
        keyMaterial: resolution.keyMaterial,
      });
    }
    await monitor.declareRound(this.doomLoopRound, declared);
  }

  /**
   * Evaluate one call against the doom-loop monitor, serialized on
   * `doomLoopChain` so parallel executions record in the deterministic
   * order their evaluations were ENQUEUED (the `.map()` over a round's
   * calls runs synchronously to its first await, i.e. model-emission
   * order) — not in hash-completion order.
   *
   * Applies the fallback invariant: detection must never take down or
   * alter a run except via its defined actions. Unhashable key material
   * (bigint, non-finite numbers, circular/too-deep structures from a
   * computed loopKey) degrades to `fallbackKeyMaterial`; if THAT is also
   * unhashable (parse-error path passes null), detection is skipped for
   * the call and it proceeds normally.
   *
   * Returns the final decision for this call (`action: 'proceed'` when no
   * rung fired or the call is exempt/skipped; `message` carries the
   * verdict's explanation for block outputs). Side effects (steer queue,
   * stop arm) are applied here so every caller shares them.
   */
  private enqueueDoomLoopEvaluation(evaluation: {
    toolName: string;
    keyMaterial: unknown;
    /** Identity to retry with when `keyMaterial` is unhashable; null = skip detection. */
    fallbackKeyMaterial: unknown;
    allowBlock: boolean;
    detector: 'tool-fingerprint' | 'server-tool-fingerprint';
    toolCall?: ParsedToolCall<Tool>;
  }): Promise<{
    action: DoomLoopAction | 'proceed';
    message?: string;
  }> {
    const run = async (): Promise<{
      action: DoomLoopAction | 'proceed';
      message?: string;
    }> => {
      const monitor = this.doomLoopMonitor;
      if (!monitor) {
        return {
          action: 'proceed',
        };
      }

      let record: DoomLoopCallRecord;
      try {
        record = await monitor.recordToolCall(
          evaluation.toolName,
          evaluation.keyMaterial,
          this.doomLoopRound,
          {
            allowBlock: evaluation.allowBlock,
            detector: evaluation.detector,
          },
        );
      } catch (error) {
        // Unhashable key material (bigint/NaN/circular/too-deep loopKey
        // output). Fall back to the raw-arguments identity; if that also
        // fails, skip detection for this call — never fail the call itself.
        console.warn(
          `[DoomLoop] could not fingerprint call to "${evaluation.toolName}"; ` +
            `${evaluation.fallbackKeyMaterial !== null ? 'falling back to full arguments' : 'skipping detection for this call'}:`,
          error,
        );
        if (evaluation.fallbackKeyMaterial === null) {
          return {
            action: 'proceed',
          };
        }
        try {
          record = await monitor.recordToolCall(
            evaluation.toolName,
            evaluation.fallbackKeyMaterial,
            this.doomLoopRound,
            {
              allowBlock: evaluation.allowBlock,
              detector: evaluation.detector,
            },
          );
        } catch (fallbackError) {
          console.warn(
            `[DoomLoop] fallback identity for "${evaluation.toolName}" also unhashable; skipping detection for this call:`,
            fallbackError,
          );
          return {
            action: 'proceed',
          };
        }
      }

      // Same (tool, fingerprint) already decided this round: reuse the
      // decision — no second streak increment, no second hook emission.
      const decisionKey = `${evaluation.toolName}\n${record.fingerprint}`;
      if (record.duplicateInRound) {
        return (
          this.doomLoopRoundDecisions.get(decisionKey) ?? {
            action: 'proceed',
          }
        );
      }

      if (!record.verdict) {
        const decision = {
          action: 'proceed' as const,
        };
        this.doomLoopRoundDecisions.set(decisionKey, decision);
        return decision;
      }

      const action = await this.applyDoomLoopVerdict(record.verdict, evaluation.toolCall);
      const decision = {
        action,
        message: record.verdict.message,
      };
      this.doomLoopRoundDecisions.set(decisionKey, decision);
      this.applyDoomLoopSideEffects(action, record.verdict);
      return decision;
    };

    // Serialize on the chain; keep the chain alive even if an evaluation
    // throws unexpectedly (it should not — run() catches everything).
    const evaluationPromise = this.doomLoopChain.then(run, run);
    this.doomLoopChain = evaluationPromise.catch(() => undefined);
    return evaluationPromise;
  }

  /**
   * Doom-loop checkpoint for one tool call, run before PreToolUse/execution.
   *
   * Resolves the tool's `loopKey` declaration (function |
   * false | absent — see {@link resolveLoopKeyMaterial}) and evaluates the
   * call against the monitor. Ladder actions:
   *
   * - `observe` — hook already emitted, nothing else.
   * - `steer`   — queue a corrective user message for the next model turn.
   * - `block`   — return `blocked` so the caller synthesizes an error output
   *   without executing. The model sees the explanation in the tool result.
   * - `stop`    — arm `doomLoopStop`; ALSO blocks this call (executing a
   *   call the detector just condemned, then stopping, would be
   *   incoherent). The loop halts before the next model request.
   */
  private async checkDoomLoopBeforeExecution(
    tool: Tool,
    toolCall: ParsedToolCall<Tool>,
  ): Promise<
    | {
        blocked: false;
      }
    | {
        blocked: true;
        reason: string;
      }
  > {
    if (!this.doomLoopMonitor) {
      return {
        blocked: false,
      };
    }

    // The parse-error guard in runToolWithHooks already rejected raw-string
    // arguments, so what remains is the parsed record (or null/undefined for
    // no-args calls — coerced to {} the same way the PreToolUse payload is).
    const callArguments = (toolCall.arguments ?? {}) as Record<string, unknown>;
    /*
     * Reuse what `beginDoomLoopRound` resolved for this call when it declared
     * the round. `loopKey` is user code — it may count, log, or return a fresh
     * value each time — so it must run at most once per call. Resolving here
     * as well would double-invoke it and, for a non-repeatable callback, make
     * the declared identity and the recorded identity disagree.
     */
    const cached = this.doomLoopRoundKeyMaterial.get(toolCall.id);
    let resolution: LoopKeyResolution;
    if (cached !== undefined && cached !== DUPLICATE_CALL_ID) {
      resolution = cached;
    } else {
      /*
       * Not declared (undeclared round, or the declaration skipped this call).
       * `resolveLoopKeyMaterial` can throw despite catching `loopKey` itself —
       * the field-list form reads `args[field]`, so a getter on the arguments
       * throws out of it. Detection must never reject a call or fail a run
       * except through a ladder action, so skip detection for this one call.
       */
      try {
        resolution = resolveLoopKeyMaterial(
          isClientTool(tool) ? tool.function.loopKey : undefined,
          callArguments,
        );
      } catch (error) {
        console.warn(
          `[DoomLoop] could not resolve loop identity for "${toolCall.name}"; ` +
            'skipping detection for this call:',
          error,
        );
        return {
          blocked: false,
        };
      }
    }
    if (resolution.kind === 'exempt') {
      return {
        blocked: false,
      };
    }
    if (resolution.kind === 'fallback') {
      console.warn(`[DoomLoop] tool "${toolCall.name}": ${resolution.warning}`);
    }

    const decision = await this.enqueueDoomLoopEvaluation({
      toolName: String(toolCall.name),
      keyMaterial: resolution.keyMaterial,
      fallbackKeyMaterial: resolution.keyMaterial === callArguments ? null : callArguments,
      allowBlock: true,
      detector: 'tool-fingerprint',
      toolCall,
    });

    if (decision.action === 'block' || decision.action === 'stop') {
      return {
        blocked: true,
        reason:
          decision.message ??
          `Doom loop suspected: tool "${toolCall.name}" is repeating identical calls. ` +
            'Repeating the call will not change the result. Take a different approach.',
      };
    }
    return {
      blocked: false,
    };
  }

  /**
   * Emit the DoomLoopDetected hook for a verdict and resolve the final
   * action. Handlers may override per event (`overrideAction`), letting
   * userland escalate or de-escalate without reconfiguring the ladder;
   * the LAST override in the chain wins (matching PermissionRequest's
   * last-wins convention). Non-blockable verdicts (text, server tools —
   * the tokens are already emitted / the tool already ran) downgrade a
   * 'block' override to 'observe'. An 'escalate' override is honored only
   * when an escalation mechanism is configured with remaining budget;
   * otherwise it downgrades to 'observe' (never silently to a stronger
   * action).
   */
  private async applyDoomLoopVerdict(
    verdict: DoomLoopVerdict,
    toolCall?: ParsedToolCall<Tool>,
  ): Promise<DoomLoopVerdict['action']> {
    let action = verdict.action;
    if (this.hooksManager) {
      const emit = await this.hooksManager.emit(
        'DoomLoopDetected',
        {
          detector: verdict.detector,
          action: verdict.action,
          streak: verdict.streak,
          fingerprint: verdict.fingerprint,
          ...(verdict.toolName !== undefined && {
            toolName: verdict.toolName,
          }),
          ...(toolCall !== undefined &&
            isRecord(toolCall.arguments) && {
              toolInput: toolCall.arguments as Record<string, unknown>,
            }),
          message: verdict.message,
        },
        this.hookEmitContext(verdict.toolName),
      );
      for (const result of emit.results) {
        if (result?.overrideAction) {
          action = result.overrideAction;
        }
      }
    }
    if (verdict.detector !== 'tool-fingerprint' && action === 'block') {
      // Nothing to block for text/server-tool verdicts; observe instead of
      // silently acting stronger/weaker than the handler intended.
      action = 'observe';
    }
    if (action === 'escalate' && !(this.doomLoopMonitor?.canEscalate() ?? false)) {
      // Ladder verdicts are already budget-gated by the monitor; this
      // catches hook overrides requesting escalation without config/budget.
      action = 'observe';
    }
    return action;
  }

  /**
   * Apply the side effects of a resolved doom-loop action shared by every
   * checkpoint: queue steer guidance, arm an escalation for the next
   * request, or arm the stop verdict. 'block' has no shared side effect —
   * the calling checkpoint synthesizes the blocked output itself.
   */
  private applyDoomLoopSideEffects(
    action: DoomLoopAction | 'proceed',
    verdict: DoomLoopVerdict,
  ): void {
    if (action === 'steer') {
      this.queueDoomLoopSteer(verdict.message);
    } else if (action === 'escalate') {
      // Latch the FIRST escalation verdict for the next request; a second
      // verdict in the same window (e.g. tool + text detectors both firing)
      // must not double-spend the budget.
      if (this.pendingDoomLoopEscalation === null) {
        this.pendingDoomLoopEscalation = verdict;
        // The model should know why its next turn looks different. Rides
        // the persisted steer path so the transcript stays well-formed.
        this.queueDoomLoopSteer(
          `${verdict.message} An escalated turn follows: use the additional guidance to change course.`,
        );
      }
    } else if (action === 'stop') {
      this.doomLoopStop = verdict;
    }
  }

  /**
   * Consume a pending escalation into ONE-TURN request overrides:
   *
   * - `model` — replace the request's model for this dispatch only (the
   *   base `resolvedRequest` is never mutated, so the following turn
   *   reverts automatically).
   * - `advisor` — append an `openrouter:advisor` server tool (transcript
   *   forwarded, instructions describing the detected loop) and pin
   *   `toolChoice` to it via `allowed_tools`/`required`, so the stuck model
   *   must consult the advisor before doing anything else this turn.
   *
   * Burns one unit of the escalation budget (persisted via the monitor) at
   * APPLICATION time — verdicts the engine never got to apply (run stopped,
   * paused, or overridden) do not spend.
   */
  private takeDoomLoopEscalationOverrides(): Partial<models.ResponsesRequest> | null {
    const verdict = this.pendingDoomLoopEscalation;
    const config = this.doomLoopEscalation;
    if (!verdict || !config || !this.doomLoopMonitor?.canEscalate()) {
      this.pendingDoomLoopEscalation = null;
      return null;
    }
    this.pendingDoomLoopEscalation = null;
    this.doomLoopMonitor.consumeEscalation();

    const overrides: Record<string, unknown> = {};
    if (config.model !== undefined) {
      overrides['model'] = config.model;
      // A single-model override must not be shadowed by a fallback list.
      overrides['models'] = undefined;
    }
    if (config.advisor !== undefined && config.advisor !== false) {
      const advisorParameters: Record<string, unknown> = {
        forwardTranscript: true,
        instructions:
          'You are an escalation advisor. The executing model appears stuck in a loop: ' +
          `${verdict.message} Diagnose why its approach is failing and give concrete, ` +
          'specific instructions for a DIFFERENT approach. Do not restate the problem.',
        ...(typeof config.advisor === 'object' ? config.advisor : {}),
      };
      const existingTools = Array.isArray(
        (this.resolvedRequest as Record<string, unknown> | null)?.['tools'],
      )
        ? ((this.resolvedRequest as Record<string, unknown>)['tools'] as unknown[])
        : [];
      overrides['tools'] = [
        ...existingTools,
        {
          type: 'openrouter:advisor',
          parameters: advisorParameters,
        },
      ];
      // Force the consult: constrain this turn's tool surface to the
      // advisor and require a call.
      overrides['toolChoice'] = {
        type: 'allowed_tools',
        mode: 'required',
        tools: [
          {
            type: 'openrouter:advisor',
          },
        ],
      };
    }
    return overrides as Partial<models.ResponsesRequest>;
  }

  /**
   * Step-level doom-loop checkpoint on a fresh model response:
   *
   * 1. Text detectors — within-response token repetition + cross-step
   *    identical-text streak.
   * 2. Server-tool fingerprints — server tools (web_search_call etc.) never
   *    pass through runToolWithHooks; their repetition is detected here,
   *    post-execution, from the echoed call fields on the output item.
   *    Post-execution ⇒ block is meaningless (allowBlock: false); the
   *    actions are observe/steer/stop.
   *
   * Runs where the loop already inspects each fresh response, so scripted
   * transcripts exercise it deterministically.
   */
  private async checkDoomLoopForResponse(response: models.OpenResponsesResult): Promise<void> {
    if (!this.doomLoopMonitor) {
      return;
    }
    let verdict: DoomLoopVerdict | undefined;
    try {
      verdict = await this.doomLoopMonitor.recordAssistantText(extractTextFromResponse(response));
    } catch (error) {
      console.warn('[DoomLoop] text checkpoint failed; skipping for this response:', error);
      verdict = undefined;
    }
    if (verdict) {
      const action = await this.applyDoomLoopVerdict(verdict);
      this.applyDoomLoopSideEffects(action, verdict);
    }

    // Server-tool repetition. The response's server-tool output items echo
    // their call identity (action/query fields, item type as the tool name).
    for (const item of response.output) {
      if (!hasTypeProperty(item) || !isServerToolResultItem(item)) {
        continue;
      }
      const identity = extractServerToolIdentity(item);
      if (identity === null) {
        continue;
      }
      await this.enqueueDoomLoopEvaluation({
        toolName: `server:${item.type}`,
        keyMaterial: identity,
        fallbackKeyMaterial: null,
        allowBlock: false,
        detector: 'server-tool-fingerprint',
      });
    }
  }

  /**
   * Queue steer guidance, deduplicating identical messages (one verdict can
   * repeat across calls in a round; the model needs the guidance once).
   */
  private queueDoomLoopSteer(message: string): void {
    if (!this.pendingDoomLoopSteer.includes(message)) {
      this.pendingDoomLoopSteer.push(message);
    }
  }

  /**
   * Inject any queued doom-loop steer messages as a user message before the
   * next model turn. Reuses the Stop-hook appendPrompt injection path, so
   * state/messages advance observably. Called in-loop before each follow-up
   * request AND before every pause-persist, so guidance queued right before
   * a pause lands in the persisted conversation instead of being dropped.
   */
  private async flushDoomLoopSteer(): Promise<void> {
    if (this.pendingDoomLoopSteer.length === 0) {
      return;
    }
    const prompt = this.pendingDoomLoopSteer.join('\n');
    this.pendingDoomLoopSteer = [];
    await this.injectAppendPromptMessage(prompt);
  }

  /**
   * Halt the run for an armed doom-loop stop verdict, keeping the persisted
   * history well-formed: every executable `function_call` in the current
   * response that has no output yet gets a synthesized halt-error output
   * (persisted via the normal tool-result path), so a stateful resume never
   * sends a dangling `function_call` (providers reject those with a 400).
   *
   * Used by every stop site: the pre-round break, the post-round break, the
   * no-tools early return, the allow-final-response gate, and the approval-
   * resume gate.
   *
   * @param resolvedCallIds - call ids that already have outputs this round.
   */
  private async sealDoomLoopStop(
    currentResponse: models.OpenResponsesResult,
    resolvedCallIds?: ReadonlySet<string>,
  ): Promise<void> {
    const verdict = this.doomLoopStop;
    const toolCalls = extractToolCallsFromResponse(currentResponse);
    const unresolved = toolCalls.filter((tc) => !resolvedCallIds?.has(tc.id));
    if (unresolved.length > 0) {
      const haltMessage = verdict
        ? `Run halted by doom-loop detection: ${verdict.message}`
        : 'Run halted by doom-loop detection.';
      const haltOutputs: models.FunctionCallOutputItem[] = unresolved.map((tc) => ({
        type: 'function_call_output' as const,
        id: `output_${tc.id}`,
        callId: tc.id,
        output: JSON.stringify({
          error: haltMessage,
        }),
      }));
      await this.saveToolResultsToState(haltOutputs);
    }
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
   * Emit PostToolUse / PostToolUseFailure for an async task at settlement —
   * the point its final output actually exists. Round-synchronous tools
   * emit these in runToolWithHooks; async invocations skip that emission
   * (no output yet) and land here instead. `durationMs` is the task's
   * start-to-settle wall clock (includes background-pool queue wait, which
   * counts against the task's own timeout budget). Observation-only — a
   * throwing hook must not break delivery.
   */
  private async emitAsyncSettledHooks(task: SettledToolTask): Promise<void> {
    if (!this.hooksManager) {
      return;
    }
    try {
      if (task.status === 'completed') {
        await this.hooksManager.emit(
          'PostToolUse',
          {
            toolName: task.name,
            toolInput: task.input ?? {},
            toolOutput: task.result,
            durationMs: task.durationMs,
          },
          this.hookEmitContext(task.name),
        );
      } else {
        await this.hooksManager.emit(
          'PostToolUseFailure',
          {
            toolName: task.name,
            toolInput: task.input ?? {},
            error: new Error(task.error ?? `Task ${task.taskId} ${task.status}`),
          },
          this.hookEmitContext(task.name),
        );
      }
    } catch (error) {
      console.warn('[AsyncTools] PostToolUse hook threw during async settlement:', error);
    }
  }

  /**
   * Emit SessionEnd exactly once, and only when a matching SessionStart
   * actually succeeded. Safe to call from multiple teardown paths.
   */
  private async emitSessionEndOnce(
    reason: 'user' | 'error' | 'max_turns' | 'complete' | 'doom_loop',
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
          totalUsage: this.snapshotSessionUsage(),
        }),
      },
      this.hookEmitContext(),
    );
  }

  /**
   * Materialize the running session aggregate as an immutable
   * `SessionUsageTotals`. `cost` is present only when at least one response
   * reported it, matching the hook payload's optionality (a summed cost of
   * `0` from cost-less responses would read as "free" rather than "unknown").
   *
   * Single source of truth for both `SessionEnd.totalUsage` and the public
   * `getUsage()` accessor, so the two can never drift.
   */
  private snapshotSessionUsage(): SessionUsageTotals {
    return {
      modelCalls: this.sessionUsage.modelCalls,
      inputTokens: this.sessionUsage.inputTokens,
      outputTokens: this.sessionUsage.outputTokens,
      totalTokens: this.sessionUsage.totalTokens,
      cachedTokens: this.sessionUsage.cachedTokens,
      reasoningTokens: this.sessionUsage.reasoningTokens,
      ...(this.sessionUsage.hasCost && {
        cost: this.sessionUsage.cost,
      }),
    };
  }

  /**
   * Emit PostModelCall for a completed model response and fold its usage
   * into the session aggregate. One emit per materialized response.
   *
   * Accumulation runs unconditionally — before the hooks short-circuit —
   * because `getUsage()` surfaces these totals to callers who configured no
   * hooks at all. Only the hook emit is gated on a `HooksManager`.
   */
  private async emitPostModelCall(
    response: models.OpenResponsesResult,
    startedAt: number,
    turnType: PostModelCallPayload['turnType'],
    turnNumber: number,
  ): Promise<void> {
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
    if (!this.hooksManager) {
      return;
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
   * executeToolsIfNeeded (the normal SessionEnd site). Materializes the
   * parked model-call telemetry, emits SessionEnd once, and drains pending
   * hook work. Never throws: teardown must not mask the stream's own outcome.
   */
  private async finishHooksSessionForStream(
    reason: 'complete' | 'error' = 'complete',
  ): Promise<void> {
    // Materialize the parked initial-call telemetry when the stream fully
    // completed (the retained buffer replays without touching the source).
    // A failed/errored stream skips it: no materialized response exists.
    // (`response.incomplete` responses DO emit — they are materialized, have
    // a generation id, and consumed tokens.)
    // Runs even without a HooksManager: this is the only site that folds the
    // no-tools streaming response into `sessionUsage`, which `getUsage()`
    // reports to hook-less callers.
    // Isolated try: a telemetry failure (e.g. a buffer without a completion
    // event, or a throwing strict-mode handler) must not skip SessionEnd or
    // the drain below — those are contractual on every exit path.
    try {
      if (this.pendingModelCall) {
        if (this.finalResponse) {
          await this.emitPendingModelCallOnce(this.finalResponse);
        } else if (this.reusableStream?.isComplete) {
          // Sync backward scan of the retained buffer — not a consumer
          // replay, which would cost one microtask hop per buffered event
          // on every hook-less streaming teardown.
          await this.emitPendingModelCallOnce(this.extractCachedCompletion());
        } else if (this.reusableStream) {
          // Consumers stop at the terminal event (streamTerminationEvents),
          // usually before the pump reads the source close that flips
          // `isComplete` — with a real network stream the close frame
          // arrives after `response.completed`. The terminal event is
          // already buffered in that window, so recover it rather than
          // dropping the parked telemetry. Stays silent (no emit, no
          // throw) when nothing terminal was buffered — e.g. an errored
          // mid-flight stream, where no materialized response exists.
          const buffered = this.tryExtractCachedCompletion();
          if (buffered) {
            await this.emitPendingModelCallOnce(buffered);
          }
        }
      }
    } catch (telemetryError) {
      console.warn('[PostModelCall] error during stream teardown:', telemetryError);
    }
    if (!this.hooksManager) {
      return;
    }
    try {
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

  private async prepareToolCallForApproval(
    toolCall: ParsedToolCall<Tool>,
  ): Promise<ParsedToolCall<Tool>> {
    if (!this.hooksManager || typeof toolCall.arguments === 'string') {
      return toolCall;
    }

    const preResult = await this.hooksManager.emit(
      'PreToolUse',
      {
        toolName: toolCall.name,
        toolInput: (toolCall.arguments ?? {}) as Record<string, unknown>,
      },
      this.hookEmitContext(toolCall.name),
    );

    if (preResult.blocked) {
      const block = preResult.results.find((result) => result.block)?.block;
      const reason = typeof block === 'string' ? block : 'Blocked by PreToolUse hook';
      this.preparedToolCalls.set(toolCall.id, {
        type: 'blocked',
        reason,
        output: {
          type: 'function_call_output',
          id: `output_${toolCall.id}`,
          callId: toolCall.id,
          output: JSON.stringify({
            error: reason,
          }),
        },
      });
      return toolCall;
    }

    const effectiveToolCall = preResult.mutated
      ? {
          ...toolCall,
          arguments: preResult.finalPayload.toolInput,
        }
      : toolCall;
    this.preparedToolCalls.set(toolCall.id, {
      type: 'ready',
      toolCall: effectiveToolCall,
      mutated: preResult.mutated,
    });
    return effectiveToolCall;
  }

  private approvalResponseKey(response: models.OpenResponsesResult): string {
    let occurrence = this.approvalResponseOccurrences.get(response);
    if (occurrence === undefined) {
      occurrence = this.nextApprovalResponseOccurrence++;
      this.approvalResponseOccurrences.set(response, occurrence);
    }
    return `${response.id}:${occurrence}`;
  }

  private approvalGateKey(
    phase: 'initial' | 'mutated',
    responseKey: string,
    occurrence: string,
  ): string {
    return JSON.stringify([
      phase,
      responseKey,
      occurrence,
    ]);
  }

  private assignApprovalCallOccurrences(
    response: models.OpenResponsesResult,
    toolCalls: ParsedToolCall<Tool>[],
  ): Map<ParsedToolCall<Tool>, string> {
    let identities = this.approvalCallOccurrences.get(response);
    if (!identities) {
      identities = [];
      this.approvalCallOccurrences.set(response, identities);
    }
    const occurrences = new Map<ParsedToolCall<Tool>, string>();
    for (const [index, toolCall] of toolCalls.entries()) {
      const identity = identities[index] ?? `call:${this.nextApprovalCallOccurrence++}`;
      identities[index] = identity;
      occurrences.set(toolCall, identity);
    }
    return occurrences;
  }

  /** Re-check only approval sources whose answer can depend on input. */
  private async mutatedInputRequiresApproval(
    toolCall: ParsedToolCall<Tool>,
    context: TurnContext,
  ): Promise<boolean> {
    const tools = this.options.tools;
    if (!tools) {
      return false;
    }
    const tool = tools.find(
      (candidate) => isClientTool(candidate) && candidate.function.name === toolCall.name,
    );
    if (this.requireApprovalFn) {
      return toolRequiresApproval(
        toolCall as ParsedToolCall<TTools[number]>,
        tools,
        context,
        this.requireApprovalFn,
      );
    }
    if (!tool || !isClientTool(tool) || typeof tool.function.requireApproval !== 'function') {
      return false;
    }
    return toolRequiresApproval(toolCall as ParsedToolCall<TTools[number]>, tools, context);
  }

  private async emitPreparedFailure(toolCall: ParsedToolCall<Tool>, reason: string): Promise<void> {
    if (!this.hooksManager) {
      return;
    }
    await this.hooksManager.emit(
      'PostToolUseFailure',
      {
        toolName: toolCall.name,
        toolInput: (toolCall.arguments ?? {}) as Record<string, unknown>,
        error: new Error(reason),
      },
      this.hookEmitContext(toolCall.name),
    );
  }

  private async blockPreparedToolCall(
    toolCall: ParsedToolCall<Tool>,
    reason: string,
  ): Promise<void> {
    this.preparedToolCalls.set(toolCall.id, {
      type: 'blocked',
      reason,
      output: {
        type: 'function_call_output',
        id: `output_${toolCall.id}`,
        callId: toolCall.id,
        output: JSON.stringify({
          error: reason,
        }),
      },
    });
    await this.emitPreparedFailure(toolCall, reason);
  }

  private async validatePreparedMutation(
    effective: ParsedToolCall<Tool>,
  ): Promise<'ready' | 'blocked'> {
    const tool = this.options.tools?.find(
      (candidate) => isClientTool(candidate) && candidate.function.name === effective.name,
    );
    if (!tool || !isClientTool(tool)) {
      return 'ready';
    }
    const parsed = z4.safeParse(tool.function.inputSchema, effective.arguments);
    if (!parsed.success || !isRecord(parsed.data)) {
      await this.blockPreparedToolCall(
        effective,
        `PreToolUse produced invalid input for "${effective.name}"`,
      );
      return 'blocked';
    }
    return 'ready';
  }

  private async prepareAfterInitialApproval(
    toolCall: ParsedToolCall<Tool>,
    context: TurnContext,
    responseKey: string,
    occurrence: string,
  ): Promise<'ready' | 'blocked' | 'pending'> {
    const effective = await this.prepareToolCallForApproval(toolCall);
    const prepared = this.preparedToolCalls.get(toolCall.id);
    if (prepared?.type !== 'ready' || !prepared.mutated) {
      return prepared?.type === 'blocked' ? 'blocked' : 'ready';
    }

    if ((await this.validatePreparedMutation(effective)) === 'blocked') {
      return 'blocked';
    }
    const key = this.approvalGateKey('mutated', responseKey, occurrence);
    if (this.completedApprovalGates.has(key)) {
      return 'ready';
    }
    this.completedApprovalGates.add(key);
    if (!(await this.mutatedInputRequiresApproval(effective, context))) {
      return 'ready';
    }

    const { decision, reason } = await this.emitPermissionRequest(effective);
    if (decision === 'allow') {
      return 'ready';
    }
    if (decision === 'deny') {
      await this.blockPreparedToolCall(effective, reason ?? 'Denied by PermissionRequest hook');
      return 'blocked';
    }
    return 'pending';
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
   * Settle an async invocation on the approval/resume path, where results
   * are accumulated as `UnsentToolResult`s rather than round outputs.
   *
   * - background: degrade to synchronous execution — the approval flow is
   *   already a discrete resume step, so there is no round to unblock; the
   *   work is awaited and its (validated) value becomes the unsent result.
   * - defer: the external task HAS been started by `start()`; record the
   *   pending placeholder as the unsent result and track the task on
   *   `pendingAsyncTools` so `resumeToolResults` can deliver the real
   *   result later as an envelope.
   */
  private async settleAsyncInvocationAsUnsent(
    tc: ParsedToolCall<TTools[number]>,
    invocation: AsyncToolInvocation,
  ): Promise<UnsentToolResult<TTools>> {
    if (invocation.asyncMode === 'background') {
      try {
        const result = await invocation.run();
        return createUnsentResult(tc.id, String(tc.name), result);
      } catch (error) {
        return createRejectedResult(
          tc.id,
          String(tc.name),
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const registry = this.ensureAsyncToolRegistry();
    const input = (tc.arguments ?? {}) as Record<string, unknown>;
    const liveTask = registry.trackDeferred({
      callId: tc.id,
      taskId: invocation.taskId,
      name: String(tc.name),
      input,
      ...(invocation.pollAfterMs !== undefined && {
        pollAfterMs: invocation.pollAfterMs,
      }),
      ...(invocation.expiresAt !== undefined && {
        expiresAt: invocation.expiresAt,
      }),
    });
    const task: PendingAsyncTool = {
      callId: tc.id,
      taskId: invocation.taskId,
      name: String(tc.name),
      mode: 'defer',
      status: 'working',
      startedAt: liveTask.startedAt,
      input,
      ...(invocation.pollAfterMs !== undefined && {
        pollAfterMs: invocation.pollAfterMs,
      }),
      ...(invocation.expiresAt !== undefined && {
        expiresAt: invocation.expiresAt,
      }),
    };
    if (this.currentState) {
      this.currentState = updateState(this.currentState, {
        pendingAsyncTools: [
          ...(this.currentState.pendingAsyncTools ?? []).filter((t) => t.callId !== tc.id),
          task,
        ],
      });
    }
    const placeholder = this.buildPendingPlaceholder(
      tc as ParsedToolCall<Tool>,
      invocation.taskId,
      invocation.ack,
      invocation.pollAfterMs,
    );
    return createUnsentResult(
      tc.id,
      String(tc.name),
      typeof placeholder.output === 'string' ? JSON.parse(placeholder.output) : placeholder.output,
    );
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
        this.broadcastToolResult(tc.id, String(tc.name), isMcpTool(tool) ? 'mcp' : 'client', {
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

      if (isAsyncToolInvocation(result)) {
        return this.settleAsyncInvocationAsUnsent(tc, result);
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

  private async classifyInitialApprovalCalls(
    toolCalls: ParsedToolCall<Tool>[],
    responseKey: string,
    occurrences: Map<ParsedToolCall<Tool>, string>,
  ): Promise<{
    unseenCalls: ParsedToolCall<Tool>[];
    blockedCalls: ParsedToolCall<Tool>[];
  }> {
    const unseenCalls: ParsedToolCall<Tool>[] = [];
    const blockedCalls: ParsedToolCall<Tool>[] = [];
    const unseenKeys = toolCalls.filter(
      (toolCall) =>
        !this.completedApprovalGates.has(
          this.approvalGateKey('initial', responseKey, occurrences.get(toolCall) ?? ''),
        ),
    );
    await this.beginDoomLoopRound(unseenKeys);

    for (const toolCall of toolCalls) {
      const key = this.approvalGateKey('initial', responseKey, occurrences.get(toolCall) ?? '');
      if (this.completedApprovalGates.has(key)) {
        continue;
      }
      this.completedApprovalGates.add(key);
      const tool = this.options.tools?.find(
        (candidate) => isClientTool(candidate) && candidate.function.name === toolCall.name,
      );
      if (tool && isAutoResolvableTool(tool)) {
        const rawArgs: unknown = toolCall.arguments;
        const doomOutcome =
          typeof rawArgs === 'string' && this.doomLoopMonitor
            ? await this.enqueueDoomLoopEvaluation({
                toolName: String(toolCall.name),
                keyMaterial: rawArgs,
                fallbackKeyMaterial: null,
                allowBlock: true,
                detector: 'tool-fingerprint',
                toolCall,
              }).then((decision) => ({
                blocked: decision.action === 'block' || decision.action === 'stop',
                reason: decision.message ?? 'Blocked by doom loop',
              }))
            : await this.checkDoomLoopBeforeExecution(tool, toolCall);
        if (doomOutcome.blocked) {
          this.preparedToolCalls.set(toolCall.id, {
            type: 'blocked',
            reason: doomOutcome.reason,
            output: {
              type: 'function_call_output',
              id: `output_${toolCall.id}`,
              callId: toolCall.id,
              output: JSON.stringify({
                error: doomOutcome.reason,
              }),
            },
          });
          blockedCalls.push(toolCall);
          continue;
        }
      }
      unseenCalls.push(toolCall);
    }
    return {
      unseenCalls,
      blockedCalls,
    };
  }

  private async resolveApprovalPhases(
    needsApproval: ParsedToolCall<TTools[number]>[],
    autoExecute: ParsedToolCall<TTools[number]>[],
    turnContext: TurnContext,
    responseKey: string,
    occurrences: Map<ParsedToolCall<Tool>, string>,
  ): Promise<{
    denied: {
      tc: ParsedToolCall<TTools[number]>;
      reason: string;
    }[];
    stillPending: ParsedToolCall<TTools[number]>[];
    initialSurvivors: ParsedToolCall<Tool>[];
  }> {
    const denied: {
      tc: ParsedToolCall<TTools[number]>;
      reason: string;
    }[] = [];
    const stillPending: ParsedToolCall<TTools[number]>[] = [];

    if (this.hooksManager) {
      for (const tc of needsApproval) {
        const { decision, reason } = await this.emitPermissionRequest(tc as ParsedToolCall<Tool>);
        if (decision === 'deny') {
          denied.push({
            tc,
            reason: reason ?? 'Denied by PermissionRequest hook',
          });
        } else if (decision !== 'allow') {
          stillPending.push(tc);
        }
      }
    } else {
      stillPending.push(...needsApproval);
    }

    const initialSurvivors = [
      ...autoExecute,
      ...needsApproval.filter(
        (tc) =>
          !stillPending.some((pending) => pending.id === tc.id) &&
          !denied.some((entry) => entry.tc.id === tc.id),
      ),
    ] as ParsedToolCall<Tool>[];
    for (const toolCall of initialSurvivors) {
      const tool = this.options.tools?.find(
        (candidate) => isClientTool(candidate) && candidate.function.name === toolCall.name,
      );
      if (!tool || !isAutoResolvableTool(tool)) {
        continue;
      }
      if (
        (await this.prepareAfterInitialApproval(
          toolCall,
          turnContext,
          responseKey,
          occurrences.get(toolCall) ?? '',
        )) === 'pending'
      ) {
        const prepared = this.preparedToolCalls.get(toolCall.id);
        if (prepared?.type === 'ready') {
          stillPending.push(prepared.toolCall as ParsedToolCall<TTools[number]>);
        }
      }
    }
    return {
      denied,
      stillPending,
      initialSurvivors,
    };
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
    suppliedToolCalls: ParsedToolCall<Tool>[],
    currentRound: number,
    currentResponse: models.OpenResponsesResult,
  ): Promise<boolean> {
    if (!this.options.tools) {
      return false;
    }

    const turnContext: TurnContext = {
      numberOfTurns: currentRound,
    };
    const responseKey = this.approvalResponseKey(currentResponse);
    // Always enumerate the complete response so subset visits find the original
    // response-local occurrence and appended calls receive fresh identities.
    const responseToolCalls = extractToolCallsFromResponse(currentResponse);
    const toolCalls = responseToolCalls.length > 0 ? responseToolCalls : suppliedToolCalls;
    const occurrences = this.assignApprovalCallOccurrences(currentResponse, toolCalls);

    const { unseenCalls, blockedCalls } = await this.classifyInitialApprovalCalls(
      toolCalls,
      responseKey,
      occurrences,
    );

    if (unseenCalls.length === 0 && blockedCalls.length === 0) {
      return false;
    }

    const { requiresApproval: needsApproval, autoExecute } = await partitionToolCalls(
      unseenCalls as ParsedToolCall<TTools[number]>[],
      this.options.tools,
      turnContext,
      this.requireApprovalFn ?? undefined,
    );

    const { denied, stillPending, initialSurvivors } = await this.resolveApprovalPhases(
      needsApproval,
      autoExecute,
      turnContext,
      responseKey,
      occurrences,
    );

    if (stillPending.length === 0) {
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
    const pendingIds = new Set(stillPending.map((call) => call.id));
    const executableNow = [
      ...initialSurvivors.filter((call) => !pendingIds.has(call.id)),
      ...blockedCalls,
    ];
    const unsentResults = await this.executeAutoApproveTools(
      executableNow as ParsedToolCall<TTools[number]>[],
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
        pendingToolCalls: stillPending.map((toolCall) => ({
          ...toolCall,
          ...(this.preparedToolCalls.has(toolCall.id) && {
            preToolUseApplied: true as const,
          }),
        })),
        status: 'awaiting_approval',
      };
    if (combinedResults.length > 0) {
      stateUpdates.unsentToolResults = combinedResults;
    }
    await this.saveStateSafely(stateUpdates);

    this.preparedToolCalls.clear();
    this.hookDeniedCalls.clear();
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

    // Queued steer guidance is NOT injected here: the paused calls are
    // dangling function_calls, and a user message between a function_call
    // and its eventual output is invalid history. saveStateSafely persists
    // the queue (doomLoop.pendingSteer); the resumed run delivers it at its
    // next safe flush point.

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

    // Steer queue persists via saveStateSafely (see persistHitlPause).

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
   * Persist state when one or more deferred tools (`tool.deferred`) started
   * durable external tasks this round. The placeholder outputs are already
   * persisted (the round is fully paired), so — unlike HITL/manual pauses —
   * nothing dangles; the pause exists purely because the model's next turn
   * should wait for the real results.
   *
   * Mirrors `persistHitlPause` in shape. Status `awaiting_async_tools` is
   * distinct from `awaiting_client_tools`: the tool DID execute; only its
   * result is pending. Resumption happens via the deferred tool's
   * `.resolve()` / `.fail()` / `.cancel()` or `resumeToolResults()`.
   */
  private async persistAsyncToolPause(
    currentResponse: models.OpenResponsesResult,
    deferredTasks: PendingAsyncTool[],
  ): Promise<void> {
    this.finalResponse = currentResponse;

    if (!this.stateAccessor) {
      return;
    }

    const existing = (this.currentState?.pendingAsyncTools ?? []).filter(
      (t) => !deferredTasks.some((d) => d.callId === t.callId),
    );
    await this.saveStateSafely({
      pendingAsyncTools: [
        ...existing,
        ...deferredTasks,
      ],
      status: 'awaiting_async_tools',
    });
  }

  /**
   * Harvest background tasks that settled since the last flush and inject
   * their outcomes into the conversation as `tool_task_result` envelope
   * messages (user role). Runs at the same safe point as
   * `flushDoomLoopSteer()` — after a fully-paired round, before the next
   * request — because injecting between a dangling `function_call` and its
   * future output would be invalid history.
   *
   * A delivery is forward progress: the text-repetition streak is reset so a
   * model saying "still waiting…" between deliveries is not condemned.
   */
  private async flushAsyncToolDeliveries(): Promise<boolean> {
    const registry = this.asyncToolRegistry;
    if (!registry) {
      return false;
    }
    const settled = registry.takeSettled();
    if (settled.length === 0) {
      return false;
    }

    const envelopes: string[] = [];
    for (const task of settled) {
      this.broadcastAsyncSettled(task, 'injected');
      // Emit the canonical tool.result event with the FINAL value so
      // consumers watching only tool.result see real results exactly once.
      if (task.status === 'completed') {
        this.broadcastToolResult(
          task.callId,
          String(task.name),
          this.toolSourceByName(String(task.name)),
          task.result as InferToolOutputsUnion<TTools>,
        );
        const tool = this.options.tools?.find(
          (candidate) => isClientTool(candidate) && candidate.function.name === task.name,
        );
        if (tool && task.input !== undefined) {
          this.dispatchUiFragment({
            toolCall: {
              id: task.callId,
              name: task.name,
              arguments: task.input,
            } as ParsedToolCall<Tool>,
            tool,
            result: {
              result: task.result,
            },
          });
        }
      }
      // PostToolUse/PostToolUseFailure fire at SETTLEMENT for async tools —
      // the observation-only audit surface (secret scanning, output review)
      // must cover long-running results, which are exactly the ones that
      // arrive from external processes.
      await this.emitAsyncSettledHooks(task);
      envelopes.push(
        JSON.stringify({
          type: 'tool_task_result',
          tool: task.name,
          taskId: task.taskId,
          callId: task.callId,
          status: task.status,
          ...(task.result !== undefined && {
            result: task.result,
          }),
          ...(task.error !== undefined && {
            error: task.error,
          }),
        }),
      );
      // Record settlement for the at-most-once guard. The pending entry is
      // KEPT with its terminal status (not removed) — same policy as
      // resumeToolResults — so a late external resolution by taskId OR
      // callId resolves to ToolTaskAlreadySettledError, never "not found".
      if (this.currentState) {
        const terminalStatus =
          task.status === 'completed' || task.status === 'cancelled' ? task.status : 'failed';
        this.currentState = updateState(this.currentState, {
          settledAsyncCallIds: [
            ...(this.currentState.settledAsyncCallIds ?? []),
            task.callId,
          ],
          ...(this.currentState.pendingAsyncTools !== undefined && {
            pendingAsyncTools: this.currentState.pendingAsyncTools.map((t) =>
              t.callId === task.callId
                ? {
                    ...t,
                    status: terminalStatus,
                  }
                : t,
            ),
          }),
        });
      }
    }

    // Instruction boundary: the injected message rides the user role (the
    // only channel that can deliver a late result without a duplicate
    // function_call_output), but its content is tool output — mark it so
    // attacker-influenced result text does not read as user instructions.
    await this.injectAppendPromptMessage(`${TASK_RESULT_BOUNDARY}\n${envelopes.join('\n')}`);

    // Delivery is observable forward progress — clear the text streak so
    // legitimate "waiting" phrasing between deliveries can't accumulate
    // into a doom-loop stop.
    this.doomLoopMonitor?.resetTextStreak();
    return true;
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
        type: 'async';
        toolCall: ParsedToolCall<Tool>;
        tool: Tool;
        invocation: AsyncToolInvocation;
        controller: AbortController;
        timeoutMs: number | undefined;
        runBinding: RunBinding;
      }
    | {
        type: 'execution';
        toolCall: ParsedToolCall<Tool>;
        tool: Tool;
        result: {
          result: unknown;
          error?: Error;
        };
      }
  > {
    // Universal task-tool dispatch: ONE static tool ("task") handles every
    // check/steer/result/cancel interaction with running tasks, addressed
    // by taskId — the wire surface stays constant regardless of how many
    // async tools are registered, while the handling stays tool-resident
    // (the owning tool's `check` config). Engine-intercepted: bypasses
    // gates, deadlines, and Pre/PostToolUse hooks (engine bookkeeping, not
    // user work) and never reaches the doom-loop checkpoint. A
    // PermissionRequest denial recorded for the call IS honored — cancel
    // is destructive and steer reshapes a running task, so a policy layer
    // that vetoed the call wins over the interception.
    if (toolCall.name === TASK_TOOL_NAME && this.taskToolActive()) {
      return this.consumeHookDenial(toolCall.id) ?? this.answerTaskToolCall(toolCall);
    }

    const tool = this.options.tools?.find(
      (t) => isClientTool(t) && t.function.name === toolCall.name,
    );
    if (!tool || !isAutoResolvableTool(tool)) {
      return null;
    }

    // PermissionRequest hook denied this call without pausing: synthesize a
    // rejection instead of executing. Consume the entry so a later round
    // with a reused id is not affected.
    const hookDenied = this.consumeHookDenial(toolCall.id);
    if (hookDenied !== null) {
      return hookDenied;
    }

    const hasBroadcaster = this.toolEventBroadcaster || this.turnBroadcaster;
    const onPreliminaryResult = hasBroadcaster
      ? (callId: string, resultValue: unknown) => {
          this.broadcastPreliminaryResult(
            callId,
            String(toolCall.name),
            resultValue as InferToolEventsUnion<TTools>,
          );
        }
      : undefined;

    // Compose the per-call abort signal (run signal + tool/run timeout +
    // per-call controller) and acquire the concurrency gates in fixed order
    // (round gate first, then per-tool gate — fixed ordering is what makes
    // multi-gate acquisition deadlock-free). Gate WAITING happens before the
    // timeout race below, so queue wait counts against the deadline only
    // for background tasks (which carry their own timeout in the registry).
    //
    // Background lifecycles skip the per-tool gate HERE: their body only
    // runs later via runBackgroundWork, which acquires that gate for the
    // body's true duration. Acquiring it on the round path too would let
    // detached bodies holding all maxConcurrency slots block a later
    // round's dispatch (thunk creation, no body work) for the full task
    // duration — while it holds a round-gate slot, head-of-line-blocking
    // every other call in the round.
    const { controller, signal, timeoutMs } = this.composeToolSignal(
      String(toolCall.name),
      toolCall.id,
    );
    const isBackgroundLifecycle = isUnifiedTool(tool) && tool.function.lifecycle === 'background';
    const releaseGates = await acquireAll([
      this.roundGate ?? undefined,
      isBackgroundLifecycle ? undefined : this.perToolGate(String(toolCall.name)),
    ]);

    try {
      // Run the tool through the full Pre/Post lifecycle hooks. The helper
      // fails closed on a JSON-parse failure in toolCall.arguments so hooks
      // never see a malformed payload; the caller handles that case via the
      // shared `parse_error` / `hook_blocked` branch.
      //
      // The whole hooked execution is raced against the tool deadline: on
      // timeout the round stops waiting (the model gets a `tool_timeout`
      // error output) and the body's signal is aborted. The abandoned body
      // keeps running detached; awaiting it would reintroduce the hang
      // run-cancellation (DEV-658) fixed.
      // Unified-run affordances. The ToolTask is created later (when the
      // call escapes the round in handleAsyncInvocation), so the log sink
      // and inbox registration go through a mutable slot the task binds to
      // on creation; entries logged before that are buffered.
      const runBinding = this.createRunBinding(toolCall.id);

      const executionPromise = this.runToolWithHooks(
        tool,
        toolCall,
        turnContext,
        onPreliminaryResult,
        {
          signal,
          callId: toolCall.id,
          ...(this.currentState?.id !== undefined && {
            conversationId: this.currentState.id,
          }),
          client: this.options.client,
          runExtras: buildRunExtras(tool, runBinding),
        },
      );

      const executed = await this.raceToolDeadline(
        executionPromise,
        String(toolCall.name),
        timeoutMs,
        controller,
      );

      if (executed === 'timeout') {
        return this.buildToolTimeoutOutcome(toolCall, tool, timeoutMs);
      }

      if (executed.type === 'parse_error') {
        this.broadcastToolResult(
          toolCall.id,
          String(toolCall.name),
          isMcpTool(tool) ? 'mcp' : 'client',
          {
            error: executed.errorMessage,
          } as InferToolOutputsUnion<TTools>,
        );
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

      if (isAsyncToolInvocation(result)) {
        // Background/deferred: the round's aggregation loop turns this into
        // a placeholder output (and, for background, tracks the work in the
        // registry). The per-call controller stays alive with the task.
        return {
          type: 'async' as const,
          toolCall: executed.effectiveToolCall,
          tool,
          invocation: result,
          controller,
          timeoutMs,
          runBinding,
        };
      }

      return {
        type: 'execution' as const,
        toolCall: executed.effectiveToolCall,
        tool,
        result,
      };
    } finally {
      releaseGates();
      // The inflight map only tracks round-synchronous executions; async
      // background tasks hand their controller to the registry, which owns
      // teardown from here (cancelTask / abortAll).
      this.inflightToolControllers.delete(toolCall.id);
    }
  }

  /**
   * The `tool_timeout` execution outcome for a call whose deadline fired:
   * the model receives an error output immediately (the abandoned body
   * keeps running detached).
   */
  private buildToolTimeoutOutcome(
    toolCall: ParsedToolCall<Tool>,
    tool: Tool,
    timeoutMs: number | undefined,
  ): {
    type: 'execution';
    toolCall: ParsedToolCall<Tool>;
    tool: Tool;
    result: {
      result: unknown;
      error?: Error;
    };
  } {
    const message = `Tool "${toolCall.name}" timed out after ${timeoutMs}ms`;
    this.broadcastToolResult(
      toolCall.id,
      String(toolCall.name),
      isMcpTool(tool) ? 'mcp' : 'client',
      {
        error: message,
      } as InferToolOutputsUnion<TTools>,
    );
    return {
      type: 'execution' as const,
      toolCall,
      tool,
      result: {
        result: null,
        error: Object.assign(new Error(message), {
          code: 'tool_timeout',
        }),
      },
    };
  }

  /**
   * PermissionRequest-hook denial for a call, as a `hook_blocked` outcome —
   * or null when the call was not denied. Consumes the entry so a later
   * round with a reused id is not affected.
   */
  private consumeHookDenial(callId: string): {
    type: 'hook_blocked';
    output: models.FunctionCallOutputItem;
  } | null {
    const denialReason = this.hookDeniedCalls.get(callId);
    if (denialReason === undefined) {
      return null;
    }
    this.hookDeniedCalls.delete(callId);
    return {
      type: 'hook_blocked' as const,
      output: {
        type: 'function_call_output' as const,
        id: `output_${callId}`,
        callId,
        output: JSON.stringify({
          error: denialReason,
        }),
      },
    };
  }

  /**
   * Race a tool execution against its deadline. Returns `'timeout'` when the
   * deadline fires first — the caller synthesizes the `tool_timeout` output —
   * and aborts the body's controller so cooperative tools stop working. The
   * timer is cleared on settle either way.
   */
  private raceToolDeadline<T>(
    execution: Promise<T>,
    toolName: string,
    timeoutMs: number | undefined,
    controller: AbortController,
  ): Promise<T | 'timeout'> {
    if (timeoutMs === undefined || timeoutMs <= 0) {
      return execution;
    }
    return new Promise<T | 'timeout'>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort(new Error(`Tool "${toolName}" timed out after ${timeoutMs}ms`));
        resolve('timeout');
      }, timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
        timer.unref();
      }
      execution.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async executeToolRound(
    toolCalls: ParsedToolCall<Tool>[],
    turnContext: TurnContext,
  ): Promise<{
    toolResults: models.FunctionCallOutputItem[];
    pausedCalls: ParsedToolCall<Tool>[];
    deferredTasks: PendingAsyncTool[];
  }> {
    const toolCallPromises = toolCalls.map((toolCall) =>
      this.executeSingleToolCall(toolCall, turnContext),
    );

    const settledResults = await Promise.allSettled(toolCallPromises);
    const toolResults: models.FunctionCallOutputItem[] = [];
    const pausedCalls: ParsedToolCall<Tool>[] = [];
    const deferredTasks: PendingAsyncTool[] = [];

    // Start ALL async invocations before consuming any outcome: the work
    // (and its grace window) begins in handleAsyncInvocation, so awaiting
    // it inside the ordered loop below would serialize background calls.
    const asyncOutcomes = new Map<
      number,
      Promise<{
        output: models.FunctionCallOutputItem;
        deferredTask?: PendingAsyncTool;
      }>
    >();
    for (let i = 0; i < settledResults.length; i++) {
      const settled = settledResults[i];
      if (settled?.status === 'fulfilled' && settled.value?.type === 'async') {
        asyncOutcomes.set(i, this.handleAsyncInvocation(settled.value));
      }
    }

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
          String(originalToolCall.name),
          this.toolSourceByName(String(originalToolCall.name)),
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

      if (value.type === 'async') {
        // Background / deferred: the call escapes the round. Its handling
        // (grace-window race, registry tracking, placeholder synthesis)
        // was started above in parallel with the round's other async
        // calls; awaiting here keeps outputs in call order.
        const asyncOutcome = await (asyncOutcomes.get(i) ?? this.handleAsyncInvocation(value));
        toolResults.push(asyncOutcome.output);
        this.turnBroadcaster?.push({
          type: 'tool.call_output' as const,
          output: asyncOutcome.output,
          timestamp: Date.now(),
        } satisfies ToolCallOutputEvent);
        if (asyncOutcome.deferredTask) {
          deferredTasks.push(asyncOutcome.deferredTask);
        }
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
        String(value.toolCall.name),
        isMcpTool(value.tool) ? 'mcp' : 'client',
        toolResult,
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

      this.dispatchUiFragment(value);
    }

    return {
      toolResults,
      pausedCalls,
      deferredTasks,
    };
  }

  /**
   * Handle one async invocation from a round.
   *
   * Background: start the work under the background pool, race it against
   * the grace window — settle in time and the call yields a plain
   * synchronous output (no async machinery visible); otherwise emit the
   * pending placeholder and let the registry track the task.
   *
   * Deferred: emit the placeholder and report the task for the pause path.
   */
  private async handleAsyncInvocation(value: {
    toolCall: ParsedToolCall<Tool>;
    tool: Tool;
    invocation: AsyncToolInvocation;
    controller: AbortController;
    timeoutMs: number | undefined;
    runBinding: RunBinding;
  }): Promise<{
    output: models.FunctionCallOutputItem;
    deferredTask?: PendingAsyncTool;
  }> {
    const { toolCall, tool, invocation, controller, runBinding } = value;
    const registry = this.ensureAsyncToolRegistry();
    const source = isMcpTool(tool) ? 'mcp' : 'client';
    const logLimits = isUnifiedTool(tool) ? tool.function.logLimits : undefined;

    if (invocation.asyncMode === 'defer') {
      const collision = this.rejectDuplicateTaskId(toolCall, invocation.taskId, source);
      if (collision) {
        return collision;
      }
      const input = (toolCall.arguments ?? {}) as Record<string, unknown>;
      const liveTask = registry.trackDeferred({
        callId: toolCall.id,
        taskId: invocation.taskId,
        name: String(toolCall.name),
        input,
        ...(invocation.expiresAt !== undefined && {
          expiresAt: invocation.expiresAt,
        }),
        ...(invocation.pollAfterMs !== undefined && {
          pollAfterMs: invocation.pollAfterMs,
        }),
      });
      runBinding.bind(liveTask);
      const task: PendingAsyncTool = {
        callId: toolCall.id,
        taskId: invocation.taskId,
        name: String(toolCall.name),
        mode: 'defer',
        status: 'working',
        startedAt: liveTask.startedAt,
        input,
        ...(invocation.pollAfterMs !== undefined && {
          pollAfterMs: invocation.pollAfterMs,
        }),
        ...(invocation.expiresAt !== undefined && {
          expiresAt: invocation.expiresAt,
        }),
      };
      this.broadcastAsyncStarted(toolCall, 'defer', invocation.taskId, invocation.ack);
      return {
        output: this.buildPendingPlaceholder(
          toolCall,
          invocation.taskId,
          invocation.ack,
          invocation.pollAfterMs,
        ),
        deferredTask: task,
      };
    }

    // Background: start the work under the background pool. The pool slot is
    // held for the duration of the work (queue wait counts against the
    // task's own timeout tracked by the registry).
    const taskId = registry.generateTaskId();
    const liveTask = new ToolTask({
      taskId,
      callId: toolCall.id,
      toolName: String(toolCall.name),
      mode: isAgentTool(tool) ? 'agent' : 'background',
      controller,
      ...(logLimits !== undefined && {
        limits: logLimits,
      }),
      // Carried so PostToolUse/PostToolUseFailure can fire at settlement
      // with the same payload shape as round-synchronous executions.
      input: (toolCall.arguments ?? {}) as Record<string, unknown>,
    });
    runBinding.bind(liveTask);
    // Visible to steering / cancel / snapshots from the start — a large
    // graceMs must not create a window where the running task cannot be
    // reached (sendToTask queues into the inbox; cancelTask aborts the
    // controller, which the grace race observes as an error settlement).
    registry.register(liveTask);
    const work = this.runBackgroundWork(String(toolCall.name), invocation.run, controller);
    // Surface unhandled rejections nowhere — the registry's .then() below
    // (or the grace race) is the sole consumer.
    work.catch(() => undefined);

    // Grace window: work settling in time yields a plain synchronous output.
    const graceMs = invocation.graceMs;
    if (graceMs > 0) {
      // The timer is cleared when the work settles first (same discipline
      // as raceToolDeadline) — it's unref'd, but a leaked timer is still a
      // leaked timer.
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        work.then(
          (result) => ({
            outcome: 'ok' as const,
            result,
          }),
          (error: unknown) => ({
            outcome: 'error' as const,
            error,
          }),
        ),
        new Promise<'pending'>((resolve) => {
          graceTimer = setTimeout(() => resolve('pending'), graceMs);
          if (
            typeof graceTimer === 'object' &&
            'unref' in graceTimer &&
            typeof graceTimer.unref === 'function'
          ) {
            graceTimer.unref();
          }
        }),
      ]);
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }

      if (settled !== 'pending') {
        // Settled in-window: behave exactly like a regular tool. The call
        // yields a synchronous output, so the task leaves the registry —
        // including any settlement a racing cancelTask queued for it (the
        // sync output already reports the outcome; an envelope on top
        // would be a double delivery).
        registry.untrack(toolCall.id);
        if (settled.outcome === 'ok') {
          this.broadcastToolResult(
            toolCall.id,
            String(toolCall.name),
            source,
            settled.result as InferToolOutputsUnion<TTools>,
          );
          const settledValue = {
            toolCall,
            tool,
            result: {
              result: settled.result,
            },
          };
          const outputForModel = await this.computeToolOutputForModel(settledValue);
          this.dispatchUiFragment(settledValue);
          return {
            output: {
              type: 'function_call_output' as const,
              id: `output_${toolCall.id}`,
              callId: toolCall.id,
              output: outputForModel,
            },
          };
        }
        const message =
          settled.error instanceof Error ? settled.error.message : String(settled.error);
        this.broadcastToolResult(toolCall.id, String(toolCall.name), source, {
          error: message,
        } as InferToolOutputsUnion<TTools>);
        return {
          output: {
            type: 'function_call_output' as const,
            id: `output_${toolCall.id}`,
            callId: toolCall.id,
            output: JSON.stringify({
              error: message,
            }),
          },
        };
      }
    }

    // Outlived the grace window: placeholder now, deliver later. The
    // registry owns the timeout from here (the per-call deadline raced in
    // executeSingleToolCall only bounds the ROUND's wait; a background task
    // gets its full budget).
    registry.trackBackground(
      liveTask,
      work,
      value.timeoutMs !== undefined
        ? {
            timeoutMs: value.timeoutMs,
          }
        : undefined,
    );
    this.broadcastAsyncStarted(toolCall, liveTask.mode, taskId, invocation.ack);
    return {
      output: this.buildPendingPlaceholder(toolCall, taskId, invocation.ack),
    };
  }

  /**
   * Reject a `ctx.defer()` taskId already claimed by ANOTHER pending task.
   * Task ids are the resolution key (resumeToolResults matches on them), so
   * a duplicate would make one of the two calls unresolvable — the
   * conversation would wait forever. Caller-supplied ids
   * (`ctx.defer(ticket.id)`) carry no uniqueness guarantee; reject the
   * collision at start time, when the tool can still see it.
   * @returns the error output for the colliding call, or null when unique.
   */
  private rejectDuplicateTaskId(
    toolCall: ParsedToolCall<Tool>,
    taskId: string,
    source: 'mcp' | 'client',
  ): {
    output: models.FunctionCallOutputItem;
  } | null {
    const duplicate =
      this.asyncToolRegistry?.getTask(taskId) ??
      this.currentState?.pendingAsyncTools?.find((t) => t.taskId === taskId);
    if (!duplicate || duplicate.callId === toolCall.id) {
      return null;
    }
    const message = `Tool "${toolCall.name}": ctx.defer() taskId "${taskId}" is already in use by another pending task in this conversation (call ${duplicate.callId}). Task ids must be unique per conversation — include a per-call component (e.g. the ticket id plus your callId).`;
    this.broadcastToolResult(toolCall.id, String(toolCall.name), source, {
      error: message,
    } as InferToolOutputsUnion<TTools>);
    return {
      output: {
        type: 'function_call_output' as const,
        id: `output_${toolCall.id}`,
        callId: toolCall.id,
        output: JSON.stringify({
          error: message,
        }),
      },
    };
  }

  /**
   * A mutable binding between a tool call's run context and its (created
   * later) ToolTask. `ctx.log()` entries before the task exists are
   * buffered; `ctx.onMessage()` registrations are forwarded on bind.
   */
  private createRunBinding(_callId: string): RunBinding {
    let task: ToolTask | null = null;
    const bufferedLogs: unknown[] = [];
    let pendingHandler: ((message: unknown) => void) | null = null;
    let pendingTranscriptSource: ToolTask['transcriptSource'] | null = null;
    return {
      log: (entry: unknown) => {
        if (task) {
          task.appendLog(entry, typeof entry === 'string' ? 'text' : 'event');
        } else {
          bufferedLogs.push(entry);
        }
      },
      onMessage: (handler: (message: unknown) => void) => {
        if (task) {
          task.onMessage(handler);
        } else {
          pendingHandler = handler;
        }
      },
      setTranscriptSource: (source: NonNullable<ToolTask['transcriptSource']>) => {
        if (task) {
          task.transcriptSource = source;
        } else {
          pendingTranscriptSource = source;
        }
      },
      bind: (bound: ToolTask) => {
        task = bound;
        for (const entry of bufferedLogs) {
          bound.appendLog(entry, typeof entry === 'string' ? 'text' : 'event');
        }
        bufferedLogs.length = 0;
        if (pendingHandler) {
          bound.onMessage(pendingHandler);
          pendingHandler = null;
        }
        if (pendingTranscriptSource) {
          bound.transcriptSource = pendingTranscriptSource;
          pendingTranscriptSource = null;
        }
      },
      task: () => task,
    };
  }

  /**
   * Run a background tool's work under the tool's own concurrency gate AND
   * the background pool. The round path does not touch the per-tool gate
   * for background lifecycles (the thunk had not run yet), so the gate is
   * acquired here for the body's lifetime — `maxConcurrency` bounds
   * executions of the BODY, wherever they run.
   *
   * Acquisition order: per-tool gate FIRST, then the pool. The narrow gate
   * is where a saturated tool's excess calls queue — queuing them on the
   * shared pool instead would let 16 waiters on one maxConcurrency:2 tool
   * hold every global slot while only two bodies run, starving every other
   * background tool. Order is deadlock-safe: only background bodies take
   * the per-tool gate (the round path skips it for them), and every body
   * acquires in this same fixed order.
   *
   * Queue wait counts against the task's own timeout (tracked by the
   * registry); an abort observed before the slots free up short-circuits
   * without running the body.
   */
  private async runBackgroundWork(
    toolName: string,
    run: () => Promise<unknown>,
    controller: AbortController,
  ): Promise<unknown> {
    const gate = this.perToolGate(toolName);
    const releaseGate = gate ? await gate.acquire() : undefined;
    const pool = this.backgroundPool;
    const releasePool = pool ? await pool.acquire() : undefined;
    try {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error(String(controller.signal.reason ?? 'aborted'));
      }
      return await run();
    } finally {
      releasePool?.();
      releaseGate?.();
    }
  }

  /** Broadcast a `tool.async_started` event on the turn broadcaster. */
  private broadcastAsyncStarted(
    toolCall: ParsedToolCall<Tool>,
    mode: ToolTaskMode,
    taskId: string,
    ack?: unknown,
  ): void {
    this.turnBroadcaster?.push({
      type: 'tool.async_started' as const,
      toolCallId: toolCall.id,
      toolName: String(toolCall.name),
      taskId,
      mode,
      ...(ack !== undefined && {
        ack,
      }),
      timestamp: Date.now(),
    } satisfies ToolAsyncStartedEvent);
  }

  /** Broadcast a `tool.async_settled` event on the turn broadcaster. */
  private broadcastAsyncSettled(
    settled: SettledToolTask,
    delivery: 'injected' | 'pending_resume' | 'dropped',
  ): void {
    this.turnBroadcaster?.push({
      type: 'tool.async_settled' as const,
      toolCallId: settled.callId,
      taskId: settled.taskId,
      status: settled.status,
      ...(settled.result !== undefined && {
        result: settled.result as InferToolOutputsUnion<TTools>,
      }),
      ...(settled.error !== undefined && {
        error: settled.error,
      }),
      delivery,
      timestamp: Date.now(),
    } satisfies ToolAsyncSettledEvent<InferToolOutputsUnion<TTools>>);
  }

  /**
   * Build the pending placeholder `function_call_output` for an async tool
   * call. Pairs the `function_call` immediately (providers 400 on unpaired
   * calls in follow-up history); the real result arrives later as a
   * `tool_task_result` envelope. The note steers the model: with check-ins
   * enabled it points at the universal `task` tool; with check-ins
   * disabled it forbids re-calling entirely.
   */
  private buildPendingPlaceholder(
    toolCall: ParsedToolCall<Tool>,
    taskId: string,
    ack?: unknown,
    pollAfterMs?: number,
  ): models.FunctionCallOutputItem {
    const checkinsEnabled = this.options.asyncTools?.checkins !== false;
    const payload: Record<string, unknown> = {
      status: 'pending',
      taskId,
      ...(pollAfterMs !== undefined && {
        pollAfterMs,
      }),
      ...(checkinsEnabled && {
        check: true,
      }),
    };
    const directive = checkinsEnabled
      ? `The result will be delivered to you automatically when ready. To check progress, steer, or cancel, call the task tool with { "taskId": "${taskId}" }. Keep working on other steps meanwhile.`
      : 'The result will be delivered to you automatically when ready — do not call this tool again to check on it.';
    if (typeof ack === 'string') {
      payload['note'] = `${ack} ${directive}`;
    } else {
      if (ack !== undefined && typeof ack === 'object') {
        Object.assign(payload, ack);
      }
      payload['note'] = `Started. ${directive}`;
    }
    return {
      type: 'function_call_output' as const,
      id: `output_${toolCall.id}`,
      callId: toolCall.id,
      output: JSON.stringify(payload),
    };
  }

  /**
   * True when the built-in task tool is active for this run. Mirrors
   * `needsTaskTool` exactly: when a user tool claims the reserved name the
   * built-in is not registered, so calls named "task" must NOT be
   * intercepted — they belong to the user's tool.
   */
  private taskToolActive(): boolean {
    if (this.options.asyncTools?.checkins === false) {
      return false;
    }
    const tools = this.options.tools ?? [];
    if (hasTaskToolNameCollision(tools)) {
      return false;
    }
    return tools.some((t) => isLongRunningTool(t));
  }

  /**
   * Answer a call to the universal `task` tool: resolve the taskId to its
   * live registry task (or persisted pendingAsyncTools entry, post-restart)
   * and its OWNING tool, then dispatch by action:
   *
   * - `check` (default): the owning tool's `check.execute` when declared
   *   (custom `params` validated against `check.schema`), else the SDK
   *   default status / logs / transcript views.
   * - `steer`: deliver `message` to the run body's inbox.
   * - `result`: the final result if settled, else the status view.
   * - `cancel`: cancel the task.
   */
  private async answerTaskToolCall(toolCall: ParsedToolCall<Tool>): Promise<{
    type: 'execution';
    toolCall: ParsedToolCall<Tool>;
    tool: Tool;
    result: {
      result: unknown;
      error?: Error;
    };
  }> {
    const taskTool = buildTaskToolStub();
    const answer = (result: unknown, error?: Error) => {
      if (error === undefined) {
        this.broadcastToolResult(
          toolCall.id,
          String(toolCall.name),
          'client',
          result as InferToolOutputsUnion<TTools>,
        );
      }
      return {
        type: 'execution' as const,
        toolCall,
        tool: taskTool,
        result: error
          ? {
              result: null,
              error,
            }
          : {
              result,
            },
      };
    };

    let input: TaskToolInput;
    try {
      input = validateToolInput(TaskToolInputSchema, toolCall.arguments ?? {}) as TaskToolInput;
    } catch (error) {
      return answer(null, error instanceof Error ? error : new Error(String(error)));
    }

    const liveTask = this.asyncToolRegistry?.getTask(input.taskId);
    const persisted = this.currentState?.pendingAsyncTools?.find((t) => t.taskId === input.taskId);
    if (!liveTask && !persisted) {
      return answer({
        error: 'unknown_task',
        taskId: input.taskId,
        hint: 'No task with this id exists in this conversation. It may belong to another conversation, or its record was dropped.',
      });
    }

    try {
      switch (input.action ?? 'check') {
        case 'cancel':
          return answer(this.taskToolCancel(input, liveTask));
        case 'steer':
          return answer(...this.taskToolSteer(input, liveTask));
        case 'result': {
          const settled = taskToolResultIfSettled(input, liveTask);
          if (settled !== null) {
            return answer(settled);
          }
          // Not settled: fall through to the status view.
          return answer(await this.taskToolCheck(input, liveTask, persisted as PendingAsyncTool));
        }
        default:
          return answer(await this.taskToolCheck(input, liveTask, persisted as PendingAsyncTool));
      }
    } catch (error) {
      return answer(null, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** `task` tool, action=cancel. */
  private taskToolCancel(input: TaskToolInput, liveTask: ToolTask | undefined): unknown {
    const cancelled = liveTask
      ? (this.asyncToolRegistry?.cancelTask(input.taskId, input.reason) ?? false)
      : false;
    return cancelled
      ? {
          taskId: input.taskId,
          status: 'cancelled',
        }
      : {
          taskId: input.taskId,
          error: 'not_cancellable',
          hint: liveTask
            ? 'The task has already settled.'
            : 'This task is owned by an external system — cancel it there (or via the tool’s .cancel() method).',
        };
  }

  /** `task` tool, action=steer. Returns [result, error?] for `answer`. */
  private taskToolSteer(
    input: TaskToolInput,
    liveTask: ToolTask | undefined,
  ): [
    unknown,
    Error?,
  ] {
    if (typeof input.message !== 'string' || input.message.length === 0) {
      return [
        null,
        new Error("action 'steer' requires a non-empty `message`"),
      ];
    }
    if (!liveTask || liveTask.mode === 'defer') {
      return [
        {
          taskId: input.taskId,
          error: 'not_steerable',
          hint: 'This task runs in an external system — steer it there.',
        },
      ];
    }
    liveTask.send(input.message);
    return [
      {
        taskId: input.taskId,
        steered: true,
      },
    ];
  }

  /**
   * `task` tool, action=check (and the status-view fallback for `result`
   * on an unsettled task): the owning tool's `check.execute` when
   * declared, else the SDK default views — live-task-backed when the task
   * is in this process, persisted-state-backed post-restart.
   */
  private async taskToolCheck(
    input: TaskToolInput,
    liveTask: ToolTask | undefined,
    persisted: PendingAsyncTool,
  ): Promise<unknown> {
    const owningToolName = liveTask?.toolName ?? persisted?.name ?? '';
    const owningTool = this.options.tools?.find(
      (t) => isClientTool(t) && t.function.name === owningToolName,
    );
    const config = owningTool && isUnifiedTool(owningTool) ? owningTool.function.check : undefined;
    const { schema, execute } = resolveCheckConfig(config);
    const maxTranscriptChars = this.options.asyncTools?.maxTranscriptChars ?? 20_000;

    // Custom params for the owning tool's handler are validated against
    // its check.schema when both are present.
    let customParams: Record<string, unknown> = input.params ?? {};
    if (schema && input.params !== undefined) {
      customParams = validateToolInput(schema, input.params) as Record<string, unknown>;
    }

    if (liveTask) {
      const handle = this.buildTaskHandle(liveTask, maxTranscriptChars);
      const checkTurnContext: TurnContext = {
        numberOfTurns: this.allToolExecutionRounds.length + 1,
        toolCallStatus: liveTask.status,
        accumulatedYieldedEvents: liveTask.accumulatedYieldedEvents,
        task: handle,
      };
      return execute
        ? await Promise.resolve(execute(customParams, checkTurnContext))
        : defaultCheckResult(
            {
              view: input.view,
              tail: input.tail,
            },
            checkTurnContext,
            {
              maxTranscriptChars,
            },
          );
    }

    // Cross-process / post-restart: only persisted status survives. A
    // custom check.execute still runs, with a state-backed context (no
    // live task handle — `turnContext.task` is absent here). Handlers
    // written against `task.statusView()` with optional chaining return
    // undefined in this situation; fall back to the persisted status view
    // rather than answering the model with nothing.
    const checkTurnContext: TurnContext = {
      numberOfTurns: this.allToolExecutionRounds.length + 1,
      toolCallStatus: persisted.status,
      accumulatedYieldedEvents: persisted.lastLog
        ? [
            persisted.lastLog.text,
          ]
        : [],
    };
    const customResult = execute
      ? await Promise.resolve(execute(customParams, checkTurnContext))
      : undefined;
    return (
      customResult ??
      persistedTaskCheckResult(
        {
          view: input.view,
        },
        persisted,
      )
    );
  }

  /** Build the narrow ToolTaskHandle façade for check.execute handlers. */
  private buildTaskHandle(task: ToolTask, maxTranscriptChars: number) {
    const registry = this.asyncToolRegistry;
    return {
      taskId: task.taskId,
      toolName: task.toolName,
      mode: task.mode,
      status: () => task.status,
      statusView: () => task.toStatusView() as Record<string, unknown>,
      tailLogs: (n: number) => task.tailLogs(n),
      transcript: (maxChars?: number) => task.renderTranscript(maxChars ?? maxTranscriptChars),
      send: (message: unknown) => task.send(message),
      cancel: (reason?: string) => registry?.cancelTask(task.taskId, reason) ?? false,
    };
  }

  /** @internal Queue externally resumed tool results for the UI lifecycle. */
  queueUiToolResults(
    results: Array<{
      callId: string;
      name: string;
      input: Record<string, unknown>;
      output: unknown;
    }>,
  ): void {
    this.queuedUiToolResults.push(...results);
  }

  private dispatchQueuedUiToolResults(): void {
    const queued = this.queuedUiToolResults;
    this.queuedUiToolResults = [];
    for (const result of queued) {
      const tool = this.options.tools?.find(
        (candidate) => isClientTool(candidate) && candidate.function.name === result.name,
      );
      if (tool) {
        this.dispatchUiFragment({
          toolCall: {
            id: result.callId,
            name: result.name,
            arguments: result.input,
          } as ParsedToolCall<Tool>,
          tool,
          result: {
            result: result.output,
          },
        });
      }
    }
  }

  private dispatchUiFragment(value: {
    toolCall: ParsedToolCall<Tool>;
    tool: Tool;
    result: {
      result: unknown;
      error?: Error;
    };
  }): void {
    if (!this.uiBroadcaster?.activeConsumerCount) {
      return;
    }
    const rendering = this.broadcastUiFragment(value);
    this.pendingUiFragments.add(rendering);
    rendering.finally(() => this.pendingUiFragments.delete(rendering));
  }

  private async drainUiFragments(): Promise<void> {
    if (this.pendingUiFragments.size === 0) {
      return;
    }
    const timeoutMs = DEFAULT_UI_DRAIN_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    });
    try {
      while (this.pendingUiFragments.size > 0) {
        const pending = [
          ...this.pendingUiFragments,
        ];
        try {
          const timedOut = await Promise.race([
            Promise.all(pending).then(() => false),
            deadline,
          ]);
          if (timedOut) {
            this.pendingUiFragments.clear();
            return;
          }
        } finally {
          for (const rendering of pending) {
            this.pendingUiFragments.delete(rendering);
          }
        }
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Compute and broadcast a tool-authored OpenUI fragment for a successful
   * execution. Render-only: the fragment never reaches the model, so a
   * throwing `toUiOutput` degrades to "no fragment" instead of failing the
   * round — the model-facing output has already been pushed.
   */
  private async broadcastUiFragment(value: {
    toolCall: ParsedToolCall<Tool>;
    tool: Tool;
    result: {
      result: unknown;
      error?: Error;
    };
  }): Promise<void> {
    if (
      value.result.error ||
      !isAutoResolvableTool(value.tool) ||
      !value.tool.function.toUiOutput
    ) {
      return;
    }
    const rawArgs: unknown = value.toolCall.arguments;
    if (!isRecord(rawArgs)) {
      return;
    }
    try {
      const fragment = await value.tool.function.toUiOutput({
        output: value.result.result,
        input: rawArgs,
      });
      if (!fragment) {
        return;
      }
      if (!this.uiBroadcaster?.activeConsumerCount) {
        return;
      }
      this.uiBroadcaster.push({
        type: 'tool.ui_fragment' as const,
        toolCallId: value.toolCall.id,
        toolName: value.toolCall.name,
        fragment: {
          dialect: fragment.dialect,
          source: fragment.source,
        },
        timestamp: Date.now(),
      } satisfies ToolUiFragmentEvent);
    } catch (error) {
      // Fragment construction failed — drop it; rendering is best-effort. But
      // surface the cause, or a throwing toUiOutput is undebuggable ("no
      // fragment ever arrives", with nothing in the console).
      console.warn(
        `toUiOutput for tool "${value.toolCall.name}" (call ${value.toolCall.id}) threw; dropping UI fragment:`,
        error,
      );
    }
  }

  /**
   * Resolve async functions for the current turn.
   * Updates the resolved request with turn-specific parameter values.
   *
   * @param turnContext - The turn context for parameter resolution
   */
  private async resolveAsyncFunctionsForTurn(turnContext: TurnContext): Promise<void> {
    if (hasAsyncFunctions(this.options.request)) {
      const resolved = await this.resolveRequestForContext(turnContext);
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

    if (Object.keys(computedParams).length === 0) {
      return;
    }

    const nextRequest = applyNextTurnParamsToRequest(this.resolvedRequest, computedParams);

    /*
     * A tool-computed `toolChoice` becomes the new caller-level policy, not a
     * one-turn override. Merging it onto the request alone is not enough:
     * `makeFollowupRequest` re-derives the wire choice from
     * `configuredToolChoice` via `applyForcedToolChoicePolicy`, which would
     * discard the tool's value before dispatch. Re-running the resolved-policy
     * bookkeeping re-stamps the configured choice and its forced-choice
     * consumption key together, so relaxation stays consistent for later turns.
     */
    this.resolvedRequest =
      'toolChoice' in computedParams
        ? this.applyResolvedForcedToolChoicePolicy(nextRequest)
        : nextRequest;
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

    // Update resolvedRequest.input with accumulated conversation for next turn.
    this.resolvedRequest = {
      ...this.resolvedRequest,
      input: newInput,
    };

    // A forced tool choice (`required` or a specific tool) has served its
    // purpose once a tool round has executed; keeping it on follow-up turns
    // would forbid the model from ever answering in text, looping it through
    // tool calls until the step budget runs out (DEV-785). Relax it to `auto`
    // so the model can either call another tool or synthesize its answer.
    this.resolvedRequest = this.applyForcedToolChoicePolicy(this.resolvedRequest);

    // Escalation recovery: one-turn overrides (model swap / forced advisor
    // consult) applied to THIS dispatch only — `resolvedRequest` above keeps
    // the configured model/tools, so the next turn reverts automatically.
    const escalationOverrides = this.takeDoomLoopEscalationOverrides();
    const newRequest: models.ResponsesRequest = {
      ...this.resolvedRequest,
      ...(escalationOverrides ?? {}),
      stream: true,
    };

    this.beginToolChoiceDispatch(newRequest.toolChoice);
    const startedAt = performance.now();
    const newResult = await betaResponsesSend(
      this.options.client,
      {
        responsesRequest: newRequest,
      },
      this.dispatchRequestOptions(),
    );

    if (!newResult.ok) {
      throw newResult.error;
    }

    const response = await this.materializeResponse(newResult.value, turnNumber);
    this.commitToolChoiceDispatch(responseHasToolCalls(response));
    await this.emitPostModelCall(response, startedAt, 'tool_round', turnNumber);
    return response;
  }

  /**
   * Append a response's output items to the accumulated request input,
   * exactly as `makeFollowupRequest` does before adding tool results. Used
   * by the end-of-run drain, where envelope messages must land AFTER the
   * final assistant output in the request.
   */
  private accumulateResponseIntoInput(response: models.OpenResponsesResult): void {
    if (!this.resolvedRequest) {
      return;
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
    this.resolvedRequest = {
      ...this.resolvedRequest,
      input: [
        ...normalizedOriginalInput,
        ...(Array.isArray(response.output)
          ? response.output
          : [
              response.output,
            ]),
      ],
    };
  }

  /**
   * End-of-run handling for async background tasks still in flight (or
   * settled but unharvested) when the loop is about to finalize.
   *
   * - `'drain'` (default): wait for tasks (bounded by `drainTimeoutMs`),
   *   inject their results, and give the model up to `maxDrainTurns` extra
   *   `toolChoice: 'none'` turns so the final answer incorporates them.
   * - `'detach'`: return immediately; still-working tasks are marked
   *   `orphaned` on persisted state and their eventual results are dropped.
   * - `'cancel'`: abort in-flight tasks and finish.
   *
   * @returns the (possibly replaced) final response.
   */
  private async handleRunEndAsyncTasks(
    currentResponse: models.OpenResponsesResult,
  ): Promise<models.OpenResponsesResult> {
    const registry = this.asyncToolRegistry;
    if (!registry || (!registry.hasInFlight() && !registry.hasUnharvestedSettled())) {
      return currentResponse;
    }

    const config = this.options.asyncTools;
    const mode = config?.onRunEnd ?? 'drain';

    if (mode === 'cancel') {
      registry.abortAll('Run ended (onRunEnd: cancel)');
      await this.dropSettledTasks();
      return currentResponse;
    }

    if (mode === 'detach') {
      await this.detachWorkingTasks();
      return currentResponse;
    }

    // 'drain': deliver late results and let the model incorporate them.
    // Drain turns use the retry path (toolChoice forced to 'none' when tools
    // are present) so a drain turn cannot open a fresh tool round — it
    // exists purely to fold the delivered results into the final answer.
    // ONE deadline spans the whole drain phase: drainTimeoutMs bounds total
    // WAITING (documented contract), not per-turn waiting — maxDrainTurns
    // bounds the extra model turns, not the wait.
    const drainTimeoutMs = config?.drainTimeoutMs ?? 30_000;
    const maxDrainTurns = config?.maxDrainTurns ?? 2;
    const drainDeadline = Date.now() + drainTimeoutMs;
    let response = currentResponse;

    for (let drainTurn = 0; drainTurn < maxDrainTurns; drainTurn++) {
      if (!registry.hasUnharvestedSettled() && registry.hasInFlight()) {
        const remaining = drainDeadline - Date.now();
        if (remaining <= 0) {
          break;
        }
        await registry.drain(remaining);
      }
      // Accumulate the current final output BEFORE injecting so the
      // envelope lands after the assistant's last message in the request.
      this.accumulateResponseIntoInput(response);
      // Queued steering (queueUserMessage / sendToTask) flushes here too —
      // a drain turn is a model dispatch, and guidance queued while the
      // last tool round was already finishing would otherwise be dropped.
      await this.flushDoomLoopSteer();
      const delivered = await this.flushAsyncToolDeliveries();
      if (!delivered) {
        // Drain timed out with nothing new settled — stop waiting.
        break;
      }

      const turnNumber = this.allToolExecutionRounds.length + 1 + drainTurn;
      response = await this.retryCurrentRequest(turnNumber);
      await this.saveResponseToState(response);

      if (!registry.hasInFlight() && !registry.hasUnharvestedSettled()) {
        break;
      }
    }

    // Drain budget exhausted with work still in flight: cut it loose.
    if (registry.hasInFlight()) {
      registry.abortAll('Async tool drain budget exhausted at run end');
      await this.dropSettledTasks();
    }

    return response;
  }

  /**
   * Broadcast every unharvested settlement as dropped (no in-run delivery),
   * mirror the terminal status onto persisted `pendingAsyncTools`, and
   * append a terminal `tool_task_result` envelope to persisted history.
   *
   * The status mirror prevents a stuck resume: an entry persisted as
   * `working` for a task that only ever settles in-memory (abortAll at
   * drain exhaustion / run cancel) would pin a later cross-process resume
   * to `awaiting_async_tools` forever. The envelope keeps the pending
   * placeholder's "the result will be delivered" promise honest for
   * PERSISTED conversations: the run is over (no more model dispatch), but
   * the terminal outcome rides along on the next `callModel({ state })`
   * instead of vanishing.
   */
  private async dropSettledTasks(): Promise<void> {
    const registry = this.asyncToolRegistry;
    if (!registry) {
      return;
    }
    const settled = registry.takeSettled();
    for (const task of settled) {
      this.broadcastAsyncSettled(task, 'dropped');
    }
    if (settled.length === 0 || !this.stateAccessor || !this.currentState) {
      return;
    }
    const terminalByCallId = new Map(
      settled.map((t) => [
        t.callId,
        t.status === 'completed' || t.status === 'cancelled' ? t.status : ('failed' as const),
      ]),
    );
    const envelopes = settled.map((t) =>
      JSON.stringify({
        type: 'tool_task_result',
        tool: t.name,
        taskId: t.taskId,
        callId: t.callId,
        status: t.status,
        ...(t.result !== undefined && {
          result: t.result,
        }),
        ...(t.error !== undefined && {
          error: t.error,
        }),
      }),
    );
    await this.saveStateSafely({
      messages: appendToMessages(this.currentState.messages, [
        {
          role: 'user',
          content: `${TASK_RESULT_BOUNDARY}\n${envelopes.join('\n')}`,
        } as models.BaseInputsUnion,
      ]),
      ...(this.currentState.pendingAsyncTools?.length && {
        pendingAsyncTools: this.currentState.pendingAsyncTools.map((entry) => {
          const terminal = terminalByCallId.get(entry.callId);
          return terminal !== undefined
            ? {
                ...entry,
                status: terminal,
              }
            : entry;
        }),
      }),
    });
  }

  /**
   * `onRunEnd: 'detach'`: mark still-working tasks orphaned on persisted
   * state (their eventual results are dropped) and drop unharvested
   * settlements.
   */
  private async detachWorkingTasks(): Promise<void> {
    const registry = this.asyncToolRegistry;
    if (!registry) {
      return;
    }
    const orphaned = registry.markWorkingAsOrphaned();
    await this.dropSettledTasks();
    if (orphaned.length > 0 && this.stateAccessor && this.currentState) {
      const existing = (this.currentState.pendingAsyncTools ?? []).filter(
        (t) => !orphaned.some((o) => o.callId === t.callId),
      );
      await this.saveStateSafely({
        pendingAsyncTools: [
          ...existing,
          ...orphaned,
        ],
      });
    }
  }

  /**
   * Make a final no-tool-calls request to coerce a text response after the
   * loop was halted by `stopWhen` mid-tool-call. Reuses the resolved request
   * so `instructions`, `model`, and other API fields ride along unchanged.
   * `tools` stays in the request with `toolChoice: 'none'` — forbidding
   * calls while keeping the prompt-cache prefix intact (stripping the tools
   * block would bust the cache). The caller is expected to have already
   * executed the pending tool calls and to pass their outputs in
   * `toolOutputs` so every function_call in the input has a matching output.
   */
  private async makeFinalResponseRequest(
    currentResponse: models.OpenResponsesResult,
    toolOutputs: models.FunctionCallOutputItem[],
    allowFinalResponse: boolean | string | undefined,
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

    // Default-on (`undefined`) and bare `true` get the built-in directive;
    // a non-empty string overrides the wording; `''` appends nothing
    // (explicit opt-out).
    const finalDirective =
      allowFinalResponse === true || allowFinalResponse === undefined
        ? DEFAULT_FINAL_RESPONSE_DIRECTIVE
        : allowFinalResponse;

    const newInput: models.InputsUnion = [
      ...normalizedOriginalInput,
      ...(Array.isArray(currentResponse.output)
        ? currentResponse.output
        : [
            currentResponse.output,
          ]),
      ...toolOutputs,
      ...(typeof finalDirective === 'string' && finalDirective.length > 0
        ? [
            {
              role: 'user' as const,
              content: finalDirective,
            },
          ]
        : []),
    ];

    const finalRequest: models.ResponsesRequest = {
      ...this.resolvedRequest,
      // Forbid tool calls without dropping the tools block: removing
      // `tools` would invalidate the prompt-cache prefix.
      ...(this.resolvedRequest.tools !== undefined && {
        toolChoice: 'none' as const,
      }),
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
      this.dispatchRequestOptions(),
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
   * Message prefixes (`Invalid final response: missing required fields`,
   * `Invalid final response: empty or invalid output`) are load-bearing —
   * callers and tests match on them. Detail is appended after an em dash;
   * never reword the prefixes.
   *
   * The detail exists because the bare "empty or invalid output" message was
   * routinely misread as "the model returned a tool call and validation
   * rejected it" (issue #45). It does not: this is a pure array-length check,
   * so a `function_call`-only output passes. Naming the actual defect —
   * empty array vs. wrong type — stops that misdiagnosis at the error string.
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
      const missing: string[] = [];
      if (!response?.id) {
        missing.push('id');
      }
      if (!response?.output) {
        missing.push('output');
      }
      throw new Error(`Invalid final response: missing required fields: ${missing.join(', ')}`);
    }
    if (!Array.isArray(response.output) || response.output.length === 0) {
      if (allowEmptyOutput) {
        return;
      }
      const detail = Array.isArray(response.output)
        ? `output array is empty (length 0) for response "${response.id}". The model returned no output items. This can happen when the provider returns an empty final turn; see the strictFinalResponse/allowFinalResponse options`
        : `output is not an array (got ${describeNonRecord(response.output)}) for response "${response.id}"`;
      throw new Error(`Invalid final response: empty or invalid output — ${detail}`);
    }
  }

  /**
   * Re-send the current resolved request (same accumulated input) once.
   * Used when a follow-up after tool execution returned an empty `output`.
   *
   * `toolChoice` is forced to `'none'` when tools are present (mirroring
   * `makeFinalResponseRequest`) so the retry coerces a text turn: on the
   * natural-loop-completion path the resolved request still carries tools,
   * and a retry that emitted a fresh `function_call` would pass
   * `validateFinalResponse` but never be executed — silently dropping a
   * proposed tool call. Tools stay in the request to keep the prompt-cache
   * prefix intact.
   */
  private async retryCurrentRequest(turnNumber: number): Promise<models.OpenResponsesResult> {
    if (!this.resolvedRequest) {
      throw new Error('Request not initialized');
    }

    const newRequest: models.ResponsesRequest = {
      ...this.resolvedRequest,
      ...(this.resolvedRequest.tools !== undefined && {
        toolChoice: 'none' as const,
      }),
      stream: true,
    };

    const startedAt = performance.now();
    const newResult = await betaResponsesSend(
      this.options.client,
      {
        responsesRequest: newRequest,
      },
      this.dispatchRequestOptions(),
    );

    if (!newResult.ok) {
      throw newResult.error;
    }

    const response = await this.materializeResponse(newResult.value, turnNumber);
    await this.emitPostModelCall(response, startedAt, 'retry', turnNumber);
    return response;
  }

  /**
   * Build the RequestOptions for one API dispatch, composing the run-level
   * cancellation signal (`options.signal`) with the caller's RequestOptions.
   *
   * The SDK only auto-wires `timeoutMs` into an abort signal when NO signal
   * is present on the options — a supplied signal silently disables the
   * timeout. Composing here keeps both: each request is bounded by
   * whichever of {run signal, caller signal, per-request timeout} fires
   * first. MUST be called once per dispatch — `AbortSignal.timeout()`
   * starts counting at creation, so a cached composite would burn its
   * budget across turns instead of per request.
   *
   * Also the per-request fail-fast checkpoint: an already-aborted run
   * signal throws its abort reason here, before any network I/O.
   */
  private dispatchRequestOptions(): RequestOptions | undefined {
    const base = this.options.options;
    const runSignal = this.options.signal;
    if (!runSignal) {
      return base;
    }
    runSignal.throwIfAborted();

    const signals: AbortSignal[] = [
      runSignal,
    ];
    const callerSignal = base?.signal ?? base?.fetchOptions?.signal;
    if (callerSignal) {
      signals.push(callerSignal);
    }
    // Re-create the timeout the SDK would have wired had no signal been
    // present. Per-request option wins over the client-level default,
    // mirroring betaResponsesSend's own precedence.
    const timeoutMs = base?.timeoutMs ?? this.options.client._options.timeoutMs;
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      signals.push(AbortSignal.timeout(timeoutMs));
    }
    return {
      ...base,
      signal: signals.length === 1 ? runSignal : AbortSignal.any(signals),
    };
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
      const resolved = await resolveAsyncFunctions(this.options.request, context);
      return this.applyResolvedForcedToolChoicePolicy(resolved);
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
      doomLoop: _dl,
      streamReplay: _sr,
      signal: _sig,
      toolTimeoutMs: _ttm,
      toolConcurrency: _tc,
      asyncTools: _at,
      activeTools: _activeTools,
      ...rest
    } = this.options.request;
    const resolved: Record<PropertyKey, unknown> = {
      ...rest,
    };
    stripToolSetSnapshotMetadata(resolved);
    return this.applyResolvedForcedToolChoicePolicy(resolved as ResolvedCallModelInput);
  }

  /**
   * Record the freshly-resolved caller choice before deriving its wire value.
   * An unforced turn clears the consumed key, re-arming the same forced value
   * if it appears again later. A different forced key re-arms immediately.
   */
  private applyResolvedForcedToolChoicePolicy<
    TRequest extends {
      toolChoice?: models.ResponsesRequest['toolChoice'];
    },
  >(request: TRequest): TRequest {
    this.configuredToolChoice = request.toolChoice;
    this.configuredForcedToolChoiceKey = forcedToolChoiceKey(request.toolChoice);

    if (this.configuredForcedToolChoiceKey === null) {
      this.preparedToolChoiceCommit =
        this.activeConsumedForcedToolChoiceKey === null
          ? null
          : {
              type: 'clear',
            };
    } else {
      this.preparedToolChoiceCommit =
        this.configuredForcedToolChoiceKey === this.activeConsumedForcedToolChoiceKey
          ? null
          : {
              type: 'consume',
              key: this.configuredForcedToolChoiceKey,
            };
    }

    return this.applyForcedToolChoicePolicy(request);
  }

  /**
   * Derive the caller-configured tool choice for the active logical run.
   * Engine-owned one-turn overrides (`none` for finalization, or a pinned
   * doom-loop advisor) are applied after this helper and therefore still win.
   */
  private applyForcedToolChoicePolicy<
    TRequest extends {
      toolChoice?: models.ResponsesRequest['toolChoice'];
    },
  >(request: TRequest): TRequest {
    const toolChoice =
      this.configuredForcedToolChoiceKey !== null &&
      this.configuredForcedToolChoiceKey === this.activeConsumedForcedToolChoiceKey
        ? relaxForcedToolChoice(this.configuredToolChoice)
        : this.configuredToolChoice;
    this.preparedEffectiveToolChoice = toolChoice;
    return toolChoice === request.toolChoice
      ? request
      : {
          ...request,
          toolChoice,
        };
  }

  /**
   * Bind the prepared caller-policy transition to the actual wire request.
   * Engine-owned overrides (for example a forced advisor consult) deliberately
   * produce a different semantic key and therefore cannot commit caller state.
   */
  private beginToolChoiceDispatch(actualToolChoice: models.ResponsesRequest['toolChoice']): void {
    this.dispatchedCallerToolChoice =
      canonicalizeKeyMaterial(actualToolChoice ?? null) ===
      canonicalizeKeyMaterial(this.preparedEffectiveToolChoice ?? null);
    this.dispatchedToolChoiceCommit = this.dispatchedCallerToolChoice
      ? this.preparedToolChoiceCommit
      : null;
  }

  /**
   * Commit only after the prepared caller choice reached the wire and a
   * response was materialized. A pause before dispatch leaves persisted state
   * untouched; a forced choice is consumed only when that response called a
   * tool.
   */
  private commitToolChoiceDispatch(hasToolCalls: boolean): void {
    const callerChoiceDispatched = this.dispatchedCallerToolChoice;
    const commit = this.dispatchedToolChoiceCommit;
    this.dispatchedCallerToolChoice = false;
    this.dispatchedToolChoiceCommit = null;

    if (!callerChoiceDispatched) {
      return;
    }

    this.preparedToolChoiceCommit = null;
    if (commit?.type === 'clear') {
      this.activeConsumedForcedToolChoiceKey = null;
    } else if (commit?.type === 'consume' && hasToolCalls) {
      this.activeConsumedForcedToolChoiceKey = commit.key;
    }
  }

  /** Clear all runtime and persisted policy state for a terminal run exit. */
  private resetForcedToolChoicePolicy(): void {
    this.activeConsumedForcedToolChoiceKey = null;
    this.configuredForcedToolChoiceKey = null;
    this.configuredToolChoice = undefined;
    this.preparedEffectiveToolChoice = undefined;
    this.preparedToolChoiceCommit = null;
    this.dispatchedToolChoiceCommit = null;
    this.dispatchedCallerToolChoice = false;
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

    // Persist only the consumed semantic key, never the callback or a copied
    // effective toolChoice. Dynamic values are re-resolved on every turn.
    if (this.activeConsumedForcedToolChoiceKey !== null) {
      this.currentState = {
        ...this.currentState,
        consumedForcedToolChoiceKey: this.activeConsumedForcedToolChoiceKey,
      };
    } else if (this.currentState.consumedForcedToolChoiceKey !== undefined) {
      const nextState = {
        ...this.currentState,
      };
      delete nextState.consumedForcedToolChoiceKey;
      this.currentState = nextState;
    }

    // Piggyback the doom-loop detector snapshot on every persist so loop
    // memory survives serialize → resume (a resumed doom loop is still a
    // doom loop — provided the resuming call passes `doomLoop` again).
    // Plain bounded JSON; absent when detection is off. The engine-owned
    // fields ride along: `stopVerdict` keeps a condemned run condemned
    // across decision-only resumes; `pendingSteer` carries queued guidance
    // that had no flush opportunity before a pause.
    if (this.doomLoopMonitor) {
      const doomLoopState: DoomLoopSerializedState = {
        ...this.doomLoopMonitor.getState(),
        ...(this.doomLoopStop !== null && {
          stopVerdict: this.doomLoopStop,
        }),
        ...(this.pendingDoomLoopSteer.length > 0 && {
          pendingSteer: [
            ...this.pendingDoomLoopSteer,
          ],
        }),
      };
      this.currentState = {
        ...this.currentState,
        doomLoop: doomLoopState,
      };
    }

    // Mirror each live task's lastLog onto its persisted pendingAsyncTools
    // entry (bounded ~200 chars) — the one piece of progress that survives
    // a restart, surfaced by post-restart check calls. Debounced naturally:
    // this runs only when state is being saved anyway, never per log entry.
    if (this.asyncToolRegistry && this.currentState.pendingAsyncTools?.length) {
      const registry = this.asyncToolRegistry;
      this.currentState = {
        ...this.currentState,
        pendingAsyncTools: this.currentState.pendingAsyncTools.map((entry) => {
          const live = registry.findByCallId(entry.callId);
          const lastLog = live?.lastLog;
          if (!lastLog) {
            return entry;
          }
          const text =
            typeof lastLog.data === 'string'
              ? lastLog.data
              : (JSON.stringify(lastLog.data) ?? String(lastLog.data));
          return {
            ...entry,
            lastLog: {
              at: lastLog.at,
              text: text.length > 200 ? `${text.slice(0, 200)}…` : text,
            },
          };
        }),
      };
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
    props: Array<
      | 'pendingToolCalls'
      | 'unsentToolResults'
      | 'interruptedBy'
      | 'partialResponse'
      | 'pendingAsyncTools'
    >,
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
          this.activeConsumedForcedToolChoiceKey = loadedState.consumedForcedToolChoiceKey ?? null;

          // Rehydrate doom-loop state so a resumed run continues where it
          // left off: streak counters always; the queued steer guidance;
          // and the stop verdict under the condemnation rule below.
          if (this.doomLoopMonitor && loadedState.doomLoop !== undefined) {
            this.doomLoopMonitor.restore(loadedState.doomLoop);
            const persisted = loadedState.doomLoop;
            if (Array.isArray(persisted.pendingSteer)) {
              for (const message of persisted.pendingSteer) {
                if (typeof message === 'string') {
                  this.queueDoomLoopSteer(message);
                }
              }
            }
            // Condemnation rule: a doom-stopped conversation STAYS stopped
            // across decision-only resumes (approveToolCalls /
            // rejectToolCalls — approving a call is not new conversation).
            // A fresh conversational turn (a plain callModel on the same
            // state, no decisions) clears the verdict: operator input is
            // new information. Streaks are kept either way, so renewed
            // repetition re-condemns quickly.
            if (persisted.stopVerdict) {
              const isDecisionResume =
                this.approvedToolCalls.length > 0 || this.rejectedToolCalls.length > 0;
              if (isDecisionResume) {
                this.doomLoopStop = persisted.stopVerdict;
              }
            }
          }

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
          // that request failed. `awaiting_async_tools` resumes the same way:
          // the pending-task bookkeeping was already updated by
          // resumeToolResults (or remains pending for tasks not yet resolved),
          // and the placeholder outputs are in history, so a fresh request is
          // valid.
          this.resumingFromClientTools = loadedState.status === 'awaiting_client_tools';
          this.resumingFromAsyncTools = loadedState.status === 'awaiting_async_tools';
        } else {
          this.currentState = createInitialState<TTools>();
        }

        if (!this.resumingFromClientTools && !this.resumingFromAsyncTools) {
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
      this.beginToolChoiceDispatch(request.toolChoice);
      const apiResult = await betaResponsesSend(
        this.options.client,
        {
          responsesRequest: request,
        },
        this.dispatchRequestOptions(),
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
        this.setReusableStream(apiResult.value);
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

    // Calls that pause again after PreToolUse mutation remain pending without
    // re-running the hook on the next resume.
    const secondGatePausedIds = new Set<string>();
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

      if (toolCall.preToolUseApplied !== true) {
        const prepared = await this.prepareAfterInitialApproval(
          toolCall as ParsedToolCall<Tool>,
          turnContext,
          `persisted:${this.currentState.previousResponseId ?? 'unknown'}`,
          callId,
        );
        if (prepared === 'pending') {
          const ready = this.preparedToolCalls.get(callId);
          if (ready?.type === 'ready') {
            Object.assign(toolCall, ready.toolCall, {
              preToolUseApplied: true as const,
            });
          }
          secondGatePausedIds.add(callId);
          continue;
        }
      }

      const hookOutcome = await this.runToolWithHooks(
        tool,
        toolCall as ParsedToolCall<Tool>,
        turnContext,
        undefined,
        undefined,
        false,
      );

      if (hookOutcome.type === 'parse_error') {
        this.broadcastToolResult(
          callId,
          String(toolCall.name),
          this.toolSourceByName(String(toolCall.name)),
          {
            error: hookOutcome.errorMessage,
          } as InferToolOutputsUnion<TTools>,
        );
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

      if (isAsyncToolInvocation(result)) {
        unsentResults.push(
          await this.settleAsyncInvocationAsUnsent(
            toolCall as ParsedToolCall<TTools[number]>,
            result,
          ),
        );
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

      const reason = 'Rejected by user';
      if (toolCall.preToolUseApplied === true) {
        await this.emitPreparedFailure(toolCall as ParsedToolCall<Tool>, reason);
      }
      this.preparedToolCalls.delete(callId);
      this.hookDeniedCalls.delete(callId);
      unsentResults.push(createRejectedResult(callId, String(toolCall.name), reason));
    }

    // Remove processed calls from pending. Approved HITL calls that paused are
    // NOT considered processed — they stay on pendingToolCalls so getPendingToolCalls()
    // still surfaces them to the caller on resume.
    const processedIds = new Set(
      [
        ...this.approvedToolCalls,
        ...this.rejectedToolCalls,
      ].filter((id) => !hitlPausedIds.has(id) && !secondGatePausedIds.has(id)),
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
    if (nextStatus === 'in_progress' && this.doomLoopStop) {
      // This approval continuation is terminal: no model request follows, so
      // a later fresh run must not inherit its consumed caller choice.
      this.resetForcedToolChoicePolicy();
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

    // If we are paused (for approval or for HITL), stop here. Queued steer
    // guidance rides doomLoop.pendingSteer in the state persisted above;
    // the resumed run delivers it at its next safe flush point (injecting a
    // user message between dangling function_calls and their future
    // outputs would be invalid history).
    if (nextStatus !== 'in_progress') {
      this.preparedToolCalls.clear();
      this.hookDeniedCalls.clear();
      return;
    }

    // A doom-stop armed while executing the approved calls (the restored
    // streak crossed the stop rung): halt WITHOUT the unsent-results model
    // request. The executed outputs are already persisted as unsent; the
    // condemned call got a blocked output. Session teardown reports the
    // doom reason via the armed verdict (see executeToolsIfNeeded).
    if (this.doomLoopStop) {
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
    this.beginToolChoiceDispatch(request.toolChoice);
    const apiResult = await betaResponsesSend(
      this.options.client,
      {
        responsesRequest: request,
      },
      this.dispatchRequestOptions(),
    );

    if (!apiResult.ok) {
      throw apiResult.error;
    }

    // Handle both streaming and non-streaming responses
    if (isEventStream(apiResult.value)) {
      this.setReusableStream(apiResult.value);
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
      let sessionEndReason: 'user' | 'error' | 'max_turns' | 'complete' | 'doom_loop' = 'complete';
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

        // A doom-stop armed while executing approved calls on resume:
        // processApprovalDecisions already skipped the unsent-results model
        // request; the executed outputs are persisted as unsent for a later
        // (fresh-input) resume. Halt here — like a pause, no stream exists.
        if (this.isResumingFromApproval && this.doomLoopStop) {
          sessionEndReason = 'doom_loop';
          this.resetForcedToolChoicePolicy();
          await this.saveStateSafely();
          return;
        }

        // Get initial response
        let currentResponse = await this.getInitialResponse();

        // toolChoice constrains model output, so a forced requirement is
        // satisfied as soon as this turn emits a tool call. Record it before
        // any approval/HITL/client/async pause can persist the run.
        const hasToolCalls = responseHasToolCalls(currentResponse);
        this.commitToolChoiceDispatch(hasToolCalls);

        // Save initial response to state
        await this.saveResponseToState(currentResponse);

        // Doom-loop text checkpoint for the initial response (within-response
        // token repetition + cross-step streak seed).
        await this.checkDoomLoopForResponse(currentResponse);

        // Check if tools should be executed
        if (!this.options.tools?.length || !hasToolCalls) {
          // A text verdict on the initial response may have armed a stop —
          // report the run as doom-stopped, not as a normal completion.
          if (this.doomLoopStop) {
            sessionEndReason = 'doom_loop';
          }
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
          // Run-level cancellation: fail the loop at the turn boundary with
          // the abort reason. In-flight requests are aborted independently
          // by the composed dispatch signal (dispatchRequestOptions); this
          // check covers cancellation between requests (during tool
          // execution or hook work).
          this.options.signal?.throwIfAborted();

          // Check for external interruption
          if (await this.checkForInterruption(currentResponse)) {
            sessionEndReason = 'user';
            return;
          }

          // A doom-loop 'stop' verdict from the previous response's text
          // halts the run before any further spend. Seal first: this break
          // fires BEFORE this response's tool calls execute, so they need
          // synthesized halt outputs or the persisted history would carry
          // dangling function_calls (providers 400 on resume).
          if (this.doomLoopStop) {
            await this.sealDoomLoopStop(currentResponse);
            sessionEndReason = 'doom_loop';
            break;
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
          const {
            toolResults,
            pausedCalls,
            deferredTasks = [],
          } = await this.executeToolRound(currentToolCalls, turnContext);

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

          // Deferred tools started durable external tasks this round: pause.
          // Unlike HITL, the round is fully paired (placeholder outputs were
          // persisted above), so the resumed conversation history is valid;
          // the pause exists so the model's next turn can incorporate the
          // real results supplied via .resolve()/resumeToolResults().
          if (deferredTasks.length > 0) {
            await this.persistAsyncToolPause(currentResponse, deferredTasks);
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

          // A doom-loop 'stop' verdict armed during this round halts the run
          // before the next model request. Seal defensively: the condemned
          // call already got a blocked error output, but a TEXT stop armed
          // by a concurrent checkpoint could leave other calls unresolved.
          // No final text-coercion request is made: the point of 'stop' is
          // to cut spend on a run that is demonstrably not progressing.
          if (this.doomLoopStop) {
            await this.sealDoomLoopStop(currentResponse, new Set(toolResults.map((r) => r.callId)));
            sessionEndReason = 'doom_loop';
            break;
          }

          // Inject any queued doom-loop steer guidance so the very next
          // request carries it. It lands in the input before this round's
          // call/output items (the injection point predates the follow-up
          // accumulation) — semantically fine, the guidance names the
          // repeated pattern explicitly.
          await this.flushDoomLoopSteer();

          // Inject any background-tool results that settled since the last
          // flush. Same safe point as the steer flush: the round is fully
          // paired, so a user-role envelope here is valid history.
          await this.flushAsyncToolDeliveries();

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

          // Doom-loop text checkpoint for the fresh response.
          await this.checkDoomLoopForResponse(currentResponse);

          currentRound++;
        }

        // If stopWhen broke the loop while the model was still emitting tool
        // calls, execute those tool calls so they have matching outputs, then
        // make one more `toolChoice: 'none'` request to coerce a final text
        // response. Default-on: `undefined`, `true`, and any string enable
        // it (`''` means "don't append a user message"); `false` opts out.
        const allowFinalResponse = this.options.allowFinalResponse;
        const finalResponseEnabled = allowFinalResponse !== false;
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

          // Gate these calls exactly like a normal round would. This path
          // executes real tools, so it needs the same approval check as the
          // in-loop call sites above — without it, `stopWhen` firing on a turn
          // that carries a `requireApproval` call would run that call
          // unguarded, and hook-based 'deny' would never fire either (the
          // deny bookkeeping lives inside handleApprovalCheck).
          //
          // On pause, handleApprovalCheck persists `pendingToolCalls` +
          // status 'awaiting_approval', executes any auto-approved calls as
          // unsent results, and sets `finalResponse` — so returning here is
          // safe: nothing executed, so there is no round to record, and we
          // must NOT fall through to markStateComplete() or the final
          // text-coercion request. `sessionEndReason` stays 'max_turns' —
          // accurate (the loop did stop on the stop condition) and consistent
          // with the HITL pause return further down this same block.
          if (await this.handleApprovalCheck(pendingToolCalls, turnNumber, currentResponse)) {
            return;
          }

          const turnContext: TurnContext = {
            numberOfTurns: turnNumber,
          };

          await this.options.onTurnStart?.(turnContext);
          await this.resolveAsyncFunctionsForTurn(turnContext);

          const {
            toolResults,
            pausedCalls,
            deferredTasks: finalDeferredTasks = [],
          } = await this.executeToolRound(pendingToolCalls, turnContext);

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
            // HITL paused — persist and exit without making the final
            // text-coercion request. The conversation will resume via the
            // normal awaiting_hitl flow.
            await this.persistHitlPause(currentResponse, pausedCalls);
            return;
          }

          if (finalDeferredTasks.length > 0) {
            // Deferred tasks started on the halted turn — persist the pause
            // and skip the final text-coercion request; the resumed run
            // produces the final answer with the real results in hand.
            await this.persistAsyncToolPause(currentResponse, finalDeferredTasks);
            return;
          }

          // A doom-stop armed while executing the halted turn's pending
          // calls: seal and skip the final text-coercion request — the
          // design contract is "no further model requests after stop".
          if (this.doomLoopStop) {
            await this.sealDoomLoopStop(currentResponse, new Set(toolResults.map((r) => r.callId)));
            sessionEndReason = 'doom_loop';
          } else {
            // Apply any nextTurnParams from the executed tools so they affect
            // the final text-coercion request (mirrors the in-loop behavior).
            await this.applyNextTurnParams(pendingToolCalls);

            // Pair any manual tool calls (no execute fn) with stub outputs so
            // every function_call in the *request* has a matching output.
            // Stubs are NOT persisted to state — only real tool outputs are —
            // so a resumed conversation doesn't see "Tool execution skipped"
            // as if it were a real result.
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
        }

        // Background tasks still in flight (or settled but undelivered) as
        // the loop finalizes: drain / detach / cancel per asyncTools config.
        currentResponse = await this.handleRunEndAsyncTasks(currentResponse);

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
        // A failing (or aborted) run must not leave tool bodies or
        // background tasks running against a dead conversation.
        this.abortAllToolWork(error instanceof Error ? error.message : String(error));
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
   *
   * Note: in a multi-round tool loop this is the **final** round's response
   * only — its `usage` block covers that one generation, not the run. For
   * aggregate totals across every model call, use `getUsage()`.
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
  getFullResponsesStream(): AsyncIterableIterator<CorrelatedResponseStreamEvent<TTools>> {
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
   *
   * This stream carries **output items only** — no usage or response-level
   * metadata. The `response.completed` events (which hold each round's usage
   * block) are not surfaced here, and `getResponse()` afterwards returns only
   * the *final* round's response, so a multi-round tool loop's `tool_calls`
   * generations are not accounted for by either. For usage, reach for:
   * - `getUsage()` — aggregate token/cost totals across every round
   * - the `PostModelCall` hook — one emit per model call, with
   *   `turnType`/`turnNumber` and that call's own `usage`
   * - `getFullResponsesStream()` — raw events including each round's
   *   `response.completed`, and therefore its per-round usage block
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
   * Stream OpenUI events from all turns: completed OpenUI Lang statements
   * authored by the model (`response.openui.*` wire events from the `openui`
   * plugin) and tool-authored fragments (`tool.ui_fragment` events produced
   * by tools declaring `toUiOutput`).
   *
   * Wire events not yet in the SDK's stream-event union arrive through its
   * forward-compat catch-all; translation reads the raw payload, so this
   * stream works both before and after the SDK regen picks them up.
   */
  getUiStream(): AsyncIterableIterator<UiStreamEvent> {
    return async function* (this: ModelResult<TTools, TShared>) {
      if (!this.options.tools?.length) {
        await this.initStreamGuarded();
        let streamFailed = false;
        try {
          if (this.reusableStream) {
            for await (const event of this.reusableStream.createConsumer()) {
              const uiEvent = translateUiEvent(event);
              if (uiEvent) {
                yield uiEvent;
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

      if (!this.uiBroadcaster) {
        this.uiBroadcaster = new ToolEventBroadcaster();
      }
      const uiBroadcaster = this.uiBroadcaster;
      const uiConsumer = uiBroadcaster.createConsumer();
      try {
        this.dispatchQueuedUiToolResults();
        await this.initStreamGuarded();
        const { consumer, executionPromise } = this.startTurnBroadcasterExecution();
        if (!this.uiBroadcasterCompletionPromise) {
          this.uiBroadcasterCompletionPromise = executionPromise.finally(async () => {
            await this.drainUiFragments();
            uiBroadcaster.complete();
          });
        }

        for await (const event of mergeAsyncIterators([
          consumer,
          uiConsumer,
        ])) {
          const uiEvent = translateUiEvent(event);
          if (uiEvent) {
            yield uiEvent;
          }
        }

        await this.uiBroadcasterCompletionPromise;
      } finally {
        await uiConsumer.return?.();
        if (uiBroadcaster.activeConsumerCount === 0) {
          this.pendingUiFragments.clear();
        }
      }
    }.call(this);
  }

  /**
   * Stream tool call argument deltas and preliminary results from all turns.
   * Preliminary results are streamed in REAL-TIME as generator tools yield.
   * - Tool call argument deltas as { type: "delta", content: string }
   * - Preliminary results as { type: "preliminary_result", toolCallId, result }
   */
  getToolStream(): AsyncIterableIterator<CorrelatedToolStreamEvent<TTools>> {
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
          const prelim = event as {
            toolCallId: string;
            toolName: string;
            result: InferToolEventsUnion<TTools>;
          };
          yield {
            type: 'preliminary_result' as const,
            toolCallId: prelim.toolCallId,
            toolName: prelim.toolName,
            result: prelim.result,
          } as CorrelatedToolStreamEvent<TTools>;
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

    const completedResponse = await this.getInitialResponse();
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
   * Cancel the underlying stream and all consumers, and abort in-flight
   * tool executions and background tasks (their `ctx.signal` fires).
   *
   * Note: prior releases only cancelled the stream; aborting tool work is
   * new with async tool support.
   */
  async cancel(): Promise<void> {
    this.abortAllToolWork('Cancelled via ModelResult.cancel()');
    if (this.reusableStream) {
      await this.reusableStream.cancel();
    }
  }

  /**
   * Snapshot of every async tool task tracked by this run (background and
   * deferred), including settled ones.
   */
  getAsyncTasks(): PendingAsyncTool[] {
    return this.asyncToolRegistry?.snapshot() ?? [];
  }

  /**
   * Cancel one in-process async task by its task id. Background tasks abort
   * their `ctx.signal`; the model receives a `status: 'cancelled'` envelope
   * at the next delivery point so it is not left waiting forever.
   *
   * For deferred tasks in a paused (possibly other-process) conversation,
   * use the deferred tool's `.cancel()` method instead.
   *
   * @returns true when a working task was found and cancelled.
   */
  cancelTask(taskId: string, reason?: string): boolean {
    return this.asyncToolRegistry?.cancelTask(taskId, reason) ?? false;
  }

  /**
   * Send a steering message to a running in-process task. Delivered to the
   * run body's `ctx.onMessage` handler (queued until one registers). Agent
   * tools (`tool.agent()`) auto-forward messages into the child
   * conversation as user messages at the child's next turn boundary.
   *
   * Throws for deferred tasks — their work runs in an external system;
   * steer it there.
   *
   * @returns true when a working task received (or queued) the message.
   */
  sendToTask(taskId: string, message: unknown): boolean {
    return this.asyncToolRegistry?.sendToTask(taskId, message) ?? false;
  }

  /**
   * Queue a user-role message for injection into this run's conversation at
   * the next safe turn boundary (the same mechanism doom-loop steer
   * guidance uses — never between a dangling `function_call` and its
   * output). The primary consumer is `tool.agent()`, which forwards
   * steering messages into child conversations through this.
   *
   * Delivery requires a next dispatch: boundaries are post-tool-round
   * follow-ups, pause-persists, and end-of-run drain turns. A message
   * queued while the run is composing its FINAL text response (no further
   * dispatch of any kind) has no boundary left and is not delivered —
   * steer while the run still has work in flight.
   */
  queueUserMessage(text: string): void {
    this.queueDoomLoopSteer(text);
  }

  // =========================================================================
  // Multi-Turn Conversation State Methods
  // =========================================================================

  /**
   * Check if the conversation requires human/client input to continue.
   * Returns true when the conversation is paused waiting on the CALLER —
   * approval/rejection (`awaiting_approval`), HITL tool resume
   * (`awaiting_hitl`), client-executed manual tools
   * (`awaiting_client_tools`), or an external async task resolution
   * (`awaiting_async_tools`, cleared via the deferred tool's `.resolve()` /
   * `.fail()` / `.cancel()` or `resumeToolResults()` — NOT via
   * `approveToolCalls`). Also returns true whenever `pendingToolCalls` is
   * populated regardless of status. To branch on the pause KIND, read
   * `(await getState()).status` instead.
   */
  async requiresApproval(): Promise<boolean> {
    await this.initStreamGuarded({
      requireStream: false,
    });

    const status = this.currentState?.status;
    if (
      status === 'awaiting_approval' ||
      status === 'awaiting_hitl' ||
      status === 'awaiting_client_tools' ||
      status === 'awaiting_async_tools'
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

  /**
   * The doom-loop verdict that stopped this run, or null when the run was
   * not stopped by doom-loop detection (including when detection is off).
   * Resolves after the tool loop settles. For per-event observation use the
   * `DoomLoopDetected` hook.
   */
  async getDoomLoopVerdict(): Promise<DoomLoopVerdict | null> {
    await this.initStreamGuarded({
      requireStream: false,
    });
    if (!this.isResumingFromApproval) {
      await this.executeToolsIfNeeded();
    }
    return this.doomLoopStop;
  }

  /**
   * Aggregate token/cost usage across **every** model call this run made —
   * the initial request, each tool-round follow-up, the empty-final retry,
   * the `allowFinalResponse` final turn, and approval-resume requests.
   *
   * This is the pull-based counterpart to the `SessionEnd.totalUsage` hook
   * payload (same `SessionUsageTotals` shape, same numbers) and exists
   * because `getResponse()` returns only the **final** round's response: in a
   * multi-round tool loop the `tool_calls` generations' tokens are otherwise
   * unreachable, and `getItemsStream()` carries output items only — no
   * `response.completed` usage block.
   *
   * Gates on run completion the same way `getResponse()` does, so totals are
   * final whether you await it directly, after `getResponse()`, or after
   * consuming any of the streaming getters — except on an approval-resumed
   * run, where reading usage never advances the tool loop: the resume
   * request's own generation is awaited and counted, but no further rounds
   * are driven, so totals can be mid-run. Await `getResponse()`/`getText()`
   * first for final totals there. On a run that paused (approval / HITL) or
   * failed, it returns the totals accrued so far — `modelCalls: 0` with
   * zeroed tokens when no model call ever completed.
   *
   * Unlike `getResponse()`, this never rejects: a failed run still consumed
   * tokens, and cost accounting typically runs in a `finally`/`catch` where a
   * second throw would mask the run's original error. Await the run itself
   * (e.g. `getResponse()`) if you need to observe the failure.
   *
   * `cost` is present only when the server reported cost accounting for at
   * least one call; a `0` would be indistinguishable from "free".
   *
   * For per-call granularity use the `PostModelCall` hook (one emit per model
   * call, with `turnType`/`turnNumber`) or `getFullResponsesStream()`, whose
   * `response.completed` events carry each round's own usage block.
   */
  async getUsage(): Promise<SessionUsageTotals> {
    try {
      await this.initStreamGuarded({
        requireStream: false,
      });
      if (!this.isResumingFromApproval) {
        await this.executeToolsIfNeeded();
      } else if (this.pendingModelCall && this.reusableStream) {
        // The resume dispatch returned a live event stream whose telemetry
        // is still parked (the non-streaming branch folds usage in
        // immediately — see continueWithUnsentResults). Consuming the
        // reusable stream is a passive observation: it buffers events
        // without executing tools or mutating conversation state, so the
        // resume generation is counted without advancing the loop.
        await this.emitPendingModelCallOnce(await this.getInitialResponse());
      }
    } catch (error) {
      // Intentionally swallowed — see the "never rejects" note above. The
      // aggregate below still reports whatever calls completed before the
      // failure; the warn leaves a diagnostic thread for the swallowed cause.
      console.warn('[getUsage] run failed; reporting totals accrued so far:', error);
    }
    return this.snapshotSessionUsage();
  }
}

/**
 * The unified-run affordances (`ctx.defer` for deferred tools, `ctx.log`,
 * `ctx.onMessage`, the transcript-source slot) threaded into a tool's run
 * context via `runExtras`.
 */
function buildRunExtras(tool: Tool, runBinding: RunBinding): Record<string, unknown> {
  return {
    ...(isUnifiedTool(tool) &&
      tool.function.lifecycle === 'deferred' && {
        defer: (taskId: string, options?: Record<string, unknown>) => ({
          __deferred: true,
          taskId,
          ...(options ?? {}),
        }),
      }),
    log: runBinding.log,
    onMessage: runBinding.onMessage,
    // Live getter through the binding — the ToolTask (and its id) is only
    // created when the call escapes the round, after this object is built.
    get taskId(): string | undefined {
      return runBinding.task()?.taskId;
    },
    // Transcript slot only — deliberately NOT `task`: TurnContext.task is
    // the ToolTaskHandle facade (check calls only) and a run body must not
    // see a transcript-only object under that name.
    taskTranscript: {
      set transcriptSource(source: NonNullable<ToolTask['transcriptSource']>) {
        runBinding.setTranscriptSource(source);
      },
      get transcriptSource(): ToolTask['transcriptSource'] {
        return runBinding.task()?.transcriptSource;
      },
    },
  };
}

/**
 * `task` tool, action=result on a SETTLED live task: the final result
 * (completed) or terminal status + error. Null when the task is not
 * settled in-process — the caller falls back to the status view.
 */
function taskToolResultIfSettled(
  input: TaskToolInput,
  liveTask: ToolTask | undefined,
): Record<string, unknown> | null {
  if (liveTask?.status === 'completed') {
    return {
      taskId: input.taskId,
      status: 'completed',
      result: liveTask.result,
    };
  }
  if (liveTask && liveTask.status !== 'working') {
    return {
      taskId: input.taskId,
      status: liveTask.status,
      ...(liveTask.error !== undefined && {
        error: liveTask.error,
      }),
    };
  }
  return null;
}
