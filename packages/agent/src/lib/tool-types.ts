import type * as models from '@openrouter/sdk/models';
import type { StreamEvents } from '@openrouter/sdk/models';
import type { $ZodObject, $ZodShape, $ZodType, infer as zodInfer } from 'zod/v4/core';
import type { ModelResult } from './model-result.js';

/**
 * Tool type enum for enhanced tools
 */
export enum ToolType {
  Function = 'function',
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
}

//#region Context Types

/**
 * Extract context schema type from a tool definition
 * Returns the inferred type of the tool's contextSchema, or empty object if none
 */
export type InferToolContext<T> = T extends {
  function: {
    contextSchema: infer S;
  };
}
  ? S extends $ZodType
    ? zodInfer<S>
    : Record<string, never>
  : Record<string, never>;

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
  [K in keyof NextTurnParamsContext]?: (
    params: TInput,
    context: NextTurnParamsContext,
  ) => NextTurnParamsContext[K] | Promise<NextTurnParamsContext[K]>;
};

/**
 * Tool-level approval check function type
 * Receives the tool's input params and turn context
 * Returns true if approval is required, false otherwise
 */
export type ToolApprovalCheck<TInput> = (
  params: TInput,
  context: TurnContext,
) => boolean | Promise<boolean>;

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
export type ToModelOutputFunction<TInput, TOutput> = (params: {
  output: TOutput;
  input: TInput;
}) => ToModelOutputResult | Promise<ToModelOutputResult>;

/**
 * Base tool function interface with inputSchema
 * @template TInput - Zod schema for tool input
 */
export interface BaseToolFunction<TInput extends $ZodObject<$ZodShape>> {
  name: string;
  description?: string;
  inputSchema: TInput;
  /** Zod schema declaring the context data this tool needs */
  contextSchema?: $ZodObject<$ZodShape>;
  nextTurnParams?: NextTurnParamsFunctions<zodInfer<TInput>>;
  /**
   * Whether this tool requires human approval before execution
   * Can be a boolean or an async function that receives the tool's input params and context
   */
  requireApproval?: boolean | ToolApprovalCheck<zodInfer<TInput>>;
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
> extends BaseToolFunction<TInput> {
  outputSchema?: TOutput;
  execute: (
    params: zodInfer<TInput>,
    context?: ToolExecuteContext<TName, TContext>,
  ) => Promise<zodInfer<TOutput>> | zodInfer<TOutput>;
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
> extends BaseToolFunction<TInput> {
  eventSchema: TEvent;
  outputSchema: TOutput;
  execute: (
    params: zodInfer<TInput>,
    context?: ToolExecuteContext<TName, TContext>,
  ) => AsyncGenerator<zodInfer<TEvent> | zodInfer<TOutput>, zodInfer<TOutput> | undefined>;
  /** Convert tool execution output to model-facing output */
  toModelOutput?: ToModelOutputFunction<zodInfer<TInput>, zodInfer<TOutput>>;
}

/**
 * Manual tool without execute function - requires manual handling by developer
 */
export interface ManualToolFunction<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType = $ZodType<unknown>,
> extends BaseToolFunction<TInput> {
  outputSchema?: TOutput;
}

/**
 * Tool with execute function (regular or generator)
 */
export type ToolWithExecute<
  TInput extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TOutput extends $ZodType = $ZodType<unknown>,
  TContext extends Record<string, unknown> = Record<string, unknown>,
> = {
  type: ToolType.Function;
  function: ToolFunctionWithExecute<TInput, TOutput, TContext>;
};

/**
 * Tool with generator execute function
 */
export type ToolWithGenerator<
  TInput extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TEvent extends $ZodType = $ZodType<unknown>,
  TOutput extends $ZodType = $ZodType<unknown>,
  TContext extends Record<string, unknown> = Record<string, unknown>,
> = {
  type: ToolType.Function;
  function: ToolFunctionWithGenerator<TInput, TEvent, TOutput, TContext>;
};

/**
 * Tool without execute function (manual handling)
 */
export type ManualTool<
  TInput extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TOutput extends $ZodType = $ZodType<unknown>,
> = {
  type: ToolType.Function;
  function: ManualToolFunction<TInput, TOutput>;
};

/**
 * Union type of all client-executed tool shapes (function, generator, manual).
 * These run in the user's process via the agent SDK's tool execution loop.
 */
export type ClientTool =
  | ToolWithExecute<$ZodObject<$ZodShape>, $ZodType<unknown>>
  | ToolWithGenerator<$ZodObject<$ZodShape>, $ZodType<unknown>, $ZodType<unknown>>
  | ManualTool<$ZodObject<$ZodShape>, $ZodType<unknown>>;

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
 * Type guard: true if the tool is a client-executed tool (function, generator, or manual).
 */
export function isClientTool(tool: Tool): tool is ClientTool {
  return !isServerTool(tool);
}

/**
 * Type guard to check if a tool has an execute function
 */
export function hasExecuteFunction(tool: Tool): tool is ToolWithExecute | ToolWithGenerator {
  if (isServerTool(tool)) {
    return false;
  }
  return 'execute' in tool.function && typeof tool.function.execute === 'function';
}

/**
 * Type guard to check if a tool uses a generator (has eventSchema)
 */
export function isGeneratorTool(tool: Tool): tool is ToolWithGenerator {
  if (isServerTool(tool)) {
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
 * Type guard to check if a tool is a manual tool (no execute function)
 */
export function isManualTool(tool: Tool): tool is ManualTool {
  if (isServerTool(tool)) {
    return false;
  }
  return !('execute' in tool.function);
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
 * Result of tool execution
 * @template T - The tool type to infer result types from
 */
export interface ToolExecutionResult<T extends Tool> {
  toolCallId: string;
  toolName: string;
  result: T extends
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
 * Result of executeTools operation
 */
export interface ExecuteToolsResult<TTools extends readonly Tool[]> {
  finalResponse: ModelResult<TTools>;
  allResponses: ModelResult<TTools>[];
  toolResults: Map<
    string,
    {
      result: unknown;
      preliminaryResults?: unknown[];
    }
  >;
}

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
  | TurnStartEvent
  | TurnEndEvent;

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
 * Status of a conversation state
 */
export type ConversationStatus = 'complete' | 'interrupted' | 'awaiting_approval' | 'in_progress';

/**
 * State for multi-turn conversations with persistence and approval gates
 * @template TTools - The tools array type for proper type inference
 */
export interface ConversationState<TTools extends readonly Tool[] = readonly Tool[]> {
  /** Unique identifier for this conversation */
  id: string;
  /** Full message history */
  messages: models.InputsUnion;
  /** Previous response ID for chaining (OpenRouter server-side optimization) */
  previousResponseId?: string;
  /** Tool calls awaiting human approval */
  pendingToolCalls?: Array<ParsedToolCall<TTools[number]>>;
  /** Tool results executed but not yet sent to the model */
  unsentToolResults?: Array<UnsentToolResult<TTools>>;
  /** Partial response data captured during interruption */
  partialResponse?: PartialResponse<TTools>;
  /** Signal from a new request to interrupt this conversation */
  interruptedBy?: string;
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
