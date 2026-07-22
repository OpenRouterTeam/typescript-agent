/**
 * Integration tests for the doom-loop remediation pass (adversarial-review
 * findings, see planning/doom-loop-remediation-plan.md in the monorepo).
 *
 * Every scenario simulates the LLM with scripted `betaResponsesSend`
 * responses. Coverage map (finding → test group):
 *
 * - B1/D7  state integrity + session reason on text-verdict stops
 * - B3     parallel same-round duplicates are one piece of evidence
 * - D1     no final-response request after a doom stop
 * - D2/D3  approval-resume gating + verdict persistence/clearing
 * - D4     steer survives pauses via persisted pendingSteer; in-loop steer
 * - D5     loopKey undefined → fallback (not a colliding constant)
 * - H1     DOCUMENTED MISS: nonce-varying args evade the fingerprint
 * - H2     server-tool repetition detected at the step checkpoint
 * - API1   declarative loopKey forms (field list, false)
 * - config ON→OFF / OFF→ON lifecycle across resumes
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
import { HooksManager } from '../../src/lib/hooks-manager.js';
import type { DoomLoopDetectedPayload } from '../../src/lib/hooks-schemas.js';
import { tool } from '../../src/lib/tool.js';
import type { ConversationState, StateAccessor, Tool } from '../../src/lib/tool-types.js';

// ---------------------------------------------------------------------------
// Fixtures (same scripted-LLM harness as doom-loop-integration.test.ts)
// ---------------------------------------------------------------------------

let responseCounter = 0;
let callCounter = 0;

function baseResponse(output: unknown[]): models.OpenResponsesResult {
  responseCounter++;
  return {
    id: `resp_${responseCounter}`,
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

function functionCallItem(name: string, args: unknown): Record<string, unknown> {
  callCounter++;
  return {
    type: 'function_call',
    id: `fc_${callCounter}`,
    callId: `call_${callCounter}`,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}

function messageItem(text: string): Record<string, unknown> {
  callCounter++;
  return {
    id: `msg_${callCounter}`,
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
  };
}

/** A turn with arbitrary output items. */
function turn(...items: Record<string, unknown>[]): models.OpenResponsesResult {
  return baseResponse(items);
}

function toolCallTurn(name: string, args: unknown): models.OpenResponsesResult {
  return turn(functionCallItem(name, args));
}

function textTurn(text: string): models.OpenResponsesResult {
  return turn(messageItem(text));
}

function scriptModelTurns(...turns: models.OpenResponsesResult[]) {
  for (const scripted of turns) {
    mockBetaResponsesSend.mockResolvedValueOnce({
      ok: true,
      value: scripted,
    });
  }
}

const FunctionCallItemSchema = z.object({
  type: z.literal('function_call'),
  callId: z.string(),
});
const FunctionCallOutputItemSchema = z.object({
  type: z.literal('function_call_output'),
  callId: z.string(),
  output: z.string(),
});

