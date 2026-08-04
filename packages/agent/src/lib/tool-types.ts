import type * as models from '@openrouter/sdk/models';
import type { StreamEvents } from '@openrouter/sdk/models';
import type { $ZodObject, $ZodShape, $ZodType, infer as zodInfer } from 'zod/v4/core';
import type { DoomLoopSerializedState } from './doom-loop.js';
import type { TaskLogLimits, ToolTaskMode, ToolTaskStatus } from './tool-task.js';

/**
 * Tool type enum for enhanced tools
 */
export enum ToolType {
  Function = 'function',
}

/**
 * Narrow façade over a running task, handed to check-in `execute` handlers
 * via `turnContext.task`. Lets a custom check read progress, steer, or
 * cancel without exposing the full registry.
 */
export interface ToolTaskHandle {
  readonly taskId: string;
  readonly toolName: string;
  readonly mode: ToolTaskMode;
  /** Current lifecycle status. */
  status(): ToolTaskStatus;
  /** The `status` check-view summary. */
  statusView(): Record<string, unknown>;
  /** Last `n` log entries (oldest first). */
  tailLogs(n: number): Array<{
    seq: number;
    at: number;
    data: unknown;
    kind: string;
  }>;
  /** Rendered transcript, truncated to `maxChars` keeping the tail. */
  transcript(maxChars?: number): string;
  /** Queue a steering message for the run body (`ctx.onMessage`). */
  send(message: unknown): void;
  /** Cancel the task. Returns true when a working task was cancelled. */
  cancel(reason?: string): boolean;
}

/**
 * Turn context passed to tool execute functions and async parameter resolution
 * Contains information about the current conversation state
 */
export interface TurnContext {
  /** The specific tool call being executed (only available during tool execution) */
  toolCall?: models.FunctionCallItem;
  /** Number of tool execution turns so far (1-indexed: first turn = 1, 0 = initial request) */
  numberOfTurns: number;
  /** The full request being sent to the API (only available during tool execution) */
  turnRequest?: models.ResponsesRequest;
  /**
   * CHECK CALLS ONLY: lifecycle status of the task the model is checking on.
   * Absent on every other path.
   */
  toolCallStatus?: ToolTaskStatus;
  /**
   * CHECK CALLS ONLY: the data of every retained yield/log from the task's
   * `run` so far, oldest first. Absent on every other path.
   */
  accumulatedYieldedEvents?: unknown[];
  /**
   * CHECK CALLS ONLY: façade over the task being checked (read progress,
   * steer via `send`, cancel). Absent on every other path.
   */
  task?: ToolTaskHandle;
}

//#region Context Types

/**
 * Extract context schema type from a tool definition.
 * Returns the inferred type of the tool's `contextSchema`, or
 * `Record<string, never>` when the tool has no (required) contextSchema.
 *
 * Note: optional `contextSchema?: ...` does not match; tools produced by
 * `tool()` only mark `contextSchema` as required when one was provided, so
 * tools without a schema keep `Record<string, never>` map slots.
 */
export type InferToolContext<T> = T extends {
  function: {
    readonly contextSchema?: infer S;
  };
}
  ? [
      S,
    ] extends [
      $ZodObject<$ZodShape>,
    ]
    ? $ZodObject<$ZodShape> extends S
      ? Record<string, never> // wide/default schema type ⇒ tool declared no context
      : zodInfer<S> extends Record<string, unknown>
        ? zodInfer<S>
        : zodInfer<S> & Record<string, unknown>
    : Record<string, never>
  : Record<string, never>;

/**
 * Resolve execute-context shape from a contextSchema generic.
 * - Wide/default `$ZodObject<$ZodShape>` (no schema provided) → `Record<string, unknown>`
 * - Concrete schema → its Zod-inferred shape
 */
export type ContextFromSchema<TCtx extends $ZodObject<$ZodShape>> =
  $ZodObject<$ZodShape> extends TCtx
    ? Record<string, unknown>
    : zodInfer<TCtx> extends Record<string, unknown>
      ? zodInfer<TCtx>
      : zodInfer<TCtx> & Record<string, unknown>;

/**
 * Extract tool name from a tool definition
 */
type InferToolName<T> = T extends {
  function: {
    name: infer N extends string;
  };
}
  ? N
  : string;

/**
 * Flat execute context passed as the second argument to tool execute functions.
 * Merges TurnContext fields with a `local` getter (own tool context) and `setContext()`.
 *
 * @template TName - The tool's literal name string
 * @template TContext - The shape of the tool's contextSchema
 * @template TShared - The shape of the sharedContextSchema
 */
export type ToolExecuteContext<
  TName extends string = string,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TShared extends Record<string, unknown> = Record<string, unknown>,
> = TurnContext & {
  /** The tool's name (type-level only, for generic inference) */
  readonly _toolName?: TName;
  /** This tool's own context (reads from the store, frozen snapshot) */
  local: Readonly<TContext>;
  /** Mutate this tool's context in the shared store (persists across turns) */
  setContext(partial: Partial<TContext>): void;
  /** Shared context visible to all tools */
  shared: Readonly<TShared>;
  /** Mutate the shared context in the store (persists across turns) */
  setSharedContext(partial: Partial<TShared>): void;
  /**
   * Abort signal for this tool call. Fires when the run is aborted
   * (`callModel`'s `signal` option or `ModelResult.cancel()`), when the
   * tool's `timeoutMs` (or the run-level `toolTimeoutMs`) elapses, or when
   * a background task is cancelled via `cancelTask`. Cooperative: tool
   * bodies should pass it to their own I/O (fetch, child processes, ...).
   * Always present — a never-aborting signal is supplied when no
   * cancellation sources exist.
   */
  readonly signal: AbortSignal;
  /** The id of the tool call being executed (for correlating external work). */
  readonly callId?: string;
  /**
   * The conversation id when a `StateAccessor` is configured. Deferred
   * tools typically hand this to the external system so its webhook can
   * locate the conversation to resume.
   */
  readonly conversationId?: string;
};

declare const DEFERRED_BRAND: unique symbol;

/**
 * Returned by `ctx.defer()`. Returning it from `run` parks the call on a
 * durable external task: the model gets a pending placeholder and the run
 * pauses (`status: 'awaiting_async_tools'`) until the task is resolved via
 * the tool's `.resolve()` / `.fail()` / `.cancel()` methods or
 * `resumeToolResults()` — possibly from another process.
 *
 * Branded with TOutput so a handle from one tool cannot be returned from
 * another whose outputSchema differs.
 *
 * Two distinct markers, deliberately:
 * - `[DEFERRED_BRAND]` is TYPE-ONLY (`declare const` — no runtime value
 *   exists) and carries the TOutput brand for compile-time safety.
 * - `__deferred` is the RUNTIME marker {@link isDeferredHandle} checks.
 *   `ctx.defer()` (the sole creator, in model-result.ts) always sets it.
 * Changing either without the other breaks deferred-handle detection —
 * keep them in sync.
 */
export interface DeferredHandle<TOutput = unknown> {
  readonly [DEFERRED_BRAND]: TOutput;
  /** Runtime marker set by `ctx.defer()`; checked by {@link isDeferredHandle}. */
  readonly __deferred: true;
  readonly taskId: string;
  readonly pollAfterMs?: number;
  readonly expiresAt?: number;
  readonly ack?: string | Record<string, unknown>;
}

/** Runtime guard for {@link DeferredHandle} (structural — brand is type-only). */
export function isDeferredHandle(value: unknown): value is DeferredHandle {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    __deferred?: unknown;
    taskId?: unknown;
  };
  return candidate.__deferred === true && typeof candidate.taskId === 'string';
}

