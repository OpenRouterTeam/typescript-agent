import type * as models from '@openrouter/sdk/models';
import * as z4 from 'zod/v4';
import type { $ZodObject, $ZodShape, $ZodType } from 'zod/v4/core';
import { isContentArray } from './conversation-state.js';
import { isFunctionCallItem, isFunctionCallOutputItem } from './stream-type-guards.js';
import type { ToolContextStore } from './tool-context.js';
import { buildToolExecuteContext } from './tool-context.js';
import type {
  APITool,
  ClientTool,
  HITLTool,
  ParsedToolCall,
  Tool,
  ToolExecuteContext,
  ToolExecutionResult,
  TurnContext,
} from './tool-types.js';
import {
  hasExecuteFunction,
  isGeneratorTool,
  isHITLTool,
  isMcpTool,
  isRegularExecuteTool,
  isServerTool,
} from './tool-types.js';

// Re-export ZodError for convenience
export const ZodError = z4.ZodError;

/**
 * Typeguard to check if a value is a non-null object (not an array).
 */
function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively remove keys prefixed with ~ from an object.
 * These are metadata properties (like ~standard from Standard Schema)
 * that should not be sent to downstream providers.
 * @see https://github.com/OpenRouterTeam/typescript-sdk/issues/131
 *
 * When given a Record<string, unknown>, returns Record<string, unknown>.
 * When given unknown, returns unknown (preserves primitives, null, etc).
 */
export function sanitizeJsonSchema(obj: Record<string, unknown>): Record<string, unknown>;
export function sanitizeJsonSchema(obj: unknown): unknown;
export function sanitizeJsonSchema(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeJsonSchema);
  }

  // At this point, obj is a non-null, non-array object
  // Use typeguard to narrow the type for type-safe property access
  if (!isNonNullObject(obj)) {
    return obj;
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (!key.startsWith('~')) {
      result[key] = sanitizeJsonSchema(obj[key]);
    }
  }
  return result;
}

/**
 * Typeguard to check if a value is a valid Zod schema compatible with zod/v4.
 * Zod schemas have a _zod property that contains schema metadata.
 */
function isZodSchema(value: unknown): value is z4.ZodType {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('_zod' in value)) {
    return false;
  }
  // After the 'in' check, TypeScript knows value has _zod property
  return typeof value._zod === 'object';
}

/**
 * Convert a Zod schema to JSON Schema using Zod v4's toJSONSchema function.
 * Accepts ZodType from the main zod package for user compatibility.
 * The resulting schema is sanitized to remove metadata properties (like ~standard)
 * that would cause 400 errors with downstream providers.
 */
export function convertZodToJsonSchema(zodSchema: $ZodType): Record<string, unknown> {
  if (!isZodSchema(zodSchema)) {
    throw new Error('Invalid Zod schema provided');
  }
  // Use draft-7 as it's closest to OpenAPI 3.0's JSON Schema variant
  const jsonSchema = z4.toJSONSchema(zodSchema, {
    target: 'draft-7',
  });
  // jsonSchema is always a Record<string, unknown> from toJSONSchema
  // The overloaded sanitizeJsonSchema preserves this type
  return sanitizeJsonSchema(jsonSchema);
}

/**
 * Convert tools to OpenRouter API format. Server tools pass their SDK-shaped
 * config through untouched; client tools are packaged into the function-call
 * shape. Return type widens to the SDK's full request-tool union so any new
 * server-tool variant added upstream flows through automatically.
 */
export function convertToolsToAPIFormat(
  tools: readonly Tool[],
): Array<models.ResponsesRequestToolUnion> {
  return tools.map((tool) => {
    if (isServerTool(tool)) {
      return tool.config;
    }
    const apiTool: APITool = {
      type: 'function' as const,
      name: tool.function.name,
      description: tool.function.description || null,
      strict: null,
      parameters: convertZodToJsonSchema(tool.function.inputSchema),
    };
    return apiTool;
  });
}

/**
 * Validate tool input against Zod schema
 * @throws ZodError if validation fails
 */
export function validateToolInput<T>(schema: $ZodType<T>, args: unknown): T {
  return z4.parse(schema, args);
}

