import type { OpenRouterCore } from '@openrouter/sdk/core';
import type { RequestOptions } from '@openrouter/sdk/lib/sdks';
import type { $ZodObject, $ZodShape, $ZodType, infer as zodInfer } from 'zod/v4/core';
import type { CallModelInput } from './async-params.js';
import type { ModelResult } from './model-result.js';
import type {
  AsyncToolAck,
  BackgroundTool,
  BackgroundToolExecuteContext,
  ContextFromSchema,
  DeferredStartResult,
  DeferredTool,
  HITLTool,
  ManualTool,
  McpBranded,
  NextTurnParamsFunctions,
  ServerTool,
  ServerToolConfig,
  ServerToolType,
  StateAccessor,
  ToModelOutputFunction,
  Tool,
  ToolApprovalCheck,
  ToolExecuteContext,
  ToolLoopKey,
  ToolWithExecute,
  ToolWithGenerator,
} from './tool-types.js';
import { isClientTool, SHARED_CONTEXT_KEY, ToolType } from './tool-types.js';

//#region Config Types

/**
 * Configuration for a regular tool with outputSchema.
 * `TCtx` preserves a concrete `contextSchema` through the overload boundary so
 * execute's `ctx.local` and the returned tool's `function.contextSchema` stay typed.
 */
type RegularToolConfigWithOutput<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
> = {
  name: TName;
  description?: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  eventSchema?: undefined;
  /** Zod schema declaring the context data this tool needs */
  contextSchema?: TCtx;
  nextTurnParams?: NextTurnParamsFunctions<zodInfer<TInput>>;
  requireApproval?: boolean | ToolApprovalCheck<zodInfer<TInput>>;
  /** Doom-loop identity: function, field list, or false — see {@link ToolLoopKey} */
  loopKey?: ToolLoopKey<zodInfer<TInput>>;
  /** Deadline for one execution of this tool, in ms (see BaseToolFunction.timeoutMs) */
  timeoutMs?: number;
  /** Max simultaneous in-flight executions of this tool across the run */
  maxConcurrency?: number;
  execute: (
    params: zodInfer<TInput>,
    context?: ToolExecuteContext<TName, ContextFromSchema<TCtx>>,
  ) => Promise<zodInfer<TOutput>> | zodInfer<TOutput>;
  /** Convert tool execution output to model-facing output */
  toModelOutput?: ToModelOutputFunction<zodInfer<TInput>, zodInfer<TOutput>>;
};

/**
 * Configuration for a regular tool without outputSchema (infers return type from execute)
 */
type RegularToolConfigWithoutOutput<
  TInput extends $ZodObject<$ZodShape>,
  TReturn,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
> = {
  name: TName;
  description?: string;
  inputSchema: TInput;
  outputSchema?: undefined;
  eventSchema?: undefined;
  /** Zod schema declaring the context data this tool needs */
  contextSchema?: TCtx;
  nextTurnParams?: NextTurnParamsFunctions<zodInfer<TInput>>;
  requireApproval?: boolean | ToolApprovalCheck<zodInfer<TInput>>;
  /** Doom-loop identity: function, field list, or false — see {@link ToolLoopKey} */
  loopKey?: ToolLoopKey<zodInfer<TInput>>;
  /** Deadline for one execution of this tool, in ms (see BaseToolFunction.timeoutMs) */
  timeoutMs?: number;
  /** Max simultaneous in-flight executions of this tool across the run */
  maxConcurrency?: number;
  execute: (
    params: zodInfer<TInput>,
    context?: ToolExecuteContext<TName, ContextFromSchema<TCtx>>,
  ) => Promise<TReturn> | TReturn;
  /** Convert tool execution output to model-facing output */
  toModelOutput?: ToModelOutputFunction<zodInfer<TInput>, TReturn>;
};

/**
 * Configuration for a generator tool (with eventSchema)
 */
type GeneratorToolConfig<
  TInput extends $ZodObject<$ZodShape>,
  TEvent extends $ZodType,
  TOutput extends $ZodType,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