/** Options for `ctx.defer()`. */
export type DeferOptions = {
  /** Poll-interval hint surfaced in the placeholder and to external pollers. */
  pollAfterMs?: number;
  /** Unix ms after which the task is considered expired. */
  expiresAt?: number;
  /** Model-facing note merged into the placeholder (overrides the tool-level `ack`). */
  ack?: string | Record<string, unknown>;
};

/**
 * Context passed to a unified tool's `run`. Extends the base execute
 * context with the async-task affordances: deferral, logging, and the
 * steering inbox.
 */
export type ToolRunContext<
  TName extends string = string,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown,
  TShared extends Record<string, unknown> = Record<string, unknown>,
> = ToolExecuteContext<TName, TContext, TShared> & {
  /**
   * Park this call on a durable external task and return the handle:
   * `return ctx.defer(ticket.id)`. Only valid on `lifecycle: 'deferred'`
   * tools — throws elsewhere.
   */
  defer(taskId: string, options?: DeferOptions): DeferredHandle<TOutput>;
  /**
   * Append a log entry without yielding — progress for non-generator `run`
   * bodies. Same pipeline as a yield: validated against `eventSchema` when
   * declared, appended to the task log, surfaced as `tool.preliminary_result`.
   */
  log(entry: unknown): void;
  /**
   * Register a steering handler. Messages sent via a check call's
   * `turnContext.task.send(...)` or `ModelResult.sendToTask()` are delivered
   * here (queued until registration).
   */
  onMessage(handler: (message: unknown) => void): void;
  /** The task's id (background/agent: engine-generated, present once escaped). */
  readonly taskId?: string;
};

/**
 * Context map keyed by tool name for callModel's `context` option.
 * Each key is a tool's name, each value is that tool's inferred context type.
 */
export type ToolContextMap<T extends readonly Tool[]> = {
  [K in T[number] as InferToolName<K>]: InferToolContext<K>;
};

/**
 * Context map with an optional `shared` key for shared context.
 * When TShared is provided (non-empty), a `shared` key is added to the map.
 */
export type ToolContextMapWithShared<
  T extends readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, never>,
> = ToolContextMap<T> &
  (TShared extends Record<string, never>
    ? // biome-ignore lint/complexity/noBannedTypes: empty object is intentional for conditional type
      {}
    : {
        shared: TShared;
      });

/**
 * Reserved key in the context store for shared context data.
 * The tool name 'shared' is forbidden — it's reserved for this purpose.
 */
export const SHARED_CONTEXT_KEY = 'shared' as const;

//#endregion

/**
 * Context passed to nextTurnParams functions
 * Contains current request state for parameter computation
 * Allows modification of key request parameters between turns
 */
export type NextTurnParamsContext = {
  /** Current input (messages) */
  input: models.InputsUnion;
  /** Current model selection */
  model: string;
  /** Current models array */
  models: string[];
  /** Current temperature */
  temperature: number | null;
  /** Current maxOutputTokens */
  maxOutputTokens: number | null;
  /** Current topP */
  topP: number | null;
  /** Current topK */
  topK?: number | undefined;
  /** Current instructions */
  instructions: string | null;
};

/**
 * Functions to compute next turn parameters
 * Each function receives the tool's input params and current request context
 */
export type NextTurnParamsFunctions<TInput> = {
  // Method syntax via mapped object for bivariant `params` — keeps tools
  // with concrete TInput assignable to the wide `Tool` union (see execute()).
  [K in keyof NextTurnParamsContext]?: {
    bivarianceHack(
      params: TInput,
      context: NextTurnParamsContext,
    ): NextTurnParamsContext[K] | Promise<NextTurnParamsContext[K]>;
  }['bivarianceHack'];
};

/**
 * Tool-level approval check function type
 * Receives the tool's input params and turn context
 * Returns true if approval is required, false otherwise
 */
export type ToolApprovalCheck<TInput> = {
  // Bivariant params — see NextTurnParamsFunctions.
  bivarianceHack(params: TInput, context: TurnContext): boolean | Promise<boolean>;
}['bivarianceHack'];

/**
 * Function form of {@link ToolLoopKey}: computes the key material that
 * identifies a call of this tool for doom-loop detection.
 *
 * The returned value is canonicalized (RFC 8785) and hashed by the engine —
 * tools declare *what identifies a call*, the engine owns *how it is
 * fingerprinted*. Two calls whose key material canonicalizes identically
 * count as the same call.
 *
 * - Return a focused subset for precise identity: a web-search tool returns
 *   its normalized query; a bash tool returns `{ command, cwd, env }`.
 * - Return `null` to exempt THIS call from detection (e.g. a legitimate
 *   repeat the tool can recognize from its arguments).
 * - Returning `undefined` (a bare `return;`) is treated as a bug: the
 *   engine warns and falls back to the full-arguments identity.
 *
 * Must be pure and deterministic. A throwing `loopKey` falls back to the
 * full-arguments fingerprint (detection must never take down a run).
 */
export type ToolLoopKeyFn<TInput> = {
  // Bivariant params — see NextTurnParamsFunctions.
  bivarianceHack(params: TInput): unknown;
}['bivarianceHack'];

/**
 * Doom-loop identity declaration for a tool (see the `doomLoop` option on
 * `callModel`). Computed like every other tool hook — a plain function over
 * the call's validated arguments:
 *
 * - function — computes key material per call ({@link ToolLoopKeyFn}), e.g.
 *   `({ command, cwd }) => ({ command, cwd })` for a bash tool. Returning
 *   `null` exempts individual calls (a legitimate repeat the tool can
 *   recognize from its arguments).
 * - field-name array — the declarative subset identifying a call, e.g.
 *   `['command', 'cwd']` for a bash tool. Data, not code: serializable, so
 *   it survives tool caches and can be advertised over the MCP wire.
 * - `false` — this tool is statically exempt (repetition is its job, e.g. a
 *   status poller).
 * - absent — the full validated arguments object is the identity.
 */
export type ToolLoopKey<TInput> = ToolLoopKeyFn<TInput> | readonly string[] | false;

/**
 * Content item types for tool output to model.
 * These match the Responses API format for multimodal tool outputs.
 */
export type ToolOutputContentItem =
  | {
      type: 'input_text';
      text: string;
    }
  | {
      type: 'input_image';
      detail: 'auto' | 'low' | 'high';
      imageUrl: string;
    }
  | {
      type: 'input_file';
      fileId: string;
      filename?: string;
    };

/**
 * Result of toModelOutput function.
 * The 'content' type passes value array directly as tool output.
 */
export type ToModelOutputResult = {
  type: 'content';
  value: ToolOutputContentItem[];
};

/**
 * Function to convert tool execution output to model-facing output.
 * Receives the execute result and input arguments for full context.
 * @template TInput - The tool's input type
 * @template TOutput - The tool's output type
 */
// Object-with-method form (not a bare function type) so the params position
// is checked bivariantly — concrete TInput/TOutput tools stay assignable to
// the wide `Tool` union. See the execute() members for the same pattern.
export type ToModelOutputFunction<TInput, TOutput> = {
  bivarianceHack(params: {
    output: TOutput;
    input: TInput;
  }): ToModelOutputResult | Promise<ToModelOutputResult>;
}['bivarianceHack'];

/**
 * Base tool function interface with inputSchema
 * @template TInput - Zod schema for tool input
 * @template TCtx - Zod schema for tool context (optional; default = erased wide type)
 */
