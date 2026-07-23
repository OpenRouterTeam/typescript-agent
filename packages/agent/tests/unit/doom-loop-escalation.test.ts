/**
 * Tests for the doom-loop `escalate` recovery rung: on detection, throw more
 * intelligence at the NEXT turn — a one-turn model swap and/or a forced
 * `openrouter:advisor` consult — then return to the configured model.
 *
 * All scenarios simulate the LLM with scripted `betaResponsesSend`
 * responses (no live model). Coverage:
 *
 * - config resolution: rung + mechanism pairing, budget defaults, warnings
 * - ladder placement: steer < escalate < block; budget exhaustion falls through
 * - engine: one-turn model override (and automatic revert), advisor tool
 *   injection with pinned toolChoice, steer notice accompanying escalation,
 *   budget consumption at APPLICATION time, persistence of escalationsUsed
 * - hook interplay: overrideAction 'escalate' honored with budget, downgraded
 *   without
 */
import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

import { callModel } from '../../src/inner-loop/call-model.js';
import { DoomLoopMonitor, resolveDoomLoopOption } from '../../src/lib/doom-loop.js';
import { HooksManager } from '../../src/lib/hooks-manager.js';
import type { DoomLoopDetectedPayload } from '../../src/lib/hooks-schemas.js';
import { tool } from '../../src/lib/tool.js';
import type { ConversationState, StateAccessor, Tool } from '../../src/lib/tool-types.js';

// ---------------------------------------------------------------------------
// Fixtures (same scripted-LLM harness as the sibling doom-loop test files)
// ---------------------------------------------------------------------------

let counter = 0;

