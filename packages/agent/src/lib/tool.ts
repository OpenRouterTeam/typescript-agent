import type { $ZodObject, $ZodShape, $ZodType, infer as zodInfer } from 'zod/v4/core';
import type {
  ContextFromSchema,
  HITLTool,
  ManualTool,
  McpBranded,
  NextTurnParamsFunctions,
  ServerTool,
  ServerToolConfig,
  ServerToolType,
  ToModelOutputFunction,
  Tool,
  ToolApprovalCheck,
  ToolExecuteContext,
  ToolWithExecute,
  ToolWithGenerator,
} from './tool-types.js';
import { SHARED_CONTEXT_KEY, ToolType } from './tool-types.js';

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
  TName extends string = string,
> = {
  name: TName;
  description?: string;
  inputSchema: TInput;
  /** Zod schema declaring the context data this tool needs */
  contextSchema?: TCtx;
  nextTurnParams?: NextTurnParamsFunctions<zodInfer<TInput>>;
  requireApproval?: boolean | ToolApprovalCheck<zodInfer<TInput>>;
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
): ToolWithGenerator<TInput, TEvent, TOutput, Record<string, unknown>, TCtx, TName>;

// Overload for HITL tools (when onToolCalled is provided)
export function tool<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
>(
  config: HITLToolConfig<TInput, TOutput, TCtx, TName>,
): HITLTool<TInput, TOutput, Record<string, unknown>, TCtx, TName>;

// Overload for manual tools (execute: false)
export function tool<
  TInput extends $ZodObject<$ZodShape>,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
>(
  config: ManualToolConfig<TInput, TCtx, TName>,
): ManualTool<TInput, $ZodType<unknown>, TCtx, TName>;

// Overload for regular tools with outputSchema
export function tool<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
>(
  config: RegularToolConfigWithOutput<TInput, TOutput, TCtx, TName>,
): ToolWithExecute<TInput, TOutput, Record<string, unknown>, TCtx, TName>;

// Overload for regular tools without outputSchema (infers return type)
export function tool<
  TInput extends $ZodObject<$ZodShape>,
  TReturn,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
>(
  config: RegularToolConfigWithoutOutput<TInput, TReturn, TCtx, TName>,
): ToolWithExecute<TInput, $ZodType<TReturn>, Record<string, unknown>, TCtx, TName>;

// Overload for explicit TShared: tool<SharedContext>({...})
// When a non-ZodObject type is provided as the first generic,
// the specific overloads above won't match (constraint mismatch),
// so TypeScript falls through to this catch-all.
export function tool<
  TShared extends Record<string, unknown>,
  TName extends string = string,
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
>(
  config: ToolConfigWithSharedContext<TShared, TCtx> & {
    name: TName;
  },
): Tool & {
  function: {
    name: TName;
  };
};

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

//#region serverTool() Factory

/**
 * Options for {@link serverTool}.
 * @template TId Stable tool-set identity used by `@openrouter/agent-tool-set`.
 */
export type ServerToolOptions<TId extends string = string> = {
  /**
   * Override the default tool-set ID (`server:${config.type}`).
   * Useful when two server tools of the same type need distinct activation IDs.
   */
  id?: TId;
};

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
 * Each server tool carries a stable tool-set `id` (default `server:${type}`)
 * so activation APIs can address it. Override via the optional second argument.
 *
 * @example
 * ```typescript
 * const tools = [
 *   serverTool({ type: 'web_search_2025_08_26', engine: 'exa', maxResults: 10 }),
 *   serverTool({ type: 'openrouter:datetime', parameters: { timezone: 'UTC' } }),
 *   serverTool({ type: 'image_generation', size: '1024x1024', quality: 'high' }),
 *   serverTool({ type: 'web_search_2025_08_26' }, { id: 'server:public_search' }),
 * ];
 * ```
 */
export function serverTool<T extends ServerToolType, TId extends string = `server:${T}`>(
  config: Extract<
    ServerToolConfig,
    {
      type: T;
    }
  >,
  options?: ServerToolOptions<TId>,
): ServerTool<T, TId> {
  if (options?.id === '') {
    throw new Error('Server tool ID must not be empty');
  }
  const id = (options?.id ?? (`server:${config.type}` as const)) as TId;
  return {
    _brand: 'server-tool',
    config,
    id,
  };
}

/**
 * Add the additive MCP brand to an already-built client tool (see
 * {@link McpBranded}). Non-mutating: returns a shallow copy carrying `_mcp`, so
 * the tool's runtime behavior and wire shape are unchanged — only its type (and
 * the runtime {@link isMcpTool} check) now identify it as MCP-originated. Used
 * by `@openrouter/mcp` to mark wrapped remote tools.
 */
export function markMcp<T extends Tool>(toolToMark: T): McpBranded<T> {
  return {
    ...toolToMark,
    _mcp: true as const,
  };
}

//#endregion
