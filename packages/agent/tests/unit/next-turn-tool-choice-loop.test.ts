/**
 * `nextTurnParams.toolChoice` driven through the real callModel loop, with
 * betaResponsesSend mocked at the module level.
 *
 * Asserted against the DISPATCHED request rather than the helper in isolation:
 * `makeFollowupRequest` re-derives the wire tool choice from the caller-
 * configured value after `applyNextTurnParams` runs, so a hook that merges
 * correctly into `resolvedRequest` can still be discarded before dispatch.
 * Only a loop-level assertion catches that.
 */
import type * as models from '@openrouter/sdk/models';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import type { OpenRouterCore } from '@openrouter/sdk/core';
import { callModel } from '../../src/inner-loop/call-model.js';
import { tool } from '../../src/lib/tool.js';

afterEach(() => {
  mockBetaResponsesSend.mockReset();
  vi.restoreAllMocks();
});

const client = {} as unknown as OpenRouterCore;

function allowed(names: string[]): models.ResponsesRequest['toolChoice'] {
  return {
    type: 'allowed_tools',
    mode: 'auto',
    tools: names.map((name) => ({
      type: 'function',
      name,
    })),
  } as unknown as models.ResponsesRequest['toolChoice'];
}

function toolCallResponse(): models.OpenResponsesResult {
  return {
    id: 'resp_tool',
    output: [
      {
        type: 'function_call',
        id: 'out_1',
        callId: 'call_1',
        name: 'tool_search',
        arguments: '{"pattern":"weather"}',
        status: 'completed',
      },
    ],
  } as unknown as models.OpenResponsesResult;
}

function textResponse(): models.OpenResponsesResult {
  return {
    id: 'resp_text',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'done',
          },
        ],
        status: 'completed',
      },
    ],
  } as unknown as models.OpenResponsesResult;
}

/** The tool choice on each request actually handed to the SDK. */
function dispatchedToolChoices(): unknown[] {
  return mockBetaResponsesSend.mock.calls.map(
    (call) =>
      (
        call[1] as {
          responsesRequest: models.ResponsesRequest;
        }
      ).responsesRequest.toolChoice,
  );
}

function makeSearchTool(widened: string[]) {
  return tool({
    name: 'tool_search',
    inputSchema: z.object({
      pattern: z.string(),
    }),
    execute: () => ({
      found: widened,
    }),
    nextTurnParams: {
      toolChoice: () => allowed(widened),
    },
  });
}

const getWeather = tool({
  name: 'get_weather',
  inputSchema: z.object({}),
  execute: () => ({
    ok: true,
  }),
});

describe('nextTurnParams.toolChoice through the callModel loop', () => {
  it('reaches the dispatched follow-up request', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse(),
      })
      .mockResolvedValue({
        ok: true,
        value: textResponse(),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        makeSearchTool([
          'tool_search',
          'get_weather',
        ]),
        getWeather,
      ],
      toolChoice: allowed([
        'tool_search',
      ]),
    }).getText();

    const choices = dispatchedToolChoices();
    expect(choices.length).toBeGreaterThanOrEqual(2);

    // Turn 1 uses the caller's narrow set.
    expect(choices[0]).toEqual(
      allowed([
        'tool_search',
      ]),
    );

    // Turn 2 must carry the tool's widened set, not the caller's original.
    expect(choices[1]).toEqual(
      allowed([
        'tool_search',
        'get_weather',
      ]),
    );
  });

  it('leaves the tools array untouched while the choice widens', async () => {
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse(),
      })
      .mockResolvedValue({
        ok: true,
        value: textResponse(),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        makeSearchTool([
          'tool_search',
          'get_weather',
        ]),
        getWeather,
      ],
      toolChoice: allowed([
        'tool_search',
      ]),
    }).getText();

    const toolNames = mockBetaResponsesSend.mock.calls.map((call) =>
      (
        (
          call[1] as {
            responsesRequest: models.ResponsesRequest;
          }
        ).responsesRequest.tools ?? []
      ).map(
        (t) =>
          (
            t as {
              name?: string;
            }
          ).name,
      ),
    );

    /* Identical across turns: widening must not change the request prefix, or
     * the provider's prompt cache is lost — the reason to withhold tools at all. */
    expect(toolNames[1]).toEqual(toolNames[0]);
  });

  it('does not disturb toolChoice when no tool computes one', async () => {
    const plain = tool({
      name: 'tool_search',
      inputSchema: z.object({
        pattern: z.string(),
      }),
      execute: () => ({
        ok: true,
      }),
    });

    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: toolCallResponse(),
      })
      .mockResolvedValue({
        ok: true,
        value: textResponse(),
      });

    await callModel(client, {
      model: 'test-model',
      input: 'hi',
      tools: [
        plain,
        getWeather,
      ],
      toolChoice: allowed([
        'tool_search',
      ]),
    }).getText();

    for (const choice of dispatchedToolChoices()) {
      expect(choice).toEqual(
        allowed([
          'tool_search',
        ]),
      );
    }
  });
});
