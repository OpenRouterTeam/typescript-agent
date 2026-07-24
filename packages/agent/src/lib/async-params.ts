import type * as models from '@openrouter/sdk/models';
import type { OpenResponsesResult } from '@openrouter/sdk/models';
import type { DoomLoopOption } from './doom-loop.js';
import type { HooksManager } from './hooks-manager.js';
import type { InlineHookConfig } from './hooks-types.js';
import type { Item } from './item-types.js';
import type { ContextInput } from './tool-context.js';
import type {
  ParsedToolCall,
  StateAccessor,
  StopWhen,
  Tool,
  ToolContextMapWithShared,
  TurnContext,
} from './tool-types.js';

// Re-export Tool type for convenience
export type { Tool } from './tool-types.js';

/**
 * Type guard to check if a value is a parameter function
 * Parameter functions take TurnContext and return a value or promise
 */
function isParameterFunction(
  value: unknown,
): value is (context: TurnContext) => unknown | Promise<unknown> {
  return typeof value === 'function';
}

/**
 * Build a resolved request object from entries
 * This validates the structure matches the expected ResolvedCallModelInput shape
 */
function buildResolvedRequest(
  entries: ReadonlyArray<
    readonly [
      string,
      unknown,
    ]
  >,
): ResolvedCallModelInput {
  const obj = Object.fromEntries(entries);

  return obj satisfies ResolvedCallModelInput;
}

/**
 * A field can be either a value of type T or a function that computes T
 */
export type FieldOrAsyncFunction<T> = T | ((context: TurnContext) => T | Promise<T>);

/**
 * Base input type for callModel without approval-related fields
 */
type BaseCallModelInput<
  TTools extends readonly Tool[] = readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, never>,
> = {
  [K in keyof Omit<models.ResponsesRequest, 'stream' | 'tools' | 'input'>]?: FieldOrAsyncFunction<
    models.ResponsesRequest[K]
  >;
} & {
  input: FieldOrAsyncFunction<Item[]> | string;
  tools?: TTools;
  stopWhen?: StopWhen<TTools>;
  /** Typed context data passed to tools via contextSchema. Includes optional `shared` key. */
  context?: ContextInput<ToolContextMapWithShared<TTools, TShared>>;
  /**
   * Call-level approval check - overrides tool-level requireApproval setting
   * Receives the tool call and turn context, can be sync or async
   */
  requireApproval?: (
    toolCall: ParsedToolCall<TTools[number]>,
    context: TurnContext,
  ) => boolean | Promise<boolean>;
  /**
   * Callback invoked at the start of each tool execution turn
   * Receives the turn context with the current turn number
   */
  onTurnStart?: (context: TurnContext) => void | Promise<void>;
  /**
   * Callback invoked at the end of each tool execution turn
   * Receives the turn context and the completed response for that turn
   */
  onTurnEnd?: (context: TurnContext, response: OpenResponsesResult) => void | Promise<void>;
  /**
   * When the loop exits because `stopWhen` was met and the last response
   * still contained tool calls, execute those pending tool calls (so they
   * have matching outputs) and then make one more model request with
   * `toolChoice: 'none'` so the model produces a final text response.
   * Tools stay in the request — only calling is forbidden — so the
   * prompt-cache prefix is preserved.
   *
   * **Default: on.** Omitting the option behaves like `true`.
   *
   * - `true` / omitted — re-prompt with the accumulated conversation and a
   *   default final-answer directive appended as a user message
   *   (`DEFAULT_FINAL_RESPONSE_DIRECTIVE`). Without the directive, models
   *   that emit tool-call syntax as text may leak an unparsed tool call
   *   into the final content.
   * - non-empty string — append that string as the final user message
   *   instead of the default (e.g. `"Please summarize what you've learned"`).
   * - `''` — no final user message; tool calls are still forbidden.
   * - `false` — no final turn; the run ends on the halted tool-call turn.
   *
   * The full accumulated input array and the original `instructions` are
   * sent. Manual (non-executable) tool calls in the halted turn are paired
   * with synthesized stub `function_call_output` items so the input is
   * well-formed. Has no effect when the loop exits for any other reason
   * (HITL pause, approval pause, interruption, or natural completion).
   */
  allowFinalResponse?: boolean | string;
  /**
   * When true, throw if the final response has an empty `output` array even
   * after completed tool rounds (legacy behavior). Default false: empty
   * finals after tool work are retried once, then accepted with empty text.
   */
  strictFinalResponse?: boolean;
  /** Hook system for lifecycle events. Accepts inline config or a HooksManager instance. */
  hooks?: InlineHookConfig | HooksManager;
  /**
   * Doom-loop detection: catch runs that repeat the same tool call with
   * identical arguments (including repeated empty or unparseable calls) or
   * emit the same text over and over, and respond with a graduated ladder
   * (observe → steer → block → stop; defaults observe@2, block@3, stop@6
   * consecutive repetitions). `true` enables recommended defaults; an
   * object tunes thresholds and text detection. Off by default.
   *
   * Tools declare precise call identity via `loopKey` (hash the search
   * query, the bash command + cwd + env, ...); without one the full
   * arguments object is the identity. `loopKey: () => null` exempts a tool
   * (legitimate polling). Detection is deterministic: the same transcript
   * always produces the same verdicts.
   */
  doomLoop?: DoomLoopOption;
  /**
   * Cancel the whole run. Aborting stops the tool-execution loop at the
   * next turn boundary AND aborts the in-flight API request/stream, so a
   * stalled provider fails fast instead of hanging until an outer test or
   * caller timeout kills the process. The run's promises reject with the
   * signal's abort reason.
   *
   * Composes with per-request `RequestOptions.timeoutMs` (the third
   * `callModel` argument): when both are set, each request is bounded by
   * whichever fires first. (Passing a raw `signal` through `RequestOptions`
   * instead would silently disable the SDK's `timeoutMs` wiring.)
   */
  signal?: AbortSignal;
};

