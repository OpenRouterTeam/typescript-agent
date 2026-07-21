/**
 * Integration tests for doom-loop detection in the callModel tool loop.
 *
 * No live model anywhere: `betaResponsesSend` is mocked with scripted
 * responses that SIMULATE an LLM stuck in a doom loop — the same tool call
 * with identical arguments turn after turn, repeated EMPTY tool calls,
 * repeated unparseable (invalid-JSON) calls, and degenerate repeated-token
 * text output. Detection is deterministic, so each scenario asserts the
 * exact turn on which the ladder fires and exactly how the engine responds
 * (hook emission, blocked tool output, halted loop, persisted state).
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
import { HooksManager } from '../../src/lib/hooks-manager.js';
import type { DoomLoopDetectedPayload } from '../../src/lib/hooks-schemas.js';
import { tool } from '../../src/lib/tool.js';
import type { ConversationState, StateAccessor, Tool } from '../../src/lib/tool-types.js';

// ---------------------------------------------------------------------------
// Scripted-response fixtures (the "simulated LLM")
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

/** A turn where the model calls `name` with `args` (JSON-encoded like the API does). */
function toolCallTurn(name: string, args: unknown): models.OpenResponsesResult {
  callCounter++;
  return baseResponse([
    {
      type: 'function_call',
      id: `fc_${callCounter}`,
      callId: `call_${callCounter}`,
      name,
      arguments: JSON.stringify(args),
      status: 'completed',
    },
  ]);
}

/** A turn where the model emits invalid JSON for the tool call arguments. */
function invalidJsonToolCallTurn(name: string, rawArguments: string): models.OpenResponsesResult {
  callCounter++;
  return baseResponse([
    {
      type: 'function_call',
      id: `fc_${callCounter}`,
      callId: `call_${callCounter}`,
      name,
      arguments: rawArguments,
      status: 'completed',
    },
  ]);
}

/** A plain-text turn (ends the natural loop). */
function textTurn(text: string): models.OpenResponsesResult {
  callCounter++;
  return baseResponse([
    {
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
    },
  ]);
}