/** Assert every function_call in `messages` has a matching output. */
function assertWellFormedHistory(messages: unknown): void {
  const items: unknown[] = Array.isArray(messages) ? messages : [];
  const callIds = new Set<string>();
  const outputIds = new Set<string>();
  for (const item of items) {
    const call = FunctionCallItemSchema.safeParse(item);
    if (call.success) {
      callIds.add(call.data.callId);
    }
    const output = FunctionCallOutputItemSchema.safeParse(item);
    if (output.success) {
      outputIds.add(output.data.callId);
    }
  }
  for (const id of callIds) {
    expect(outputIds.has(id), `function_call ${id} must have a matching output`).toBe(true);
  }
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

const client = {} as OpenRouterCore;

const searchTool = tool({
  name: 'web_search',
  description: 'Search the web.',
  inputSchema: z.object({
    query: z.string(),
  }),
  outputSchema: z.object({
    results: z.array(z.string()),
  }),
  loopKey: ({ query }) => query.trim().toLowerCase(),
  execute: async ({ query }) => ({
    results: [
      `result for ${query}`,
    ],
  }),
});

beforeEach(() => {
  mockBetaResponsesSend.mockReset();
  responseCounter = 0;
  callCounter = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// B3 — parallel same-round duplicates
// ---------------------------------------------------------------------------

describe('B3: parallel identical calls in ONE round are one piece of evidence', () => {
  it('a 6-wide identical fan-out executes fully with zero detections', async () => {
    const executeSpy = vi.fn(async () => ({
      results: [
        'r',
      ],
    }));
    const fanoutTool = tool({
      name: 'web_search',
      inputSchema: z.object({
        query: z.string(),
      }),
      outputSchema: z.object({
        results: z.array(z.string()),
      }),
      execute: executeSpy,
    });

    const hooks = new HooksManager();
    const detections = collectDetections(hooks);

    const args = {
      query: 'same',
    };
    scriptModelTurns(
      turn(
        functionCallItem('web_search', args),
        functionCallItem('web_search', args),
        functionCallItem('web_search', args),
        functionCallItem('web_search', args),
        functionCallItem('web_search', args),
        functionCallItem('web_search', args),
      ),
      textTurn('All six ran.'),
    );

    const text = await callModel(client, {
      model: 'test-model',
      input: 'Fan out.',
      tools: [
        fanoutTool,
      ] as const,
      doomLoop: true,
      hooks,
    }).getText();

    expect(text).toBe('All six ran.');
    // Previously: streaks 1..6 → observe/block/block/block/stop. Now: one
    // round = one increment (streak 1), everything executes, no verdicts.
    expect(executeSpy).toHaveBeenCalledTimes(6);
    expect(detections).toEqual([]);
  });

  it('duplicates of a call blocked this round share the block decision', async () => {
    const executeSpy = vi.fn(async () => ({
      ok: true,
    }));
    const t = tool({
      name: 'noisy',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      execute: executeSpy,
    });

    const hooks = new HooksManager();
    const detections = collectDetections(hooks);

    // Rounds 1 and 2 build the streak to 2; round 3 fans out THREE identical
    // calls — the streak increments once (to 3, block) and all three share
    // the block decision. Exactly one DoomLoopDetected for the round.
    scriptModelTurns(
      toolCallTurn('noisy', {}),
      toolCallTurn('noisy', {}),
      turn(
        functionCallItem('noisy', {}),
        functionCallItem('noisy', {}),
        functionCallItem('noisy', {}),
      ),
      textTurn('done'),
    );

    const text = await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        t,
      ] as const,
      doomLoop: true,
      hooks,
    }).getText();

    expect(text).toBe('done');
    // Rounds 1+2 executed one call each; round 3's three duplicates all blocked.
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(
      detections.map((d) => [
        d.action,
        d.streak,
      ]),
    ).toEqual([
      [
        'observe',
        2,
      ],
      [
        'block',
        3,
      ],
    ]);
  });
});

// ---------------------------------------------------------------------------
// B1 + D7 — state integrity and session reason on text-verdict stops
// ---------------------------------------------------------------------------

