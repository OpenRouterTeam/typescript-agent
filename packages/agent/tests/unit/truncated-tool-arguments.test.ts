/**
 * Tests for max_output_tokens-truncated tool-call arguments.
 *
 * When a response is cut off by the output token limit mid-arguments, the
 * arguments string is unparseable — but retrying the identical call can never
 * succeed, so the model must be told to shrink the call rather than "provide
 * valid JSON". These tests script an incomplete response through `callModel`
 * (no live model) and assert the exact feedback the model receives, and that
 * ordinary invalid-JSON feedback is unchanged.
 */
import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { callModel } from '../../src/inner-loop/call-model.js';
import { tool } from '../../src/lib/tool.js';

let responseCounter = 0;

function baseResponse(
  output: unknown[],
  status: 'completed' | 'incomplete' = 'completed',
  incompleteReason?: string,
): models.OpenResponsesResult {
  responseCounter++;
  return {
    id: `resp_${responseCounter}`,
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status,
    completedAt: 0,
    output,
    error: null,
    incompleteDetails: incompleteReason
      ? {
          reason: incompleteReason,
        }
      : null,
    temperature: null,
    topP: null,
    presencePenalty: null,
    frequencyPenalty: null,
    metadata: null,
    instructions: null,
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: false,
  } as models.OpenResponsesResult;
}

function functionCallItem(name: string, rawArguments: string): unknown {
  return {
    type: 'function_call',
    id: `fc_${responseCounter + 1}`,
    callId: `call_${responseCounter + 1}`,
    name,
    arguments: rawArguments,
    status: 'completed',
  };
}

function textTurn(text: string): models.OpenResponsesResult {
  return baseResponse([
    {
      id: `msg_${responseCounter + 1}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text,
          annotations: [],
        },
      ],
    },
  ]);
}

function scriptModelTurns(...turns: models.OpenResponsesResult[]): void {
  for (const turn of turns) {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: turn,
    });
  }
}

const FunctionCallOutputItemSchema = z.object({
  type: z.literal('function_call_output'),
  callId: z.string(),
  output: z.string(),
});

/**
 * The decoded error strings from the function_call_output items the engine
 * sent in request `requestIndex` (0-based). Outputs are JSON-encoded
 * `{ error: string }` objects on the wire.
 */
function sentToolErrorFeedback(requestIndex: number): string[] {
  const request = mockBetaResponsesSend.mock.calls[requestIndex]?.[1]?.responsesRequest;
  const input: unknown[] = Array.isArray(request?.input) ? request.input : [];
  const outputs: string[] = [];
  for (const item of input) {
    const parsed = FunctionCallOutputItemSchema.safeParse(item);
    if (parsed.success) {
      const decoded = z
        .object({
          error: z.string(),
        })
        .safeParse(JSON.parse(parsed.data.output));
      outputs.push(decoded.success ? decoded.data.error : parsed.data.output);
    }
  }
  return outputs;
}

const client = {} as OpenRouterCore;

const shellTool = tool({
  name: 'run_shell',
  description: 'Run shell commands.',
  inputSchema: z.object({
    commands: z.array(z.string()),
  }),
  outputSchema: z.object({
    stdout: z.string(),
  }),
  execute: async () => ({
    stdout: '',
  }),
});

/** A long payload cut off mid-string, the shape a max_tokens truncation produces. */
const TRUNCATED_ARGS = `{"commands": ["cat << 'EOF' > /tmp/app/index.html\\n${'<div>very long generated content</div>\\n'.repeat(20)}`;

beforeEach(() => {
  mockBetaResponsesSend.mockReset();
  responseCounter = 0;
});

describe('tool-call arguments truncated by max_output_tokens', () => {
  it('tells the model the call was cut off and to shrink it, without echoing the full payload', async () => {
    scriptModelTurns(
      baseResponse(
        [
          functionCallItem('run_shell', TRUNCATED_ARGS),
        ],
        'incomplete',
        'max_output_tokens',
      ),
      textTurn('understood'),
    );

    const result = callModel(client, {
      model: 'test-model',
      input: 'Build the page.',
      tools: [
        shellTool,
      ] as const,
    });
    await result.getResponse();

    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    const outputs = sentToolErrorFeedback(1);
    expect(outputs).toHaveLength(1);
    const feedback = outputs[0] ?? '';
    expect(feedback).toContain('output token limit');
    expect(feedback).toContain('max_output_tokens');
    expect(feedback).toContain('splitting the work');
    // Only a short prefix of the raw payload is echoed back — the full
    // truncated payload would burn a large slice of the next turn's context.
    expect(feedback).toContain(TRUNCATED_ARGS.substring(0, 50));
    expect(feedback).not.toContain(TRUNCATED_ARGS);
  });

  it('keeps the generic invalid-JSON feedback for malformed arguments on completed responses', async () => {
    scriptModelTurns(
      baseResponse([
        functionCallItem('run_shell', '{"commands": broken'),
      ]),
      textTurn('understood'),
    );

    const result = callModel(client, {
      model: 'test-model',
      input: 'Run it.',
      tools: [
        shellTool,
      ] as const,
    });
    await result.getResponse();

    const outputs = sentToolErrorFeedback(1);
    expect(outputs).toHaveLength(1);
    const feedback = outputs[0] ?? '';
    expect(feedback).toContain('The model provided invalid JSON');
    expect(feedback).toContain('{"commands": broken');
    expect(feedback).not.toContain('output token limit');
  });

  it('only flags the final output item — an earlier malformed call in the same incomplete response gets the generic feedback', async () => {
    // max_output_tokens cuts generation at one point, so only the last item
    // can be truncated. The earlier call is genuinely malformed and must be
    // told to fix its JSON, not to shrink the call.
    scriptModelTurns(
      baseResponse(
        [
          functionCallItem('run_shell', '{"commands": broken'),
          functionCallItem('run_shell', TRUNCATED_ARGS),
        ],
        'incomplete',
        'max_output_tokens',
      ),
      textTurn('understood'),
    );

    const result = callModel(client, {
      model: 'test-model',
      input: 'Run both.',
      tools: [
        shellTool,
      ] as const,
    });
    await result.getResponse();

    const outputs = sentToolErrorFeedback(1);
    expect(outputs).toHaveLength(2);
    expect(outputs[0] ?? '').toContain('The model provided invalid JSON');
    expect(outputs[0] ?? '').not.toContain('output token limit');
    expect(outputs[1] ?? '').toContain('output token limit');
  });

  it('keeps the generic feedback when a response is incomplete for a different reason', async () => {
    scriptModelTurns(
      baseResponse(
        [
          functionCallItem('run_shell', '{"commands": broken'),
        ],
        'incomplete',
        'content_filter',
      ),
      textTurn('understood'),
    );

    const result = callModel(client, {
      model: 'test-model',
      input: 'Run it.',
      tools: [
        shellTool,
      ] as const,
    });
    await result.getResponse();

    const outputs = sentToolErrorFeedback(1);
    expect(outputs).toHaveLength(1);
    expect(outputs[0] ?? '').toContain('The model provided invalid JSON');
  });
});