export interface BaseToolFunction<
  TInput extends $ZodObject<$ZodShape>,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> {
  name: string;
  description?: string;
  inputSchema: TInput;
  /**
   * Zod schema declaring the context data this tool needs.
   * `readonly` keeps TCtx covariant so tools carrying a concrete schema stay
   * assignable to the wide `Tool` union.
   */
  readonly contextSchema?: TCtx;
  nextTurnParams?: NextTurnParamsFunctions<zodInfer<TInput>>;
  /**
   * Whether this tool requires human approval before execution
   * Can be a boolean or an async function that receives the tool's input params and context
   */
  requireApproval?: boolean | ToolApprovalCheck<zodInfer<TInput>>;
  /**
   * Doom-loop identity for this tool's calls — see {@link ToolLoopKey}.
   * A computed function over the call's arguments, a field-name array
   * (serializable — used by MCP tool caches), or `false` (exempt).
   * Absent: the full validated arguments object is the identity.
   */
  loopKey?: ToolLoopKey<zodInfer<TInput>>;
  /**
   * Deadline for one execution of this tool, in milliseconds. When it
   * elapses the round stops waiting: the model receives a
   * `{ error, code: 'tool_timeout' }` output immediately and the tool's
   * `ctx.signal` is aborted. The timeout bounds the round's WAIT, not the
   * tool body's execution — a body that ignores its signal keeps running
   * detached (its result is discarded). Overrides the run-level
   * `toolTimeoutMs` default.
   */
  timeoutMs?: number;
  /**
   * Maximum simultaneous in-flight executions of THIS tool across the run
   * — round-synchronous and background alike (background bodies re-acquire
   * the gate for their full duration). Typically encodes an external
   * constraint (one DB connection, a rate-limited API key). Excess calls
   * queue FIFO. Queue wait does NOT count against `timeoutMs` for
   * round-synchronous calls (the deadline starts once the slot is held);
   * background tasks queue against their own registry-tracked timeout.
   * Unbounded when absent.
   */
  maxConcurrency?: number;
}

/**
 * Regular tool with synchronous or asynchronous execute function and optional outputSchema
 * @template TContext - Shape of the tool's context (inferred from contextSchema)
 * @template TName - The tool's literal name string
 */
export interface ToolFunctionWithExecute<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType = $ZodType<unknown>,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TName extends string = string,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> extends BaseToolFunction<TInput, TCtx> {
  outputSchema?: TOutput;
  /**
   * Absent on regular tools. Declared as `undefined`-only so
   * `UnifiedToolFunction` (which requires `run` and `lifecycle`) is
   * structurally DISJOINT from this interface — type-guard narrowing must
   * not keep unified tools in the regular-execute union.
   */
  readonly run?: undefined;
  readonly lifecycle?: undefined;
  // Method syntax (not property syntax) is deliberate: methods are checked
  // bivariantly, so tools carrying concrete TInput/TContext types remain
  // assignable to the wide `Tool` union despite contravariant params.
  execute(
    params: zodInfer<TInput>,
    context?: ToolExecuteContext<TName, TContext>,
  ): Promise<zodInfer<TOutput>> | zodInfer<TOutput>;
  /** Convert tool execution output to model-facing output */
  toModelOutput?: ToModelOutputFunction<zodInfer<TInput>, zodInfer<TOutput>>;
}

/**
 * Generator-based tool with async generator execute function
 * Emits preliminary events (validated by eventSchema) during execution
 * and a final output (validated by outputSchema) as the last emission
 *
 * The generator can yield both events and the final output.
 * All yields are validated against eventSchema (which should be a union of event and output types),
 * and the last yield is additionally validated against outputSchema.
 *
 * @example
 * ```typescript
 * {
 *   eventSchema: z.object({ status: z.string() }),  // For progress events
 *   outputSchema: z.object({ result: z.number() }), // For final output
 *   execute: async function* (params) {
 *     yield { status: "processing..." };  // Event
 *     yield { status: "almost done..." }; // Event
 *     yield { result: 42 };               // Final output (must be last)
 *   }
 * }
 * ```
 */
export interface ToolFunctionWithGenerator<
  TInput extends $ZodObject<$ZodShape>,
  TEvent extends $ZodType = $ZodType<unknown>,
  TOutput extends $ZodType = $ZodType<unknown>,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TName extends string = string,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> extends BaseToolFunction<TInput, TCtx> {
  eventSchema: TEvent;
  outputSchema: TOutput;
  // Method syntax for bivariant param checking — see ToolFunctionWithExecute.
  execute(
    params: zodInfer<TInput>,
    context?: ToolExecuteContext<TName, TContext>,
  ): AsyncGenerator<zodInfer<TEvent> | zodInfer<TOutput>, zodInfer<TOutput> | undefined>;
  /** Convert tool execution output to model-facing output */
  toModelOutput?: ToModelOutputFunction<zodInfer<TInput>, zodInfer<TOutput>>;
}

/**
 * Manual tool without execute function - requires manual handling by developer
 */
export interface ManualToolFunction<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType = $ZodType<unknown>,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> extends BaseToolFunction<TInput, TCtx> {
  outputSchema?: TOutput;
}

/**
 * Human-in-the-loop tool. Extends manual-tool semantics with two async hooks.
 *
 * `onToolCalled` fires when the model invokes the tool. Returning a value feeds
 * the model directly (like regular `execute`); returning `null` pauses the loop
 * like a manual tool, letting the caller resume later with a FunctionCallOutputItem.
 *
 * `onResponseReceived` fires on the next turn when an incoming FunctionCallOutputItem
 * corresponds to a prior call of this tool (matched by callId → function_call.name).
 * It receives the caller-supplied raw result and returns the value sent to the model.
 * Throwing surfaces as a tool error to the model.
 */
export interface HITLToolFunction<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType = $ZodType<unknown>,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TName extends string = string,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> extends BaseToolFunction<TInput, TCtx> {
  /**
   * Required for HITL tools. Used to validate both the `onToolCalled` return
   * value (when non-null) and the caller-supplied response that comes back via
   * a matching `function_call_output` — whether transformed by
   * `onResponseReceived` or passed through directly when no hook is defined.
   */
  outputSchema: TOutput;
  // Method syntax for bivariant param checking — see ToolFunctionWithExecute.
  onToolCalled(
    params: zodInfer<TInput>,
    context?: ToolExecuteContext<TName, TContext>,
  ): Promise<zodInfer<TOutput> | null> | zodInfer<TOutput> | null;
  onResponseReceived?(
    rawResult: unknown,
    context?: ToolExecuteContext<TName, TContext>,
  ): Promise<zodInfer<TOutput>> | zodInfer<TOutput>;
  toModelOutput?: ToModelOutputFunction<zodInfer<TInput>, zodInfer<TOutput>>;
}

/**
 * Model-facing acknowledgement for an async tool's placeholder output.
 * A string becomes the placeholder's `note`; an object is merged into the
 * placeholder payload; a function computes either from the call's input.
 */
export type AsyncToolAck<TInput> =
  | string
  | Record<string, unknown>
  | {
      // Bivariant params — see NextTurnParamsFunctions.
      bivarianceHack(input: TInput): string | Record<string, unknown>;
    }['bivarianceHack'];

/** How a unified tool's execution relates to the tool round. */
export type ToolLifecycle = 'sync' | 'background' | 'deferred';

