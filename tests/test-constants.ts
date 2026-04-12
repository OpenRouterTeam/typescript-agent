/**
 * Shared test constants and typed factory helpers.
 *
 * Unit/integration tests use a synthetic placeholder so they never
 * depend on a real model existing. Change these in one place if the
 * convention needs to be updated.
 */

import type * as models from '@openrouter/sdk/models';
import type { CallModelInput } from '../src/lib/async-params.js';
import type {
  ParsedToolCall,
  StepResult,
  Tool,
  ToolExecutionResult,
  TurnContext,
  TypedToolCallUnion,
} from '../src/lib/tool-types.js';

/** Default model identifier used in non-e2e tests. */
export const TEST_MODEL = 'openai/gpt-4.1-nano';

/** Alternative model for tests that need a second, distinct model. */
export const TEST_MODEL_ALT = 'openai/gpt-4.1-mini';

// ---------------------------------------------------------------------------
// Factory helpers – build properly typed test data without `as any`
// ---------------------------------------------------------------------------

/** Minimal Usage object that satisfies the SDK's required fields. */
export function makeUsage(
  overrides: Partial<models.Usage> & {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
  },
): models.Usage {
  return {
    inputTokensDetails: {
      cachedTokens: 0,
    },
    outputTokensDetails: {
      reasoningTokens: 0,
    },
    ...overrides,
  };
}

/** Minimal OpenResponsesResult that satisfies the SDK's required fields. */
export function makeResponse(
  overrides: Partial<models.OpenResponsesResult> & {
    output: models.OutputItems[];
  },
): models.OpenResponsesResult {
  return {
    id: 'resp_test',
    object: 'response',
    createdAt: 0,
    model: TEST_MODEL,
    status: 'completed',
    completedAt: null,
    error: null,
    incompleteDetails: null,
    temperature: null,
    topP: null,
    presencePenalty: null,
    frequencyPenalty: null,
    instructions: null,
    metadata: null,
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: false,
    ...overrides,
  };
}

/** Minimal StepResult that satisfies the interface without `as any`. */
export function makeStep(overrides: Partial<StepResult> = {}): StepResult {
  return {
    stepType: 'initial',
    text: '',
    response: makeResponse({
      output: [],
    }),
    toolCalls: [],
    toolResults: [],
    finishReason: undefined,
    usage: undefined,
    ...overrides,
  };
}

/** Minimal TurnContext for tests. */
export function makeTurnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    numberOfTurns: 0,
    ...overrides,
  };
}

/** Typed ParsedToolCall factory. */
export function makeToolCall(overrides: {
  id: string;
  name: string;
  arguments: unknown;
}): ParsedToolCall<Tool> {
  return overrides;
}

/** Typed ToolExecutionResult factory. */
export function makeToolResult(
  overrides: Partial<ToolExecutionResult<Tool>> & {
    toolCallId: string;
    toolName: string;
  },
): ToolExecutionResult<Tool> {
  return {
    result: undefined,
    ...overrides,
  };
}

/**
 * Cast a partial CallModelInput to the full type.
 * Use when tests provide only a subset of fields (model, temperature, etc.)
 * that don't include the full union-discriminant fields.
 */
export function makeCallModelInput(fields: Record<string, unknown>): CallModelInput {
  return fields as CallModelInput;
}

/** Typed tool call array for StepResult.toolCalls */
export function makeTypedToolCalls(
  calls: Array<{
    id: string;
    name: string;
    arguments: unknown;
  }>,
): TypedToolCallUnion<readonly Tool[]>[] {
  return calls as TypedToolCallUnion<readonly Tool[]>[];
}

/** Minimal ResponsesRequest for tests. */
export function makeRequest(
  overrides: Partial<models.ResponsesRequest> = {},
): models.ResponsesRequest {
  return {
    model: TEST_MODEL,
    input: 'test',
    ...overrides,
  };
}