> = {
  name: TName;
  description?: string;
  inputSchema: TInput;
  eventSchema: TEvent;
  outputSchema: TOutput;
  /** Zod schema declaring the context data this tool needs */
  contextSchema?: TCtx;
  nextTurnParams?: NextTurnParamsFunctions<zodInfer<TInput>>;
  requireApproval?: boolean | ToolApprovalCheck<zodInfer<TInput>>;
  /** Doom-loop identity: function, field list, or false — see {@link ToolLoopKey} */
  loopKey?: ToolLoopKey<zodInfer<TInput>>;
  /** Deadline for one execution of this tool, in ms (see BaseToolFunction.timeoutMs) */
  timeoutMs?: number;
  /** Max simultaneous in-flight executions of this tool across the run */
  maxConcurrency?: number;
  execute: (
    params: zodInfer<TInput>,
    context?: ToolExecuteContext<TName, ContextFromSchema<TCtx>>,
  ) => AsyncGenerator<zodInfer<TEvent> | zodInfer<TOutput>>;
  /** Convert tool execution output to model-facing output */
  toModelOutput?: ToModelOutputFunction<zodInfer<TInput>, zodInfer<TOutput>>;
};

/**
 * Configuration for a manual tool (execute: false, no eventSchema or outputSchema)
 */
type ManualToolConfig<
  TInput extends $ZodObject<$ZodShape>,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> = {
  name: string; // Manual tools don't use TName since they have no execute
  description?: string;
  inputSchema: TInput;
  /** Zod schema declaring the context data this tool needs */
  contextSchema?: TCtx;
  nextTurnParams?: NextTurnParamsFunctions<zodInfer<TInput>>;
  requireApproval?: boolean | ToolApprovalCheck<zodInfer<TInput>>;
  /** Doom-loop identity: function, field list, or false — see {@link ToolLoopKey} */
  loopKey?: ToolLoopKey<zodInfer<TInput>>;
  /** Deadline for one execution of this tool, in ms (see BaseToolFunction.timeoutMs) */
  timeoutMs?: number;
  /** Max simultaneous in-flight executions of this tool across the run */
  maxConcurrency?: number;
  execute: false;
};

/**
 * Configuration for a human-in-the-loop tool.
 * Discriminated by the presence of `onToolCalled`. No `execute` or `eventSchema`.
 *
 * `onToolCalled` returning `null` pauses the loop (manual-tool semantics).
 * Any non-null return is treated as the tool's result for the model.
 *
 * `onResponseReceived` is invoked on a later turn when an incoming
 * `FunctionCallOutputItem` corresponds to a prior call of this tool; the
 * returned value replaces what the model ultimately sees.
 */
type HITLToolConfig<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
> = {
  name: TName;
  description?: string;
  inputSchema: TInput;
  /**
   * Required for HITL tools. Used to validate both the `onToolCalled` return
   * value (when non-null) and the caller-supplied response that comes back via
   * a matching `function_call_output` — whether transformed by
   * `onResponseReceived` or passed through directly when no hook is defined.
   */
  outputSchema: TOutput;
  eventSchema?: undefined;
  execute?: undefined;
  /** Zod schema declaring the context data this tool needs */
  contextSchema?: TCtx;
  nextTurnParams?: NextTurnParamsFunctions<zodInfer<TInput>>;
  requireApproval?: boolean | ToolApprovalCheck<zodInfer<TInput>>;
  /** Doom-loop identity: function, field list, or false — see {@link ToolLoopKey} */
  loopKey?: ToolLoopKey<zodInfer<TInput>>;
  /** Deadline for one execution of this tool, in ms (see BaseToolFunction.timeoutMs) */
  timeoutMs?: number;
  /** Max simultaneous in-flight executions of this tool across the run */
  maxConcurrency?: number;
  onToolCalled: (
    params: zodInfer<TInput>,
    context?: ToolExecuteContext<TName, ContextFromSchema<TCtx>>,
  ) => Promise<zodInfer<TOutput> | null> | zodInfer<TOutput> | null;
  onResponseReceived?: (
    rawResult: unknown,
    context?: ToolExecuteContext<TName, ContextFromSchema<TCtx>>,
  ) => Promise<zodInfer<TOutput>> | zodInfer<TOutput>;
  /** Convert tool execution output to model-facing output */
  toModelOutput?: ToModelOutputFunction<zodInfer<TInput>, zodInfer<TOutput>>;
};

/**
 * Loose config type for the `tool<TShared>()` overload.
 * Accepts any valid tool config while typing `ctx.shared` from TShared.
 */