/** Queue scripted turns; the "LLM" plays them back in order. */
function scriptModelTurns(...turns: models.OpenResponsesResult[]) {
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

type SentToolOutput = z.infer<typeof FunctionCallOutputItemSchema>;

/** The function_call_output items the engine sent in request `requestIndex` (0-based). */
function sentToolOutputs(requestIndex: number): SentToolOutput[] {
  const request = mockBetaResponsesSend.mock.calls[requestIndex]?.[1]?.responsesRequest;
  const input: unknown[] = Array.isArray(request?.input) ? request.input : [];
  const outputs: SentToolOutput[] = [];
  for (const item of input) {
    const parsed = FunctionCallOutputItemSchema.safeParse(item);
    if (parsed.success) {
      outputs.push(parsed.data);
    }
  }
  return outputs;
}

function makeStateAccessor(): StateAccessor<readonly Tool[]> & {
  getLatest: () => ConversationState<readonly Tool[]> | null;
  setLatest: (s: ConversationState<readonly Tool[]>) => void;
} {
  let state: ConversationState<readonly Tool[]> | null = null;
  return {
    load: async () => state,
    save: async (s) => {
      state = s;
    },
    getLatest: () => state,
    setLatest: (s) => {
      state = s;
    },
  };
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
  // Doom-loop identity: the query only — mirrors "a web-search tool hashes
  // its search query".
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

// ---------------------------------------------------------------------------
// Scenario 1: identical tool calls, turn after turn
// ---------------------------------------------------------------------------

describe('simulated LLM repeating the same tool call', () => {
  it('observes at 2, blocks at 3 with an explanatory tool error, and lets the model recover', async () => {
    const executeSpy = vi.fn(async ({ query }: { query: string }) => ({
      results: [
        `result for ${query}`,
      ],
    }));
    const spiedSearch = tool({
      name: 'web_search',
      inputSchema: z.object({
        query: z.string(),
      }),
      outputSchema: z.object({
        results: z.array(z.string()),
      }),
      loopKey: ({ query }) => query.trim().toLowerCase(),
      execute: executeSpy,
    });

    const detections: DoomLoopDetectedPayload[] = [];
    const hooks = new HooksManager();
    hooks.on('DoomLoopDetected', {
      handler: (payload) => {
        detections.push(payload);
      },
    });

    // The simulated doom loop: three identical searches (case/whitespace
    // vary — loopKey normalization must collapse them), then recovery.
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'openrouter sdk',
      }),
      toolCallTurn('web_search', {
        query: 'OpenRouter SDK',
      }),
      toolCallTurn('web_search', {
        query: '  openrouter sdk  ',
      }),
      textTurn('Giving up on repeating; here is my answer.'),
    );

    const text = await callModel(client, {
      model: 'test-model',
      input: 'Find the SDK.',
      tools: [
        spiedSearch,
      ] as const,
      doomLoop: true,
      hooks,
    }).getText();

    expect(text).toBe('Giving up on repeating; here is my answer.');

    // Calls 1 and 2 executed; call 3 was BLOCKED before execution.
    expect(executeSpy).toHaveBeenCalledTimes(2);

    // Streak 2 → observe; streak 3 → block. Deterministic firing points.
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
    expect(detections[0]).toMatchObject({
      detector: 'tool-fingerprint',
      toolName: 'web_search',
    });

    // The model received an explanatory error output for the blocked call
    // (request 4 carries the third call's function_call_output).
    const outputs = sentToolOutputs(3);
    const blocked = outputs[outputs.length - 1];
    expect(blocked?.output).toContain('Doom loop suspected');
    expect(blocked?.output).toContain('web_search');
    expect(blocked?.output).toContain('3 consecutive times');
  });

  it('stops the run at the stop threshold instead of spending forever', async () => {
    // stop rung lowered to 4 so the scenario stays compact. The scripted
    // model NEVER recovers — without detection this transcript would consume
    // every scripted turn and keep going.
    scriptModelTurns(
      ...Array.from(
        {
          length: 10,
        },
        () =>
          toolCallTurn('web_search', {
            query: 'same query',
          }),
      ),
    );

    const result = callModel(client, {
      model: 'test-model',
      input: 'Find it.',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: {
          observe: 2,
          block: 3,
          stop: 4,
        },
      },
    });

    const response = await result.getResponse();

    // Streaks: call1=1 (executes), call2=2 (observe, executes), call3=3
    // (block), call4=4 (stop). The 4th call arrives on the 4th scripted
    // turn; the loop halts before requesting a 5th.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(4);

    const verdict = await result.getDoomLoopVerdict();
    expect(verdict).toMatchObject({
      action: 'stop',
      detector: 'tool-fingerprint',
      streak: 4,
      toolName: 'web_search',
    });

    // The run surfaces the last response rather than throwing.
    expect(response.id).toBe('resp_4');
  });

  it('emits SessionEnd with reason doom_loop when stopped', async () => {
    const sessionEnds: unknown[] = [];
    const hooks = new HooksManager();
    hooks.on('SessionEnd', {
      handler: (payload) => {
        sessionEnds.push(payload);
      },
    });

    scriptModelTurns(
      ...Array.from(
        {
          length: 6,
        },
        () =>
          toolCallTurn('web_search', {
            query: 'x',
          }),
      ),
    );

    await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: {
          stop: 3,
        },
      },
      hooks,
    }).getResponse();

    expect(sessionEnds).toHaveLength(1);
    expect(sessionEnds[0]).toMatchObject({
      reason: 'doom_loop',
    });
  });

  it('does not interfere with a healthy run (distinct queries, natural finish)', async () => {
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'first',
      }),
      toolCallTurn('web_search', {
        query: 'second',
      }),
      toolCallTurn('web_search', {
        query: 'third',
      }),
      textTurn('All three found.'),
    );

    const detections: DoomLoopDetectedPayload[] = [];
    const hooks = new HooksManager();
    hooks.on('DoomLoopDetected', {
      handler: (payload) => {
        detections.push(payload);
      },
    });

    const text = await callModel(client, {
      model: 'test-model',
      input: 'Search three things.',
      tools: [
        searchTool,
      ] as const,
      doomLoop: true,
      hooks,
    }).getText();

    expect(text).toBe('All three found.');
    expect(detections).toEqual([]);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(4);
  });

  it('is fully inert when doomLoop is not configured (default off)', async () => {
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'same',
      }),
      toolCallTurn('web_search', {
        query: 'same',
      }),
      toolCallTurn('web_search', {
        query: 'same',
      }),
      toolCallTurn('web_search', {
        query: 'same',
      }),
      textTurn('done'),
    );

    const text = await callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
    }).getText();

    // All four identical calls executed; nothing blocked, nothing stopped.
    expect(text).toBe('done');
    for (const requestIndex of [
      1,
      2,
      3,
      4,
    ]) {
      const outputs = sentToolOutputs(requestIndex);
      expect(outputs[outputs.length - 1]?.output).not.toContain('Doom loop');
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: repeated EMPTY tool calls
// ---------------------------------------------------------------------------

describe('simulated LLM repeating empty tool calls', () => {
  const listTool = tool({
    name: 'list_tasks',
    description: 'List everything.',
    inputSchema: z.object({}),
    outputSchema: z.object({
      tasks: z.array(z.string()),
    }),
    execute: async () => ({
      tasks: [
        'task-1',
      ],
    }),
  });

  it('treats repeated {} calls as a streak and blocks at the threshold', async () => {
    const detections: DoomLoopDetectedPayload[] = [];
    const hooks = new HooksManager();
    hooks.on('DoomLoopDetected', {
      handler: (payload) => {
        detections.push(payload);
      },
    });

    scriptModelTurns(
      toolCallTurn('list_tasks', {}),
      toolCallTurn('list_tasks', {}),
      toolCallTurn('list_tasks', {}),
      textTurn('The list has not changed; stopping.'),
    );

    const text = await callModel(client, {
      model: 'test-model',
      input: 'What tasks exist?',
      tools: [
        listTool,
      ] as const,
      doomLoop: true,
      hooks,
    }).getText();

    expect(text).toBe('The list has not changed; stopping.');
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
    const outputs = sentToolOutputs(3);
    expect(outputs[outputs.length - 1]?.output).toContain('Doom loop suspected');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: repeated malformed (invalid JSON) tool calls
// ---------------------------------------------------------------------------

describe('simulated LLM stuck emitting the same invalid JSON', () => {
  it('counts parse-error repeats and stops instead of bouncing off the parse error forever', async () => {
    const detections: DoomLoopDetectedPayload[] = [];
    const hooks = new HooksManager();
    hooks.on('DoomLoopDetected', {
      handler: (payload) => {
        detections.push(payload);
      },
    });

    // The same broken arguments string every turn. Without detection this
    // would loop as long as the model keeps emitting it (each turn gets a
    // parse-error output and the model retries identically).
    scriptModelTurns(
      invalidJsonToolCallTurn('web_search', '{"query": broken'),
      invalidJsonToolCallTurn('web_search', '{"query": broken'),
      invalidJsonToolCallTurn('web_search', '{"query": broken'),
      invalidJsonToolCallTurn('web_search', '{"query": broken'),
    );

    const result = callModel(client, {
      model: 'test-model',
      input: 'Search.',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: {
          observe: 2,
          block: 3,
          stop: 3,
        },
      },
      hooks,
    });

    await result.getResponse();

    // Streak 2 observes; streak 3 crosses stop (stop wins over block).
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
        'stop',
        3,
      ],
    ]);
    // Halted after the 3rd scripted turn — the 4th was never requested.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(3);
    expect(await result.getDoomLoopVerdict()).toMatchObject({
      action: 'stop',
      streak: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: doom-loop TEXT tokens
// ---------------------------------------------------------------------------

describe('simulated LLM emitting doom-loop text tokens', () => {
  it('stops a run whose response is one degenerate repeated-token loop', async () => {
    const detections: DoomLoopDetectedPayload[] = [];
    const hooks = new HooksManager();
    hooks.on('DoomLoopDetected', {
      handler: (payload) => {
        detections.push(payload);
      },
    });

    // 40 repeats of the same sentence — the classic runaway generation.
    const doomText = Array(40).fill('I need to check the file again.').join(' ');
    scriptModelTurns(textTurn(doomText));

    const result = callModel(client, {
      model: 'test-model',
      input: 'Summarize.',
      doomLoop: true,
      hooks,
    });
    const text = await result.getText();

    // The tokens were already emitted — the response is surfaced as-is —
    // but the verdict fired deterministically with the repeat count.
    expect(text).toBe(doomText);
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({
      detector: 'text-repetition',
      action: 'stop',
      streak: 40,
    });
  });

  it('halts a tool loop when every turn repeats identical filler text', async () => {
    // Each turn: the same "thinking out loud" text + a DIFFERENT tool call
    // (so the tool-fingerprint detector stays quiet — this isolates the
    // cross-step text streak).
    function textAndCallTurn(text: string, query: string): models.OpenResponsesResult {
      callCounter++;
      return baseResponse([
        {
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
        },
        {
          type: 'function_call',
          id: `fc_${callCounter}`,
          callId: `call_${callCounter}`,
          name: 'web_search',
          arguments: JSON.stringify({
            query,
          }),
          status: 'completed',
        },
      ]);
    }

    const filler = 'Hmm, let me look somewhere else.';
    scriptModelTurns(
      textAndCallTurn(filler, 'q1'),
      textAndCallTurn(filler, 'q2'),
      textAndCallTurn(filler, 'q3'),
      textAndCallTurn(filler, 'q4'),
      textAndCallTurn(filler, 'q5'),
    );

    const result = callModel(client, {
      model: 'test-model',
      input: 'Find it.',
      tools: [
        searchTool,
      ] as const,
      doomLoop: {
        ladder: {
          observe: 2,
          block: 3,
          stop: 3,
        },
        text: true,
      },
    });

    await result.getResponse();

    // Text streak: turn1=1, turn2=2 (observe), turn3=3 (stop). The stop is
    // armed after turn 3's response lands; the loop breaks before another
    // model request, so exactly 3 requests were made.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(3);
    expect(await result.getDoomLoopVerdict()).toMatchObject({
      detector: 'text-streak',
      action: 'stop',
      streak: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// loopKey contract
// ---------------------------------------------------------------------------

describe('tool-declared loopKey', () => {
  it('bash-style loopKey: same command in a different cwd is NOT a loop', async () => {
    const runs: string[] = [];
    const bashTool = tool({
      name: 'bash',
      description: 'Run a command.',
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string(),
      }),
      outputSchema: z.object({
        stdout: z.string(),
      }),
      // The doom-loop identity of a bash call: the command AND where it runs.
      loopKey: ({ command, cwd }) => ({
        command: command.trim(),
        cwd,
      }),
      execute: async ({ command, cwd }) => {
        runs.push(`${cwd}:${command}`);
        return {
          stdout: `ran ${command} in ${cwd}`,
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
      toolCallTurn('bash', {
        command: 'ls',
        cwd: '/c',
      }),
      textTurn('Directory listings acquired.'),
    );

    const text = await callModel(client, {
      model: 'test-model',
      input: 'List all three directories.',
      tools: [
        bashTool,
      ] as const,
      doomLoop: {
        ladder: {
          block: 2, // aggressive: ANY consecutive repeat would block
        },
      },
    }).getText();

    // All three executed — cwd differentiates the fingerprints.
    expect(text).toBe('Directory listings acquired.');
    expect(runs).toEqual([
      '/a:ls',
      '/b:ls',
      '/c:ls',
    ]);
  });

  it('loopKey returning null exempts a legitimately-repetitive tool (polling)', async () => {
    const pollTool = tool({
      name: 'check_status',
      description: 'Poll job status.',
      inputSchema: z.object({
        jobId: z.string(),
      }),
      outputSchema: z.object({
        done: z.boolean(),
      }),
      loopKey: () => null, // repetition is this tool's job
      execute: async () => ({
        done: false,
      }),
    });

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
      textTurn('Job still running after 5 polls.'),
    );

    const detections: DoomLoopDetectedPayload[] = [];
    const hooks = new HooksManager();
    hooks.on('DoomLoopDetected', {
      handler: (payload) => {
        detections.push(payload);
      },
    });

    const text = await callModel(client, {
      model: 'test-model',
      input: 'Wait for the job.',
      tools: [
        pollTool,
      ] as const,
      doomLoop: true,
      hooks,
    }).getText();

    expect(text).toBe('Job still running after 5 polls.');
    expect(detections).toEqual([]);
  });

  it('a throwing loopKey falls back to full-arguments identity instead of failing the run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const brokenKeyTool = tool({
        name: 'flaky',
        inputSchema: z.object({
          value: z.string(),
        }),
        outputSchema: z.object({
          ok: z.boolean(),
        }),
        loopKey: () => {
          throw new Error('loopKey bug');
        },
        execute: async () => ({
          ok: true,
        }),
      });

      scriptModelTurns(
        toolCallTurn('flaky', {
          value: 'same',
        }),
        toolCallTurn('flaky', {
          value: 'same',
        }),
        toolCallTurn('flaky', {
          value: 'same',
        }),
        textTurn('done'),
      );

      const detections: DoomLoopDetectedPayload[] = [];
      const hooks = new HooksManager();
      hooks.on('DoomLoopDetected', {
        handler: (payload) => {
          detections.push(payload);
        },
      });

      const text = await callModel(client, {
        model: 'test-model',
        input: 'go',
        tools: [
          brokenKeyTool,
        ] as const,
        doomLoop: true,
        hooks,
      }).getText();

      // Detection still worked via the fallback identity.
      expect(text).toBe('done');
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
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('loopKey for tool "flaky" threw'),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// DoomLoopDetected hook overrides
// ---------------------------------------------------------------------------

describe('DoomLoopDetected hook overrideAction', () => {
  it('a handler can de-escalate a block to observe (call still executes)', async () => {
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
    hooks.on('DoomLoopDetected', {
      handler: () => ({
        overrideAction: 'observe' as const,
      }),
    });

    scriptModelTurns(
      toolCallTurn('noisy', {}),
      toolCallTurn('noisy', {}),
      toolCallTurn('noisy', {}),
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
    // Without the override the 3rd call would be blocked; the de-escalation
    // let all 3 execute.
    expect(executeSpy).toHaveBeenCalledTimes(3);
  });

  it('a handler can escalate an observe to stop', async () => {
    const hooks = new HooksManager();
    hooks.on('DoomLoopDetected', {
      handler: () => ({
        overrideAction: 'stop' as const,
      }),
    });

    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'x',
      }),
      toolCallTurn('web_search', {
        query: 'x',
      }),
      toolCallTurn('web_search', {
        query: 'x',
      }),
    );

    const result = callModel(client, {
      model: 'test-model',
      input: 'go',
      tools: [
        searchTool,
      ] as const,
      doomLoop: true,
      hooks,
    });
    await result.getResponse();

    // First verdict fires at streak 2 (observe) and is escalated to stop:
    // the loop halts after the 2nd scripted turn.
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    expect(await result.getDoomLoopVerdict()).toMatchObject({
      streak: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// State persistence: a resumed doom loop is still a doom loop
// ---------------------------------------------------------------------------

describe('doom-loop state persistence', () => {
  it('persists streaks into ConversationState and keeps counting across a resume', async () => {
    const accessor = makeStateAccessor();

    // Run 1: two identical calls → streak 2 persisted.
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'persistent',
      }),
      toolCallTurn('web_search', {
        query: 'persistent',
      }),
      textTurn('pausing here'),
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

    const persisted = accessor.getLatest();
    expect(persisted?.doomLoop?.tools['web_search']).toMatchObject({
      streak: 2,
    });

    // Run 2 on the same conversation: ONE more identical call crosses the
    // block rung — the streak survived the round-trip. (A fresh run would
    // be at streak 1 and never fire.)
    const detections: DoomLoopDetectedPayload[] = [];
    const hooks = new HooksManager();
    hooks.on('DoomLoopDetected', {
      handler: (payload) => {
        detections.push(payload);
      },
    });

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

  it('doomLoop state round-trips through JSON serialization', async () => {
    const accessor = makeStateAccessor();
    scriptModelTurns(
      toolCallTurn('web_search', {
        query: 'x',
      }),
      toolCallTurn('web_search', {
        query: 'x',
      }),
      textTurn('done'),
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

    const state = accessor.getLatest();
    if (!state) {
      throw new Error('state must exist');
    }
    // Plain JSON: survives stringify/parse byte-identically.
    const roundTripped = JSON.parse(JSON.stringify(state)) as ConversationState<readonly Tool[]>;
    expect(roundTripped.doomLoop).toEqual(state.doomLoop);
  });
});
