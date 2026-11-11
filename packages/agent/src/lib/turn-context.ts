// Type-only: a runtime import of the models barrel would evaluate ~600
// Speakeasy modules of top-level Zod schema construction in every consumer
// that statically reaches the `tool` subpath (~+200ms of Cloudflare Worker
// startup CPU). See the startup-import-closure unit test.
import type * as models from '@openrouter/sdk/models';
import type { TurnContext } from './tool-types.js';

/**
 * Options for building a turn context
 */
export interface BuildTurnContextOptions {
  /** Number of turns so far (1-indexed for tool execution, 0 for initial request) */
  numberOfTurns: number;
  /** The specific tool call being executed (optional for initial/async resolution contexts) */
  toolCall?: models.FunctionCallItem;
  /** The full request being sent to the API (optional for initial/async resolution contexts) */
  turnRequest?: models.ResponsesRequest;
}

/**
 * Build a turn context for tool execution or async parameter resolution
 *
 * @param options - Options for building the context
 * @returns A TurnContext object
 *
 * @example
 * ```typescript
 * // For tool execution with full context
 * const context = buildTurnContext({
 *   numberOfTurns: 1,
 *   toolCall: rawToolCall,
 *   turnRequest: currentRequest,
 * });
 *
 * // For async parameter resolution (partial context)
 * const context = buildTurnContext({
 *   numberOfTurns: 0,
 * });
 * ```
 */
export function buildTurnContext(options: BuildTurnContextOptions): TurnContext {
  const context: TurnContext = {
    numberOfTurns: options.numberOfTurns,
  };

  if (options.toolCall !== undefined) {
    context.toolCall = options.toolCall;
  }

  if (options.turnRequest !== undefined) {
    context.turnRequest = options.turnRequest;
  }

  return context;
}

/**
 * Normalize OpenResponsesInput to an array format
 * Converts string input to array with single user message
 *
 * @param input - The input to normalize
 * @returns Array format of the input
 *
 * @example
 * ```typescript
 * const arrayInput = normalizeInputToArray("Hello!");
 * // Returns: [{ role: "user", content: "Hello!" }]
 * ```
 */
export function normalizeInputToArray(input: models.InputsUnion): Array<models.InputsUnion1> {
  if (typeof input === 'string') {
    // Construct object with all required fields - type is optional
    const message: models.EasyInputMessage = {
      role: 'user',
      content: input,
    };
    return [
      message,
    ];
  }
  return input;
}

/**
 * Whether a value is shaped like a single item of a Responses `input` array:
 * an object carrying an item `type` or a message `role`.
 *
 * Response output items are fed back as input on the next turn. The SDK types
 * the two directions separately, so this guard is how an output item crosses
 * over.
 */
export function isInputItem(value: unknown): value is models.InputsUnion1 {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    ('type' in value && typeof value.type === 'string') ||
    ('role' in value && typeof value.role === 'string')
  );
}

/**
 * Convert a response's output into input items for the next request.
 */
export function outputToInputItems(output: unknown): Array<models.InputsUnion1> {
  const items: unknown[] = Array.isArray(output)
    ? output
    : [
        output,
      ];
  return items.filter(isInputItem);
}