/**
 * Check-in configuration for a long-running tool. The model interacts with
 * running tasks through the SINGLE universal `task` tool (`action:
 * 'check' | 'steer' | 'result' | 'cancel'`, addressed by `taskId`); the
 * engine dispatches those calls to the owning tool's config here — so the
 * wire surface stays constant while the implementation stays tool-specific.
 *
 * - `true` — explicit opt-in to the SDK default handling (long-running
 *   tools get it even without this).
 * - `schema` — validates the task tool's free-form `params` object when the
 *   model passes one to this tool's custom handler.
 * - `execute` — custom check handler, replacing the SDK default for
 *   `action: 'check'` calls targeting this tool's tasks. Receives the
 *   validated `params` and a TurnContext populated with `toolCallStatus`,
 *   `accumulatedYieldedEvents`, and the `task` handle. Its return value is
 *   the tool output the model sees.
 */
export type ToolCheckConfig<TCheckParams = Record<string, unknown>> =
  | true
  | {
      /**
       * Validation schema for the model-supplied `params` on check calls.
       * SECURITY: `params` is MODEL INPUT (and models can be steered by
       * injected tool/web content). Without a schema the handler receives
       * the raw record — declare one whenever `execute` forwards params
       * into steering/cancel or any other side effect, exactly as you
       * would validate a tool's inputSchema.
       */
      schema?: $ZodObject<$ZodShape>;
      // Method syntax for bivariant param checking — see ToolFunctionWithExecute.
      execute?: {
        bivarianceHack(params: TCheckParams, turnContext: TurnContext): unknown | Promise<unknown>;
      }['bivarianceHack'];
    };

/**
 * The unified `run`-based tool kind. One shape covers every lifecycle:
 *
 * - `'sync'` (default): `run` is awaited in the round, exactly like `execute`.
 * - `'background'`: the loop does not wait. Work settling within `graceMs`
 *   behaves like a sync call; otherwise the model receives a pending
 *   placeholder, the loop continues, and the return value is injected as a
 *   `tool_task_result` envelope when it settles.
 * - `'deferred'`: `run` may return `ctx.defer(taskId)` to park the call on a
 *   durable external task — the run pauses (`awaiting_async_tools`) until
 *   the task is resolved via `.resolve()`/`.fail()`/`.cancel()` or
 *   `resumeToolResults()`, possibly from another process. Returning a plain
 *   value resolves immediately (typed fast path).
 *
 * `run` is an async function or an async generator. Generator yields become
 * the task's LOG entries (feeding check-in views and
 * `tool.preliminary_result` events); the generator's RETURN value is the
 * final result, validated against `outputSchema`. (This is stricter than
 * legacy `execute` generators, which accept a final yield as the result.)
 */
export interface UnifiedToolFunction<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType = $ZodType<unknown>,
  TEvent extends $ZodType = $ZodType<unknown>,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TName extends string = string,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> extends BaseToolFunction<TInput, TCtx> {
  /** Discriminator against every legacy kind. */
  readonly lifecycle: ToolLifecycle;
  /**
   * Required for 'background' | 'deferred' (results settle after the round,
   * possibly in another process). Optional for 'sync' (inferred from run).
   */
  outputSchema?: TOutput;
  /** Validates `run` yields / `ctx.log()` entries when declared. */
  eventSchema?: TEvent;
  /** Model-facing acknowledgement merged into the pending placeholder. */
  ack?: AsyncToolAck<zodInfer<TInput>>;
  /**
   * Background only: hold the round this long (ms) before emitting a
   * placeholder. Work settling in-window produces a plain synchronous
   * output. Default 250; `0` always placeholders.
   */
  graceMs?: number;
  /** Deferred only: default poll-interval hint for tasks from this tool. */
  pollAfterMs?: number;
  /** Check-in configuration — see {@link ToolCheckConfig}. */
  check?: ToolCheckConfig;
  /** Set by `tool.agent()`: marks the run as a child-conversation driver. */
  readonly kind?: 'agent';
  /** Per-task log ring-buffer overrides. */
  logLimits?: Partial<TaskLogLimits>;
  // Method syntax for bivariant param checking — see ToolFunctionWithExecute.
  run(
    params: zodInfer<TInput>,
    context?: ToolRunContext<TName, TContext, zodInfer<TOutput>>,
  ):
    | Promise<zodInfer<TOutput> | DeferredHandle<zodInfer<TOutput>>>
    | zodInfer<TOutput>
    | DeferredHandle<zodInfer<TOutput>>
    | AsyncGenerator<zodInfer<TEvent>, zodInfer<TOutput> | DeferredHandle<zodInfer<TOutput>>>;
  /**
   * Convert tool execution output to model-facing output.
   *
   * ROUND-SYNCHRONOUS RESULTS ONLY: applies to `lifecycle: 'sync'` results
   * and background work that settles inside its grace window — the paths
   * that produce a `function_call_output`. Late-delivered results
   * (background past the grace window, deferred completions) arrive as a
   * `tool_task_result` JSON envelope in a user-role message, which cannot
   * carry this mapper's content-item arrays; they deliver the validated
   * output verbatim.
   */
  toModelOutput?: ToModelOutputFunction<zodInfer<TInput>, zodInfer<TOutput>>;
  /** Absent on unified tools — keeps them disjoint from legacy kinds. */
  readonly execute?: undefined;
  readonly onToolCalled?: undefined;
}

/**
 * Tool with execute function (regular or generator)
 * @template TCtx - The concrete contextSchema type when one was provided to `tool()`
 */
export type ToolWithExecute<
  TInput extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TOutput extends $ZodType = $ZodType<unknown>,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> = {
  type: ToolType.Function;
  function: ToolFunctionWithExecute<TInput, TOutput, TContext, string, TCtx>;
};

/**
 * Tool with generator execute function
 * @template TCtx - The concrete contextSchema type when one was provided to `tool()`
 */
export type ToolWithGenerator<
  TInput extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TEvent extends $ZodType = $ZodType<unknown>,
  TOutput extends $ZodType = $ZodType<unknown>,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> = {
  type: ToolType.Function;
  function: ToolFunctionWithGenerator<TInput, TEvent, TOutput, TContext, string, TCtx>;
};

/**
 * Tool without execute function (manual handling)
 * @template TCtx - The concrete contextSchema type when one was provided to `tool()`
 */
export type ManualTool<
  TInput extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TOutput extends $ZodType = $ZodType<unknown>,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> = {
  type: ToolType.Function;
  function: ManualToolFunction<TInput, TOutput, TCtx>;
};

/**
 * Human-in-the-loop tool (with onToolCalled / onResponseReceived hooks)
 * @template TCtx - The concrete contextSchema type when one was provided to `tool()`
 */
export type HITLTool<
  TInput extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TOutput extends $ZodType = $ZodType<unknown>,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> = {
  type: ToolType.Function;
  function: HITLToolFunction<TInput, TOutput, TContext, string, TCtx>;
};

/**
 * Unified tool wrapper (`tool()` with `run`)
 * @template TCtx - The concrete contextSchema type when one was provided
 */
export type UnifiedTool<
  TInput extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TOutput extends $ZodType = $ZodType<unknown>,
  TEvent extends $ZodType = $ZodType<unknown>,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> = {
  type: ToolType.Function;
  function: UnifiedToolFunction<TInput, TOutput, TEvent, TContext, string, TCtx>;
};

/**
 * Union type of all client-executed tool shapes (function, generator, manual,
 * HITL, unified `run`). These run in the user's process via the agent SDK's
 * tool execution loop.
 */
