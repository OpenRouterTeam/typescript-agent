import type * as models from '@openrouter/sdk/models';
import type {
  ConversationState,
  ParsedToolCall,
  Tool,
  TurnContext,
  UnsentToolResult,
} from './tool-types.js';
import { isClientTool } from './tool-types.js';

import { normalizeInputToArray } from './turn-context.js';

/**
 * Type guard to verify an object is a valid UnsentToolResult
 */
function isValidUnsentToolResult<TTools extends readonly Tool[]>(
  obj: unknown,
): obj is UnsentToolResult<TTools> {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  return (
    'callId' in obj &&
    typeof obj.callId === 'string' &&
    'name' in obj &&
    typeof obj.name === 'string' &&
    'output' in obj
  );
}

/**
 * Type guard to verify an object is a valid ParsedToolCall
 */
function isValidParsedToolCall<TTools extends readonly Tool[]>(
  obj: unknown,
): obj is ParsedToolCall<TTools[number]> {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  return (
    'id' in obj &&
    typeof obj.id === 'string' &&
    'name' in obj &&
    typeof obj.name === 'string' &&
    'arguments' in obj
  );
}

/**
 * Generate a unique ID for a conversation
 * Uses crypto.randomUUID if available, falls back to timestamp + random
 */
export function generateConversationId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `conv_${crypto.randomUUID()}`;
  }
  // Fallback for environments without crypto.randomUUID
  return `conv_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Create an initial conversation state
 * @param id - Optional custom ID, generates one if not provided
 */
/** Currently supported ConversationState serialization version. */
export const CONVERSATION_STATE_VERSION = 1 as const;

export function createInitialState<TTools extends readonly Tool[] = readonly Tool[]>(
  id?: string,
): ConversationState<TTools> {
  const now = Date.now();
  return {
    version: CONVERSATION_STATE_VERSION,
    id: id ?? generateConversationId(),
    messages: [],
    status: 'in_progress',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Thrown when {@link deserializeConversationState} encounters a state blob whose
 * `version` is not supported by this SDK build.
 */
export class UnsupportedStateVersionError extends Error {
  readonly found: number;
  readonly supported: readonly number[];

  constructor(found: number, supported: readonly number[] = [CONVERSATION_STATE_VERSION]) {
    super(
      `Unsupported ConversationState version ${found}; supported version(s): ${supported.join(', ')}`,
    );
    this.name = 'UnsupportedStateVersionError';
    this.found = found;
    this.supported = supported;
  }
}

/**
 * Thrown when {@link deserializeConversationState} receives JSON that is not a
 * well-formed ConversationState (missing/wrong required fields, or invalid JSON).
 */
export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateError';
  }
}

/**
 * Serialize a {@link ConversationState} to a stable JSON string for durable storage.
 *
 * Guarantees the `version` field is present (injects `1` when the input state
 * lacks it). Treat the returned JSON as **opaque**: consumers should round-trip
 * via these helpers rather than introspecting item shapes.
 *
 * **Compat policy:** additive field changes within a major version. On version
 * bumps, migrations run inside {@link deserializeConversationState}. The
 * StateAccessor load/save contract is unchanged — these helpers are opt-in.
 */
export function serializeConversationState<TTools extends readonly Tool[] = readonly Tool[]>(
  state: ConversationState<TTools>,
): string {
  return JSON.stringify({
    ...state,
    version: state.version ?? CONVERSATION_STATE_VERSION,
  });
}

/**
 * Parse and validate a previously serialized {@link ConversationState}.
 *
 * Accepts version-less legacy blobs and states with `version: 1`, normalizing
 * both to `version: 1`. Throws {@link UnsupportedStateVersionError} for any
 * other version (fail loudly so stores don't silently misinterpret future
 * shapes). Throws {@link InvalidStateError} for malformed JSON or missing
 * required fields (`id`, `messages`, `status`).
 *
 * **Compat policy:** absence of `version` means v1. Migrations for future
 * versions happen here; callers should treat the JSON as opaque.
 */
export function deserializeConversationState<TTools extends readonly Tool[] = readonly Tool[]>(
  json: string,
): ConversationState<TTools> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new InvalidStateError(
      `Invalid ConversationState JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidStateError('ConversationState must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['id'] !== 'string') {
    throw new InvalidStateError(
      `ConversationState missing or invalid field "id" (expected string, got ${describeType(obj['id'])})`,
    );
  }

  // messages is models.InputsUnion — typically an array of items, but the type
  // also allows a single item / string; require array for durable store blobs.
  if (!Array.isArray(obj['messages'])) {
    throw new InvalidStateError(
      `ConversationState missing or invalid field "messages" (expected array, got ${describeType(obj['messages'])})`,
    );
  }

  if (typeof obj['status'] !== 'string') {
    throw new InvalidStateError(
      `ConversationState missing or invalid field "status" (expected string, got ${describeType(obj['status'])})`,
    );
  }

  const version = obj['version'];
  if (version !== undefined && version !== CONVERSATION_STATE_VERSION) {
    if (typeof version !== 'number') {
      throw new InvalidStateError(
        `ConversationState field "version" must be a number when present (got ${describeType(version)})`,
      );
    }
    throw new UnsupportedStateVersionError(version, [CONVERSATION_STATE_VERSION]);
  }

  return {
    ...(obj as unknown as ConversationState<TTools>),
    version: CONVERSATION_STATE_VERSION,
  };
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Update a conversation state with new values
 * Automatically updates the updatedAt timestamp
 */
