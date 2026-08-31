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
import { resumeToolResults } from '../../src/inner-loop/resume-tool-results.js';
import { ModelResult } from '../../src/lib/model-result.js';
import { fragment } from '../../src/lib/openui/fragment.js';
import { createLibrary, defineComponent } from '../../src/lib/openui/library.js';
import { translateUiEvent } from '../../src/lib/openui/ui-stream.js';
import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import { tool } from '../../src/lib/tool.js';
import type {
  ConversationState,
  ParsedToolCall,
  StateAccessor,
  Tool,
} from '../../src/lib/tool-types.js';
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
  it('does not render or block the run without a UI consumer', async () => {
    mockBetaResponsesSend.mockReset();
    mockToolRound('hanging_ui');
    const toUiOutput = vi.fn(() => new Promise<never>(() => undefined));
    const hanging = tool({
      name: 'hanging_ui',
      inputSchema: z.object({}),
      execute: () => 'ok',
      toUiOutput,
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

    await expect(result.getText()).resolves.toBe('done');
    expect(toUiOutput).not.toHaveBeenCalled();
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
  });

  it('finishes text immediately and closes hanging UI at its own deadline', async () => {
    vi.useFakeTimers();
    try {
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
            drainTimeoutMs: 1,
          },
        },
      );

      async function consumeUiStream() {
        for await (const _event of result.getUiStream()) {
          // No fragment is produced by the hanging renderer.
        }
      }
      const uiDone = consumeUiStream();
      await expect(result.getText()).resolves.toBe('done');

      let closed = false;
      void uiDone.then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await uiDone;

      expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
      expect(
        (
          result as unknown as {
            pendingUiFragments: Set<Promise<void>>;
          }
        ).pendingUiFragments,
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers async UI when UI, text, and item streams are consumed concurrently', async () => {
    mockBetaResponsesSend.mockReset();
    mockToolRound('concurrent_ui');
    let release: (() => void) | undefined;
    const rendering = new Promise<void>((resolve) => {
      release = resolve;
    });
    const concurrentUi = tool({
      name: 'concurrent_ui',
      inputSchema: z.object({}),
      execute: () => 'ok',
      toUiOutput: async () => {
        await rendering;
        return ui.Text('concurrent');
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
          concurrentUi,
        ] as const,
      },
    );
    const text: string[] = [];
    const items: unknown[] = [];
    const events: unknown[] = [];
    async function collect<T>(stream: AsyncIterable<T>, values: T[]) {
      for await (const value of stream) {
        values.push(value);
      }
    }
    const consumeText = collect(result.getTextStream(), text);
    const consumeItems = collect(result.getItemsStream(), items);
    const consumeUi = collect(result.getUiStream(), events);

    await vi.waitFor(() => expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2));
    release?.();
    await Promise.all([
      consumeText,
      consumeItems,
      consumeUi,
    ]);

    expect(text).toEqual([]);
    expect(items).toContainEqual(
      expect.objectContaining({
        type: 'function_call_output',
      }),
    );
    expect(events).toContainEqual({
      type: 'fragment',
      toolCallId: 'c1',
      toolName: 'concurrent_ui',
      dialect: 'openui-lang/0.5',
      source: 'root = Text("concurrent")',
    });
  });

  it('delivers the same fragment to concurrent UI consumers', async () => {
    mockBetaResponsesSend.mockReset();
    mockToolRound('shared_ui');
    const sharedUi = tool({
      name: 'shared_ui',
      inputSchema: z.object({}),
      execute: () => 'ok',
      toUiOutput: () => ui.Text('shared'),
    });
    const result = callModel(
      {
        _options: {},
      } as OpenRouterCore,
      {
        model: 'test-model',
        input: 'test',
        tools: [
          sharedUi,
        ] as const,
      },
    );
    const collect = async (stream: AsyncIterable<unknown>) => {
      const events = [];
      for await (const event of stream) {
        events.push(event);
      }
      return events;
    };

    const [first, second] = await Promise.all([
      collect(result.getUiStream()),
      collect(result.getUiStream()),
    ]);

    expect(first).toEqual(second);
    expect(first).toContainEqual(
      expect.objectContaining({
        type: 'fragment',
        toolName: 'shared_ui',
      }),
    );
  });

  it('unsubscribes after an early break and skips later rendering', async () => {
    mockBetaResponsesSend.mockReset();
    mockToolRound('first_ui');
    const firstUi = tool({
      name: 'first_ui',
      inputSchema: z.object({}),
      execute: () => 'first',
      toUiOutput: () => ui.Text('first'),
    });
    const laterRenderer = vi.fn(() => ui.Text('later'));
    const laterUi = tool({
      name: 'later_ui',
      inputSchema: z.object({}),
      execute: () => 'later',
      toUiOutput: laterRenderer,
    });
    const result = callModel(
      {
        _options: {},
      } as OpenRouterCore,
      {
        model: 'test-model',
        input: 'test',
        tools: [
          firstUi,
        ] as const,
      },
    );

    for await (const event of result.getUiStream()) {
      expect(event).toMatchObject({
        type: 'fragment',
        toolName: 'first_ui',
      });
      break;
    }

    const internal = result as unknown as {
      uiBroadcaster: {
        activeConsumerCount: number;
      };
      pendingUiFragments: Set<Promise<void>>;
      dispatchUiFragment: (value: {
        toolCall: ParsedToolCall<Tool>;
        tool: Tool;
        result: {
          result: unknown;
        };
      }) => void;
    };
    expect(internal.uiBroadcaster.activeConsumerCount).toBe(0);
    internal.dispatchUiFragment({
      toolCall: {
        id: 'c2',
        name: 'later_ui',
        arguments: {},
      } as unknown as ParsedToolCall<Tool>,
      tool: laterUi,
      result: {
        result: 'later',
      },
    });

    expect(laterRenderer).not.toHaveBeenCalled();
    expect(internal.pendingUiFragments).toHaveLength(0);
  });

  it('keeps rendering for a remaining UI consumer after another exits', async () => {
    mockBetaResponsesSend.mockReset();
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: response('r1', [
          {
            type: 'function_call',
            id: 'fc1',
            callId: 'c1',
            name: 'fast_ui',
            arguments: '{}',
            status: 'completed',
          },
          {
            type: 'function_call',
            id: 'fc2',
            callId: 'c2',
            name: 'slow_ui',
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
            content: [],
          },
        ]),
      });
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const fastUi = tool({
      name: 'fast_ui',
      inputSchema: z.object({}),
      execute: () => 'fast',
      toUiOutput: () => ui.Text('fast'),
    });
    const slowRenderer = vi.fn(async () => {
      await slowGate;
      return ui.Text('slow');
    });
    const slowUi = tool({
      name: 'slow_ui',
      inputSchema: z.object({}),
      execute: () => 'slow',
      toUiOutput: slowRenderer,
    });
    const result = callModel(
      {
        _options: {},
      } as OpenRouterCore,
      {
        model: 'test-model',
        input: 'test',
        tools: [
          fastUi,
          slowUi,
        ] as const,
      },
    );
    const first = result.getUiStream();
    const remaining = result.getUiStream();

    const [firstEvent, remainingFirstEvent] = await Promise.all([
      first.next(),
      remaining.next(),
    ]);
    expect(firstEvent.value).toMatchObject({
      type: 'fragment',
      toolName: 'fast_ui',
    });
    expect(remainingFirstEvent.value).toEqual(firstEvent.value);
    await first.return();
    expect(
      (
        result as unknown as {
          uiBroadcaster: {
            activeConsumerCount: number;
          };
        }
      ).uiBroadcaster.activeConsumerCount,
    ).toBe(1);

    releaseSlow?.();
    await expect(remaining.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: 'fragment',
        toolName: 'slow_ui',
      },
    });
    await remaining.return();
    expect(slowRenderer).toHaveBeenCalledOnce();
  });

  it('yields a tool fragment before the later model round completes', async () => {
    mockBetaResponsesSend.mockReset();
    let finishRound: ((value: { ok: true; value: models.OpenResponsesResult }) => void) | undefined;
    const laterRound = new Promise<{
      ok: true;
      value: models.OpenResponsesResult;
    }>((resolve) => {
      finishRound = resolve;
    });
    mockBetaResponsesSend
      .mockResolvedValueOnce({
        ok: true,
        value: response('r1', [
          {
            type: 'function_call',
            id: 'fc1',
            callId: 'c1',
            name: 'progressive_ui',
            arguments: '{}',
            status: 'completed',
          },
        ]),
      })
      .mockReturnValueOnce(laterRound);
    const progressiveUi = tool({
      name: 'progressive_ui',
      inputSchema: z.object({}),
      execute: () => 'ready',
      toUiOutput: () => ui.Text('progressive'),
    });
    const result = callModel(
      {
        _options: {},
      } as OpenRouterCore,
      {
        model: 'test-model',
        input: 'test',
        tools: [
          progressiveUi,
        ] as const,
      },
    );
    const stream = result.getUiStream();
    let firstEvent: IteratorResult<unknown> | undefined;
    const pendingFirst = stream.next().then((event) => {
      firstEvent = event;
      return event;
    });

    await vi.waitFor(() => expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(firstEvent).toBeDefined());
    expect(await pendingFirst).toMatchObject({
      done: false,
      value: {
        type: 'fragment',
        toolName: 'progressive_ui',
      },
    });

    finishRound?.({
      ok: true,
      value: response('r2', [
        {
          type: 'message',
          id: 'm1',
          role: 'assistant',
          status: 'completed',
          content: [],
        },
      ]),
    });
    while (!(await stream.next()).done) {
      // Drain the completed round so no execution work escapes the test.
    }
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

describe('late async tool UI settlement', () => {
  const deferred = tool({
    name: 'deferred_ui',
    lifecycle: 'deferred',
    inputSchema: z.object({
      city: z.string(),
    }),
    outputSchema: z.object({
      summary: z.string(),
    }),
    run: () => ({
      taskId: 'task_1',
    }),
    toUiOutput: ({ input, output }) => ui.Text(`${input.city}: ${output.summary}`),
  });

  function makeSettlementHarness(input?: Record<string, unknown>) {
    const result = new ModelResult({
      request: {
        model: 'test-model',
        input: 'test',
      },
      tools: [
        deferred,
      ],
      client: {} as OpenRouterCore,
    });
    const pushed: unknown[] = [];
    const internal = result as unknown as {
      asyncToolRegistry: {
        takeSettled: () => Array<Record<string, unknown>>;
      };
      uiBroadcaster: {
        activeConsumerCount: number;
        push: (event: unknown) => void;
      };
      flushAsyncToolDeliveries: () => Promise<boolean>;
      injectAppendPromptMessage: () => Promise<void>;
      drainUiFragments: () => Promise<void>;
    };
    internal.uiBroadcaster = {
      activeConsumerCount: 1,
      push: (event) => pushed.push(event),
    };
    internal.asyncToolRegistry = {
      takeSettled: () => [
        {
          callId: 'c1',
          taskId: 'task_1',
          name: 'deferred_ui',
          status: 'completed',
          result: {
            summary: 'Clear',
          },
          ...(input !== undefined && {
            input,
          }),
          durationMs: 1,
        },
      ],
    };
    internal.injectAppendPromptMessage = async () => undefined;
    return {
      internal,
      pushed,
    };
  }

  it('renders same-run deferred settlement with retained input', async () => {
    const { internal, pushed } = makeSettlementHarness({
      city: 'Lisbon',
    });

    await internal.flushAsyncToolDeliveries();
    await internal.drainUiFragments();

    expect(pushed).toContainEqual(
      expect.objectContaining({
        type: 'tool.ui_fragment',
        toolCallId: 'c1',
        fragment: {
          dialect: 'openui-lang/0.5',
          source: 'root = Text("Lisbon: Clear")',
        },
      }),
    );
  });

  it('renders externally resumed deferred settlement through the UI stream', async () => {
    mockBetaResponsesSend.mockReset();
    mockBetaResponsesSend.mockResolvedValueOnce({
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
    let state: ConversationState = {
      id: 'conversation_1',
      messages: [],
      status: 'awaiting_async_tools',
      pendingAsyncTools: [
        {
          callId: 'c1',
          taskId: 'task_1',
          name: 'deferred_ui',
          mode: 'defer',
          status: 'working',
          startedAt: Date.now(),
          input: {
            city: 'Lisbon',
          },
        },
      ],
    };
    const accessor: StateAccessor = {
      load: async () => state,
      save: async (next) => {
        state = next;
      },
    };

    const result = await resumeToolResults(
      {
        _options: {},
      } as OpenRouterCore,
      {
        state: accessor,
        tools: [
          deferred,
        ] as const,
        results: [
          {
            taskId: 'task_1',
            output: {
              summary: 'Clear',
            },
          },
        ],
        run: {
          model: 'test-model',
        },
      },
    );
    const events: unknown[] = [];
    if (result) {
      for await (const event of result.getUiStream()) {
        events.push(event);
      }
    }

    expect(events).toContainEqual({
      type: 'fragment',
      toolCallId: 'c1',
      toolName: 'deferred_ui',
      dialect: 'openui-lang/0.5',
      source: 'root = Text("Lisbon: Clear")',
    });
  });

  it('skips legacy deferred settlement without retained input', async () => {
    const { internal, pushed } = makeSettlementHarness();

    await internal.flushAsyncToolDeliveries();
    await internal.drainUiFragments();

    expect(pushed).toEqual([]);
  });
});

describe('broadcastUiFragment', () => {
  type Internal = {
    uiBroadcaster: {
      activeConsumerCount: number;
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
    internal.uiBroadcaster = {
      activeConsumerCount: 1,
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

  it('delivers renders added during the production drain before closing the UI stream', async () => {
    mockBetaResponsesSend.mockReset();
    mockToolRound('initial_ui');
    let releaseInitial: (() => void) | undefined;
    let releaseLater: (() => void) | undefined;
    const initial = tool({
      name: 'initial_ui',
      inputSchema: z.object({}),
      execute: () => 'initial',
      toUiOutput: async () => {
        await new Promise<void>((resolve) => {
          releaseInitial = resolve;
        });
        return ui.Text('initial');
      },
    });
    const later = tool({
      name: 'later_ui',
      inputSchema: z.object({}),
      execute: () => 'later',
      toUiOutput: async () => {
        await new Promise<void>((resolve) => {
          releaseLater = resolve;
        });
        return ui.Text('later');
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
          initial,
        ] as const,
      },
    );
    const internal = result as unknown as Internal;
    let notifyDrainStarted: (() => void) | undefined;
    const drainStarted = new Promise<void>((resolve) => {
      notifyDrainStarted = resolve;
    });
    const drainUiFragments = internal.drainUiFragments.bind(internal);
    internal.drainUiFragments = async () => {
      notifyDrainStarted?.();
      await drainUiFragments();
    };

    const events: unknown[] = [];
    async function consumeUiStream() {
      for await (const event of result.getUiStream()) {
        events.push(event);
      }
    }
    const consuming = consumeUiStream();

    await drainStarted;
    expect(mockBetaResponsesSend).toHaveBeenCalledTimes(2);
    internal.dispatchUiFragment(
      makeCall(later, {
        result: 'later',
      }),
    );
    releaseInitial?.();
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          toolName: 'initial_ui',
        }),
      ),
    );
    releaseLater?.();
    await consuming;

    expect(internal.pendingUiFragments).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        toolName: 'later_ui',
      }),
    );
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