/**
 * Validate tool output against Zod schema
 * @throws ZodError if validation fails
 */
export function validateToolOutput<T>(schema: $ZodType<T>, result: unknown): T {
  return z4.parse(schema, result);
}

/**
 * Try to validate a value against a Zod schema without throwing
 * @returns true if validation succeeds, false otherwise
 */
function tryValidate(schema: $ZodType, value: unknown): boolean {
  const result = z4.safeParse(schema, value);
  return result.success;
}

/**
 * Parse tool call arguments from JSON string.
 * Treats empty/whitespace-only strings as an empty object — some providers
 * return `arguments: ""` for tools that take no parameters.
 */
export function parseToolCallArguments(argumentsString: string): unknown {
  const trimmed = argumentsString.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `Failed to parse tool call arguments: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Build a ToolExecuteContext for a tool from a TurnContext and optional context store
 */
// biome-ignore lint: parameters match the internal API shape
function buildExecuteCtx(
  tool: ClientTool,
  turnContext: TurnContext,
  contextStore?: ToolContextStore,
  sharedSchema?: $ZodObject<$ZodShape>,
): ToolExecuteContext {
  return buildToolExecuteContext(
    turnContext,
    contextStore,
    tool.function.name,
    tool.function.contextSchema,
    sharedSchema,
  );
}

/**
 * Execute a regular (non-generator) tool
 */
// biome-ignore lint: parameters match the internal API shape
export async function executeRegularTool(
  tool: Tool,
  toolCall: ParsedToolCall<Tool>,
  context: TurnContext,
  contextStore?: ToolContextStore,
  sharedSchema?: $ZodObject<$ZodShape>,
): Promise<ToolExecutionResult<Tool>> {
  if (!isRegularExecuteTool(tool)) {
    throw new Error(
      `Tool "${toolCall.name}" is not a regular execute tool or has no execute function`,
    );
  }

  const source = isMcpTool(tool) ? 'mcp' : 'client';

  try {
    const validatedInput = validateToolInput(tool.function.inputSchema, toolCall.arguments);
    const executeContext = buildExecuteCtx(tool, context, contextStore, sharedSchema);

    // Execute tool with context
    const result = await Promise.resolve(tool.function.execute(validatedInput, executeContext));

    // Validate output if schema is provided
    if (tool.function.outputSchema) {
      const validatedOutput = validateToolOutput(tool.function.outputSchema, result);

      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        source,
        result: validatedOutput,
      };
    }

    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      source,
      result,
    };
  } catch (error) {
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      source,
      result: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Execute a generator tool and collect preliminary and final results
 * - Intermediate yields are validated against eventSchema (preliminary events)
 * - Last yield is validated against outputSchema (final result sent to model)
 * - Generator must emit at least one value
 */
// biome-ignore lint: parameters match the internal API shape
export async function executeGeneratorTool(
  tool: Tool,
  toolCall: ParsedToolCall<Tool>,
  context: TurnContext,
  onPreliminaryResult?: (toolCallId: string, result: unknown) => void,
  contextStore?: ToolContextStore,
  sharedSchema?: $ZodObject<$ZodShape>,
): Promise<ToolExecutionResult<Tool>> {
  if (!isGeneratorTool(tool)) {
    throw new Error(`Tool "${toolCall.name}" is not a generator tool`);
  }

  const source = isMcpTool(tool) ? 'mcp' : 'client';

  try {
    const validatedInput = validateToolInput(tool.function.inputSchema, toolCall.arguments);
    const executeContext = buildExecuteCtx(tool, context, contextStore, sharedSchema);

    const preliminaryResults: unknown[] = [];
    let finalResult: unknown;
    let hasFinalResult = false;
    let lastEmittedValue: unknown;
    let hasEmittedValue = false;

    const iterator = tool.function.execute(validatedInput, executeContext);
    let iterResult = await iterator.next();

    while (!iterResult.done) {
      const event = iterResult.value;
      lastEmittedValue = event;
      hasEmittedValue = true;

      const matchesOutputSchema = tryValidate(tool.function.outputSchema, event);
      const matchesEventSchema = tryValidate(tool.function.eventSchema, event);

      if (matchesOutputSchema && !matchesEventSchema && !hasFinalResult) {
        finalResult = validateToolOutput(tool.function.outputSchema, event);
        hasFinalResult = true;
      } else {
        const validatedPreliminary = validateToolOutput(tool.function.eventSchema, event);
        preliminaryResults.push(validatedPreliminary);
        if (onPreliminaryResult) {
          onPreliminaryResult(toolCall.id, validatedPreliminary);
        }
      }

      iterResult = await iterator.next();
    }

    if (iterResult.value !== undefined) {
      finalResult = validateToolOutput(tool.function.outputSchema, iterResult.value);
      hasFinalResult = true;
    }

    if (!hasFinalResult) {
      if (!hasEmittedValue) {
        throw new Error(
          `Generator tool "${toolCall.name}" completed without emitting any values or returning a result`,
        );
      }
      finalResult = validateToolOutput(tool.function.outputSchema, lastEmittedValue);
    }

    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      source,
      result: finalResult,
      preliminaryResults,
    };
  } catch (error) {
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      source,
      result: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Execute a HITL tool's `onToolCalled` hook.
 *
 * Returns:
 * - `ToolExecutionResult` if the hook produced a value (short-circuit, send to model)
 * - `null` if the hook returned `null` (pause — treat as manual tool)
 * - `ToolExecutionResult` with `error` set if the hook threw
 */
// biome-ignore lint: parameters match the internal API shape
export async function executeHITLTool(
  tool: Tool,
  toolCall: ParsedToolCall<Tool>,
  context: TurnContext,
  contextStore?: ToolContextStore,
  sharedSchema?: $ZodObject<$ZodShape>,
): Promise<ToolExecutionResult<Tool> | null> {
  if (!isHITLTool(tool)) {
    throw new Error(`Tool "${toolCall.name}" is not a HITL tool`);
  }

  const source = isMcpTool(tool) ? 'mcp' : 'client';

  try {
    const validatedInput = validateToolInput(tool.function.inputSchema, toolCall.arguments);
    const executeContext = buildExecuteCtx(tool, context, contextStore, sharedSchema);

    const result = await Promise.resolve(
      tool.function.onToolCalled(validatedInput, executeContext),
    );

    if (result === null) {
      // Pause — treat as manual tool
      return null;
    }

    // outputSchema is required on HITL tools — validate unconditionally.
    const validatedOutput = validateToolOutput(tool.function.outputSchema, result);
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      source,
      result: validatedOutput,
    };
  } catch (error) {
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      source,
      result: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Execute a tool call.
 * Automatically detects if it's a regular, generator, or HITL tool.
 *
 * Returns `null` only for HITL tools whose `onToolCalled` returned `null`
 * (signaling a manual-style pause). All other tools always return a
 * `ToolExecutionResult` (with `error` set on failure).
 */
// biome-ignore lint: parameters match the internal API shape
export async function executeTool(
  tool: Tool,
  toolCall: ParsedToolCall<Tool>,
  context: TurnContext,
  onPreliminaryResult?: (toolCallId: string, result: unknown) => void,
  contextStore?: ToolContextStore,
  sharedSchema?: $ZodObject<$ZodShape>,
): Promise<ToolExecutionResult<Tool> | null> {
  if (isHITLTool(tool)) {
    return executeHITLTool(tool, toolCall, context, contextStore, sharedSchema);
  }

  if (!hasExecuteFunction(tool)) {
    throw new Error(`Tool "${toolCall.name}" has no execute function. Use manual tool execution.`);
  }

  if (isGeneratorTool(tool)) {
    return executeGeneratorTool(
      tool,
      toolCall,
      context,
      onPreliminaryResult,
      contextStore,
      sharedSchema,
    );
  }

  return executeRegularTool(tool, toolCall, context, contextStore, sharedSchema);
}

/**
 * Find a client tool by name in the tools array. Server tools have no
 * client-side name to match against and are skipped.
 */
export function findToolByName(tools: Tool[], name: string): ClientTool | undefined {
  return tools.find(
    (tool): tool is ClientTool => !isServerTool(tool) && tool.function.name === name,
  );
}

/**
 * Format tool execution result as a string for sending to the model
 */
export function formatToolResultForModel(result: ToolExecutionResult<Tool>): string {
  if (result.error) {
    return JSON.stringify({
      error: result.error.message,
      toolName: result.toolName,
    });
  }

  return JSON.stringify(result.result);
}

/**
 * Create a user-friendly error message for tool execution errors
 */
export function formatToolExecutionError(error: Error, toolCall: ParsedToolCall<Tool>): string {
  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    return `Tool "${toolCall.name}" validation error:\n${JSON.stringify(issues, null, 2)}`;
  }

  return `Tool "${toolCall.name}" execution error: ${error.message}`;
}

/**
 * Typeguard: input is a plain array of items. Narrows the InputsUnion's
 * "string | Array<...>" shape so we can walk the array.
 */
function isItemArray(
  input: models.InputsUnion,
): input is Extract<models.InputsUnion, readonly unknown[]> {
  return Array.isArray(input);
}

/**
 * Serialize a value for `FunctionCallOutputItem.output`, preserving the
 * content-array shape (input_text/input_image/input_file blocks) verbatim so
 * multimodal outputs are not corrupted by JSON.stringify. All other values
 * are stringified. Matches the detection used elsewhere in the SDK
 * (`unsentResultsToAPIFormat`).
 */
function toFunctionCallOutputValue(
  value: unknown,
): string | models.FunctionCallOutputItemOutputUnion1[] {
  if (isContentArray(value)) {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Format a validation/hook-error payload alongside the caller's original output.
 * The wrapper itself is a synthetic object and is always JSON. The
 * `originalOutput` slot preserves a content-array shape verbatim if the
 * caller supplied one, so the model can still see the rich payload that
 * triggered the error.
 */
function formatHookError(
  message: string,
  originalOutput: unknown,
): string | models.FunctionCallOutputItemOutputUnion1[] {
  if (isContentArray(originalOutput)) {
    // When the caller supplied a content array, we cannot cram both the
    // error wrapper and the content blocks into a single content array —
    // the `FunctionCallOutputItemOutputUnion1` members are visible-to-model
    // blocks, not arbitrary JSON. Emit a text block carrying the error plus
    // the original content blocks so the model sees both.
    return [
      {
        type: 'input_text',
        text: JSON.stringify({
          error: message,
        }),
      },
      ...originalOutput,
    ];
  }
  return JSON.stringify({
    error: message,
    originalOutput,
  });
}

/**
 * Parse a raw `FunctionCallOutputItem.output` value for HITL processing.
 * JSON-parses string payloads when possible; leaves content arrays and
 * non-string inputs untouched.
 */
function parseRawFunctionCallOutput(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Build a name → HITL tool map from the registered tools. */
function buildHitlToolMap(tools: readonly Tool[]): Map<string, HITLTool> {
  const map = new Map<string, HITLTool>();
  for (const t of tools) {
    if (isHITLTool(t)) {
      map.set(t.function.name, t);
    }
  }
  return map;
}

/**
 * Build a callId → tool-name map from `function_call` items in an input
 * array, so `function_call_output` items can be associated with their tool.
 */
function buildCallIdToNameMap(
  input: Extract<models.InputsUnion, readonly unknown[]>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of input) {
    if (isFunctionCallItem(item)) {
      map.set(item.callId, item.name);
    }
  }
  return map;
}

type HookOutput = string | models.FunctionCallOutputItemOutputUnion1[];

/**
 * Invoke `onResponseReceived`, validate the return against the tool's
 * `outputSchema`, and convert the result (or any error) to a
 * `FunctionCallOutputItem.output` payload.
 */
// biome-ignore lint: parameters match the internal API shape
async function invokeOnResponseReceived(
  tool: HITLTool,
  parsed: unknown,
  context: TurnContext,
  contextStore?: ToolContextStore,
  sharedSchema?: $ZodObject<$ZodShape>,
): Promise<HookOutput> {
  const hook = tool.function.onResponseReceived;
  if (!hook) {
    throw new Error('invokeOnResponseReceived called without onResponseReceived hook');
  }
  const executeContext = buildExecuteCtx(tool, context, contextStore, sharedSchema);
  try {
    const hookResult = await Promise.resolve(hook(parsed, executeContext));
    const validation = z4.safeParse(tool.function.outputSchema, hookResult);
    if (!validation.success) {
      return formatHookError(validation.error.message, parsed);
    }
    return toFunctionCallOutputValue(hookResult);
  } catch (err) {
    // Preserve the caller's original output alongside the hook error so
    // the model can distinguish a hook failure from a tool-reported error.
    return formatHookError(err instanceof Error ? err.message : String(err), parsed);
  }
}

/**
 * Compute the (optional) replacement output for a single HITL
 * `function_call_output` item. Returns `null` when the caller-supplied output
 * is schema-conformant and should be left untouched.
 */
// biome-ignore lint: parameters match the internal API shape
async function computeHitlItemOutput(
  tool: HITLTool,
  item: models.FunctionCallOutputItem,
  context: TurnContext,
  contextStore?: ToolContextStore,
  sharedSchema?: $ZodObject<$ZodShape>,
): Promise<HookOutput | null> {
  const parsed = parseRawFunctionCallOutput(item.output);

  if (tool.function.onResponseReceived) {
    return invokeOnResponseReceived(tool, parsed, context, contextStore, sharedSchema);
  }

  // No hook — validate the parsed raw output against outputSchema. On
  // success, leave the item untouched; on failure, surface an error wrapper.
  const validation = z4.safeParse(tool.function.outputSchema, parsed);
  if (validation.success) {
    return null;
  }
  return formatHookError(validation.error.message, parsed);
}

/**
 * Walk the input items and apply HITL per-tool validation plus any
 * `onResponseReceived` hooks.
 *
 * For each `function_call_output` item in `input`, locate the matching
 * `function_call` (by `callId`) to identify the tool name. If that tool is a
 * HITL tool, validate the value the model will see against the tool's
 * `outputSchema`:
 *
 * - With `onResponseReceived`: invoke it with the parsed raw output, validate
 *   the hook's return against `outputSchema`, then serialize (preserving
 *   content-array shapes). Hook throws or validation failures are replaced
 *   with `{error, originalOutput}` so the model sees a tool error.
 * - Without `onResponseReceived`: validate the parsed raw output against
 *   `outputSchema`. If it matches, leave the item untouched. Otherwise
 *   replace with `{error, originalOutput}` using the same shape.
 *
 * Items that don't match a HITL tool are left untouched.
 *
 * @returns a new input array when any item was rewritten, otherwise the original input.
 */
// biome-ignore lint: parameters match the internal API shape
export async function applyOnResponseReceivedHooks(
  input: models.InputsUnion,
  tools: readonly Tool[] | undefined,
  context: TurnContext,
  contextStore?: ToolContextStore,
  sharedSchema?: $ZodObject<$ZodShape>,
): Promise<models.InputsUnion> {
  if (!tools || tools.length === 0 || !isItemArray(input)) {
    return input;
  }

  const hitlByName = buildHitlToolMap(tools);
  if (hitlByName.size === 0) {
    return input;
  }

  const callIdToName = buildCallIdToNameMap(input);

  // Element type of the array form of InputsUnion — use this so `rewritten`
  // is structurally assignable back to InputsUnion without an `as` cast.
  type InputsArrayItem = Extract<models.InputsUnion, readonly unknown[]>[number];

  let changed = false;
  const rewritten: InputsArrayItem[] = [];
  for (const item of input) {
    const tool = isFunctionCallOutputItem(item)
      ? hitlByName.get(callIdToName.get(item.callId) ?? '')
      : undefined;
    if (!tool || !isFunctionCallOutputItem(item)) {
      rewritten.push(item);
      continue;
    }

    const newOutput = await computeHitlItemOutput(tool, item, context, contextStore, sharedSchema);
    if (newOutput === null) {
      rewritten.push(item);
      continue;
    }

    rewritten.push({
      ...item,
      output: newOutput,
    });
    changed = true;
  }

  return changed ? rewritten : input;
}