describe('B1/D7: text-verdict stops seal state and report doom_loop', () => {
  it('text stop on a response that ALSO carries tool calls leaves no dangling function_call', async () => {
    const accessor = makeStateAccessor();
    const sessionEnds: unknown[] = [];
    const hooks = new HooksManager();
    hooks.on('SessionEnd', {
      handler: (payload) => {
        sessionEnds.push(payload);
      },
    });

    // One response: degenerate repeated text (stop verdict) + a tool call
    // that will never execute. The seal must synthesize its output.
    const doomText = Array(20).fill('I am stuck.').join(' ');
    scriptModelTurns(
      turn(
        messageItem(doomText),
        functionCallItem('web_search', {
          query: 'never runs',
        }),
      ),
    );

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: true,
      state: accessor,
      hooks,
    }).getResponse();

    // Only the initial request was made — the loop halted before executing.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);
    expect(sessionEnds[0]).toMatchObject({
      reason: 'doom_loop',
    });

    const state = accessor.getLatest();
    expect(state).not.toBeNull();
    assertWellFormedHistory(state?.messages);
    // The synthesized output names the halt.
    const outputs = (state?.messages as unknown[]).filter(
      (m) => FunctionCallOutputItemSchema.safeParse(m).success,
    );
    expect(outputs.length).toBe(1);
    expect(FunctionCallOutputItemSchema.parse(outputs[0]).output).toContain(
      'halted by doom-loop detection',
    );
  });

  it('a resumed conversation after a sealed text stop sends well-formed input', async () => {
    const accessor = makeStateAccessor();
    const doomText = Array(20).fill('I am stuck.').join(' ');
    scriptModelTurns(
      turn(
        messageItem(doomText),
        functionCallItem('web_search', {
          query: 'never runs',
        }),
      ),
    );
    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: true,
      state: accessor,
    }).getResponse();

    // Resume with fresh user input; the request the SDK sends must contain a
    // matching output for every function_call.
    scriptModelTurns(textTurn('resumed fine'));
    const text = await callModel(client, {
      model: 'test-model',
      input: 'continue please',
      tools: [
        searchTool,
      ] as const,
      doomLoop: true,
      state: accessor,
    }).getText();

    expect(text).toBe('resumed fine');
    const resumeRequest = mockBetaResponsesSend.mock.calls[1]?.[1]?.responsesRequest;
    assertWellFormedHistory(resumeRequest?.input);
  });

  it('text-only no-tools stop reports SessionEnd reason doom_loop (not complete)', async () => {
    const sessionEnds: unknown[] = [];
    const hooks = new HooksManager();
    hooks.on('SessionEnd', {
      handler: (payload) => {
        sessionEnds.push(payload);
      },
    });

    const doomText = Array(20).fill('I am stuck.').join(' ');
    scriptModelTurns(textTurn(doomText));

    const result = callModel(client, {
      model: 'test-model',
      input: 'Summarize.',
      doomLoop: true,
      hooks,
    });
    const text = await result.getText();

    expect(text).toBe(doomText);
    expect(sessionEnds).toHaveLength(1);
    expect(sessionEnds[0]).toMatchObject({
      reason: 'doom_loop',
    });
    expect(await result.getDoomLoopVerdict()).toMatchObject({
      detector: 'text-repetition',
      action: 'stop',
    });
  });
});

// ---------------------------------------------------------------------------
// D1 — allowFinalResponse gating
// ---------------------------------------------------------------------------

describe('D1: no model request after a doom stop on the final-response path', () => {
  it('stopWhen + doom-stop during the halted turn skips makeFinalResponseRequest', async () => {
    // stopWhen fires after step 1 while the model still emits tool calls;
    // the final-response block executes the pending calls, and the doom
    // streak (stop@2 for compactness) crosses during that execution.
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'same',
      }),
      toolCallTurn('web_search', {
        query: 'same',
      }),
      // A third scripted turn exists; it must NEVER be requested.
      textTurn('should never be fetched'),
    );

    const result = callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: {
          observe: 2,
          block: 2,
          stop: 2,
        },
      },
      stopWhen: ({ steps }) => steps.length >= 1,
      allowFinalResponse: true,
    });

    await result.getResponse();

    // Request 1 = initial, request 2 = the tool-round follow-up that stopWhen
    // then halts. The final text-coercion request is SKIPPED because the
    // doom stop armed while executing the halted turn's calls.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    expect(await result.getDoomLoopVerdict()).toMatchObject({
      action: 'stop',
      streak: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// D2 + D3 — approval resume gating, verdict persistence and clearing
// ---------------------------------------------------------------------------

