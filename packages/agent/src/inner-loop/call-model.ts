import type { OpenRouterCore } from '@openrouter/sdk/core';
import type { RequestOptions } from '@openrouter/sdk/lib/sdks';
import type { $ZodObject, $ZodShape, infer as zodInfer } from 'zod/v4/core';
import type { CallModelInput } from '../lib/async-params.js';
import { resolveHooks } from '../lib/hooks-resolve.js';
import type { GetResponseOptions } from '../lib/model-result.js';
import { ModelResult } from '../lib/model-result.js';
import { buildTaskToolApiDefinition, needsTaskTool } from '../lib/tool-check.js';
import { convertToolsToAPIFormat, convertZodToJsonSchema } from '../lib/tool-executor.js';
import type { Tool } from '../lib/tool-types.js';
import { isServerTool } from '../lib/tool-types.js';

// Re-export CallModelInput for convenience
export type { CallModelInput } from '../lib/async-params.js';

/**
 * Get a response with multiple consumption patterns
 *
 * @remarks
 * Creates a response using the OpenResponses API and returns
 * a wrapper that allows consuming the response in multiple ways:
 *
 * - `await response.getText()` - Get just the text content (tools auto-executed)
 * - `await response.getResponse()` - Get full response with usage data (inputTokens, cachedTokens, etc.)
 * - `for await (const delta of response.getTextStream())` - Stream text deltas
 * - `for await (const delta of response.getReasoningStream())` - Stream reasoning deltas
 * - `for await (const event of response.getToolStream())` - Stream tool events (incl. preliminary results)
 * - `for await (const toolCall of response.getToolCallsStream())` - Stream structured tool calls
 * - `await response.getToolCalls()` - Get all tool calls from completed response
 * - `for await (const msg of response.getNewMessagesStream())` - Stream cumulative message snapshots
 * - `for await (const event of response.getFullResponsesStream())` - Stream all events (incl. tool preliminary)
 *
 * All consumption patterns can be used concurrently on the same response.
 *
 * **Context:**
 *
 * Tools can declare a `contextSchema` to receive typed context data.
 * The `context` parameter on callModel is typed as the intersection of all tool schemas:
 *
 * @example
 * ```typescript
 * const result = callModel(client, {
 *   model: 'gpt-4',
 *   input: 'Hello',
 *   tools: [weatherTool, dbTool] as const,
 *   context: {
 *     get_weather: { apiKey: 'sk-...' },
 *     db_query: { dbUrl: 'postgres://...' },
 *   },
 * });
 * ```
 *
 * Context can also be a function or async function:
 * ```typescript
 * context: (turn) => ({
 *   get_weather: { apiKey: turn.numberOfTurns > 1 ? refreshedKey : initialKey },
 * })
 * ```
 *
 * **Stop Conditions:**
 *
 * Control when tool execution stops using the `stopWhen` parameter:
 *
 * @example
 * ```typescript
 * stopWhen: stepCountIs(3)
 * stopWhen: [stepCountIs(10), maxCost(0.50), hasToolCall('finalize')]
 * ```
 *
 * If `stopWhen` is omitted, the loop runs until the model produces a turn
 * with no tool calls. Pass `stopWhen` to bound iterations, cost, or tokens.
 *
 * **Final Response After Stop:**
 *
 * When `stopWhen` fires while the model is still emitting tool calls, the
 * loop makes one final model turn with `toolChoice: 'none'` (tools stay in
 * the request to preserve the prompt cache) so the run ends with a
 * natural-language answer rather than a half-finished tool call. This is
 * the default; `allowFinalResponse` tunes it: `true`/omitted appends a
 * default final-answer directive as a user message, a non-empty string
 * replaces the wording, `''` appends nothing, `false` disables the final
 * turn entirely.
 */
export function callModel<
  TTools extends readonly Tool[],
  TSharedSchema extends $ZodObject<$ZodShape> | undefined = undefined,
  TShared extends Record<string, unknown> = TSharedSchema extends $ZodObject<$ZodShape>
    ? zodInfer<TSharedSchema>
    : Record<string, never>,