type ToolConfigWithSharedContext<
  TShared extends Record<string, unknown>,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> = {
  name: string;
  description?: string;
  inputSchema: $ZodObject<$ZodShape>;
  outputSchema?: $ZodType;
  eventSchema?: $ZodType;
  contextSchema?: TCtx;
  nextTurnParams?: NextTurnParamsFunctions<Record<string, unknown>>;
  requireApproval?: boolean | ToolApprovalCheck<Record<string, unknown>>;
  /** Doom-loop identity: function, field list, or false — see {@link ToolLoopKey} */
  loopKey?: ToolLoopKey<Record<string, unknown>>;
  /** Deadline for one execution of this tool, in ms (see BaseToolFunction.timeoutMs) */
  timeoutMs?: number;
  /** Max simultaneous in-flight executions of this tool across the run */
  maxConcurrency?: number;
  execute:
    | ((
        params: Record<string, unknown>,
        context?: ToolExecuteContext<string, ContextFromSchema<TCtx>, TShared>,
      ) => unknown)
    | ((
        params: Record<string, unknown>,
        context?: ToolExecuteContext<string, ContextFromSchema<TCtx>, TShared>,
      ) => AsyncGenerator<unknown>)
    | false;
  /** Convert tool execution output to model-facing output */
  toModelOutput?: ToModelOutputFunction<Record<string, unknown>, unknown>;
};

/**
 * Configuration for a background tool (`tool.background`).
 * An ordinary async `execute` whose result may arrive after the round closes.
 */
type BackgroundToolConfig<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TEvent extends $ZodType = $ZodType<never>,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
> = {
  name: TName;
  description?: string;
  inputSchema: TInput;
  /** Required: the final result is validated whenever it settles. */
  outputSchema: TOutput;
  /** Optional schema for `ctx.progress()` events. */
  eventSchema?: TEvent;
  /** Model-facing acknowledgement merged into the pending placeholder. */
  ack?: AsyncToolAck<zodInfer<TInput>>;
  /**
   * Settles-fast window (ms): work finishing inside it produces a plain
   * synchronous output, no placeholder. Default 250; `0` always placeholders.
   */
  graceMs?: number;
  /** Deadline for the whole task (queue wait + execution), in ms. */
  timeoutMs?: number;
  /** Max simultaneous in-flight executions of this tool. */
  maxConcurrency?: number;
  /** Zod schema declaring the context data this tool needs */
  contextSchema?: TCtx;
  nextTurnParams?: NextTurnParamsFunctions<zodInfer<TInput>>;
  requireApproval?: boolean | ToolApprovalCheck<zodInfer<TInput>>;
  /** Doom-loop identity: function, field list, or false — see {@link ToolLoopKey} */
  loopKey?: ToolLoopKey<zodInfer<TInput>>;
  execute: (
    params: zodInfer<TInput>,
    context?: BackgroundToolExecuteContext<TName, ContextFromSchema<TCtx>, zodInfer<TEvent>>,
  ) => Promise<zodInfer<TOutput>>;
  /** Convert tool execution output to model-facing output */
  toModelOutput?: ToModelOutputFunction<zodInfer<TInput>, zodInfer<TOutput>>;
};

/**
 * Configuration for a deferred tool (`tool.deferred`).
 * `start` kicks off external work and returns `{ taskId }` (pause) or
 * `{ output }` (immediate result).
 */
type DeferredToolConfig<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
> = {
  name: TName;
  description?: string;
  inputSchema: TInput;
  /** Required: validates `{ output }` fast paths and `.resolve()` payloads. */
  outputSchema: TOutput;
  /** Model-facing acknowledgement merged into the pending placeholder. */
  ack?: AsyncToolAck<zodInfer<TInput>>;
  /** Default poll-interval hint for tasks started by this tool. */
  pollAfterMs?: number;
  /** Deadline for `start` itself (not the external task), in ms. */
  timeoutMs?: number;
  /** Max simultaneous in-flight `start` executions of this tool. */
  maxConcurrency?: number;
  /** Zod schema declaring the context data this tool needs */
  contextSchema?: TCtx;
  nextTurnParams?: NextTurnParamsFunctions<zodInfer<TInput>>;
  requireApproval?: boolean | ToolApprovalCheck<zodInfer<TInput>>;
  /** Doom-loop identity: function, field list, or false — see {@link ToolLoopKey} */
  loopKey?: ToolLoopKey<zodInfer<TInput>>;
  start: (
    params: zodInfer<TInput>,
    context?: ToolExecuteContext<TName, ContextFromSchema<TCtx>>,
  ) => Promise<DeferredStartResult<zodInfer<TOutput>>> | DeferredStartResult<zodInfer<TOutput>>;
  /** Convert tool execution output to model-facing output */
  toModelOutput?: ToModelOutputFunction<zodInfer<TInput>, zodInfer<TOutput>>;
};

//#endregion

//#region Union Config Type

/**
 * Union type for all regular tool configs
 */
