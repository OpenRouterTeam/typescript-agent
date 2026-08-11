/**
 * Tests for the OpenUI streaming half: toUiOutput plumbing through tool(),
 * the tool.ui_fragment broadcast, translateUiEvent (including the SDK's
 * forward-compat Unknown encoding of response.openui.* wire events), and
 * getUiStream()'s no-tools fast path.
 */
import type { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { StreamEvents$inboundSchema } from '@openrouter/sdk/models/streamevents';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { callModel } from '../../src/inner-loop/call-model.js';
import { ModelResult } from '../../src/lib/model-result.js';
import { fragment } from '../../src/lib/openui/fragment.js';
import { createLibrary, defineComponent } from '../../src/lib/openui/library.js';
import { translateUiEvent } from '../../src/lib/openui/ui-stream.js';
import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import { tool } from '../../src/lib/tool.js';
import type { ParsedToolCall, Tool } from '../../src/lib/tool-types.js';
import { isToolUiFragmentEvent } from '../../src/lib/tool-types.js';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

const library = createLibrary([
  defineComponent({
    name: 'Card',
    props: z.object({
      title: z.string(),
    }),
  }),
  defineComponent({
    name: 'Text',
    props: z.object({
      value: z.string(),
    }),
  }),
]);
const ui = fragment(library);

const response = (id: string, output: models.OpenResponsesResult['output']) =>
  ({
    id,
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    output,
    error: null,
    incompleteDetails: null,
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: false,
  }) as models.OpenResponsesResult;

function mockToolRound(toolName: string): void {
  mockBetaResponsesSend
    .mockResolvedValueOnce({
      ok: true,
      value: response('r1', [
        {
          type: 'function_call',
          id: 'fc1',
          callId: 'c1',
          name: toolName,
          arguments: '{}',
          status: 'completed',
        },
      ]),
    })
    .mockResolvedValueOnce({
      ok: true,
      value: response('r2', [
        {
          type: 'message',
          id: 'm1',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'done',
              annotations: [],
            },
          ],
        },
      ]),
    });
}

describe('tool() carries toUiOutput', () => {
  it('regular tool', () => {
    const t = tool({
      name: 'usage',
      inputSchema: z.object({
        days: z.number(),
      }),
      execute: async () => ({
        total: 12,
      }),
      toUiOutput: ({ output }) => ui.Card(`$${output.total}`),
    });
    expect(t.function.toUiOutput).toBeTypeOf('function');
  });

  it('generator tool', () => {
    const t = tool({
      name: 'gen',
      inputSchema: z.object({}),
      eventSchema: z.object({
        status: z.string(),
      }),
      outputSchema: z.object({
        done: z.boolean(),
      }),
      execute: async function* () {
        yield {
          done: true,
        };
      },
      toUiOutput: () => ui.Text('done'),
    });
    expect(t.function.toUiOutput).toBeTypeOf('function');
  });

  it('HITL tool', () => {
    const t = tool({
      name: 'hitl',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: () => null,
      toUiOutput: () => ui.Text('pending'),
    });
    expect(t.function.toUiOutput).toBeTypeOf('function');
  });

  it('omitted stays absent', () => {
    const t = tool({
      name: 'plain',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    });
    expect('toUiOutput' in t.function && t.function.toUiOutput !== undefined).toBe(false);
  });
});

