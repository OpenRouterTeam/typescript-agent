/**
 * Tests for the OpenUI streaming half: toUIOutput plumbing through tool(),
 * the tool.ui_fragment broadcast, translateUiEvent (including the SDK's
 * forward-compat Unknown encoding of response.openui.* wire events), and
 * getUiStream()'s no-tools fast path.
 */
import type { OpenRouterCore } from '@openrouter/sdk/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { ModelResult } from '../../src/lib/model-result.js';
import { fragment } from '../../src/lib/openui/fragment.js';
import { createLibrary, defineComponent } from '../../src/lib/openui/library.js';
import { translateUiEvent } from '../../src/lib/openui/ui-stream.js';
import { ReusableReadableStream } from '../../src/lib/reusable-stream.js';
import { tool } from '../../src/lib/tool.js';
import type { ParsedToolCall, Tool } from '../../src/lib/tool-types.js';
import { isToolUiFragmentEvent } from '../../src/lib/tool-types.js';

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

describe('tool() carries toUIOutput', () => {
  it('regular tool', () => {
    const t = tool({
      name: 'usage',
      inputSchema: z.object({
        days: z.number(),
      }),
      execute: async () => ({
        total: 12,
      }),
      toUIOutput: ({ output }) => ui.Card(`$${output.total}`),
    });
    expect(t.function.toUIOutput).toBeTypeOf('function');
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
      toUIOutput: () => ui.Text('done'),
    });
    expect(t.function.toUIOutput).toBeTypeOf('function');
  });

  it('HITL tool', () => {
    const t = tool({
      name: 'hitl',
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
      }),
      onToolCalled: () => null,
      toUIOutput: () => ui.Text('pending'),
    });
    expect(t.function.toUIOutput).toBeTypeOf('function');
  });

  it('omitted stays absent', () => {
    const t = tool({
      name: 'plain',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    });
    expect('toUIOutput' in t.function && t.function.toUIOutput !== undefined).toBe(false);
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

  it("unwraps the SDK's Unknown forward-compat encoding", () => {
    const event = translateUiEvent({
      type: 'UNKNOWN',
      isUnknown: true,
      raw: {
        type: 'response.openui.statement',
        ref: '$tab',
        kind: 'state',
        source: '$tab = "overview"',
      },
    });
    expect(event).toEqual({
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

describe('broadcastUiFragment', () => {
  type Internal = {
    turnBroadcaster: {
      push: (event: unknown) => void;
    } | null;
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
      toUIOutput: ({ output, input }) => ui.Card(`$${output.total} over ${input.days}d`),
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

  it('skips tools without toUIOutput and errored executions', async () => {
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
      toUIOutput: () => ui.Text('never'),
    });
    await internal.broadcastUiFragment(
      makeCall(withUi, {
        result: undefined,
        error: new Error('boom'),
      }),
    );

    expect(pushed).toEqual([]);
  });

  it('drops the fragment when toUIOutput returns null or throws', async () => {
    const { internal, pushed } = makeHarness();
    const nullTool = tool({
      name: 'null_ui',
      inputSchema: z.object({
        days: z.number(),
      }),
      execute: async () => 'ok',
      toUIOutput: () => null,
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
      toUIOutput: () => {
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