export type ClientTool =
  | ToolWithExecute<$ZodObject<$ZodShape>, $ZodType<unknown>>
  | ToolWithGenerator<$ZodObject<$ZodShape>, $ZodType<unknown>, $ZodType<unknown>>
  | ManualTool<$ZodObject<$ZodShape>, $ZodType<unknown>>
  | HITLTool<$ZodObject<$ZodShape>, $ZodType<unknown>>
  | UnifiedTool<$ZodObject<$ZodShape>, $ZodType<unknown>, $ZodType<unknown>>;

/**
 * Config payload for an OpenRouter server-executed tool. Derived directly
 * from the SDK's request-tool union so new server tools flow through with
 * zero agent-SDK changes. Excludes the client `function` branch — only
 * server-side variants remain.
 */
export type ServerToolConfig = Exclude<
  models.ResponsesRequestToolUnion,
  {
    type: 'function';
  }
>;

/**
 * The discriminator literals for every server tool known to the SDK
 * (e.g. `"web_search_2025_08_26"`, `"openrouter:datetime"`, `"image_generation"`).
 */
export type ServerToolType = ServerToolConfig['type'];

/**
 * Structural base type for every server tool. Interface extension (not a
 * distributive conditional) is used so the narrow-T subtype assigns cleanly
 * into the wide-T supertype via nominal inheritance — TypeScript treats
 * `ServerTool<'web_search_2025_08_26'>` as a subtype of `ServerToolBase`
 * without needing to reason about variance through `Extract<..., {type: T}>`.
 *
 * `Tool` uses `ServerToolBase` as its union member (rather than a generic
 * `ServerTool` parameterized on a union) so specific `ServerTool<T>` values
 * assign into `Tool[]` directly.
 */
export interface ServerToolBase {
  readonly _brand: 'server-tool';
  readonly config: ServerToolConfig;
}

/**
 * A server-executed tool. OpenRouter runs the tool and returns an output
 * item in the response — no execute function lives on the client. When
 * the type parameter `T` is a specific literal, `config` narrows to the
 * SDK shape for that tool. Because this interface `extends ServerToolBase`,
 * any `ServerTool<T>` value is nominally assignable to `ServerToolBase`
 * (and hence to `Tool`) regardless of `T`.
 *
 * @template T The specific server-tool type literal (narrows `config`).
 */
export interface ServerTool<T extends ServerToolType = ServerToolType> extends ServerToolBase {
  readonly config: Extract<
    ServerToolConfig,
    {
      type: T;
    }
  >;
}

/**
 * Union of every tool kind accepted by `callModel({ tools: [...] })`:
 * client function/generator/manual tools, or OpenRouter server tools.
 * The server branch is the structural base; specific `ServerTool<T>`
 * values flow in via interface extension.
 */
export type Tool = ClientTool | ServerToolBase;

/**
 * Server-tool output items that appear in `response.output`. Derived from
 * the SDK's `OutputItems` union by removing the client-owned variants
 * (message, reasoning, function_call). Every remaining branch — including
 * server-tool-specific shapes like `OutputDatetimeItem`,
 * `OutputWebSearchServerToolItem`, `OutputMcpServerToolItem`, and the
 * SDK's forward-compat `Unknown<"type">` catch-all — flows through
 * automatically when the SDK adds new server-tool variants.
 */
export type ServerToolResultItem = Exclude<
  models.OutputItems,
  | {
      type: 'message';
    }
  | {
      type: 'reasoning';
    }
  | {
      type: 'function_call';
    }
>;

/**
 * Unified tool-result item: either a client function output we construct
 * and send back, or a server-tool output item from OpenRouter. Populated
 * on `ModelResult.allToolExecutionRounds[].toolResults`.
 */
export type ToolResultItem = models.FunctionCallOutputItem | ServerToolResultItem;

/**
 * Extracts the input type from a tool definition
 */
export type InferToolInput<T> = T extends {
  function: {
    inputSchema: infer S;
  };
}
  ? S extends $ZodType
    ? zodInfer<S>
    : unknown
  : unknown;

/**
 * Extracts the output type from a tool definition
 */
export type InferToolOutput<T> = T extends {
  function: {
    outputSchema: infer S;
  };
}
  ? S extends $ZodType
    ? zodInfer<S>
    : unknown
  : unknown;

/**
 * A tool call with typed arguments based on the tool's inputSchema
 */
export type TypedToolCall<T extends Tool> = {
  id: string;
  name: T extends {
    function: {
      name: infer N;
    };
  }
    ? N
    : string;
  arguments: InferToolInput<T>;
};

/**
 * Union of typed tool calls for a tuple of tools
 */
export type TypedToolCallUnion<T extends readonly Tool[]> = {
  [K in keyof T]: T[K] extends Tool ? TypedToolCall<T[K]> : never;
}[number];

/**
 * Union of typed tool execution results for a tuple of tools
 */
export type ToolExecutionResultUnion<T extends readonly Tool[]> = {
  [K in keyof T]: T[K] extends Tool ? ToolExecutionResult<T[K]> : never;
}[number];

/**
 * Union of output types for all tools in a tuple
 * Used for typing tool result events
 */
export type InferToolOutputsUnion<T extends readonly Tool[]> = {
  [K in keyof T]: T[K] extends Tool ? InferToolOutput<T[K]> : never;
}[number];

/**
 * Extracts the event type from a generator tool definition
 * Returns `never` for non-generator tools
 */
export type InferToolEvent<T> = T extends {
  function: {
    eventSchema: infer S;
  };
}
  ? S extends $ZodType
    ? zodInfer<S>
    : never
  : never;

/**
 * Union of event types for all generator tools in a tuple
 * Filters out non-generator tools (which return `never`)
 */
export type InferToolEventsUnion<T extends readonly Tool[]> = {
  [K in keyof T]: T[K] extends Tool ? InferToolEvent<T[K]> : never;
}[number];

/**
 * Type guard: discriminates server-executed tools from client tools.
 *
 * Relies on the `_brand` discriminator that `ServerToolBase` declares and
 * `ClientTool` lacks. `'_brand' in tool` narrows the union to the server
 * branch structurally, so `tool._brand` is reachable without a cast.
 */
export function isServerTool(tool: Tool): tool is ServerTool {
  if (typeof tool !== 'object' || tool === null) {
    return false;
  }
  if (!('_brand' in tool)) {
    return false;
  }
  return tool._brand === 'server-tool';
}

/**
 * A client tool additionally branded as originating from an MCP server. The
 * `_mcp` marker is purely informational: it does NOT change how the tool is
 * executed (MCP tools keep their local `execute` fn and run through the normal
 * client-tool path) or serialized (they go on the wire as `type: 'function'`).
 * It exists only so result types can discriminate MCP results — whose output
 * schema is `unknown` at compile time — from precisely-typed client tools,
 * preventing a single MCP tool from collapsing the whole result union.
 */
export type McpBranded<T extends Tool = Tool> = T & {
  readonly _mcp: true;
};

/**
 * Type guard: true if the tool carries the additive MCP brand (see
 * {@link McpBranded}). Structural check on `_mcp`, so no cast is needed.
 */
export function isMcpTool(tool: Tool): tool is McpBranded {
  if (typeof tool !== 'object' || tool === null) {
    return false;
  }
  if (!('_mcp' in tool)) {
    return false;
  }
  return tool._mcp === true;
}

/**
 * Type guard: true if the tool is a client-executed tool (function, generator, or manual).
 */
export function isClientTool(tool: Tool): tool is ClientTool {
  return !isServerTool(tool);
}

/**
 * Type guard to check if a tool is a unified `run`-based tool
 */