describe('translateUiEvent', () => {
  it('translates tool.ui_fragment synthetic events', () => {
    const event = translateUiEvent({
      type: 'tool.ui_fragment',
      toolCallId: 'c1',
      toolName: 'usage',
      fragment: {
        dialect: 'openui-lang/0.5',
        source: 'root = Card("hi")',
      },
      timestamp: 1,
    });
    expect(event).toEqual({
      type: 'fragment',
      toolCallId: 'c1',
      toolName: 'usage',
      dialect: 'openui-lang/0.5',
      source: 'root = Card("hi")',
    });
  });

  it('translates response.openui.statement wire events', () => {
    const event = translateUiEvent({
      type: 'response.openui.statement',
      ref: 'root',
      kind: 'component',
      source: 'root = Card("Usage")',
    });
    expect(event).toEqual({
      type: 'statement',
      ref: 'root',
      kind: 'component',
      source: 'root = Card("Usage")',
    });
  });

  it("unwraps the installed SDK's runtime Unknown encoding", () => {
    const raw = {
      type: 'response.openui.statement',
      ref: '$tab',
      kind: 'state',
      source: '$tab = "overview"',
    };
    const encoded = StreamEvents$inboundSchema.parse(raw);

    expect(encoded).toEqual({
      type: 'UNKNOWN',
      isUnknown: true,
      raw,
    });
    expect(translateUiEvent(encoded)).toEqual({
      type: 'statement',
      ref: '$tab',
      kind: 'state',
      source: '$tab = "overview"',
    });
  });

  it('translates response.openui.fragment with snake_case call_id', () => {
    const event = translateUiEvent({
      type: 'response.openui.fragment',
      call_id: 'srv_1',
      dialect: 'openui-lang/0.5',
      source: 'root = Text("x")',
    });
    expect(event).toEqual({
      type: 'fragment',
      toolCallId: 'srv_1',
      dialect: 'openui-lang/0.5',
      source: 'root = Text("x")',
    });
  });

  it('translates response.openui.document with diagnostics', () => {
    const event = translateUiEvent({
      type: 'response.openui.document',
      root: 'root',
      dialect: 'openui-lang/0.5',
      diagnostics: [
        {
          line: 3,
          message: 'prose line',
          source: 'Here is your UI:',
        },
        {
          message: 'no line',
        },
        'garbage',
      ],
    });
    expect(event).toEqual({
      type: 'document',
      root: 'root',
      dialect: 'openui-lang/0.5',
      diagnostics: [
        {
          line: 3,
          message: 'prose line',
          source: 'Here is your UI:',
        },
        {
          message: 'no line',
        },
      ],
    });
  });

  it('returns null for everything else', () => {
    expect(
      translateUiEvent({
        type: 'response.output_text.delta',
        delta: 'hi',
      }),
    ).toBeNull();
    expect(
      translateUiEvent({
        type: 'turn.start',
        turnNumber: 0,
        timestamp: 1,
      }),
    ).toBeNull();
    expect(translateUiEvent(null)).toBeNull();
    expect(translateUiEvent('text')).toBeNull();
    // Malformed payloads degrade to null, never throw.
    expect(
      translateUiEvent({
        type: 'response.openui.statement',
        ref: 'r',
      }),
    ).toBeNull();
    expect(
      translateUiEvent({
        type: 'tool.ui_fragment',
        fragment: 'not-an-object',
      }),
    ).toBeNull();
  });
});

describe('getUiStream (no-tools fast path)', () => {
  function makeModelResult(events: unknown[]): ModelResult<readonly Tool[]> {
    const modelResult = new ModelResult<readonly Tool[]>({
      request: {
        model: 'test-model',
        input: 'test',
      },
      client: {} as OpenRouterCore,
    });
    const readable = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(event);
        }
        controller.close();
      },
    });
    const internal = modelResult as unknown as Record<string, unknown>;
    internal['reusableStream'] = new ReusableReadableStream(readable);
    internal['initPromise'] = Promise.resolve();
    return modelResult;
  }

  it('yields only UI events, in order, from a mixed stream', async () => {
    const modelResult = makeModelResult([
      {
        type: 'response.output_text.delta',
        delta: 'Here ',
      },
      {
        type: 'UNKNOWN',
        isUnknown: true,
        raw: {
          type: 'response.openui.statement',
          ref: 'a',
          kind: 'component',
          source: 'a = Text("1")',
        },
      },
      {
        type: 'response.output_text.delta',
        delta: 'you go',
      },
      {
        type: 'UNKNOWN',
        isUnknown: true,
        raw: {
          type: 'response.openui.document',
          root: 'a',
          dialect: 'openui-lang/0.5',
          diagnostics: [],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'r1',
        },
      },
    ]);

    const events = [];
    for await (const event of modelResult.getUiStream()) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: 'statement',
        ref: 'a',
        kind: 'component',
        source: 'a = Text("1")',
      },
      {
        type: 'document',
        root: 'a',
        dialect: 'openui-lang/0.5',
        diagnostics: [],
      },
    ]);
  });

  it('yields nothing for a stream with no UI events', async () => {
    const modelResult = makeModelResult([
      {
        type: 'response.output_text.delta',
        delta: 'plain text',
      },
      {
        type: 'response.completed',
        response: {
          id: 'r1',
        },
      },
    ]);
    const events = [];
    for await (const event of modelResult.getUiStream()) {
      events.push(event);
    }
    expect(events).toEqual([]);
  });
});