type RegularToolConfig<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TReturn,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
> =
  | RegularToolConfigWithOutput<TInput, TOutput, TCtx, TName>
  | RegularToolConfigWithoutOutput<TInput, TReturn, TCtx, TName>;

//#endregion

//#region tool() Factory

/**
 * Creates a tool with full type inference from Zod schemas.
 *
 * The tool type is automatically determined based on the configuration:
 * - **Generator tool**: When `eventSchema` is provided
 * - **Regular tool**: When `execute` is a function (no `eventSchema`)
 * - **Manual tool**: When `execute: false` is set
 *
 * Shared context typing: Pass a type parameter to type `ctx.shared`
 * in the execute callback. Runtime validation happens at callModel
 * via `sharedContextSchema`.
 *
 * @example Regular tool with typed shared context:
 * ```typescript
 * type SharedCtx = z.infer<typeof SharedContextSchema>;
 *
 * const execTool = tool<SharedCtx>({
 *   name: "sandbox_exec",
 *   inputSchema: z.object({ command: z.string() }),
 *   execute: async (params, ctx) => {
 *     ctx?.shared._sessionId;       // string | undefined
 *     return { output: '...' };
 *   },
 * });
 * ```
 */
// Overload for generator tools (when eventSchema is provided).
// TContext on the *returned* tool stays the wide default so specific tools remain
// assignable to `Tool` / `Tool[]` (function-parameter variance). Typed
// `ctx.local` is provided by the *config* execute signature via ContextFromSchema;
// the concrete schema is preserved on the return via TCtx on `BaseToolFunction.contextSchema`.
export function tool<
  TInput extends $ZodObject<$ZodShape>,
  TEvent extends $ZodType,
  TOutput extends $ZodType,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
>(
  config: GeneratorToolConfig<TInput, TEvent, TOutput, TCtx, TName>,
): ToolWithGenerator<TInput, TEvent, TOutput, Record<string, unknown>, TCtx>;

// Overload for HITL tools (when onToolCalled is provided)
export function tool<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
>(
  config: HITLToolConfig<TInput, TOutput, TCtx, TName>,
): HITLTool<TInput, TOutput, Record<string, unknown>, TCtx>;

// Overload for manual tools (execute: false)
export function tool<
  TInput extends $ZodObject<$ZodShape>,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
>(config: ManualToolConfig<TInput, TCtx>): ManualTool<TInput, $ZodType<unknown>, TCtx>;

// Overload for regular tools with outputSchema
export function tool<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
>(
  config: RegularToolConfigWithOutput<TInput, TOutput, TCtx, TName>,
): ToolWithExecute<TInput, TOutput, Record<string, unknown>, TCtx>;

// Overload for regular tools without outputSchema (infers return type)
export function tool<
  TInput extends $ZodObject<$ZodShape>,
  TReturn,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
>(
  config: RegularToolConfigWithoutOutput<TInput, TReturn, TCtx, TName>,
): ToolWithExecute<TInput, $ZodType<TReturn>, Record<string, unknown>, TCtx>;

// Overload for explicit TShared: tool<SharedContext>({...})
// When a non-ZodObject type is provided as the first generic,
// the specific overloads above won't match (constraint mismatch),
// so TypeScript falls through to this catch-all.
export function tool<TShared extends Record<string, unknown>>(
  config: ToolConfigWithSharedContext<TShared>,
): Tool;

