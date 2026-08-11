/**
 * Diagnostics for `validateFinalResponse` (issue #45).
 *
 * Issue #45 reported `Invalid final response: empty or invalid output` for
 * tool-call-only turns. That is NOT what the validator does — it is a pure
 * array-length check, so a `function_call`-only `output` passes (locked by
 * `allow-final-response.test.ts`). The reporter hit a genuinely empty
 * `output: []`, but the message was too vague to tell those apart.
 *
 * These tests pin the *specific* diagnostics so the message can't silently
 * regress to something ambiguous again. The validator is private and the
 * not-an-array / missing-field shapes are unreachable through the public
 * `callModel` path (the SDK types guarantee an array), so we drive it
 * directly with the same prototype-cast pattern used by the other
 * ModelResult unit tests.
 */
import type { OpenRouterCore } from '@openrouter/sdk/core';
import type { OpenResponsesResult } from '@openrouter/sdk/models';
import { describe, expect, it } from 'vitest';
import { ModelResult } from '../../src/lib/model-result.js';
import type { Tool } from '../../src/lib/tool-types.js';

type Validator = (response: OpenResponsesResult, allowEmptyOutput?: boolean) => void;

/**
 * Build a bare ModelResult and expose its private validator.
 *
 * No request is ever dispatched — the stub client is never touched, because
 * `validateFinalResponse` is pure.
 */
function validator(): Validator {
  const result = new ModelResult<readonly Tool[]>({
    request: {
      model: 'test-model',
      input: 'hello',
    },
    client: {} as unknown as OpenRouterCore,
  } as unknown as ConstructorParameters<typeof ModelResult<readonly Tool[]>>[0]);

  const internal = result as unknown as {
    validateFinalResponse: Validator;
  };
  return internal.validateFinalResponse.bind(result);
}

function response(overrides: Record<string, unknown>): OpenResponsesResult {
  return {
    id: 'resp_1',
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    output: [],
    ...overrides,
  } as unknown as OpenResponsesResult;
}

describe('validateFinalResponse diagnostics (#45)', () => {
  describe('empty output array', () => {
    it('reports the empty array, its length, and the response id', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            id: 'resp_empty',
            output: [],
          }),
        ),
      ).toThrow(/output array is empty \(length 0\) for response "resp_empty"/);
    });

    it('points at the strictFinalResponse/allowFinalResponse escape hatches', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            output: [],
          }),
        ),
      ).toThrow(/strictFinalResponse\/allowFinalResponse/);
    });

    it('explains that the provider returned no output items', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            output: [],
          }),
        ),
      ).toThrow(/The model returned no output items/);
    });

    it('keeps the historical message prefix so existing matchers still fire', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            output: [],
          }),
        ),
      ).toThrow(/^Invalid final response: empty or invalid output/);
    });

    it('stays a single line (no embedded newlines)', () => {
      const validate = validator();

      let message = '';
      try {
        validate(
          response({
            output: [],
          }),
        );
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).not.toBe('');
      expect(message).not.toContain('\n');
    });

    it('does not throw when empty output is explicitly allowed', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            output: [],
          }),
          true,
        ),
      ).not.toThrow();
    });
  });

  describe('output present but not an array', () => {
    it('names the offending runtime type', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            output: 'not an array',
          }),
        ),
      ).toThrow(/output is not an array \(got string\)/);
    });

    it('distinguishes an object from an array', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            output: {
              type: 'message',
            },
          }),
        ),
      ).toThrow(/output is not an array \(got object\)/);
    });

    it('does NOT claim the array is empty for a non-array output', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            output: 42,
          }),
        ),
      ).toThrow(/output is not an array \(got number\)/);
      expect(() =>
        validate(
          response({
            output: 42,
          }),
        ),
      ).not.toThrow(/output array is empty/);
    });

    it('is still tolerated under allowEmptyOutput (pre-existing behavior, unchanged here)', () => {
      const validate = validator();

      // `allowEmptyOutput` short-circuits before the message is built, so a
      // non-array output is also swallowed on the tolerant path. That is
      // pre-existing behavior and arguably wrong (a non-array is a broken
      // payload, not an empty final turn), but this change is diagnostics-only
      // — pinned here so a future logic fix is a deliberate, visible edit.
      expect(() =>
        validate(
          response({
            output: 'not an array',
          }),
          true,
        ),
      ).not.toThrow();
    });
  });

  describe('missing required fields', () => {
    it('names `id` when only the id is missing', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            id: undefined,
            output: [
              {
                type: 'message',
              },
            ],
          }),
        ),
      ).toThrow(/missing required fields: id$/);
    });

    it('names `output` when only output is missing', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            output: undefined,
          }),
        ),
      ).toThrow(/missing required fields: output$/);
    });

    it('names both fields when both are missing', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            id: undefined,
            output: undefined,
          }),
        ),
      ).toThrow(/missing required fields: id, output$/);
    });

    it('treats a null response as missing both fields rather than crashing', () => {
      const validate = validator();

      expect(() => validate(null as unknown as OpenResponsesResult)).toThrow(
        /missing required fields: id, output$/,
      );
    });

    it('keeps the historical message prefix so existing matchers still fire', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            output: undefined,
          }),
        ),
      ).toThrow(/^Invalid final response: missing required fields/);
    });
  });

  describe('valid outputs', () => {
    it('accepts a tool-call-only output — the shape issue #45 wrongly blamed', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            output: [
              {
                type: 'function_call',
                id: 'fc_1',
                callId: 'call_1',
                name: 'do_thing',
                arguments: '{}',
                status: 'completed',
              },
            ],
          }),
        ),
      ).not.toThrow();
    });

    it('accepts a normal message output', () => {
      const validate = validator();

      expect(() =>
        validate(
          response({
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: 'hi',
                    annotations: [],
                  },
                ],
              },
            ],
          }),
        ),
      ).not.toThrow();
    });
  });
});