describe('toUiOutput round lifecycle', () => {
  it('does not block the run when rendering never settles', async () => {
    mockBetaResponsesSend.mockReset();
    mockToolRound('hanging_ui');
    const hanging = tool({
      name: 'hanging_ui',
      inputSchema: z.object({}),
      execute: () => 'ok',
      toUiOutput: () => new Promise(() => undefined),
    });
    const result = callModel(
      {
        _options: {},
      } as OpenRouterCore,
      {
        model: 'test-model',
        input: 'test',
        tools: [
          hanging,
        ] as const,
      },
    );

    await expect(
      Promise.race([
        result.getText(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('run stalled')), 100)),
      ]),
    ).resolves.toBe('done');
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });

  it('bounds UI-stream close with the configured drain deadline', async () => {
    mockBetaResponsesSend.mockReset();
    mockToolRound('hanging_ui');
    const hanging = tool({
      name: 'hanging_ui',
      inputSchema: z.object({}),
      execute: () => 'ok',
      toUiOutput: () => new Promise(() => undefined),
    });
    const result = callModel(
      {
        _options: {},
      } as OpenRouterCore,
      {
        model: 'test-model',
        input: 'test',
        tools: [
          hanging,
        ] as const,
        asyncTools: {
          drainTimeoutMs: 10,
        },
      },
    );

    const events = [];
    for await (const event of result.getUiStream()) {
      events.push(event);
    }

    expect(events).toEqual([]);
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });

  it('advances the model while retaining ordinary async rendering until UI drain', async () => {
    mockBetaResponsesSend.mockReset();
    mockToolRound('async_ui');
    let release: (() => void) | undefined;
    const rendering = new Promise<void>((resolve) => {
      release = resolve;
    });
    const asyncUi = tool({
      name: 'async_ui',
      inputSchema: z.object({}),
      execute: () => 'ok',
      toUiOutput: async () => {
        await rendering;
        return ui.Text('ready');
      },
    });
    const result = callModel(
      {
        _options: {},
      } as OpenRouterCore,
      {
        model: 'test-model',
        input: 'test',
        tools: [
          asyncUi,
        ] as const,
      },
    );
    const events: unknown[] = [];
    async function consumeUiStream() {
      for await (const event of result.getUiStream()) {
        events.push(event);
      }
    }
    const consuming = consumeUiStream();

    await vi.waitFor(() => expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2));
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'fragment',
      }),
    );
    release?.();
    await consuming;

    expect(events).toContainEqual({
      type: 'fragment',
      toolCallId: 'c1',
      toolName: 'async_ui',
      dialect: 'openui-lang/0.5',
      source: 'root = Text("ready")',
    });
  });
});

describe('async tool settlement', () => {
  it('emits UI after background work settles past its grace window', async () => {
    mockBetaResponsesSend.mockReset();
    let release: ((value: { summary: string }) => void) | undefined;
    const gate = new Promise<{
      summary: string;
    }>((resolve) => {
      release = resolve;
    });
    const weather = tool({
      name: 'weather',
      lifecycle: 'background',
      graceMs: 0,
      inputSchema: z.object({
        city: z.string(),
      }),
      outputSchema: z.object({
        summary: z.string(),
      }),
      run: () => gate,
      toUiOutput: ({ input, output }) => ui.Card(`${input.city}: ${output.summary}`),
    });
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: response('r1', [
          {
            type: 'function_call',
            id: 'fc1',
            callId: 'c1',
            name: 'weather',
            arguments: '{"city":"Lisbon"}',
            status: 'completed',
          },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: response('r2', [
          {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'waiting',
                annotations: [],
              },
            ],
          },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: response('r3', [
          {
            type: 'message',
            id: 'm2',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'done',
                annotations: [],
              },
            ],
          },
        ]),
      });

    const result = callModel(
      {
        _options: {},
      } as OpenRouterCore,
      {
        model: 'test-model',
        input: 'weather',
        tools: [
          weather,
        ] as const,
        asyncTools: {
          onRunEnd: 'drain',
        },
      },
    );
    const events: unknown[] = [];
    async function consumeUiStream() {
      for await (const event of result.getUiStream()) {
        events.push(event);
      }
    }
    const consuming = consumeUiStream();
    await vi.waitFor(() => expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2));
    release?.({
      summary: 'Clear',
    });
    await consuming;

    expect(events).toContainEqual({
      type: 'fragment',
      toolCallId: 'c1',
      toolName: 'weather',
      dialect: 'openui-lang/0.5',
      source: 'root = Card("Lisbon: Clear")',
    });
  });
});