>(
  client: OpenRouterCore,
  request: CallModelInput<TTools, TShared> & {
    sharedContextSchema?: TSharedSchema;
  },
  options?: RequestOptions,
): ModelResult<TTools, TShared> {
  // Destructure state management options along with tools and stopWhen
  const {
    tools,
    activeTools,
    stopWhen,
    state,
    requireApproval,
    approveToolCalls,
    rejectToolCalls,
    context,
    sharedContextSchema,
    onTurnStart,
    onTurnEnd,
    allowFinalResponse,
    strictFinalResponse,
    hooks,
    doomLoop,
    signal,
    toolTimeoutMs,
    toolConcurrency,
    asyncTools,
    ...apiRequest
  } = request;

  // Narrow tools to the active subset (if provided) before API conversion and
  // before they are registered for execution, so the model cannot call filtered
  // tools and the executor does not carry orphaned definitions.
  const activeSet = activeTools ? new Set(activeTools) : undefined;
  const activeFilteredTools = activeSet
    ? tools?.filter((t) => isServerTool(t) || activeSet.has(t.function.name))
    : tools;

  // Collapse a filtered-to-empty (or explicitly empty) tools list to
  // `undefined` so a fully-deactivated tool set (a first-class output of
  // `inferTools()`/`.resolve()`) omits the outbound `tools` key entirely
  // instead of sending `tools: []` — several providers reject an empty
  // array outright. `ModelResult` treats `undefined` as its no-tools state
  // (see the `?.length` / truthiness checks throughout), so this also keeps
  // the engine's tool-execution machinery correctly disabled.
  const filteredTools = activeFilteredTools?.length ? activeFilteredTools : undefined;

  // Convert tools to API format - no cast needed now that convertToolsToAPIFormat accepts readonly
  const apiTools = filteredTools ? convertToolsToAPIFormat(filteredTools) : undefined;

  // Append the single universal `task` tool when any long-running tool is
  // registered (and check-ins aren't disabled): ONE static wire definition
  // for check/steer/result/cancel across every async tool — per-tool
  // context cost stays constant regardless of the tool count. Appended
  // here (not per-request in ModelResult) so `resolvedRequest.tools` stays
  // stable across turns. Calls to it are engine-intercepted.
  if (apiTools && tools && asyncTools?.checkins !== false && needsTaskTool(tools)) {
    apiTools.push(buildTaskToolApiDefinition(convertZodToJsonSchema));
  }

  // Build the request with converted tools
  // Note: async functions are resolved later in ModelResult.executeToolsIfNeeded()
  // The request can have async fields (functions) or sync fields, and the tools are converted to API format
  const finalRequest: Record<string, unknown> = {
    ...apiRequest,
  };

  if (apiTools !== undefined) {
    finalRequest['tools'] = apiTools;
  }

  // Inject x-openrouter-callmodel header into every callModel request
  const callModelOptions: RequestOptions = {
    ...options,
    headers: {
      ...Object.fromEntries(
        new Headers(options?.headers ?? options?.fetchOptions?.headers ?? undefined),
      ),
      'x-openrouter-callmodel': 'true',
    },
  };

  // Assemble engine options, then drop undefined entries so optional keys
  // are ABSENT (not present-as-undefined) — same semantics as the previous
  // per-key conditional spreads without a branch per option.
  const engineOptions: Record<string, unknown> = {
    client,
    request: finalRequest,
    options: callModelOptions,
    tools: filteredTools,
    stopWhen,
    state,
    requireApproval,
    approveToolCalls,
    rejectToolCalls,
    context,
    sharedContextSchema,
    onTurnStart,
    onTurnEnd,
    allowFinalResponse,
    strictFinalResponse,
    hooks: hooks !== undefined ? resolveHooks(hooks) : undefined,
    doomLoop,
    signal,
    toolTimeoutMs,
    toolConcurrency,
    asyncTools,
  };
  for (const key of Object.keys(engineOptions)) {
    if (engineOptions[key] === undefined) {
      delete engineOptions[key];
    }
  }

  return new ModelResult<TTools, TShared>(
    engineOptions as unknown as GetResponseOptions<TTools, TShared>,
  );
}