describe('D2/D3: approval-resume doom gating and verdict persistence', () => {
  const approvalTool = tool({
    name: 'risky',
    inputSchema: z.object({
      target: z.string(),
    }),
    outputSchema: z.object({
      done: z.boolean(),
    }),
    requireApproval: true,
    execute: async () => ({
      done: true,
    }),
  });

  async function runUntilApprovalPause(accessor: StateAccessor<readonly Tool[]>) {
    scriptModelTurns(
      toolCallTurn('risky', {
        target: 'same',
      }),
    );
    const result = callModel(client, {
      model: 'test-model',
      input: 'do the risky thing',
      tools: [
        approvalTool,
      ] as const,
      doomLoop: {
        ladder: {
          observe: 1,
          block: false,
          stop: 2,
        },
      },
      state: accessor,
    });
    await result.getResponse();
    return result;
  }

  it('doom-stop armed while executing approved calls makes no unsent-results request', async () => {
    const accessor = makeStateAccessor();

    // Run 1: model calls risky({target:'same'}) → pauses for approval.
    // The pending (unexecuted) call is NOT recorded.
    await runUntilApprovalPause(accessor);
    const paused = accessor.getLatest();
    expect(paused?.status).toBe('awaiting_approval');
    const pausedCallId = paused?.pendingToolCalls?.[0]?.id;
    expect(pausedCallId).toBeDefined();
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(1);

    // Seed a restored streak of 1 for the same fingerprint by injecting the
    // prior run's monitor state (as if an identical call executed before).
    // Approving the pending call increments to 2 → stop rung.
    const withStreak = accessor.getLatest();
    if (!withStreak?.doomLoop?.tools) {
      throw new Error('doomLoop state must be persisted');
    }
    // The paused call was never executed, so no streak exists yet. Simulate
    // the pre-pause history by re-running an executed identical call in a
    // fresh conversation is heavy; instead assert on the REAL semantics:
    // approving the call executes it (streak 1, no verdict at stop:2), and a
    // SECOND identical approved execution crosses the rung. Two pauses:
    scriptModelTurns(
      toolCallTurn('risky', {
        target: 'same',
      }),
    );
    // Resume 1: approve → executes (streak 1), unsent-results request runs,
    // model immediately calls the same tool again → pauses again.
    const resume1 = callModel(client, {
      model: 'test-model',
      input: undefined as unknown as string,
      tools: [
        approvalTool,
      ] as const,
      doomLoop: {
        ladder: {
          observe: 1,
          block: false,
          stop: 2,
        },
      },
      state: accessor,
      approveToolCalls: [
        pausedCallId as string,
      ],
    });
    await resume1.getResponse().catch(() => undefined);

    const pausedAgain = accessor.getLatest();
    expect(pausedAgain?.status).toBe('awaiting_approval');
    const secondCallId = pausedAgain?.pendingToolCalls?.[0]?.id;
    expect(secondCallId).toBeDefined();
    const requestsBeforeResume2 = mockBetaResponsesSend.mock.calls.length;

    // Resume 2: approving the second identical call crosses the stop rung
    // (restored streak 1 + this execution = 2). NO unsent-results model
    // request may fire.
    const resume2 = callModel(client, {
      model: 'test-model',
      input: undefined as unknown as string,
      tools: [
        approvalTool,
      ] as const,
      doomLoop: {
        ladder: {
          observe: 1,
          block: false,
          stop: 2,
        },
      },
      state: accessor,
      approveToolCalls: [
        secondCallId as string,
      ],
    });
    const verdict = await resume2.getDoomLoopVerdict();

    expect(verdict).toMatchObject({
      action: 'stop',
      streak: 2,
      toolName: 'risky',
    });
    // No additional model request after the doom stop.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(requestsBeforeResume2);

    // The stop verdict is persisted for decision-only resumes.
    expect(accessor.getLatest()?.doomLoop?.stopVerdict).toMatchObject({
      action: 'stop',
      streak: 2,
    });
  });

  it('a fresh conversational turn clears the persisted stop verdict; streaks survive', async () => {
    const accessor = makeStateAccessor();
    // Manufacture a condemned state directly: streaks + stopVerdict.
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'x',
      }),
      textTurn('paused here'),
    );
    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: true,
      state: accessor,
    }).getText();
    const base = accessor.getLatest();
    if (!base) {
      throw new Error('state must exist');
    }
    // Inject a stop verdict as if the run had been condemned.
    base.doomLoop = {
      ...(base.doomLoop ?? {
        tools: {},
      }),
      stopVerdict: {
        detector: 'tool-fingerprint',
        action: 'stop',
        streak: 6,
        fingerprint: 'f'.repeat(64),
        toolName: 'web_search',
        message: 'condemned',
      },
    };

    // Fresh conversational turn (plain input, no approve/reject decisions):
    // the verdict clears; the run proceeds normally.
    scriptModelTurns(textTurn('recovered'));
    const result = callModel(client, {
      model: 'test-model',
      input: 'try something new',
      tools: [
        searchTool,
      ] as const,
      doomLoop: true,
      state: accessor,
    });
    expect(await result.getText()).toBe('recovered');
    expect(await result.getDoomLoopVerdict()).toBeNull();
    // Cleared from persistence too (the next save omits it).
    expect(accessor.getLatest()?.doomLoop?.stopVerdict).toBeUndefined();
    // Streaks survived the clear.
    expect(accessor.getLatest()?.doomLoop?.tools['web_search']).toMatchObject({
      streak: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// D4 — steer delivery
// ---------------------------------------------------------------------------

describe('D4: steer', () => {
  it('injects corrective guidance before the next model request (in-loop)', async () => {
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'same',
      }),
      toolCallTurn('web_search', {
        query: 'same',
      }),
      textTurn('adjusted course'),
    );

    const text = await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: {
          observe: 2,
          steer: 2,
          block: false,
          stop: 6,
        },
      },
    }).getText();

    expect(text).toBe('adjusted course');
    // The steer verdict fired on round 2; the guidance must be a user
    // message in the THIRD request's input (the follow-up after round 2).
    const thirdRequest = mockBetaResponsesSend.mock.calls[2]?.[1]?.responsesRequest;
    const input: unknown[] = Array.isArray(thirdRequest?.input) ? thirdRequest.input : [];
    const UserMessage = z.object({
      role: z.literal('user'),
      content: z.string(),
    });
    const steerMessages = input.filter((item) => {
      const parsed = UserMessage.safeParse(item);
      return parsed.success && parsed.data.content.includes('Doom loop suspected');
    });
    expect(steerMessages).toHaveLength(1);
  });

  it('steer queued at a HITL pause persists in doomLoop.pendingSteer and delivers on resume', async () => {
    const accessor = makeStateAccessor();
    const hitlTool = tool({
      name: 'ask_human',
      inputSchema: z.object({
        question: z.string(),
      }),
      outputSchema: z.object({
        answer: z.string(),
      }),
      onToolCalled: () => null, // always pause
    });
    const steerTool = tool({
      name: 'lookup',
      inputSchema: z.object({
        key: z.string(),
      }),
      outputSchema: z.object({
        value: z.string(),
      }),
      execute: async () => ({
        value: 'v',
      }),
    });

    // Round 1: lookup(same). Round 2: lookup(same) again (steer@2 queues)
    // + a HITL call that pauses the run before any follow-up request.
    scriptModelTurns(
      toolCallTurn('lookup', {
        key: 'same',
      }),
      turn(
        functionCallItem('lookup', {
          key: 'same',
        }),
        functionCallItem('ask_human', {
          question: 'help?',
        }),
      ),
    );

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        steerTool,
        hitlTool,
      ] as const,
      doomLoop: {
        ladder: {
          observe: 2,
          steer: 2,
          block: false,
          stop: 6,
        },
      },
      state: accessor,
    }).getResponse();

    const paused = accessor.getLatest();
    expect(paused?.status).toBe('awaiting_hitl');
    // The guidance was NOT injected mid-pause (invalid history) but rides
    // the persisted state for the resumed run.
    expect(paused?.doomLoop?.pendingSteer).toEqual([
      expect.stringContaining('Doom loop suspected'),
    ]);
  });
});

