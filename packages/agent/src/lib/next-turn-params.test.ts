import type * as models from '@openrouter/sdk/models';

import { describe, expect, it } from 'vitest';
import { applyNextTurnParamsToRequest, buildNextTurnParamsContext } from './next-turn-params.js';

/**
 * Creates a minimal ResponsesRequest for testing applyNextTurnParamsToRequest.
 */
function createBaseRequest(overrides?: Partial<models.ResponsesRequest>): models.ResponsesRequest {
  return {
    model: 'openai/gpt-4',
    input: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
    ...overrides,
  };
}

describe('applyNextTurnParamsToRequest', () => {
  it('should pass through non-null values unchanged', () => {
    const request = createBaseRequest();
    const result = applyNextTurnParamsToRequest(request, {
      temperature: 0.5,
      maxOutputTokens: 1000,
      instructions: 'Be helpful',
    });

    expect(result.temperature).toBe(0.5);
    expect(result.maxOutputTokens).toBe(1000);
    expect(result.instructions).toBe('Be helpful');
  });

  it('should convert null values to undefined', () => {
    const request = createBaseRequest({
      temperature: 0.7,
    });
    const result = applyNextTurnParamsToRequest(request, {
      temperature: null,
      maxOutputTokens: null,
      instructions: null,
    });

    // null values become undefined, so the spread doesn't override
    // with null — it overrides with undefined instead
    expect(result.temperature).toBeUndefined();
    expect(result.maxOutputTokens).toBeUndefined();
    expect(result.instructions).toBeUndefined();
  });

  it('should preserve original request fields not in computedParams', () => {
    const request = createBaseRequest({
      model: 'anthropic/claude-3',
      temperature: 0.9,
    });
    const result = applyNextTurnParamsToRequest(request, {
      maxOutputTokens: 500,
    });

    expect(result.model).toBe('anthropic/claude-3');
    expect(result.temperature).toBe(0.9);
    expect(result.maxOutputTokens).toBe(500);
  });

  it('should handle empty computedParams without changing the request', () => {
    const request = createBaseRequest({
      temperature: 0.5,
    });
    const result = applyNextTurnParamsToRequest(request, {});

    expect(result.temperature).toBe(0.5);
    expect(result.model).toBe('openai/gpt-4');
  });

  it('should handle mixed null and non-null values', () => {
    const request = createBaseRequest({
      temperature: 0.7,
      topP: 0.9,
    });
    const result = applyNextTurnParamsToRequest(request, {
      temperature: null,
      topP: 0.5,
      maxOutputTokens: null,
      instructions: 'Updated instructions',
    });

    expect(result.temperature).toBeUndefined();
    expect(result.topP).toBe(0.5);
    expect(result.maxOutputTokens).toBeUndefined();
    expect(result.instructions).toBe('Updated instructions');
  });

  it('should preserve zero as a valid non-null value', () => {
    const request = createBaseRequest();
    const result = applyNextTurnParamsToRequest(request, {
      temperature: 0,
      maxOutputTokens: 0,
    });

    expect(result.temperature).toBe(0);
    expect(result.maxOutputTokens).toBe(0);
  });

  it('should preserve empty string as a valid non-null value', () => {
    const request = createBaseRequest();
    const result = applyNextTurnParamsToRequest(request, {
      instructions: '' as string | null,
    });

    expect(result.instructions).toBe('');
  });
});

/*
 * `toolChoice` is how a tool-search tool widens the model's reach mid-run: the
 * `tools` array stays byte-identical (preserving the provider's prompt-cache
 * prefix) while `{ type: 'allowed_tools', tools: [...] }` grows.
 */
describe('applyNextTurnParamsToRequest with allowed_tools', () => {
  const allowed = (names: string[]): models.ResponsesRequest['toolChoice'] => ({
    type: 'allowed_tools',
    mode: 'auto',
    tools: names.map((name) => ({
      type: 'function',
      name,
    })),
  });

  it('replaces toolChoice with a widened allowed_tools set', () => {
    const request = createBaseRequest({
      toolChoice: allowed([
        'tool_search',
      ]),
    });

    const result = applyNextTurnParamsToRequest(request, {
      toolChoice: allowed([
        'tool_search',
        'get_weather',
      ]),
    });

    expect(result.toolChoice).toEqual(
      allowed([
        'tool_search',
        'get_weather',
      ]),
    );
  });

  it('leaves the tools array untouched so the prompt-cache prefix survives', () => {
    const tools = [
      {
        type: 'function' as const,
        name: 'tool_search',
        parameters: {},
      },
      {
        type: 'function' as const,
        name: 'get_weather',
        parameters: {},
      },
    ];
    const request = createBaseRequest({
      tools,
      toolChoice: allowed([
        'tool_search',
      ]),
    });

    const result = applyNextTurnParamsToRequest(request, {
      toolChoice: allowed([
        'tool_search',
        'get_weather',
      ]),
    });

    expect(result.tools).toBe(tools);
  });

  it('leaves toolChoice alone when no tool computed one', () => {
    const request = createBaseRequest({
      toolChoice: allowed([
        'tool_search',
      ]),
    });

    const result = applyNextTurnParamsToRequest(request, {
      temperature: 0.2,
    });

    expect(result.toolChoice).toEqual(
      allowed([
        'tool_search',
      ]),
    );
  });
});

describe('buildNextTurnParamsContext with models fallback', () => {
  it('defaults model to models[0] when model is undefined', () => {
    const context = buildNextTurnParamsContext({
      models: [
        'mistralai/mistral-small-2603',
        'mistralai/mistral-large-2512',
      ],
      input: 'hello',
    });

    expect(context.model).toBe('mistralai/mistral-small-2603');
    expect(context.models).toEqual([
      'mistralai/mistral-small-2603',
      'mistralai/mistral-large-2512',
    ]);
  });

  it('preserves explicit model when provided', () => {
    const context = buildNextTurnParamsContext({
      model: 'anthropic/claude-3',
      models: [
        'mistralai/mistral-large-2512',
      ],
      input: 'hello',
    });

    expect(context.model).toBe('anthropic/claude-3');
    expect(context.models).toEqual([
      'mistralai/mistral-large-2512',
    ]);
  });
});

describe('applyNextTurnParamsToRequest with models fallback', () => {
  it('updates model to models[0] when models is updated without model', () => {
    const request = createBaseRequest({
      model: 'openai/gpt-4',
    });

    const result = applyNextTurnParamsToRequest(request, {
      models: [
        'mistralai/mistral-small-2603',
        'mistralai/mistral-large-2512',
      ],
    });

    expect(result.model).toBe('mistralai/mistral-small-2603');
    expect(result.models).toEqual([
      'mistralai/mistral-small-2603',
      'mistralai/mistral-large-2512',
    ]);
  });

  it('preserves explicit model when both model and models are updated', () => {
    const request = createBaseRequest({
      model: 'openai/gpt-4',
    });

    const result = applyNextTurnParamsToRequest(request, {
      model: 'anthropic/claude-3',
      models: [
        'mistralai/mistral-large-2512',
      ],
    });

    expect(result.model).toBe('anthropic/claude-3');
    expect(result.models).toEqual([
      'mistralai/mistral-large-2512',
    ]);
  });
});