export function isUnifiedTool(tool: Tool): tool is UnifiedTool {
  if (isServerTool(tool)) {
    return false;
  }
  return 'run' in tool.function && typeof tool.function.run === 'function';
}

/**
 * True when the tool can outlive its round: a unified tool with a
 * non-'sync' lifecycle. Drives check-schema generation and placeholder
 * wording.
 */
export function isLongRunningTool(tool: Tool): boolean {
  return isUnifiedTool(tool) && tool.function.lifecycle !== 'sync';
}

/**
 * True when the tool is an agent tool (`tool.agent()`): a unified tool
 * whose run drives a child conversation.
 */
export function isAgentTool(tool: Tool): boolean {
  return isUnifiedTool(tool) && tool.function.kind === 'agent';
}

/**
 * Type guard to check if a tool has an execute function (regular or
 * generator). Unified `run` tools are excluded — they have their own
 * dispatch and this guard's predicate would misclassify them.
 */
export function hasExecuteFunction(tool: Tool): tool is ToolWithExecute | ToolWithGenerator {
  if (isServerTool(tool) || isUnifiedTool(tool)) {
    return false;
  }
  return 'execute' in tool.function && typeof tool.function.execute === 'function';
}

/**
 * Type guard to check if a tool uses a generator (has eventSchema).
 * Unified tools may declare an `eventSchema` for run yields but are not
 * legacy generator tools.
 */
export function isGeneratorTool(tool: Tool): tool is ToolWithGenerator {
  if (isServerTool(tool) || isUnifiedTool(tool)) {
    return false;
  }
  return 'eventSchema' in tool.function;
}

/**
 * Type guard to check if a tool is a regular execution tool (not generator)
 */
export function isRegularExecuteTool(tool: Tool): tool is ToolWithExecute {
  return hasExecuteFunction(tool) && !isGeneratorTool(tool);
}

/**
 * Type guard to check if a tool is a manual tool (no execute, no onToolCalled, no run)
 */
export function isManualTool(tool: Tool): tool is ManualTool {
  if (isServerTool(tool)) {
    return false;
  }
  return (
    !('execute' in tool.function) && !('onToolCalled' in tool.function) && !('run' in tool.function)
  );
}

/**
 * Type guard to check if a tool is a human-in-the-loop tool (has onToolCalled)
 */
export function isHITLTool(tool: Tool): tool is HITLTool {
  if (isServerTool(tool)) {
    return false;
  }
  return 'onToolCalled' in tool.function && typeof tool.function.onToolCalled === 'function';
}

/**
 * Type guard: true if the tool can be auto-resolved within a turn — through a
 * client execute/generator function, a HITL onToolCalled hook, or a unified
 * `run` (which always produces at least a placeholder output). Returns false
 * for manual tools (which always pause) and server tools.
 */
export function isAutoResolvableTool(
  tool: Tool,
): tool is ToolWithExecute | ToolWithGenerator | HITLTool | UnifiedTool {
  return hasExecuteFunction(tool) || isHITLTool(tool) || isUnifiedTool(tool);
}

/**
 * Parsed tool call from API response
 * @template T - The tool type to infer argument types from
 */
export interface ParsedToolCall<T extends Tool> {
  id: string;
  name: T extends {
    function: {
      name: infer N;
    };
  }
    ? N
    : string;
  arguments: InferToolInput<T>; // Typed based on tool's inputSchema
}

/**
 * Result of tool execution.
 *
 * The `_mcp` brand is tested BEFORE the execute/generator branch: an MCP tool
 * is structurally also a `ToolWithExecute`, so checking the brand last would let
 * its `unknown` output flow through and collapse the result union. Brand-first
 * isolates MCP results as `unknown` under `source: 'mcp'` while every other tool
 * keeps its precise, schema-derived result under `source: 'client'`. Consumers
 * narrow on `source` (narrowing on the `toolName` literal alone does not exclude
 * the MCP branch, whose `toolName` is `string`).
 *
 * @template T - The tool type to infer result types from
 */
export interface ToolExecutionResult<T extends Tool> {
  toolCallId: string;
  toolName: T extends {
    function: {
      name: infer N extends string;
    };
  }
    ? N
    : string;
  source: ToolSource<T>;
  result: T extends {
    readonly _mcp: true;
  }
    ? unknown
    : [
          Tool,
        ] extends [
          T,
        ]
      ? unknown // wide `Tool`: result not statically known
      : T extends
            | ToolWithExecute<$ZodObject<$ZodShape>, infer O>
            | ToolWithGenerator<$ZodObject<$ZodShape>, $ZodType<unknown>, infer O>
        ? zodInfer<O>
        : unknown; // Final result (sent to model)
  preliminaryResults?: T extends ToolWithGenerator<$ZodObject<$ZodShape>, infer E>
    ? zodInfer<E>[]
    : undefined; // All yielded values from generator
  error?: Error;
}

/**
 * The `source` discriminant for a tool result. A specific MCP-branded tool is
 * `'mcp'`; a specific client tool is `'client'`; the wide `Tool` (used by the
 * internal executor before the concrete tool type is known) is the full union,
 * so a runtime-computed `'client' | 'mcp'` assigns into it.
 */
export type ToolSource<T extends Tool> = [
  Tool,
] extends [
  T,
]
  ? 'client' | 'mcp' // wide `Tool`: source not statically known
  : [
        T,
      ] extends [
        {
          readonly _mcp: true;
        },
      ]
    ? 'mcp'
    : 'client';

/**
 * Warning from step execution
 */
export interface Warning {
  type: string;
  message: string;
}

/**
 * Result of a single step in the tool execution loop
 * Compatible with Vercel AI SDK pattern
 */
export interface StepResult<TTools extends readonly Tool[] = readonly Tool[]> {
  readonly stepType: 'initial' | 'continue';
  readonly text: string;
  readonly toolCalls: TypedToolCallUnion<TTools>[];
  /**
   * Client function tool results ONLY. Server-tool results
   * (web_search_call, image_generation_call, file_search_call,
   * openrouter:datetime, and other server-side tool output items) are NOT
   * included here — see {@link StepResult.serverToolResults} for those.
   */
  readonly toolResults: ToolExecutionResultUnion<TTools>[];
  /**
   * Server-side tool result items emitted by OpenRouter as part of the
   * model response (e.g. `web_search_call`, `image_generation_call`,
   * `file_search_call`, `openrouter:datetime`, and any other server-tool
   * output variant in the SDK's `OutputItems` union).
   *
   * These results are produced by the provider rather than executed by
   * the client, so they do not flow through the client `toolResults`
   * array. Stop conditions that want to react to server-tool invocations
   * (for example, stopping after the model performs a web search) should
   * inspect this field.
   *
   * Optional for back-compat: earlier releases of this type did not
   * populate server-tool results in step history.
   */
  readonly serverToolResults?: ServerToolResultItem[];
  readonly response: models.OpenResponsesResult;
  readonly usage?: models.Usage | null | undefined;
  readonly finishReason?: string | undefined;
  readonly warnings?: Warning[] | undefined;
  readonly experimental_providerMetadata?: Record<string, unknown> | undefined;
}

/**
 * A condition function that determines whether to stop tool execution
 * Returns true to STOP execution, false to CONTINUE
 * (Matches Vercel AI SDK semantics)
 */
export type StopCondition<TTools extends readonly Tool[] = readonly Tool[]> = (options: {
  readonly steps: ReadonlyArray<StepResult<TTools>>;
}) => boolean | Promise<boolean>;

