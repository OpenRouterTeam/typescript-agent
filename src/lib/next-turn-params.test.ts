import type * as models from '@openrouter/sdk/models';

import { describe, expect, it } from 'vitest';
import { applyNextTurnParamsToRequest } from './next-turn-params.js';

/**
 * Creates a minimal ResponsesRequest for testing applyNextTurnParamsToRequest.
 */
function createBaseRequest(
  overrides?: Partial<models.ResponsesRequest>,
): models.ResponsesRequest {
  return {
    model: 'openai/gpt-4',
    input: [{ role: 'user', content: 'hello' }],
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
    const request = createBaseRequest({ temperature: 0.7 });
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
    const request = createBaseRequest({ temperature: 0.5 });
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