// ---------------------------------------------------------------------------
// D5 + API1 — loopKey declaration forms
// ---------------------------------------------------------------------------

describe('API1: declarative loopKey forms', () => {
  it('field-array loopKey: same command in a different cwd is NOT a loop', async () => {
    const runs: string[] = [];
    const bashTool = tool({
      name: 'bash',
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string(),
        verbose: z.boolean().optional(),
      }),
      outputSchema: z.object({
        stdout: z.string(),
      }),
      // Declarative: data, not code. verbose is deliberately excluded.
      loopKey: [
        'command',
        'cwd',
      ],
      execute: async ({ command, cwd }) => {
        runs.push(`${cwd}:${command}`);
        return {
          stdout: 'ok',
        };
      },
    });

    scriptModelTurns(
      toolCallTurn('bash', {
        command: 'ls',
        cwd: '/a',
      }),
      toolCallTurn('bash', {
        command: 'ls',
        cwd: '/b',
      }),
      textTurn('both listed'),
    );

    const text = await callModel(client, {
      model: 'test-model',
      input: 'list',
      tools: [
        bashTool,
      ] as const,
      doomLoop: {
        ladder: {
          block: 2,
        },
      },
    }).getText();

    expect(text).toBe('both listed');
    expect(runs).toEqual([
      '/a:ls',
      '/b:ls',
    ]);
  });

  it('field-array loopKey collapses excluded-field variation (verbose flag is not identity)', async () => {
    const executeSpy = vi.fn(async () => ({
      stdout: 'ok',
    }));
    const bashTool = tool({
      name: 'bash',
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string(),
        verbose: z.boolean().optional(),
      }),
      outputSchema: z.object({
        stdout: z.string(),
      }),
      loopKey: [
        'command',
        'cwd',
      ],
      execute: executeSpy,
    });

    const hooks = new HooksManager();
    const detections = collectDetections(hooks);

    scriptModelTurns(
      toolCallTurn('bash', {
        command: 'ls',
        cwd: '/a',
        verbose: false,
      }),
      toolCallTurn('bash', {
        command: 'ls',
        cwd: '/a',
        verbose: true, // varies, but is not part of the identity
      }),
      textTurn('done'),
    );

    await callModel(client, {
      model: 'test-model',
      input: 'list',
      tools: [
        bashTool,
      ] as const,
      doomLoop: true,
      hooks,
    }).getText();

    expect(
      detections.map((d) => [
        d.action,
        d.streak,
      ]),
    ).toEqual([
      [
        'observe',
        2,
      ],
    ]);
  });

  it('loopKey: false statically exempts a tool', async () => {
    const pollTool = tool({
      name: 'check_status',
      inputSchema: z.object({
        jobId: z.string(),
      }),
      outputSchema: z.object({
        done: z.boolean(),
      }),
      loopKey: false,
      execute: async () => ({
        done: false,
      }),
    });

    const hooks = new HooksManager();
    const detections = collectDetections(hooks);

    scriptModelTurns(
      ...Array.from(
        {
          length: 5,
        },
        () =>
          toolCallTurn('check_status', {
            jobId: 'job-1',
          }),
      ),
      textTurn('still running'),
    );

    const text = await callModel(client, {
      model: 'test-model',
      input: 'wait',
      tools: [
        pollTool,
      ] as const,
      doomLoop: true,
      hooks,
    }).getText();

    expect(text).toBe('still running');
    expect(detections).toEqual([]);
  });

  it('D5: loopKey returning undefined falls back to full args (varying args ⇒ no false streak)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const buggyTool = tool({
      name: 'buggy',
      inputSchema: z.object({
        value: z.string(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      // A bare `return;` — previously collided every call onto the constant
      // "null" identity, blocking a tool the author meant to exempt.
      loopKey: () => undefined,
      execute: async () => ({
        ok: true,
      }),
    });

    const hooks = new HooksManager();
    const detections = collectDetections(hooks);

    scriptModelTurns(
      toolCallTurn('buggy', {
        value: 'a',
      }),
      toolCallTurn('buggy', {
        value: 'b',
      }),
      toolCallTurn('buggy', {
        value: 'c',
      }),
      textTurn('done'),
    );

    const text = await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        buggyTool,
      ] as const,
      doomLoop: true,
      hooks,
    }).getText();

    expect(text).toBe('done');
    // Distinct args ⇒ distinct fallback identities ⇒ no detections.
    expect(detections).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('returned undefined'));
  });
});