/**
 * Stop condition configuration
 * Can be a single condition or array of conditions
 */
export type StopWhen<TTools extends readonly Tool[] = readonly Tool[]> =
  | StopCondition<TTools>
  | ReadonlyArray<StopCondition<TTools>>;

/**
 * Standard tool format for OpenRouter API (JSON Schema based)
 * Matches ResponsesRequestToolFunction structure
 */
export interface APITool {
  type: 'function';
  name: string;
  description?: string | null;
  strict?: boolean | null;
  parameters: {
    [k: string]: unknown;
  } | null;
}

/**
 * Tool preliminary result event emitted during generator tool execution
 * @template TEvent - The event type from the tool's eventSchema
 */
export type ToolPreliminaryResultEvent<TEvent = unknown> = {
  type: 'tool.preliminary_result';
  toolCallId: string;
  result: TEvent;
  timestamp: number;
};

/**
 * Tool result event emitted when a tool execution completes
 * Contains the final result and any preliminary results that were emitted
 * @template TResult - The result type from the tool's outputSchema
 * @template TPreliminaryResults - The event type from generator tools' eventSchema
 */
export type ToolResultEvent<TResult = unknown, TPreliminaryResults = unknown> = {
  type: 'tool.result';
  toolCallId: string;
  /**
   * Origin of the tool: `'mcp'` for tools wrapped from a remote MCP server
   * (whose `result` is `unknown`), `'client'` for locally-defined tools. Lets
   * consumers discriminate so an MCP result's `unknown` doesn't force callers to
   * treat every tool result as untyped.
   */
  source: 'client' | 'mcp';
  result: TResult;
  timestamp: number;
  preliminaryResults?: TPreliminaryResults[];
};

/**
 * Tool call output event carrying the fully-formed FunctionCallOutputItem.
 * Broadcast by executeToolRound so passive consumers (getItemsStream) can yield
 * tool results in real-time without owning tool execution.
 */
export type ToolCallOutputEvent = {
  type: 'tool.call_output';
  output: models.FunctionCallOutputItem;
  timestamp: number;
};

/**
 * Emitted when an async tool call escapes the round: a background tool's
 * execute outlived its grace window, or a deferred tool's start returned a
 * task handle. The model has received a pending placeholder output.
 */
export type ToolAsyncStartedEvent = {
  type: 'tool.async_started';
  toolCallId: string;
  toolName: string;
  taskId: string;
  mode: ToolTaskMode;
  /** The model-facing acknowledgement carried in the placeholder, if any. */
  ack?: unknown;
  timestamp: number;
};

/**
 * Emitted when an async tool task settles — completed, failed, cancelled,
 * timed out, or expired. `delivery` reports how (or whether) the outcome
 * reached the model: `'injected'` into this run's conversation,
 * `'pending_resume'` recorded on state for the next run, or `'dropped'`
 * (run ended under `onRunEnd: 'detach'`).
 */
export type ToolAsyncSettledEvent<TResult = unknown> = {
  type: 'tool.async_settled';
  toolCallId: string;
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'expired';
  result?: TResult;
  error?: string;
  delivery: 'injected' | 'pending_resume' | 'dropped';
  timestamp: number;
};

/**
 * Turn start event emitted at the beginning of each API turn
 * Turn 0 is the initial request, subsequent turns follow tool execution
 */
export type TurnStartEvent = {
  type: 'turn.start';
  turnNumber: number;
  timestamp: number;
};

/**
 * Turn end event emitted at the end of each API turn
 */
export type TurnEndEvent = {
  type: 'turn.end';
  turnNumber: number;
  timestamp: number;
};

/**
 * Enhanced stream event types for getFullResponsesStream
 * Extends StreamEvents with tool preliminary results, tool results,
 * and turn delimiter events for multi-turn streaming
 * @template TEvent - The event type from generator tools
 * @template TResult - The result type from tool execution
 */
export type ResponseStreamEvent<TEvent = unknown, TResult = unknown> =
  | StreamEvents
  | ToolPreliminaryResultEvent<TEvent>
  | ToolResultEvent<TResult, TEvent>
  | ToolCallOutputEvent
  | ToolAsyncStartedEvent
  | ToolAsyncSettledEvent<TResult>
  | TurnStartEvent
  | TurnEndEvent;

/**
 * Type guard to check if an event is a tool async started event
 */
export function isToolAsyncStartedEvent(
  event: ResponseStreamEvent,
): event is ToolAsyncStartedEvent {
  return event.type === 'tool.async_started';
}

/**
 * Type guard to check if an event is a tool async settled event
 */
export function isToolAsyncSettledEvent<TResult = unknown>(
  event: ResponseStreamEvent<unknown, TResult>,
): event is ToolAsyncSettledEvent<TResult> {
  return event.type === 'tool.async_settled';
}

/**
 * Type guard to check if an event is a tool preliminary result event
 */
export function isToolPreliminaryResultEvent<TEvent = unknown>(
  event: ResponseStreamEvent<TEvent>,
): event is ToolPreliminaryResultEvent<TEvent> {
  return event.type === 'tool.preliminary_result';
}

/**
 * Type guard to check if an event is a tool result event
 */
export function isToolResultEvent<TResult = unknown, TPreliminaryResults = unknown>(
  event: ResponseStreamEvent<TPreliminaryResults, TResult>,
): event is ToolResultEvent<TResult, TPreliminaryResults> {
  return event.type === 'tool.result';
}

/**
 * Type guard to check if an event is a tool call output event
 */
export function isToolCallOutputEvent(event: ResponseStreamEvent): event is ToolCallOutputEvent {
  return event.type === 'tool.call_output';
}

/**
 * Type guard to check if an event is a turn start event
 */
export function isTurnStartEvent(event: ResponseStreamEvent): event is TurnStartEvent {
  return event.type === 'turn.start';
}

/**
 * Type guard to check if an event is a turn end event
 */
export function isTurnEndEvent(event: ResponseStreamEvent): event is TurnEndEvent {
  return event.type === 'turn.end';
}

/**
 * Tool stream event types for getToolStream
 * Includes both argument deltas and preliminary results
 * @template TEvent - The event type from generator tools
 */
export type ToolStreamEvent<TEvent = unknown> =
  | {
      type: 'delta';
      content: string;
    }
  | {
      type: 'preliminary_result';
      toolCallId: string;
      result: TEvent;
    };

/**
 * Chat stream event types for getFullChatStream
 * Includes content deltas, completion events, and tool preliminary results
 * @template TEvent - The event type from generator tools
 */
export type ChatStreamEvent<TEvent = unknown> =
  | {
      type: 'content.delta';
      delta: string;
    }
  | {
      type: 'message.complete';
      response: models.OpenResponsesResult;
    }
  | {
      type: 'tool.preliminary_result';
      toolCallId: string;
      result: TEvent;
    }
  | {
      type: string;
      event: StreamEvents;
    }; // Pass-through for other events
/**
 * Result of a tool execution that hasn't been sent to the model yet
 * Used for interrupted or awaiting approval states
 * @template TTools - The tools array type for proper type inference
 */
export interface UnsentToolResult<TTools extends readonly Tool[] = readonly Tool[]> {
  /** The ID of the tool call this result is for */
  callId: string;
  /** The name of the tool that was executed (client tools only) */
  name: Extract<
    TTools[number],
    {
      function: {
        name: string;
      };
    }
  > extends {
    function: {
      name: infer N;
    };
  }
    ? N
    : string;
  /** The output of the tool execution */
  output: unknown;
  /** Error message if the tool call was rejected or failed */
  error?: string;
}