describe('broadcastUiFragment', () => {
  type Internal = {
    turnBroadcaster: {
      push: (event: unknown) => void;
    } | null;
    pendingUiFragments: Set<Promise<void>>;
    dispatchUiFragment: (value: {
      toolCall: ParsedToolCall<Tool>;
      tool: Tool;
      result: {
        result: unknown;
        error?: Error;
      };
    }) => void;
    drainUiFragments: () => Promise<void>;
    broadcastUiFragment: (value: {
      toolCall: ParsedToolCall<Tool>;
      tool: Tool;
      result: {
        result: unknown;
        error?: Error;
      };
    }) => Promise<void>;
  };

  function makeHarness() {
    const pushed: unknown[] = [];
    const modelResult = new ModelResult<readonly Tool[]>({
      request: {
        model: 'test-model',
        input: 'test',
      },
      client: {} as OpenRouterCore,
    });
    const internal = modelResult as unknown as Internal;
    internal.turnBroadcaster = {
      push: (event: unknown) => {
        pushed.push(event);
      },
    };
    return {
      internal,
      pushed,
    };
  }

  function makeCall(
    t: Tool,
    result: {
      result: unknown;
      error?: Error;
    },
  ) {
    return {
      toolCall: {
        id: 'c1',
        name: t.type === 'function' ? t.function.name : 'server',
        arguments: {
          days: 7,
        },
      } as unknown as ParsedToolCall<Tool>,
      tool: t,
      result,
    };
  }

  it('releases timed-out renders without removing renders added during the drain', async () => {
    vi.useFakeTimers();
    try {
      const { internal, pushed } = makeHarness();
      let releaseLater: (() => void) | undefined;
      const hanging = tool({
        name: 'hanging_ui',
        inputSchema: z.object({
          days: z.number(),
        }),
        execute: async () => 'old',
        toUiOutput: () => new Promise(() => undefined),
      });
      const later = tool({
        name: 'later_ui',
        inputSchema: z.object({
          days: z.number(),
        }),
        execute: async () => 'new',
        toUiOutput: async () => {
          await new Promise<void>((resolve) => {
            releaseLater = resolve;
          });
          return ui.Text('later');
        },
      });

      internal.dispatchUiFragment(
        makeCall(hanging, {
          result: 'old',
        }),
      );
      const firstDrain = internal.drainUiFragments();
      internal.dispatchUiFragment(
        makeCall(later, {
          result: 'new',
        }),
      );

      await vi.advanceTimersByTimeAsync(30_000);
      await firstDrain;
      expect(internal.pendingUiFragments).toHaveLength(1);

      let secondDrainFinished = false;
      const secondDrain = internal.drainUiFragments().then(() => {
        secondDrainFinished = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(secondDrainFinished).toBe(false);

      releaseLater?.();
      await secondDrain;
      expect(internal.pendingUiFragments).toHaveLength(0);
      expect(pushed).toContainEqual(
        expect.objectContaining({
          toolName: 'later_ui',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('pushes a tool.ui_fragment event for a successful execution', async () => {
    const { internal, pushed } = makeHarness();
    const t = tool({
      name: 'usage',
      inputSchema: z.object({
        days: z.number(),
      }),
      execute: async () => ({
        total: 12,
      }),
      toUiOutput: ({ output, input }) => ui.Card(`$${output.total} over ${input.days}d`),
    });

    await internal.broadcastUiFragment(
      makeCall(t, {
        result: {
          total: 12,
        },
      }),
    );

    expect(pushed).toHaveLength(1);
    const event = pushed[0];
    expect(isToolUiFragmentEvent(event as never)).toBe(true);
    expect(event).toMatchObject({
      type: 'tool.ui_fragment',
      toolCallId: 'c1',
      toolName: 'usage',
      fragment: {
        dialect: 'openui-lang/0.5',
        source: 'root = Card("$12 over 7d")',
      },
    });
  });

  it('skips tools without toUiOutput and errored executions', async () => {
    const { internal, pushed } = makeHarness();
    const plain = tool({
      name: 'plain',
      inputSchema: z.object({
        days: z.number(),
      }),
      execute: async () => 'ok',
    });
    await internal.broadcastUiFragment(
      makeCall(plain, {
        result: 'ok',
      }),
    );

    const withUi = tool({
      name: 'ui_tool',
      inputSchema: z.object({
        days: z.number(),
      }),
      execute: async () => 'ok',
      toUiOutput: () => ui.Text('never'),
    });
    await internal.broadcastUiFragment(
      makeCall(withUi, {
        result: undefined,
        error: new Error('boom'),
      }),
    );

    expect(pushed).toEqual([]);
  });

  it('drops the fragment when toUiOutput returns null or throws', async () => {
    const { internal, pushed } = makeHarness();
    const nullTool = tool({
      name: 'null_ui',
      inputSchema: z.object({
        days: z.number(),
      }),
      execute: async () => 'ok',
      toUiOutput: () => null,
    });
    await internal.broadcastUiFragment(
      makeCall(nullTool, {
        result: 'ok',
      }),
    );

    const throwingTool = tool({
      name: 'throwing_ui',
      inputSchema: z.object({
        days: z.number(),
      }),
      execute: async () => 'ok',
      toUiOutput: () => {
        throw new Error('render bug');
      },
    });
    await internal.broadcastUiFragment(
      makeCall(throwingTool, {
        result: 'ok',
      }),
    );

    expect(pushed).toEqual([]);
  });
});