function baseResponse(output: unknown[]): models.OpenResponsesResult {
  counter++;
  return {
    id: `resp_${counter}`,
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output,
    error: null,
    incompleteDetails: null,
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

function toolCallTurn(name: string, args: unknown): models.OpenResponsesResult {
  counter++;
  return baseResponse([
    {
      type: 'function_call',
      id: `fc_${counter}`,
      callId: `call_${counter}`,
      name,
      arguments: JSON.stringify(args),
      status: 'completed',
    },
  ]);
}

function textTurn(text: string): models.OpenResponsesResult {
  counter++;
  return baseResponse([
    {
      id: `msg_${counter}`,
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

function scriptModelTurns(...turns: models.OpenResponsesResult[]) {
  for (const scripted of turns) {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: scripted,
    });
  }
}

/** The ResponsesRequest sent in dispatch N (0-based). */
function requestOf(n: number): Record<string, unknown> {
  return mockBetaResponsesSend.mock.calls[n]?.[1]?.responsesRequest ?? {};
}

function makeStateAccessor(): StateAccessor<readonly Tool[]> & {
  getLatest: () => ConversationState<readonly Tool[]> | null;
} {
  let state: ConversationState<readonly Tool[]> | null = null;
  return {
    load: async () => state,
    save: async (s) => {
      state = s;
    },
    getLatest: () => state,
  };
}

function collectDetections(hooks: HooksManager): DoomLoopDetectedPayload[] {
  const detections: DoomLoopDetectedPayload[] = [];
  hooks.on('DoomLoopDetected', {
    handler: (payload) => {
      detections.push(payload);
    },
  });
  return detections;
}

const client = {
  _options: {},
} as OpenRouterCore;

const searchTool = tool({
  name: 'web_search',
  inputSchema: z.object({
    query: z.string(),
  }),
  outputSchema: z.object({
    results: z.string(),
  }),
  execute: async ({ query }) => ({
    results: `nothing for ${query}`,
  }),
});

/** Escalate at streak 2, block/stop far away — isolates the recovery rung. */
const ESCALATE_AT_2 = {
  observe: 1,
  steer: false as const,
  escalate: 2,
  block: 5,
  stop: 8,
};

beforeEach(() => {
  mockBetaResponsesSend.mockReset();
  counter = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

describe('escalation config resolution', () => {
  it('resolves a mechanism with the default budget', () => {
    const resolved = resolveDoomLoopOption({
      ladder: {
        escalate: 3,
      },
      escalation: {
        model: 'openai/gpt-5',
      },
    });
    expect(resolved?.escalation).toEqual({
      model: 'openai/gpt-5',
      maxEscalations: 2,
    });
    expect(resolved?.ladder.escalate).toBe(3);
  });

  it('warns and disables the rung when escalate is enabled without a mechanism', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolveDoomLoopOption({
      ladder: {
        escalate: 3,
      },
    });
    expect(resolved?.escalation).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no escalation config'));
  });

  it('warns when a mechanism is configured but the rung is disabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolveDoomLoopOption({
      escalation: {
        model: 'openai/gpt-5',
      },
    });
    // Mechanism kept (hook overrides may still use it); rung stays off.
    expect(resolved?.escalation).not.toBeNull();
    expect(resolved?.ladder.escalate).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('escalate ladder rung is disabled'));
  });

  it('clamps an invalid maxEscalations to the default', () => {
    const resolved = resolveDoomLoopOption({
      ladder: {
        escalate: 2,
      },
      escalation: {
        model: 'openai/gpt-5',
        maxEscalations: 0,
      },
    });
    expect(resolved?.escalation?.maxEscalations).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Monitor: ladder placement and budget
// ---------------------------------------------------------------------------

describe('escalate rung in the monitor', () => {
  function makeMonitor(maxEscalations = 2) {
    const config = resolveDoomLoopOption({
      ladder: ESCALATE_AT_2,
      escalation: {
        model: 'openai/gpt-5',
        maxEscalations,
      },
    });
    if (!config) {
      throw new Error('unreachable');
    }
    return new DoomLoopMonitor(config);
  }

  it('fires escalate between steer and block, and repeats while budget remains', async () => {
    const monitor = makeMonitor();
    const args = {
      q: 'same',
    };
    expect((await monitor.recordToolCall('search', args, 1)).verdict).toMatchObject({
      action: 'observe',
      streak: 1,
    });
    expect((await monitor.recordToolCall('search', args, 2)).verdict).toMatchObject({
      action: 'escalate',
      streak: 2,
    });
    // Budget not yet consumed (engine consumes at application time), so the
    // rung keeps firing.
    expect((await monitor.recordToolCall('search', args, 3)).verdict).toMatchObject({
      action: 'escalate',
      streak: 3,
    });
  });

  it('falls through to weaker rungs once the budget is exhausted', async () => {
    const monitor = makeMonitor(1);
    const args = {
      q: 'same',
    };
    await monitor.recordToolCall('search', args, 1);
    expect((await monitor.recordToolCall('search', args, 2)).verdict).toMatchObject({
      action: 'escalate',
    });
    monitor.consumeEscalation(); // engine applied it
    expect(monitor.canEscalate()).toBe(false);
    // Streak 3: escalate rung crossed but unavailable → falls to observe
    // (steer disabled, block at 5).
    expect((await monitor.recordToolCall('search', args, 3)).verdict).toMatchObject({
      action: 'observe',
      streak: 3,
    });
    // Streak 5 crosses block, which is unaffected by the escalation budget.
    await monitor.recordToolCall('search', args, 4);
    expect((await monitor.recordToolCall('search', args, 5)).verdict).toMatchObject({
      action: 'block',
      streak: 5,
    });
  });

  it('escalationsUsed round-trips through serialized state', async () => {
    const monitor = makeMonitor(2);
    monitor.consumeEscalation();
    const blob = JSON.parse(JSON.stringify(monitor.getState()));
    expect(blob.escalationsUsed).toBe(1);

    const config = resolveDoomLoopOption({
      ladder: ESCALATE_AT_2,
      escalation: {
        model: 'openai/gpt-5',
        maxEscalations: 2,
      },
    });
    if (!config) {
      throw new Error('unreachable');
    }
    const resumed = new DoomLoopMonitor(config, blob);
    expect(resumed.canEscalate()).toBe(true);
    resumed.consumeEscalation();
    expect(resumed.canEscalate()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine: one-turn overrides
// ---------------------------------------------------------------------------

describe('engine escalation recovery', () => {
  it('swaps the model for exactly ONE turn, then reverts', async () => {
    // Turns: 1 same-call (streak 1, observe) → 2 same-call (streak 2,
    // ESCALATE arms) → follow-up after round 2 is the escalated dispatch →
    // model recovers with a different call → normal dispatch → done.
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'same',
      }),
      toolCallTurn('web_search', {
        query: 'same',
      }),
      toolCallTurn('web_search', {
        query: 'different now',
      }),
      textTurn('recovered'),
    );

    const text = await callModel(client, {
      model: 'cheap-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: ESCALATE_AT_2,
        escalation: {
          model: 'frontier-model',
        },
      },
    }).getText();

    expect(text).toBe('recovered');
    // Dispatch 0 (initial) and 1 (follow-up round 1): configured model.
    expect(requestOf(0)['model']).toBe('cheap-model');
    expect(requestOf(1)['model']).toBe('cheap-model');
    // Dispatch 2 (follow-up after the escalate verdict): swapped model.
    expect(requestOf(2)['model']).toBe('frontier-model');
    // Dispatch 3: automatic revert to the configured model.
    expect(requestOf(3)['model']).toBe('cheap-model');
  });

  it('injects the advisor tool with pinned toolChoice for the escalated turn only', async () => {
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'same',
      }),
      toolCallTurn('web_search', {
        query: 'same',
      }),
      toolCallTurn('web_search', {
        query: 'unblocked',
      }),
      textTurn('done'),
    );

    await callModel(client, {
      model: 'cheap-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: ESCALATE_AT_2,
        escalation: {
          advisor: true,
        },
      },
    }).getText();

    // Escalated dispatch (2): advisor appended to tools, toolChoice pinned.
    const escalated = requestOf(2);
    const tools = escalated['tools'] as Array<Record<string, unknown>>;
    const advisor = tools.find((t) => t['type'] === 'openrouter:advisor');
    expect(advisor).toBeDefined();
    const parameters = advisor?.['parameters'] as Record<string, unknown>;
    expect(parameters['forwardTranscript']).toBe(true);
    expect(String(parameters['instructions'])).toContain('escalation advisor');
    expect(escalated['toolChoice']).toMatchObject({
      type: 'allowed_tools',
      mode: 'required',
    });
    // Model unchanged (advisor-only escalation).
    expect(escalated['model']).toBe('cheap-model');
    // Next dispatch reverts: no advisor, original toolChoice.
    const reverted = requestOf(3);
    const revertedTools = (reverted['tools'] as Array<Record<string, unknown>>) ?? [];
    expect(revertedTools.some((t) => t['type'] === 'openrouter:advisor')).toBe(false);
    expect(reverted['toolChoice']).not.toMatchObject({
      type: 'allowed_tools',
    });
  });

  it('advisor object config merges over the defaults', async () => {
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'same',
      }),
      toolCallTurn('web_search', {
        query: 'same',
      }),
      textTurn('done'),
    );

    await callModel(client, {
      model: 'cheap-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: ESCALATE_AT_2,
        escalation: {
          advisor: {
            model: 'anthropic/claude-opus-4.6',
            forwardTranscript: false,
          },
        },
      },
    }).getText();

    const parameters = (requestOf(2)['tools'] as Array<Record<string, unknown>>).find(
      (t) => t['type'] === 'openrouter:advisor',
    )?.['parameters'] as Record<string, unknown>;
    expect(parameters['model']).toBe('anthropic/claude-opus-4.6');
    // Explicit config overrides the forwardTranscript default.
    expect(parameters['forwardTranscript']).toBe(false);
    // Default instructions kept (not overridden).
    expect(String(parameters['instructions'])).toContain('escalation advisor');
  });

  it('a steer notice accompanies the escalated turn so the model knows why', async () => {
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'same',
      }),
      toolCallTurn('web_search', {
        query: 'same',
      }),
      textTurn('done'),
    );

    await callModel(client, {
      model: 'cheap-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: ESCALATE_AT_2,
        escalation: {
          model: 'frontier-model',
        },
      },
    }).getText();

    const escalatedInput = requestOf(2)['input'] as unknown[];
    const UserMessage = z.object({
      role: z.literal('user'),
      content: z.string(),
    });
    const notices = escalatedInput.filter((item) => {
      const parsed = UserMessage.safeParse(item);
      return parsed.success && parsed.data.content.includes('escalated turn follows');
    });
    expect(notices).toHaveLength(1);
  });

  it('consumes budget per APPLIED escalation and falls through when exhausted', async () => {
    const hooks = new HooksManager();
    const detections = collectDetections(hooks);

    // maxEscalations: 1. Streak 2 escalates (applied on the follow-up);
    // streak 3 would escalate again but the budget is gone → falls through
    // to observe; streak 5 blocks.
    scriptModelTurns(
      ...Array.from(
        {
          length: 6,
        },
        () =>
          toolCallTurn('web_search', {
            query: 'same',
          }),
      ),
      textTurn('gave up'),
    );

    const accessor = makeStateAccessor();
    await callModel(client, {
      model: 'cheap-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: ESCALATE_AT_2,
        escalation: {
          model: 'frontier-model',
          maxEscalations: 1,
        },
      },
      state: accessor,
      hooks,
    }).getText();

    expect(
      detections
        // The final "gave up" text turn also crosses observe@1 via the
        // text-streak detector; this test asserts the TOOL streak ladder.
        .filter((d) => d.detector === 'tool-fingerprint')
        .map((d) => [
          d.action,
          d.streak,
        ]),
    ).toEqual([
      [
        'observe',
        1,
      ],
      [
        'escalate',
        2,
      ],
      [
        'observe',
        3,
      ],
      [
        'observe',
        4,
      ],
      [
        'block',
        5,
      ],
      [
        'block',
        6,
      ],
    ]);
    // Exactly ONE dispatch used the frontier model.
    const escalatedDispatches = mockBetaResponsesSend.mock.calls.filter(
      (call) => call[1]?.responsesRequest?.model === 'frontier-model',
    );
    expect(escalatedDispatches).toHaveLength(1);
    // Consumed budget persisted for resumes.
    expect(accessor.getLatest()?.doomLoop?.escalationsUsed).toBe(1);
  });

  it('hook overrideAction escalate is honored with budget and downgraded without config', async () => {
    // With an escalation config: observe verdict overridden to escalate.
    const hooks = new HooksManager();
    hooks.on('DoomLoopDetected', {
      handler: () => ({
        overrideAction: 'escalate' as const,
      }),
    });
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'same',
      }),
      toolCallTurn('web_search', {
        query: 'same',
      }),
      textTurn('done'),
    );
    await callModel(client, {
      model: 'cheap-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: {
          observe: 2,
          block: 5,
          stop: 8,
        },
        escalation: {
          model: 'frontier-model',
        },
      },
      hooks,
    }).getText();
    expect(requestOf(2)['model']).toBe('frontier-model');

    // Without a config: the override downgrades to observe — no crash, no
    // model change.
    mockBetaResponsesSend.mockReset();
    counter = 0;
    const hooks2 = new HooksManager();
    hooks2.on('DoomLoopDetected', {
      handler: () => ({
        overrideAction: 'escalate' as const,
      }),
    });
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'same',
      }),
      toolCallTurn('web_search', {
        query: 'same',
      }),
      textTurn('done'),
    );
    const text = await callModel(client, {
      model: 'cheap-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: {
          observe: 2,
          block: 5,
          stop: 8,
        },
      },
      hooks: hooks2,
    }).getText();
    expect(text).toBe('done');
    expect(requestOf(2)['model']).toBe('cheap-model');
  });

  it('text-detector verdicts can escalate too', async () => {
    // Identical filler text across turns with DIFFERENT tool calls: only
    // the text-streak detector fires.
    function textAndCallTurn(text: string, query: string): models.OpenResponsesResult {
      counter++;
      return baseResponse([
        {
          id: `msg_${counter}`,
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
        {
          type: 'function_call',
          id: `fc_${counter}`,
          callId: `call_${counter}`,
          name: 'web_search',
          arguments: JSON.stringify({
            query,
          }),
          status: 'completed',
        },
      ]);
    }

    const filler = 'Let me look somewhere else.';
    scriptModelTurns(
      textAndCallTurn(filler, 'q1'),
      textAndCallTurn(filler, 'q2'),
      toolCallTurn('web_search', {
        query: 'q3',
      }),
      textTurn('unblocked'),
    );

    await callModel(client, {
      model: 'cheap-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: ESCALATE_AT_2,
        escalation: {
          model: 'frontier-model',
        },
        text: true,
      },
    }).getText();

    // The text streak hits 2 on the second response; the NEXT follow-up
    // dispatch is the escalated one.
    const escalatedDispatches = mockBetaResponsesSend.mock.calls.filter(
      (call) => call[1]?.responsesRequest?.model === 'frontier-model',
    );
    expect(escalatedDispatches).toHaveLength(1);
  });

  it('two detectors firing in one window escalate ONCE (no double spend)', async () => {
    // Same tool call AND same text every turn: tool-fingerprint and
    // text-streak both cross the escalate rung on turn 2. One escalation.
    function sameEverything(): models.OpenResponsesResult {
      counter++;
      return baseResponse([
        {
          id: `msg_${counter}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'Trying the same thing.',
              annotations: [],
            },
          ],
        },
        {
          type: 'function_call',
          id: `fc_${counter}`,
          callId: `call_${counter}`,
          name: 'web_search',
          arguments: JSON.stringify({
            query: 'same',
          }),
          status: 'completed',
        },
      ]);
    }

    const accessor = makeStateAccessor();
    scriptModelTurns(sameEverything(), sameEverything(), textTurn('done'));

    await callModel(client, {
      model: 'cheap-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: ESCALATE_AT_2,
        escalation: {
          model: 'frontier-model',
          maxEscalations: 5,
        },
      },
      state: accessor,
    }).getText();

    expect(accessor.getLatest()?.doomLoop?.escalationsUsed).toBe(1);
  });
});