// Implementation
export function tool(
  config:
    | GeneratorToolConfig<$ZodObject<$ZodShape>, $ZodType, $ZodType>
    | RegularToolConfig<$ZodObject<$ZodShape>, $ZodType, unknown>
    | ManualToolConfig<$ZodObject<$ZodShape>>
    | HITLToolConfig<$ZodObject<$ZodShape>, $ZodType>
    | ToolConfigWithSharedContext<Record<string, unknown>>,
): Tool {
  // 'shared' is reserved for shared context — forbid it as a tool name
  if (config.name === SHARED_CONTEXT_KEY) {
    throw new Error(
      `Tool name "${SHARED_CONTEXT_KEY}" is reserved for shared context. Choose a different name.`,
    );
  }

  // Check for HITL tool (has onToolCalled hook)
  if ('onToolCalled' in config && typeof config.onToolCalled === 'function') {
    // outputSchema is required at the type level for HITL configs, but
    // defensively check at runtime too — JavaScript callers can bypass types.
    const hitlName = config.name;
    if (!('outputSchema' in config) || config.outputSchema === undefined) {
      throw new Error(
        `HITL tool "${hitlName}" must declare an outputSchema. HITL tools require a schema so caller-supplied responses can be validated before the model sees them.`,
      );
    }

    const fn: HITLTool<$ZodObject<$ZodShape>, $ZodType>['function'] = {
      name: config.name,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      onToolCalled: config.onToolCalled,
    };

    if (config.description !== undefined) {
      fn.description = config.description;
    }

    if (config.contextSchema !== undefined) {
      // contextSchema is readonly on the type (covariance); assignment at
      // construction time is the one sanctioned write.
      (
        fn as {
          contextSchema?: unknown;
        }
      ).contextSchema = config.contextSchema;
    }

    if (config.nextTurnParams !== undefined) {
      fn.nextTurnParams = config.nextTurnParams;
    }

    if (config.requireApproval !== undefined) {
      fn.requireApproval = config.requireApproval;
    }

    if (config.loopKey !== undefined) {
      fn.loopKey = config.loopKey;
    }

    if (config.timeoutMs !== undefined) {
      fn.timeoutMs = config.timeoutMs;
    }

    if (config.maxConcurrency !== undefined) {
      fn.maxConcurrency = config.maxConcurrency;
    }

    if (config.onResponseReceived !== undefined) {
      fn.onResponseReceived = config.onResponseReceived;
    }

    if (config.toModelOutput !== undefined) {
      fn.toModelOutput = config.toModelOutput;
    }

    return {
      type: ToolType.Function,
      function: fn,
    };
  }

  // Check for manual tool first (execute === false)
  if (config.execute === false) {
    const fn: ManualTool<$ZodObject<$ZodShape>>['function'] = {
      name: config.name,
      inputSchema: config.inputSchema,
    };

    if (config.description !== undefined) {
      fn.description = config.description;
    }

    if (config.contextSchema !== undefined) {
      // contextSchema is readonly on the type (covariance); assignment at
      // construction time is the one sanctioned write.
      (
        fn as {
          contextSchema?: unknown;
        }
      ).contextSchema = config.contextSchema;
    }

    if (config.nextTurnParams !== undefined) {
      fn.nextTurnParams = config.nextTurnParams;
    }

    if (config.requireApproval !== undefined) {
      fn.requireApproval = config.requireApproval;
    }

    if (config.loopKey !== undefined) {
      fn.loopKey = config.loopKey;
    }

    if (config.timeoutMs !== undefined) {
      fn.timeoutMs = config.timeoutMs;
    }

    if (config.maxConcurrency !== undefined) {
      fn.maxConcurrency = config.maxConcurrency;
    }

    return {
      type: ToolType.Function,
      function: fn,
    };
  }

  // Check for generator tool (has eventSchema)
  if ('eventSchema' in config && config.eventSchema !== undefined) {
    const fn = {
      name: config.name,
      inputSchema: config.inputSchema,
      eventSchema: config.eventSchema,
      outputSchema: config.outputSchema,
      execute: config.execute,
    } as ToolWithGenerator<$ZodObject<$ZodShape>, $ZodType, $ZodType>['function'];

    if (config.description !== undefined) {
      fn.description = config.description;
    }

    if (config.contextSchema !== undefined) {
      // contextSchema is readonly on the type (covariance); assignment at
      // construction time is the one sanctioned write.
      (
        fn as {
          contextSchema?: unknown;
        }
      ).contextSchema = config.contextSchema;
    }

    if (config.nextTurnParams !== undefined) {
      fn.nextTurnParams = config.nextTurnParams;
    }

    if (config.requireApproval !== undefined) {
      fn.requireApproval = config.requireApproval;
    }

    if (config.loopKey !== undefined) {
      fn.loopKey = config.loopKey;
    }

    if (config.timeoutMs !== undefined) {
      fn.timeoutMs = config.timeoutMs;
    }

    if (config.maxConcurrency !== undefined) {
      fn.maxConcurrency = config.maxConcurrency;
    }

    if ('toModelOutput' in config && config.toModelOutput !== undefined) {
      fn.toModelOutput = config.toModelOutput;
    }

    return {
      type: ToolType.Function,
      function: fn,
    };
  }

  // Regular tool (has execute function, no eventSchema)
  const functionObj = {
    name: config.name,
    inputSchema: config.inputSchema,
    execute: config.execute,
    ...(config.description !== undefined && {
      description: config.description,
    }),
    ...(config.outputSchema !== undefined && {
      outputSchema: config.outputSchema,
    }),
    ...(config.contextSchema !== undefined && {
      contextSchema: config.contextSchema,
    }),
    ...(config.nextTurnParams !== undefined && {
      nextTurnParams: config.nextTurnParams,
    }),
    ...(config.requireApproval !== undefined && {
      requireApproval: config.requireApproval,
    }),
    ...(config.loopKey !== undefined && {
      loopKey: config.loopKey,
    }),
    ...(config.timeoutMs !== undefined && {
      timeoutMs: config.timeoutMs,
    }),
    ...(config.maxConcurrency !== undefined && {
      maxConcurrency: config.maxConcurrency,
    }),
    ...('toModelOutput' in config &&
      config.toModelOutput !== undefined && {
        toModelOutput: config.toModelOutput,
      }),
  };

  return {
    type: ToolType.Function,
    function: functionObj,
  };
}