// ---------------------------------------------------------------------------
// H1 — documented miss: nonce evasion
// ---------------------------------------------------------------------------

describe('H1 (DOCUMENTED MISS): varying-args loops evade the default fingerprint', () => {
  it('a model inventing a fresh nonce each turn is NOT detected without a loopKey', async () => {
    const nonceTool = tool({
      name: 'lookup',
      inputSchema: z.object({
        key: z.string(),
        request_id: z.string(),
      }),
      outputSchema: z.object({
        value: z.string(),
      }),
      // No loopKey: the full arguments (including the nonce) are the identity.
      execute: async () => ({
        value: 'same answer every time',
      }),
    });

    const hooks = new HooksManager();
    const detections = collectDetections(hooks);

    scriptModelTurns(
      ...Array.from(
        {
          length: 6,
        },
        (_, i) =>
          toolCallTurn('lookup', {
            key: 'same',
            request_id: `r${i}`, // the evasion
          }),
      ),
      textTurn('gave up'),
    );

    const text = await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        nonceTool,
      ] as const,
      doomLoop: true,
      hooks,
    }).getText();

    // This is the documented limit of Option A (the progress-ledger detector
    // is the structural fix — design doc Option C). The test locks the
    // behavior so the gap is visible, not silent.
    expect(text).toBe('gave up');
    expect(detections).toEqual([]);
  });

  it('the same loop IS caught when the tool declares a field-list loopKey', async () => {
    const nonceTool = tool({
      name: 'lookup',
      inputSchema: z.object({
        key: z.string(),
        request_id: z.string(),
      }),
      outputSchema: z.object({
        value: z.string(),
      }),
      loopKey: [
        'key',
      ],
      execute: async () => ({
        value: 'same',
      }),
    });

    const hooks = new HooksManager();
    const detections = collectDetections(hooks);

    scriptModelTurns(
      ...Array.from(
        {
          length: 3,
        },
        (_, i) =>
          toolCallTurn('lookup', {
            key: 'same',
            request_id: `r${i}`,
          }),
      ),
      textTurn('done'),
    );

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        nonceTool,
      ] as const,
      doomLoop: true,
      hooks,
    }).getText();

    expect(
      detections.map((d) => [
        d.action,
        d.streak,
      ]),
    ).toEqual([
      [
        'observe',
        2,
      ],
      [
        'block',
        3,
      ],
    ]);
  });
});