export function updateState<TTools extends readonly Tool[] = readonly Tool[]>(
  state: ConversationState<TTools>,
  updates: Partial<Omit<ConversationState<TTools>, 'id' | 'createdAt' | 'updatedAt'>>,
): ConversationState<TTools> {
  return {
    ...state,
    ...updates,
    updatedAt: Date.now(),
  };
}

/**
 * Append new items to the message history
 */
export function appendToMessages(
  current: models.InputsUnion,
  newItems: models.BaseInputsUnion[],
): models.InputsUnion {
  const currentArray = normalizeInputToArray(current);
  return [
    ...currentArray,
    ...newItems,
  ];
}

/**
 * Check if a tool call requires approval
 * @param toolCall - The tool call to check
 * @param tools - Available tools
 * @param context - Turn context for the approval check
 * @param callLevelCheck - Optional call-level approval function (overrides tool-level), can be async
 */
export async function toolRequiresApproval<TTools extends readonly Tool[]>(
  toolCall: ParsedToolCall<TTools[number]>,
  tools: TTools,
  context: TurnContext,
  callLevelCheck?: (
    toolCall: ParsedToolCall<TTools[number]>,
    context: TurnContext,
  ) => boolean | Promise<boolean>,
): Promise<boolean> {
  // Call-level check takes precedence
  if (callLevelCheck) {
    return callLevelCheck(toolCall, context);
  }

  // Fall back to tool-level setting (server tools never require approval)
  const tool = tools.find(
    (
      t,
    ): t is Exclude<
      Tool,
      {
        _brand: 'server-tool';
      }
    > => isClientTool(t) && t.function.name === toolCall.name,
  );
  if (!tool) {
    return false;
  }

  const requireApproval = tool.function.requireApproval;

  // If it's a function, call it with the tool's arguments and context.
  // Arguments have already been parsed and validated against the tool's
  // Zod inputSchema (a ZodObject), so the runtime shape is always a
  // record here. A non-record value signals a real upstream bug — surface
  // it rather than substituting an empty object.
  if (typeof requireApproval === 'function') {
    const rawArgs: unknown = toolCall.arguments;
    if (!isRecord(rawArgs)) {
      throw new Error(
        `toolCall.arguments for "${toolCall.name}" must be an object after Zod validation, got ${rawArgs === null ? 'null' : Array.isArray(rawArgs) ? 'array' : typeof rawArgs}`,
      );
    }
    return requireApproval(rawArgs, context);
  }

  // Otherwise treat as boolean
  return requireApproval ?? false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Partition tool calls into those requiring approval and those that can auto-execute
 * @param toolCalls - Tool calls to partition
 * @param tools - Available tools
 * @param context - Turn context for the approval check
 * @param callLevelCheck - Optional call-level approval function (overrides tool-level), can be async
 */
export async function partitionToolCalls<TTools extends readonly Tool[]>(
  toolCalls: ParsedToolCall<TTools[number]>[],
  tools: TTools,
  context: TurnContext,
  callLevelCheck?: (
    toolCall: ParsedToolCall<TTools[number]>,
    context: TurnContext,
  ) => boolean | Promise<boolean>,
): Promise<{
  requiresApproval: ParsedToolCall<TTools[number]>[];
  autoExecute: ParsedToolCall<TTools[number]>[];
}> {
  const requiresApproval: ParsedToolCall<TTools[number]>[] = [];
  const autoExecute: ParsedToolCall<TTools[number]>[] = [];

  for (const tc of toolCalls) {
    if (await toolRequiresApproval(tc, tools, context, callLevelCheck)) {
      requiresApproval.push(tc);
    } else {
      autoExecute.push(tc);
    }
  }

  return {
    requiresApproval,
    autoExecute,
  };
}

/**
 * Create an unsent tool result from a successful execution
 */
export function createUnsentResult<TTools extends readonly Tool[] = readonly Tool[]>(
  callId: string,
  name: string,
  output: unknown,
): UnsentToolResult<TTools> {
  const result = {
    callId,
    name,
    output,
  };
  if (!isValidUnsentToolResult<TTools>(result)) {
    throw new Error('Invalid UnsentToolResult structure');
  }
  return result;
}

/**
 * Create an unsent tool result from a rejection
 */
export function createRejectedResult<TTools extends readonly Tool[] = readonly Tool[]>(
  callId: string,
  name: string,
  reason?: string,
): UnsentToolResult<TTools> {
  const result = {
    callId,
    name,
    output: null,
    error: reason ?? 'Tool call rejected by user',
  };
  if (!isValidUnsentToolResult<TTools>(result)) {
    throw new Error('Invalid UnsentToolResult structure');
  }
  return result;
}

/**
 * Check if a value is a valid content array (array of input_text, input_image, or input_file blocks).
 * These can be passed directly as tool output without JSON.stringify.
 */
export function isContentArray(
  value: unknown,
): value is models.FunctionCallOutputItemOutputUnion1[] {
  if (!Array.isArray(value)) {
    return false;
  }
  if (value.length === 0) {
    return false;
  }
  return value.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      'type' in item &&
      (item.type === 'input_text' || item.type === 'input_image' || item.type === 'input_file'),
  );
}