//#endregion

//#region tool.background() / tool.deferred() Builders

/**
 * Request shape shared by the deferred completion methods (`.resolve()` /
 * `.fail()` / `.cancel()`). `run` continues the conversation immediately;
 * omit it to record the result on state for the next `callModel({ state })`.
 */
type DeferredCompletionBase = {
  state: StateAccessor<readonly Tool[]>;
  taskId: string;
  /**
   * Continue the conversation immediately with this run configuration
   * (model, extra tools, stopWhen, ...). The deferred tool includes itself
   * in the run's tools automatically.
   */
  run?: DeferredRunConfig;
  /** Behavior when the task is already settled. Default 'throw'. */
  ifSettled?: 'throw' | 'ignore';
};

/** Run config accepted by the deferred completion methods. */
type DeferredRunConfig = Omit<
  CallModelInput<readonly Tool[]>,
  'state' | 'input' | 'approveToolCalls' | 'rejectToolCalls'
>;

/**
 * Typed completion methods attached to every tool built by `tool.deferred()`.
 * Thin wrappers over `resumeToolResults()` with the tool reference bound, so
 * `output` is checked against the tool's `outputSchema` at compile time and
 * runtime.
 *
 * SECURITY: these methods inject values the model treats as tool results.
 * Authenticate the webhook/caller before invoking them — the SDK cannot.
 */
export interface DeferredToolMethods<TOutput> {
  /**
   * Supply the task's successful result (typed by the tool's outputSchema).
   * With `run` config the conversation continues immediately and the
   * `ModelResult` is returned; without, the result is recorded on state and
   * `null` is returned — the next `callModel({ state })` delivers it.
   */
  resolve(
    client: OpenRouterCore,
    request: DeferredCompletionBase & {
      output: TOutput;
    },
    options?: RequestOptions,
  ): Promise<ModelResult<readonly Tool[]> | null>;
  /** Report the task as failed. Same continue-or-record semantics as resolve. */
  fail(
    client: OpenRouterCore,
    request: DeferredCompletionBase & {
      error: string | Error;
    },
    options?: RequestOptions,
  ): Promise<ModelResult<readonly Tool[]> | null>;
  /** Cancel the task. Same continue-or-record semantics as resolve. */
  cancel(
    client: OpenRouterCore,
    request: DeferredCompletionBase & {
      reason?: string;
    },
    options?: RequestOptions,
  ): Promise<ModelResult<readonly Tool[]> | null>;
}

/**
 * A built deferred tool: the tool wrapper plus its typed completion methods.
 * Structurally still a `DeferredTool`, so it flows into `tools: [...]`
 * arrays unchanged.
 */
export type BuiltDeferredTool<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
> = DeferredTool<TInput, TOutput, Record<string, unknown>, TCtx> &
  DeferredToolMethods<zodInfer<TOutput>>;

/** Copy shared BaseToolFunction config fields onto a function object. */
function assignCommonToolFields(
  fn: Record<string, unknown>,
  config: {
    description?: string;
    contextSchema?: unknown;
    nextTurnParams?: unknown;
    requireApproval?: unknown;
    loopKey?: unknown;
    timeoutMs?: number;
    maxConcurrency?: number;
    toModelOutput?: unknown;
  },
): void {
  const fields = [
    'description',
    'contextSchema',
    'nextTurnParams',
    'requireApproval',
    'loopKey',
    'timeoutMs',
    'maxConcurrency',
    'toModelOutput',
  ] as const;
  for (const field of fields) {
    if (config[field] !== undefined) {
      fn[field] = config[field];
    }
  }
}

