import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { callModel } from '../../src/inner-loop/call-model.js';
import { HooksManager } from '../../src/lib/hooks-manager.js';
import { tool } from '../../src/lib/tool.js';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

function functionCallItem(
  callId: string,
  name: string,
  args: string,
): models.OutputFunctionCallItem {
  return {
    type: 'function_call',
    id: `fc_${callId}`,
    callId,
    name,
    arguments: args,
    status: 'completed',
  };
}

function messageItem(id: string, text: string) {
  return {
    id,
    type: 'message' as const,
    role: 'assistant' as const,
    status: 'completed' as const,
    content: [
      {
        type: 'output_text' as const,
        text,
        annotations: [],
      },
    ],
  };
}

function makeResponse(
  id: string,
  output: models.OpenResponsesResult['output'],
): models.OpenResponsesResult {
  return {
    id,
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

const client = {
  _options: {},
} as OpenRouterCore;

/**
 * Requests are dispatched by ONE shared mock across parent and child runs.
 * Discriminate by request `model`: parent uses 'parent-model', children use
 * 'child-model'.
 */
function routeByModel(handlers: {
  parent: () => Promise<unknown> | unknown;
  child: () => Promise<unknown> | unknown;
}) {
  mockBetaResponsesSend.mockImplementation(
    async (
      _client: unknown,
      args: {
        responsesRequest: {
          model: string;
        };
      },
    ) => {
      if (args.responsesRequest.model === 'child-model') {
        return handlers.child();
      }
      return handlers.parent();
    },
  );
}

const childSearchTool = tool({
  name: 'child_search',
  inputSchema: z.object({
    q: z.string(),
  }),
  execute: async ({ q }) => ({
    found: `results for ${q}`,
  }),
});

function makeResearcher(options?: {
  result?: (child: { getText: () => Promise<string> }) => Promise<{
    text: string;
  }>;
  hooks?: HooksManager;
}) {
  return tool.agent({
    name: 'research_topic',
    description: 'Research a topic in the background.',
    inputSchema: z.object({
      topic: z.string(),
    }),
    outputSchema: z.object({
      text: z.string(),
    }),
    graceMs: 0,
    agent: ({ topic }) => ({
      model: 'child-model',
      input: `Research: ${topic}`,
      tools: [
        childSearchTool,
      ] as const,
      ...(options?.hooks !== undefined && {
        hooks: options.hooks,
      }),
    }),
    ...(options?.result !== undefined && {
      result: options.result as never,
    }),
  });
}

describe('tool.agent — child conversation as a background task', () => {
  beforeEach(() => {
    mockBetaResponsesSend.mockReset();
  });

  it('a child that pauses (manual tool) fails the task loudly, never a partial answer', async () => {
    // Devin review: pause detection reads childState.status after
    // getResponse() resolves — pin that a pausing child (manual tool, no
    // execute) is caught by CHILD_PAUSE_STATUSES and settles the task as
    // failed, instead of slipping through to the result mapper.
    const manualChildTool = tool({
      name: 'child_manual',
      inputSchema: z.object({}),
      execute: false,
    });
    const pausingAgent = tool.agent({
      name: 'pausing_agent',
      inputSchema: z.object({}),
      outputSchema: z.object({
        text: z.string(),
      }),
      graceMs: 0,
      agent: () => ({
        model: 'child-model',
        input: 'do the thing',
        tools: [
          manualChildTool,
        ] as const,
      }),
    });

    routeByModel({
      parent: () => {
        const parentCall = mockBetaResponsesSend.mock.calls.filter(
          (c) => c[1]?.responsesRequest?.model === 'parent-model',
        ).length;
        if (parentCall === 1) {
          return {
            ok: true,
            value: makeResponse('p1', [
              functionCallItem('call_p', 'pausing_agent', '{}'),
            ]),
          };
        }
        return {
          ok: true,
          value: makeResponse(`p${parentCall}`, [
            messageItem(`pm${parentCall}`, 'done'),
          ]),
        };
      },
      child: () => ({
        ok: true,
        value: makeResponse('c1', [
          functionCallItem('cc1', 'child_manual', '{}'),
        ]),
      }),
    });

    const result = callModel(client, {
      model: 'parent-model',
      input: 'go',
      tools: [
        pausingAgent,
      ] as const,
      asyncTools: {
        drainTimeoutMs: 10_000,
      },
    });
    await result.getText();

    // The failure envelope names the pause — no partial answer delivered.
    const lastParentInput = mockBetaResponsesSend.mock.calls
      .filter((c) => c[1]?.responsesRequest?.model === 'parent-model')
      .at(-1)?.[1]?.responsesRequest?.input as Array<{
      role?: string;
      content?: string;
    }>;
    const envelope = lastParentInput.find(
      (m) => m.role === 'user' && m.content?.includes('tool_task_result'),
    );
    expect(envelope?.content).toContain('"status":"failed"');
    expect(envelope?.content).toContain('paused');
  });

  it("rejects the reserved names 'shared' and 'task' at definition time", () => {
    const base = {
      inputSchema: z.object({}),
      outputSchema: z.object({
        text: z.string(),
      }),
      agent: () => ({
        model: 'child-model',
        input: 'x',
      }),
    };
    expect(() =>
      tool.agent({
        ...base,
        name: 'shared',
      }),
    ).toThrow('reserved for shared context');
    expect(() =>
      tool.agent({
        ...base,
        name: 'task',
      }),
    ).toThrow('reserved for the built-in task-interaction tool');
  });

  it('runs the child to completion; default result maps last-message text', async () => {
    let childCalls = 0;
    routeByModel({
      parent: () => {
        const parentCall = mockBetaResponsesSend.mock.calls.filter(
          (c) => c[1]?.responsesRequest?.model === 'parent-model',
        ).length;
        if (parentCall === 1) {
          return {
            ok: true,
            value: makeResponse('p1', [
              functionCallItem('call_r', 'research_topic', '{"topic":"rust"}'),
            ]),
          };
        }
        return {
          ok: true,
          value: makeResponse(`p${parentCall}`, [
            messageItem(`pm${parentCall}`, 'working on it'),
          ]),
        };
      },
      child: () => {
        childCalls++;
        if (childCalls === 1) {
          return {
            ok: true,
            value: makeResponse('c1', [
              functionCallItem('cc1', 'child_search', '{"q":"rust"}'),
            ]),
          };
        }
        return {
          ok: true,
          value: makeResponse('c2', [
            messageItem('cm1', 'Rust is a systems language.'),
          ]),
        };
      },
    });

    const result = callModel(client, {
      model: 'parent-model',
      input: 'research rust',
      tools: [
        makeResearcher(),
      ] as const,
      asyncTools: {
        drainTimeoutMs: 10_000,
      },
    });

    await result.getText();

    // The child actually ran (its tool executed through its own loop).
    expect(childCalls).toBe(2);

    // The delivered envelope carries the default { text } result.
    const lastParentInput = mockBetaResponsesSend.mock.calls
      .filter((c) => c[1]?.responsesRequest?.model === 'parent-model')
      .at(-1)?.[1]?.responsesRequest?.input as Array<{
      role?: string;
      content?: string;
    }>;
    const envelope = lastParentInput.find(
      (m) => m.role === 'user' && m.content?.includes('tool_task_result'),
    );
    expect(envelope?.content).toContain('Rust is a systems language.');
  });

  it('a custom result mapper shapes the delivered output', async () => {
    routeByModel({
      parent: () => {
        const parentCall = mockBetaResponsesSend.mock.calls.filter(
          (c) => c[1]?.responsesRequest?.model === 'parent-model',
        ).length;
        if (parentCall === 1) {
          return {
            ok: true,
            value: makeResponse('p1', [
              functionCallItem('call_r', 'research_topic', '{"topic":"go"}'),
            ]),
          };
        }
        return {
          ok: true,
          value: makeResponse(`p${parentCall}`, [
            messageItem(`pm${parentCall}`, 'ok'),
          ]),
        };
      },
      child: () => ({
        ok: true,
        value: makeResponse('c1', [
          messageItem('cm1', 'Go is simple.'),
        ]),
      }),
    });

    await callModel(client, {
      model: 'parent-model',
      input: 'research go',
      tools: [
        makeResearcher({
          result: async (child) => ({
            text: `SUMMARY: ${await child.getText()}`,
          }),
        }),
      ] as const,
    }).getText();

    const lastParentInput = mockBetaResponsesSend.mock.calls
      .filter((c) => c[1]?.responsesRequest?.model === 'parent-model')
      .at(-1)?.[1]?.responsesRequest?.input as Array<{
      role?: string;
      content?: string;
    }>;
    const envelope = lastParentInput.find(
      (m) => m.role === 'user' && m.content?.includes('tool_task_result'),
    );
    expect(envelope?.content).toContain('SUMMARY: Go is simple.');
  });

  it('check call reports turnsCompleted and a per-turn transcript', async () => {
    let childCalls = 0;
    let releaseChild: (() => void) | undefined;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let childTurnEnded: (() => void) | undefined;
    const childTurnEndGate = new Promise<void>((resolve) => {
      childTurnEnded = resolve;
    });

    routeByModel({
      parent: async () => {
        const parentCall = mockBetaResponsesSend.mock.calls.filter(
          (c) => c[1]?.responsesRequest?.model === 'parent-model',
        ).length;
        if (parentCall === 1) {
          return {
            ok: true,
            value: makeResponse('p1', [
              functionCallItem('call_r', 'research_topic', '{"topic":"zig"}'),
            ]),
          };
        }
        if (parentCall === 2) {
          // Wait for the child's first turn to complete so the check sees
          // real progress, then issue the check.
          await childTurnEndGate;
          const input = mockBetaResponsesSend.mock.calls.filter(
            (c) => c[1]?.responsesRequest?.model === 'parent-model',
          )[1]?.[1]?.responsesRequest?.input as Array<{
            type?: string;
            callId?: string;
            output?: string;
          }>;
          const placeholder = input.find(
            (m) => m.type === 'function_call_output' && m.callId === 'call_r',
          );
          const taskId = (
            JSON.parse(placeholder?.output ?? '{}') as {
              taskId: string;
            }
          ).taskId;
          return {
            ok: true,
            value: makeResponse('p2', [
              functionCallItem(
                'call_check',
                'task',
                JSON.stringify({
                  taskId,
                  view: 'transcript',
                }),
              ),
            ]),
          };
        }
        releaseChild?.();
        return {
          ok: true,
          value: makeResponse(`p${parentCall}`, [
            messageItem(`pm${parentCall}`, 'done'),
          ]),
        };
      },
      child: async () => {
        childCalls++;
        if (childCalls === 1) {
          return {
            ok: true,
            value: makeResponse('c1', [
              functionCallItem('cc1', 'child_search', '{"q":"zig"}'),
            ]),
          };
        }
        // First turn's follow-up dispatch means turn 1 fully completed.
        childTurnEnded?.();
        // Hold the child's final turn until the parent has checked.
        await childGate;
        return {
          ok: true,
          value: makeResponse('c2', [
            messageItem('cm1', 'Zig is a low-level language.'),
          ]),
        };
      },
    });

    await callModel(client, {
      model: 'parent-model',
      input: 'research zig',
      tools: [
        makeResearcher(),
      ] as const,
      asyncTools: {
        drainTimeoutMs: 10_000,
      },
    }).getText();

    // The check output (3rd parent request input) carries the transcript.
    const thirdParentInput = mockBetaResponsesSend.mock.calls.filter(
      (c) => c[1]?.responsesRequest?.model === 'parent-model',
    )[2]?.[1]?.responsesRequest?.input as Array<{
      type?: string;
      callId?: string;
      output?: string;
    }>;
    const checkOutput = JSON.parse(
      thirdParentInput.find((m) => m.type === 'function_call_output' && m.callId === 'call_check')
        ?.output as string,
    ) as Record<string, unknown>;

    expect(checkOutput['mode']).toBe('agent');
    // The child's turn 1 follow-up is still gated at check time: the turn
    // has STARTED but not ended, and turnsCompleted must not count it.
    expect(checkOutput['turnsStarted']).toBeGreaterThanOrEqual(1);
    expect(checkOutput['turnsCompleted']).toBe(0);
    expect(checkOutput['transcript']).toContain('child_search');
  });

  it('sendToTask steers the child: the message lands as a user message in its next request', async () => {
    let childCalls = 0;
    let releaseChild: (() => void) | undefined;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let steered = false;

    routeByModel({
      parent: () => {
        const parentCall = mockBetaResponsesSend.mock.calls.filter(
          (c) => c[1]?.responsesRequest?.model === 'parent-model',
        ).length;
        if (parentCall === 1) {
          return {
            ok: true,
            value: makeResponse('p1', [
              functionCallItem('call_r', 'research_topic', '{"topic":"apl"}'),
            ]),
          };
        }
        return {
          ok: true,
          value: makeResponse(`p${parentCall}`, [
            messageItem(`pm${parentCall}`, 'done'),
          ]),
        };
      },
      child: async () => {
        childCalls++;
        if (childCalls === 1) {
          return {
            ok: true,
            value: makeResponse('c1', [
              functionCallItem('cc1', 'child_search', '{"q":"apl"}'),
            ]),
          };
        }
        if (childCalls === 2) {
          // Hold this turn until the parent steers, then emit ANOTHER tool
          // call so the child makes one more request — the queued steer
          // message flushes before that follow-up.
          await childGate;
          return {
            ok: true,
            value: makeResponse('c2', [
              functionCallItem('cc2', 'child_search', '{"q":"apl arrays"}'),
            ]),
          };
        }
        return {
          ok: true,
          value: makeResponse(`c${childCalls}`, [
            messageItem(`cm${childCalls}`, 'APL research complete.'),
          ]),
        };
      },
    });

    const result = callModel(client, {
      model: 'parent-model',
      input: 'research apl',
      tools: [
        makeResearcher(),
      ] as const,
      asyncTools: {
        drainTimeoutMs: 10_000,
      },
    });

    const textPromise = result.getText();
    await vi.waitFor(() => {
      const task = result.getAsyncTasks().find((t) => t.status === 'working');
      if (!task) {
        throw new Error('agent task not started');
      }
      expect(result.sendToTask(task.taskId, 'focus on array semantics')).toBe(true);
      steered = true;
      releaseChild?.();
    });
    await textPromise;

    // Some child request after the steer carries the injected user message.
    const childInputs = mockBetaResponsesSend.mock.calls
      .filter((c) => c[1]?.responsesRequest?.model === 'child-model')
      .map((c) => c[1]?.responsesRequest?.input as unknown);
    const sawSteer = childInputs.some(
      (input) =>
        Array.isArray(input) &&
        input.some(
          (m: { role?: string; content?: string }) =>
            m.role === 'user' && m.content?.includes('focus on array semantics'),
        ),
    );
    expect(sawSteer).toBe(true);
  });

  it('cancelTask cancels a running child mid-run', async () => {
    let childCalls = 0;
    routeByModel({
      parent: () => {
        const parentCall = mockBetaResponsesSend.mock.calls.filter(
          (c) => c[1]?.responsesRequest?.model === 'parent-model',
        ).length;
        if (parentCall === 1) {
          return {
            ok: true,
            value: makeResponse('p1', [
              functionCallItem('call_r', 'research_topic', '{"topic":"cobol"}'),
            ]),
          };
        }
        return {
          ok: true,
          value: makeResponse(`p${parentCall}`, [
            messageItem(`pm${parentCall}`, 'acknowledged'),
          ]),
        };
      },
      child: async () => {
        childCalls++;
        // Slow, bounded child turns: enough runway for the parent to cancel
        // mid-run without the child spinning the mock unboundedly.
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (childCalls > 100) {
          return {
            ok: true,
            value: makeResponse(`c${childCalls}`, [
              messageItem('cm_end', 'gave up'),
            ]),
          };
        }
        return {
          ok: true,
          value: makeResponse(`c${childCalls}`, [
            functionCallItem(`cc${childCalls}`, 'child_search', '{"q":"cobol"}'),
          ]),
        };
      },
    });

    const result = callModel(client, {
      model: 'parent-model',
      input: 'research cobol',
      tools: [
        makeResearcher(),
      ] as const,
      asyncTools: {
        drainTimeoutMs: 10_000,
      },
    });

    const textPromise = result.getText();
    await vi.waitFor(() => {
      const task = result.getAsyncTasks().find((t) => t.status === 'working');
      if (!task) {
        throw new Error('agent task not started');
      }
      expect(result.cancelTask(task.taskId, 'changed my mind')).toBe(true);
    });
    await textPromise;

    const tasks = result.getAsyncTasks();
    expect(tasks[0]?.status).toBe('cancelled');

    // The cancellation envelope reached the model.
    const lastParentInput = mockBetaResponsesSend.mock.calls
      .filter((c) => c[1]?.responsesRequest?.model === 'parent-model')
      .at(-1)?.[1]?.responsesRequest?.input as Array<{
      role?: string;
      content?: string;
    }>;
    const envelope = lastParentInput.find(
      (m) => m.role === 'user' && m.content?.includes('tool_task_result'),
    );
    expect(envelope?.content).toContain('"status":"cancelled"');
  });

  it('parent hooks are NOT inherited by the child; child-supplied hooks fire', async () => {
    const parentPreToolNames: string[] = [];
    const parentHooks = new HooksManager();
    parentHooks.on('PreToolUse', {
      handler: (payload) => {
        parentPreToolNames.push(
          (
            payload as {
              toolName: string;
            }
          ).toolName,
        );
        return {};
      },
    });

    const childPreToolNames: string[] = [];
    const childHooks = new HooksManager();
    childHooks.on('PreToolUse', {
      handler: (payload) => {
        childPreToolNames.push(
          (
            payload as {
              toolName: string;
            }
          ).toolName,
        );
        return {};
      },
    });

    let childCalls = 0;
    routeByModel({
      parent: () => {
        const parentCall = mockBetaResponsesSend.mock.calls.filter(
          (c) => c[1]?.responsesRequest?.model === 'parent-model',
        ).length;
        if (parentCall === 1) {
          return {
            ok: true,
            value: makeResponse('p1', [
              functionCallItem('call_r', 'research_topic', '{"topic":"hooks"}'),
            ]),
          };
        }
        return {
          ok: true,
          value: makeResponse(`p${parentCall}`, [
            messageItem(`pm${parentCall}`, 'done'),
          ]),
        };
      },
      child: () => {
        childCalls++;
        if (childCalls === 1) {
          return {
            ok: true,
            value: makeResponse('c1', [
              functionCallItem('cc1', 'child_search', '{"q":"hooks"}'),
            ]),
          };
        }
        return {
          ok: true,
          value: makeResponse('c2', [
            messageItem('cm1', 'child finished'),
          ]),
        };
      },
    });

    await callModel(client, {
      model: 'parent-model',
      input: 'research hooks',
      tools: [
        makeResearcher({
          hooks: childHooks,
        }),
      ] as const,
      hooks: parentHooks,
    }).getText();

    // Parent hook saw the agent tool call, never the child's tool.
    expect(parentPreToolNames).toContain('research_topic');
    expect(parentPreToolNames).not.toContain('child_search');
    // Child hook saw the child's tool.
    expect(childPreToolNames).toContain('child_search');
  });

  it('two agent calls in one round both run and deliver', async () => {
    const childCallsByTopic = new Map<string, number>();
    routeByModel({
      parent: () => {
        const parentCall = mockBetaResponsesSend.mock.calls.filter(
          (c) => c[1]?.responsesRequest?.model === 'parent-model',
        ).length;
        if (parentCall === 1) {
          return {
            ok: true,
            value: makeResponse('p1', [
              functionCallItem('call_a', 'research_topic', '{"topic":"alpha"}'),
              functionCallItem('call_b', 'research_topic', '{"topic":"beta"}'),
            ]),
          };
        }
        return {
          ok: true,
          value: makeResponse(`p${parentCall}`, [
            messageItem(`pm${parentCall}`, 'both running'),
          ]),
        };
      },
      child: () => ({
        ok: true,
        value: makeResponse(`c_${Math.random()}`, [
          messageItem('cm', 'topic researched'),
        ]),
      }),
    });

    const result = callModel(client, {
      model: 'parent-model',
      input: 'research both',
      tools: [
        makeResearcher(),
      ] as const,
      asyncTools: {
        drainTimeoutMs: 10_000,
      },
    });

    await result.getText();

    const tasks = result.getAsyncTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.status === 'completed')).toBe(true);
    expect(tasks.every((t) => t.mode === 'agent')).toBe(true);
    void childCallsByTopic;
  });
});