// ---------------------------------------------------------------------------
// H2 — server-tool fingerprinting
// ---------------------------------------------------------------------------

describe('H2: server-tool repetition at the step checkpoint', () => {
  function serverSearchItem(query: string): Record<string, unknown> {
    callCounter++;
    return {
      type: 'web_search_call',
      id: `ws_${callCounter}`,
      status: 'completed',
      action: {
        type: 'search',
        query,
      },
    };
  }

  it('repeated identical server-tool calls build a streak and can stop the run', async () => {
    const hooks = new HooksManager();
    const detections = collectDetections(hooks);

    // Each turn: a server web_search with the SAME query + a client tool
    // call that keeps the loop going. Server-tool detection is post-hoc
    // (observe/steer/stop; block meaningless).
    const clientTool = tool({
      name: 'note',
      inputSchema: z.object({
        n: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      execute: async () => ({
        ok: true,
      }),
    });

    scriptModelTurns(
      turn(
        serverSearchItem('same query'),
        functionCallItem('note', {
          n: 1,
        }),
      ),
      turn(
        serverSearchItem('same query'),
        functionCallItem('note', {
          n: 2,
        }),
      ),
      turn(
        serverSearchItem('same query'),
        functionCallItem('note', {
          n: 3,
        }),
      ),
      textTurn('done'),
    );

    const result = callModel(client, {
      model: 'test-model',
      input: 'search',
      tools: [
        clientTool,
      ] as const,
      doomLoop: {
        ladder: {
          observe: 2,
          block: 3, // meaningless for server tools — downgrades to observe
          stop: 3,
        },
      },
      hooks,
    });
    await result.getResponse();

    // Server streak: turn1=1, turn2=2 (observe), turn3=3 (stop). The stop
    // arms after turn 3's response lands; the loop halts before another
    // request — exactly 3 requests made.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(3);
    expect(detections.map((d) => d.detector)).toEqual([
      'server-tool-fingerprint',
      'server-tool-fingerprint',
    ]);
    expect(await result.getDoomLoopVerdict()).toMatchObject({
      detector: 'server-tool-fingerprint',
      action: 'stop',
      streak: 3,
      toolName: 'server:web_search_call',
    });
  });

  it('distinct server-tool queries do not build a streak', async () => {
    const hooks = new HooksManager();
    const detections = collectDetections(hooks);
    const clientTool = tool({
      name: 'note',
      inputSchema: z.object({
        n: z.number(),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      execute: async () => ({
        ok: true,
      }),
    });

    scriptModelTurns(
      turn(
        serverSearchItem('first'),
        functionCallItem('note', {
          n: 1,
        }),
      ),
      turn(
        serverSearchItem('second'),
        functionCallItem('note', {
          n: 2,
        }),
      ),
      textTurn('done'),
    );

    const text = await callModel(client, {
      model: 'test-model',
      input: 'search',
      tools: [
        clientTool,
      ] as const,
      doomLoop: true,
      hooks,
    }).getText();

    expect(text).toBe('done');
    expect(detections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Config lifecycle across resumes
// ---------------------------------------------------------------------------

describe('doomLoop config lifecycle across resumes', () => {
  it('ON→OFF: stale doomLoop blob is inert; OFF run repeats freely', async () => {
    const accessor = makeStateAccessor();
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'x',
      }),
      toolCallTurn('web_search', {
        query: 'x',
      }),
      textTurn('run 1 done'),
    );
    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: true,
      state: accessor,
    }).getText();
    expect(accessor.getLatest()?.doomLoop?.tools['web_search']).toMatchObject({
      streak: 2,
    });

    // Run 2 with detection OFF: identical calls sail through.
    const hooks = new HooksManager();
    const detections = collectDetections(hooks);
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'x',
      }),
      toolCallTurn('web_search', {
        query: 'x',
      }),
      textTurn('run 2 done'),
    );
    const text = await callModel(client, {
      model: 'test-model',
      input: 'more',
      tools: [
        searchTool,
      ] as const,
      state: accessor,
      hooks,
    }).getText();
    expect(text).toBe('run 2 done');
    expect(detections).toEqual([]);
  });

  it('ON→ON: streaks carry across the resume (a resumed doom loop is still a doom loop)', async () => {
    const accessor = makeStateAccessor();
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'persistent',
      }),
      toolCallTurn('web_search', {
        query: 'persistent',
      }),
      textTurn('pausing'),
    );
    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: true,
      state: accessor,
    }).getText();

    const hooks = new HooksManager();
    const detections = collectDetections(hooks);
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'persistent',
      }),
      textTurn('recovered'),
    );
    await callModel(client, {
      model: 'test-model',
      input: 'continue',
      tools: [
        searchTool,
      ] as const,
      doomLoop: true,
      state: accessor,
      hooks,
    }).getText();

    expect(
      detections.map((d) => [
        d.action,
        d.streak,
      ]),
    ).toEqual([
      [
        'block',
        3,
      ],
    ]);
  });
});