/**
 * Create a background tool: an ordinary async `execute` that the loop does
 * not wait for. Work settling within `graceMs` (default 250ms) produces a
 * plain synchronous output — no async machinery visible; otherwise the model
 * receives a pending placeholder immediately, the loop continues, and the
 * return value is injected into the conversation when it settles.
 *
 * @example
 * ```typescript
 * const renderVideo = tool.background({
 *   name: 'render_video',
 *   inputSchema: z.object({ script: z.string() }),
 *   eventSchema: z.object({ pct: z.number() }),
 *   outputSchema: z.object({ url: z.string() }),
 *   ack: 'Rendering started — the result arrives automatically.',
 *   timeoutMs: 300_000,
 *   execute: async ({ script }, ctx) => {
 *     const job = await renderer.start(script, { signal: ctx?.signal });
 *     for await (const p of job.progress()) ctx?.progress({ pct: p });
 *     return job.result();          // just return it
 *   },
 * });
 * ```
 */
function backgroundToolBuilder<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TEvent extends $ZodType = $ZodType<never>,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
>(
  config: BackgroundToolConfig<TInput, TOutput, TEvent, TCtx, TName>,
): BackgroundTool<TInput, TOutput, TEvent, Record<string, unknown>, TCtx> {
  if (config.name === SHARED_CONTEXT_KEY) {
    throw new Error(
      `Tool name "${SHARED_CONTEXT_KEY}" is reserved for shared context. Choose a different name.`,
    );
  }
  // Required at the type level; JavaScript callers can bypass types.
  if (config.outputSchema === undefined) {
    throw new Error(
      `Background tool "${config.name}" must declare an outputSchema. The final result is validated when it settles — possibly long after the round that started it.`,
    );
  }

  const fn: Record<string, unknown> = {
    background: true,
    name: config.name,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    execute: config.execute,
  };
  if (config.eventSchema !== undefined) {
    fn['eventSchema'] = config.eventSchema;
  }
  if (config.ack !== undefined) {
    fn['ack'] = config.ack;
  }
  if (config.graceMs !== undefined) {
    fn['graceMs'] = config.graceMs;
  }
  assignCommonToolFields(fn, config);

  return {
    type: ToolType.Function,
    function: fn as unknown as BackgroundTool<
      TInput,
      TOutput,
      TEvent,
      Record<string, unknown>,
      TCtx
    >['function'],
  };
}

/**
 * Bind one deferred completion method: resolve the entry shape, prepend the
 * tool itself to any `run` tools, and dispatch through `resumeToolResults`.
 * The resume module is imported lazily to avoid a static
 * tool.ts → call-model.ts → model-result.ts import cycle.
 */
function bindDeferredCompletion(
  toolValue: Tool,
  toEntry: (request: Record<string, unknown>) => Record<string, unknown>,
): (
  client: OpenRouterCore,
  request: DeferredCompletionBase & Record<string, unknown>,
  options?: RequestOptions,
) => Promise<ModelResult<readonly Tool[]> | null> {
  return async (client, request, options) => {
    const { resumeToolResults } = await import('../inner-loop/resume-tool-results.js');
    const run = request.run;
    return resumeToolResults<readonly Tool[]>(
      client,
      {
        state: request.state,
        tools: [
          toolValue,
        ],
        results: [
          {
            taskId: request.taskId,
            ...toEntry(request),
          } as never,
        ],
        ...(request.ifSettled !== undefined && {
          ifSettled: request.ifSettled,
        }),
        ...(run !== undefined && {
          run: {
            ...run,
            tools: [
              toolValue,
              ...(run.tools ?? []).filter((t) => t !== toolValue),
            ],
          },
        }),
      },
      options,
    );
  };
}

/**
 * Create a deferred tool: `start` kicks off durable external work (a
 * webhook-backed job, a human review) and returns a plain `{ taskId }` — the
 * model receives a pending placeholder and the run pauses
 * (`status: 'awaiting_async_tools'`) until the task is completed via the
 * tool's typed `.resolve()` / `.fail()` / `.cancel()` methods, possibly from
 * another process. Return `{ output }` instead for an immediate result.
 *
 * @example
 * ```typescript
 * const legalReview = tool.deferred({
 *   name: 'request_legal_review',
 *   inputSchema: z.object({ contractId: z.string() }),
 *   outputSchema: z.object({ approved: z.boolean() }),
 *   start: async ({ contractId }, ctx) => {
 *     const ticket = await legal.open(contractId, { conversationId: ctx?.conversationId });
 *     return { taskId: ticket.id };
 *   },
 * });
 *
 * // webhook handler — different process, days later:
 * await legalReview.resolve(client, {
 *   state: makeAccessor(conversationId),
 *   taskId: ticketId,
 *   output: { approved: true },   // ← typed by outputSchema
 *   run: { model: 'openai/gpt-4o' },
 * });
 * ```
 */