/**
 * Partial response captured during interruption
 * @template TTools - The tools array type for proper type inference
 */
export interface PartialResponse<TTools extends readonly Tool[] = readonly Tool[]> {
  /** Partial text response accumulated before interruption */
  text?: string;
  /** Tool calls that were in progress when interrupted */
  toolCalls?: Array<ParsedToolCall<TTools[number]>>;
}

/**
 * Status of a conversation state.
 *
 * - `in_progress`: conversation is actively executing
 * - `complete`: conversation finished successfully
 * - `interrupted`: execution was externally interrupted
 * - `awaiting_approval`: tool calls are waiting for caller to approve/reject
 * - `awaiting_hitl`: one or more HITL tools returned `null` from `onToolCalled`,
 *   pausing execution so the caller can supply outputs for the paused calls
 *   before resuming
 * - `awaiting_client_tools`: one or more manual (`execute: false` / no execute
 *   fn) tool calls are unresolved; the loop stopped so the caller can execute
 *   them client-side and continue. Distinct from `awaiting_hitl` — HITL tools
 *   have an `onToolCalled` hook; manual tools do not.
 * - `awaiting_async_tools`: one or more deferred tools (`tool.deferred`)
 *   started a durable external task; the loop paused until the task is
 *   resolved via the tool's `.resolve()` / `.fail()` / `.cancel()` methods
 *   (or `resumeToolResults()`), possibly from a different process. Distinct
 *   from `awaiting_client_tools` — the tool DID execute (its `start` ran and
 *   a placeholder output was persisted); only its final result is pending.
 */
export type ConversationStatus =
  | 'complete'
  | 'interrupted'
  | 'awaiting_approval'
  | 'awaiting_hitl'
  | 'awaiting_client_tools'
  | 'awaiting_async_tools'
  | 'in_progress';

export type { ToolTaskStatus } from './tool-task.js';

/**
 * A pending (or settled) async tool task tracked on
 * {@link ConversationState.pendingAsyncTools}. One entry per background /
 * deferred call that produced a placeholder output.
 */
export interface PendingAsyncTool {
  /** The originating `function_call`'s call id. */
  callId: string;
  /** Durable task id (deferred: caller-supplied; background/agent: generated). */
  taskId: string;
  /** The tool's name. */
  name: string;
  /** How the task escapes the round. */
  mode: ToolTaskMode;
  /** Current lifecycle status (MCP-Tasks-compatible vocabulary). */
  status: ToolTaskStatus;
  /** Unix ms when the task started. */
  startedAt: number;
  /** Unix ms after which the task is considered expired. */
  expiresAt?: number;
  /** Poll-interval hint surfaced to the model and external pollers. */
  pollAfterMs?: number;
  /**
   * Set on a background task left running when the run ended under
   * `onRunEnd: 'detach'` — its result will never be delivered.
   */
  orphaned?: boolean;
  /**
   * The most recent log entry, truncated (~200 chars) — the one piece of
   * progress that survives a process restart. Additive within
   * ConversationState version 1.
   */
  lastLog?: {
    at: number;
    text: string;
  };
}

/**
 * State for multi-turn conversations with persistence and approval gates
 * @template TTools - The tools array type for proper type inference
 */
export interface ConversationState<TTools extends readonly Tool[] = readonly Tool[]> {
  /**
   * Serialization-contract version for this state blob.
   *
   * Optional so legacy (pre-version-field) states remain assignable. Absence is
   * treated as version `1` by {@link deserializeConversationState}. Consumers
   * should treat serialized JSON as opaque: additive fields within a major
   * version, migrations applied inside `deserializeConversationState` on bump.
   */
  version?: number;
  /** Unique identifier for this conversation */
  id: string;
  /** Full message history */
  messages: models.InputsUnion;
  /** Previous response ID for chaining (OpenRouter server-side optimization) */
  previousResponseId?: string;
  /**
   * Whether a tool round has already satisfied the caller's forced
   * `toolChoice` for the active logical run. Persisted across approval,
   * HITL, client-tool, and async-tool pauses so a resumed follow-up can
   * synthesize text instead of being forced into another tool call.
   *
   * Cleared when the run completes. Absence means `false` for compatibility
   * with state written by older SDK versions.
   */
  forcedToolChoiceSatisfied?: true;
  /** Tool calls awaiting human approval */
  pendingToolCalls?: Array<ParsedToolCall<TTools[number]>>;
  /** Tool results executed but not yet sent to the model */
  unsentToolResults?: Array<UnsentToolResult<TTools>>;
  /** Partial response data captured during interruption */
  partialResponse?: PartialResponse<TTools>;
  /** Signal from a new request to interrupt this conversation */
  interruptedBy?: string;
  /**
   * Doom-loop detector state (see the `doomLoop` option on `callModel`).
   * Bounded plain JSON, persisted so repetition streaks survive
   * serialize → resume. Absent when detection is off. Additive within
   * ConversationState version 1.
   */
  doomLoop?: DoomLoopSerializedState;
  /**
   * Async tool tasks (background / deferred) whose placeholder output was
   * sent to the model but whose real result has not been delivered yet.
   * Additive within ConversationState version 1.
   */
  pendingAsyncTools?: PendingAsyncTool[];
  /**
   * Call ids whose async result has already been delivered — the
   * at-most-once guard against replayed webhook resolutions. Additive
   * within ConversationState version 1.
   */
  settledAsyncCallIds?: string[];
  /** Current status of the conversation */
  status: ConversationStatus;
  /** Creation timestamp (Unix ms) */
  createdAt: number;
  /** Last update timestamp (Unix ms) */
  updatedAt: number;
}

/**
 * State accessor for loading and saving conversation state
 * Enables any storage backend (memory, Redis, database, etc.)
 * @template TTools - The tools array type for proper type inference
 */
export interface StateAccessor<TTools extends readonly Tool[] = readonly Tool[]> {
  /** Load the current conversation state, or null if none exists */
  load: () => Promise<ConversationState<TTools> | null>;
  /** Save the conversation state */
  save: (state: ConversationState<TTools>) => Promise<void>;
}
/**
 * Check if a single tool has approval configured (non-false, non-undefined)
 * Returns true if the tool definitely requires approval,
 * false if it definitely doesn't, or boolean if it's uncertain
 */
export type ToolHasApproval<T extends Tool> = T extends {
  function: {
    requireApproval: true | ToolApprovalCheck<unknown>;
  };
}
  ? true
  : T extends {
        function: {
          requireApproval: false;
        };
      }
    ? false
    : T extends {
          function: {
            requireApproval: undefined;
          };
        }
      ? false
      : boolean; // Could be either (optional property)

/**
 * Check if ANY tool in an array has approval configured
 * Returns true if at least one tool might require approval
 */
export type HasApprovalTools<TTools extends readonly Tool[]> = TTools extends readonly [
  infer First extends Tool,
  ...infer Rest extends Tool[],
]
  ? ToolHasApproval<First> extends true
    ? true
    : HasApprovalTools<Rest>
  : false;

/**
 * Type guard to check if a tool has approval configured at runtime
 */
export function toolHasApprovalConfigured(tool: Tool): boolean {
  if (isServerTool(tool)) {
    return false;
  }
  const requireApproval = tool.function.requireApproval;
  return requireApproval === true || typeof requireApproval === 'function';
}

/**
 * Type guard to check if any tools in array have approval configured at runtime
 */
export function hasApprovalRequiredTools(tools: readonly Tool[]): boolean {
  return tools.some(toolHasApprovalConfigured);
}