/**
 * Convert unsent tool results to API format for sending to the model.
 *
 * Supports two output formats:
 * 1. Content arrays (input_text, input_image, input_file blocks) - passed through directly
 * 2. All other values - JSON stringified
 *
 * Content arrays are useful for tools that produce rich outputs like images,
 * avoiding the need to serialize large binary data as JSON strings.
 */
export function unsentResultsToAPIFormat(
  results: UnsentToolResult[],
): models.FunctionCallOutputItem[] {
  return results.map((r) => {
    let output: string | models.FunctionCallOutputItemOutputUnion1[];

    if (r.error) {
      output = JSON.stringify({
        error: r.error,
      });
    } else if (isContentArray(r.output)) {
      // Pass through content arrays directly (images, text blocks, files)
      output = r.output;
    } else {
      output = JSON.stringify(r.output);
    }

    return {
      type: 'function_call_output' as const,
      id: `output_${r.callId}`,
      callId: r.callId,
      output,
    };
  });
}

/**
 * Extract text content from a response
 */
export function extractTextFromResponse(response: models.OpenResponsesResult): string {
  if (!response.output) {
    return '';
  }

  const outputs = Array.isArray(response.output)
    ? response.output
    : [
        response.output,
      ];
  const textParts: string[] = [];

  for (const item of outputs) {
    if (item.type === 'message' && 'content' in item && item.content) {
      for (const content of item.content) {
        if (content.type === 'output_text' && 'text' in content && content.text) {
          textParts.push(content.text);
        }
      }
    }
  }

  return textParts.join('');
}

/**
 * Extract tool calls from a response
 */
export function extractToolCallsFromResponse<TTools extends readonly Tool[]>(
  response: models.OpenResponsesResult,
): ParsedToolCall<TTools[number]>[] {
  if (!response.output) {
    return [];
  }

  const outputs = Array.isArray(response.output)
    ? response.output
    : [
        response.output,
      ];
  const toolCalls: ParsedToolCall<TTools[number]>[] = [];

  for (const item of outputs) {
    if (item.type !== 'function_call' || !('arguments' in item)) {
      continue;
    }

    let parsedArguments: unknown;
    if (typeof item.arguments === 'string') {
      try {
        parsedArguments = JSON.parse(item.arguments);
      } catch (error) {
        // Log warning and skip malformed tool call, similar to stream-transformers.ts
        console.warn(
          `Failed to parse arguments for tool call "${'name' in item ? item.name : 'unknown'}": ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    } else {
      parsedArguments = item.arguments;
    }

    const toolCall = {
      id: ('callId' in item ? item.callId : undefined) ?? item.id ?? '',
      name: ('name' in item ? item.name : undefined) ?? '',
      arguments: parsedArguments,
    };
    if (!isValidParsedToolCall<TTools>(toolCall)) {
      throw new Error(`Invalid tool call structure for tool: ${toolCall.name}`);
    }
    toolCalls.push(toolCall);
  }

  return toolCalls;
}