/**
 * Approval params when state is provided (allows approve/reject)
 */
type ApprovalParamsWithState<TTools extends readonly Tool[] = readonly Tool[]> = {
  /** State accessor for multi-turn persistence and approval gates */
  state: StateAccessor<TTools>;
  /** Tool call IDs to approve (for resuming from awaiting_approval status) */
  approveToolCalls?: string[];
  /** Tool call IDs to reject (for resuming from awaiting_approval status) */
  rejectToolCalls?: string[];
};

/**
 * Approval params when state is NOT provided (forbids approve/reject)
 */
type ApprovalParamsWithoutState = {
  /** State accessor for multi-turn persistence and approval gates */
  state?: undefined;
  /** Not allowed without state - will cause type error */
  approveToolCalls?: never;
  /** Not allowed without state - will cause type error */
  rejectToolCalls?: never;
};

/**
 * Input type for callModel function
 * Each field can independently be a static value or a function that computes the value
 * Generic over TTools to enable proper type inference for stopWhen conditions
 *
 * Type enforcement:
 * - `approveToolCalls` and `rejectToolCalls` are only valid when `state` is provided
 * - Using these without `state` will cause a TypeScript error
 */
export type CallModelInput<
  TTools extends readonly Tool[] = readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, never>,
> = BaseCallModelInput<TTools, TShared> &
  (ApprovalParamsWithState<TTools> | ApprovalParamsWithoutState);

/**
 * CallModelInput variant that requires state - use when approval workflows are needed
 */
export type CallModelInputWithState<
  TTools extends readonly Tool[] = readonly Tool[],
  TShared extends Record<string, unknown> = Record<string, never>,
> = BaseCallModelInput<TTools, TShared> & ApprovalParamsWithState<TTools>;

/**
 * Resolved CallModelInput (all functions evaluated to values)
 * This is the type after all async functions have been resolved to their values
 */
export type ResolvedCallModelInput = Omit<models.ResponsesRequest, 'stream' | 'tools'> & {
  tools?: never;
};

/**
 * Resolve all async functions in CallModelInput to their values
 *
 * @param input - Input with possible functions
 * @param context - Turn context for function execution
 * @returns Resolved input with all values (no functions)
 *
 * @example
 * ```typescript
 * const resolved = await resolveAsyncFunctions(
 *   {
 *     model: 'gpt-4',
 *     temperature: (ctx) => ctx.numberOfTurns * 0.1,
 *     input: 'Hello',
 *   },
 *   { numberOfTurns: 2 }
 * );
 * // resolved.temperature === 0.2
 * ```
 */
export async function resolveAsyncFunctions<TTools extends readonly Tool[] = readonly Tool[]>(
  input: CallModelInput<TTools>,
  context: TurnContext,
): Promise<ResolvedCallModelInput> {
  // Build array of resolved entries
  const resolvedEntries: Array<
    readonly [
      string,
      unknown,
    ]
  > = [];

  // Fields that should not be sent to the API (client-side only)
  const clientOnlyFields = new Set([
    'stopWhen', // Handled separately in ModelResult
    'state', // Client-side state management
    'requireApproval', // Client-side approval check function
    'approveToolCalls', // Client-side approval decisions
    'rejectToolCalls', // Client-side rejection decisions
    'context', // Passed through via GetResponseOptions, not sent to API
    'sharedContextSchema', // Client-side schema for shared context validation
    'onTurnStart', // Client-side turn start callback
    'onTurnEnd', // Client-side turn end callback
    'allowFinalResponse', // Client-side: tunes the default toolChoice:'none' final turn when stopWhen breaks the loop
    'strictFinalResponse', // Client-side: restore throw on empty final after tool rounds
    'hooks', // Client-side hook system
    'doomLoop', // Client-side doom-loop detection config
    'signal', // Client-side run cancellation
  ]);

  // Iterate over all keys in the input
  for (const [key, value] of Object.entries(input)) {
    // Skip client-only fields - they're handled separately and shouldn't be sent to the API
    // Note: tools are already in API format at this point (converted in callModel()), so we include them
    if (clientOnlyFields.has(key)) {
      continue;
    }

    if (isParameterFunction(value)) {
      try {
        // Execute the function with context and store the result
        const result = await Promise.resolve(value(context));
        resolvedEntries.push([
          key,
          result,
        ] as const);
      } catch (error) {
        // Wrap errors with context about which field failed
        throw new Error(
          `Failed to resolve async function for field "${key}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      // Not a function, use as-is
      resolvedEntries.push([
        key,
        value,
      ] as const);
    }
  }

  return buildResolvedRequest(resolvedEntries);
}

/**
 * Check if input has any async functions that need resolution
 *
 * @param input - Input to check
 * @returns True if any field is a function
 */
export function hasAsyncFunctions(input: unknown): boolean {
  if (!input || typeof input !== 'object') {
    return false;
  }
  return Object.values(input).some((value) => typeof value === 'function');
}