function deferredToolBuilder<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
>(
  config: DeferredToolConfig<TInput, TOutput, TCtx, TName>,
): BuiltDeferredTool<TInput, TOutput, TCtx> {
  if (config.name === SHARED_CONTEXT_KEY) {
    throw new Error(
      `Tool name "${SHARED_CONTEXT_KEY}" is reserved for shared context. Choose a different name.`,
    );
  }
  // Required at the type level; JavaScript callers can bypass types.
  if (config.outputSchema === undefined) {
    throw new Error(
      `Deferred tool "${config.name}" must declare an outputSchema. Caller-supplied resolutions are validated before the model sees them.`,
    );
  }

  const fn: Record<string, unknown> = {
    name: config.name,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    start: config.start,
  };
  if (config.ack !== undefined) {
    fn['ack'] = config.ack;
  }
  if (config.pollAfterMs !== undefined) {
    fn['pollAfterMs'] = config.pollAfterMs;
  }
  assignCommonToolFields(fn, config);

  const toolValue = {
    type: ToolType.Function,
    function: fn as unknown as DeferredTool<
      TInput,
      TOutput,
      Record<string, unknown>,
      TCtx
    >['function'],
  };

  return Object.assign(toolValue, {
    resolve: bindDeferredCompletion(toolValue, (request) => ({
      output: request['output'],
    })),
    fail: bindDeferredCompletion(toolValue, (request) => ({
      error:
        request['error'] instanceof Error
          ? request['error'].message
          : String(request['error'] ?? 'Task failed'),
    })),
    cancel: bindDeferredCompletion(toolValue, (request) => ({
      error: typeof request['reason'] === 'string' ? request['reason'] : 'Task cancelled',
      status: 'cancelled',
    })),
  }) as BuiltDeferredTool<TInput, TOutput, TCtx>;
}

// Attach the namespaced builders. Expando properties on a function
// declaration merge into its type, so `tool.background(...)` and
// `tool.deferred(...)` are fully typed at the call site.
tool.background = backgroundToolBuilder;
tool.deferred = deferredToolBuilder;

//#endregion

//#region serverTool() Factory

/**
 * Creates an OpenRouter server-executed tool. OpenRouter runs the tool (web
 * search, datetime, image generation, etc.) and returns the output item in
 * the response — no client-side execute function is needed.
 *
 * The config shape is derived directly from the SDK's request-tool union
 * (`models.ResponsesRequestToolUnion`) via `Exclude` + `Extract`, so new
 * server-tool variants added upstream become valid here with zero changes
 * in this SDK. Provide the `type` literal and the remaining fields narrow
 * to match the chosen tool.
 *
 * @example
 * ```typescript
 * const tools = [
 *   serverTool({ type: 'web_search_2025_08_26', engine: 'exa', maxResults: 10 }),
 *   serverTool({ type: 'openrouter:datetime', parameters: { timezone: 'UTC' } }),
 *   serverTool({ type: 'image_generation', size: '1024x1024', quality: 'high' }),
 * ];
 * ```
 */
export function serverTool<T extends ServerToolType>(
  config: Extract<
    ServerToolConfig,
    {
      type: T;
    }
  >,
): ServerTool<T> {
  return {
    _brand: 'server-tool',
    config,
  };
}

/**
 * Add the additive MCP brand to an already-built client tool (see
 * {@link McpBranded}). Non-mutating: returns a shallow copy carrying `_mcp`, so
 * the tool's runtime behavior and wire shape are unchanged — only its type (and
 * the runtime {@link isMcpTool} check) now identify it as MCP-originated. Used
 * by `@openrouter/mcp` to mark wrapped remote tools.
 *
 * `options.loopKey` attaches a doom-loop identity to the wrapped tool —
 * the only injection point for MCP tools, whose remote definitions cannot
 * carry client-side functions. Prefer the declarative field-list form
 * (data, not code): it round-trips through serializable tool caches.
 */
export function markMcp<T extends Tool>(
  toolToMark: T,
  options?: {
    loopKey?: ToolLoopKey<Record<string, unknown>>;
  },
): McpBranded<T> {
  const marked = {
    ...toolToMark,
    _mcp: true as const,
  };
  if (options?.loopKey !== undefined && isClientTool(marked)) {
    marked.function = {
      ...marked.function,
      loopKey: options.loopKey,
    };
  }
  return marked;
}

//#endregion
