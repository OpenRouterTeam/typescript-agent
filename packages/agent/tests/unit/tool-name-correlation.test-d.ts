/**
 * Type-level tests: `tool()` preserves literal names, and name-correlated
 * stream/result event unions narrow `result` from `event.toolName`.
 */

import { expectTypeOf } from 'vitest';
import * as z from 'zod';
import { serverTool, tool } from '../../src/lib/tool.js';
import type {
  ChatStreamEvent,
  CorrelatedResponseStreamEvent,
  CorrelatedToolEventUnion,
  CorrelatedToolPreliminaryResultEvent,
  CorrelatedToolResultEvent,
  CorrelatedToolStreamEvent,
  CorrelatedToolStreamPreliminaryUnion,
  InferToolName,
  ServerTool,
  ServerToolBase,
  Tool,
  ToolPreliminaryResultEvent,
  ToolResultEvent,
  ToolStreamEvent,
  ToolWithExecute,
} from '../../src/lib/tool-types.js';

const weather = tool({
  name: 'weather',
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    tempC: z.number(),
  }),
  execute: async () => ({
    tempC: 20,
  }),
});

const progress = tool({
  name: 'progress_tool',
  inputSchema: z.object({
    n: z.number(),
  }),
  eventSchema: z.object({
    stage: z.string(),
  }),
  outputSchema: z.object({
    done: z.boolean(),
  }),
  execute: async function* () {
    yield {
      stage: 'start',
    };
    yield {
      done: true,
    };
  },
});

const manual = tool({
  name: 'manual_tool',
  inputSchema: z.object({
    id: z.string(),
  }),
  execute: false,
});

const shared = tool<{
  userId: string;
}>({
  name: 'shared_tool',
  inputSchema: z.object({}),
  execute: async (_params, ctx) => ctx?.shared.userId ?? '',
});

const hitl = tool({
  name: 'hitl_tool',
  inputSchema: z.object({
    q: z.string(),
  }),
  outputSchema: z.object({
    answer: z.string(),
  }),
  onToolCalled: async () => null,
});

// A tool whose `execute` throws, used below to prove that the correlated
// `tool.result` type accurately includes the runtime `{ error: string }`
// payload broadcast by `ModelResult` for rejected/errored executions.
const boom = tool({
  name: 'boom_tool',
  inputSchema: z.object({}),
  outputSchema: z.object({
    ok: z.boolean(),
  }),
  execute: async () => {
    throw new Error('explode');
  },
});

// --- Literal names survive the factory --------------------------------------
expectTypeOf(weather.function.name).toEqualTypeOf<'weather'>();
expectTypeOf(progress.function.name).toEqualTypeOf<'progress_tool'>();
expectTypeOf(manual.function.name).toEqualTypeOf<'manual_tool'>();
expectTypeOf(shared.function.name).toEqualTypeOf<'shared_tool'>();
expectTypeOf(hitl.function.name).toEqualTypeOf<'hitl_tool'>();

expectTypeOf<InferToolName<typeof weather>>().toEqualTypeOf<'weather'>();
expectTypeOf<InferToolName<typeof progress>>().toEqualTypeOf<'progress_tool'>();
expectTypeOf<InferToolName<typeof manual>>().toEqualTypeOf<'manual_tool'>();
expectTypeOf<InferToolName<typeof shared>>().toEqualTypeOf<'shared_tool'>();
expectTypeOf<InferToolName<typeof hitl>>().toEqualTypeOf<'hitl_tool'>();

// Wide defaults still assign to Tool
expectTypeOf(weather).toExtend<Tool>();
expectTypeOf(progress).toExtend<Tool>();
expectTypeOf(manual).toExtend<Tool>();
expectTypeOf(shared).toExtend<Tool>();
expectTypeOf(hitl).toExtend<Tool>();
expectTypeOf<ToolWithExecute>().toExtend<Tool>();

type Tools = readonly [
  typeof weather,
  typeof progress,
  typeof manual,
  typeof hitl,
];

type Events = CorrelatedToolEventUnion<Tools>;
type Stream = CorrelatedResponseStreamEvent<Tools>;
type ToolStream = CorrelatedToolStreamEvent<Tools>;

// --- Narrowing tool.result by toolName --------------------------------------
//
// `result` on a correlated `tool.result` event is a union of the tool's
// success output and `{ error: string }`, since `ModelResult` broadcasts the
// latter under the same `type`/`toolName` for parse failures, thrown/rejected
// executions, and tool-reported execution errors. Consumers narrow further
// with an `'error' in result` (or similar) check.
declare const correlated: Events;
if (correlated.type === 'tool.result' && correlated.toolName === 'weather') {
  expectTypeOf(correlated.result).toEqualTypeOf<
    | {
        tempC: number;
      }
    | {
        error: string;
      }
  >();
  expectTypeOf(correlated.toolName).toEqualTypeOf<'weather'>();
  if ('error' in correlated.result) {
    expectTypeOf(correlated.result).toEqualTypeOf<{
      error: string;
    }>();
  } else {
    expectTypeOf(correlated.result).toEqualTypeOf<{
      tempC: number;
    }>();
  }
}
if (correlated.type === 'tool.result' && correlated.toolName === 'progress_tool') {
  expectTypeOf(correlated.result).toEqualTypeOf<
    | {
        done: boolean;
      }
    | {
        error: string;
      }
  >();
}
if (correlated.type === 'tool.result' && correlated.toolName === 'hitl_tool') {
  expectTypeOf(correlated.result).toEqualTypeOf<
    | {
        answer: string;
      }
    | {
        error: string;
      }
  >();
}
if (correlated.type === 'tool.preliminary_result' && correlated.toolName === 'progress_tool') {
  // Preliminary (in-progress) results are never used to broadcast parse,
  // execution, or rejection errors — only the final `tool.result` is — so
  // this stays the plain success-event shape.
  expectTypeOf(correlated.result).toEqualTypeOf<{
    stage: string;
  }>();
}

// Stream method view uses the same correlated union for tool events
declare const streamEvent: Stream;
if (streamEvent.type === 'tool.result' && streamEvent.toolName === 'weather') {
  expectTypeOf(streamEvent.result).toEqualTypeOf<
    | {
        tempC: number;
      }
    | {
        error: string;
      }
  >();
}

// Legacy getToolStream preliminary events carry toolName + correlated result
declare const toolStreamEvent: ToolStream;
if (toolStreamEvent.type === 'preliminary_result' && toolStreamEvent.toolName === 'progress_tool') {
  expectTypeOf(toolStreamEvent.result).toEqualTypeOf<{
    stage: string;
  }>();
}

// Per-tool correlated result helper
expectTypeOf<CorrelatedToolResultEvent<typeof weather>['toolName']>().toEqualTypeOf<'weather'>();
expectTypeOf<CorrelatedToolResultEvent<typeof weather>['result']>().toEqualTypeOf<
  | {
      tempC: number;
    }
  | {
      error: string;
    }
>();

// --- Error payloads are included for a throwing typed tool -------------------
//
// `boom`'s `execute` always throws. At runtime `ModelResult` broadcasts
// `{ error: string }` under `tool.result` / `toolName: 'boom_tool'` for this
// case (see the `tool-name-events.test.ts` runtime coverage). The correlated
// type must accept that shape without widening away the success narrowing.
expectTypeOf<CorrelatedToolResultEvent<typeof boom>['result']>().toEqualTypeOf<
  | {
      ok: boolean;
    }
  | {
      error: string;
    }
>();

declare const boomResult: CorrelatedToolResultEvent<typeof boom>;
if ('error' in boomResult.result) {
  expectTypeOf(boomResult.result).toEqualTypeOf<{
    error: string;
  }>();
} else {
  expectTypeOf(boomResult.result).toEqualTypeOf<{
    ok: boolean;
  }>();
}

// A literal error payload assigns to the correlated result event for a
// concrete tool — this is exactly the runtime shape `broadcastToolResult`
// produces for parse failures, thrown/rejected executions, and
// tool-reported execution errors.
const boomErrorEvent: CorrelatedToolResultEvent<typeof boom> = {
  type: 'tool.result',
  toolCallId: 'call_1',
  toolName: 'boom_tool',
  source: 'client',
  result: {
    error: 'explode',
  },
  timestamp: Date.now(),
};
void boomErrorEvent;

// --- Generic `readonly Tool[]` must not collapse to `never` -----------------
//
// A tool handle whose concrete tuple isn't known at the type level (e.g. an
// `@openrouter/agent/mcp` tool array typed as `readonly Tool[]`) must still produce
// a usable, backward-compatible event shape instead of `never`. The mapped
// check `T[K] extends ClientTool` doesn't distribute over the indexed access
// `T[K]` when `T` is the wide `readonly Tool[]`, so these types fall back to
// the widest shape (matching the pre-existing, non-tuple-parameterized
// `ToolPreliminaryResultEvent`/`ToolResultEvent`/`ToolStreamEvent` defaults).
type WideEvents = CorrelatedToolEventUnion<readonly Tool[]>;
type WideStream = CorrelatedResponseStreamEvent<readonly Tool[]>;
type WideToolStream = CorrelatedToolStreamEvent<readonly Tool[]>;
type WidePreliminaryUnion = CorrelatedToolStreamPreliminaryUnion<readonly Tool[]>;

expectTypeOf<WideEvents>().not.toBeNever();
expectTypeOf<WideStream>().not.toBeNever();
expectTypeOf<WideToolStream>().not.toBeNever();
expectTypeOf<WidePreliminaryUnion>().not.toBeNever();

// The wide shapes still carry `tool.result` / `tool.preliminary_result` /
// `preliminary_result` variants (not silently dropped).
expectTypeOf<
  Extract<
    WideEvents,
    {
      type: 'tool.result';
    }
  >
>().not.toBeNever();
expectTypeOf<
  Extract<
    WideEvents,
    {
      type: 'tool.preliminary_result';
    }
  >
>().not.toBeNever();
expectTypeOf<
  Extract<
    WideStream,
    {
      type: 'tool.result';
    }
  >
>().not.toBeNever();
expectTypeOf<
  Extract<
    WideStream,
    {
      type: 'tool.preliminary_result';
    }
  >
>().not.toBeNever();
expectTypeOf<
  Extract<
    WideToolStream,
    {
      type: 'preliminary_result';
    }
  >
>().not.toBeNever();
expectTypeOf<
  Extract<
    WidePreliminaryUnion,
    {
      type: 'preliminary_result';
    }
  >
>().not.toBeNever();

// `toolName`/`result` degrade gracefully to `string`/`unknown` for the wide
// case (no correlation possible without a concrete tuple).
declare const wideResult: Extract<
  WideEvents,
  {
    type: 'tool.result';
  }
>;
expectTypeOf(wideResult.toolName).toEqualTypeOf<string>();
expectTypeOf(wideResult.result).toEqualTypeOf<unknown>();

// --- Concrete tuples still retain full name correlation ----------------------
//
// Passing a real tuple (not the wide `readonly Tool[]`) must keep narrowing
// `result` from a literal `toolName`, proving the wide-case fallback above
// doesn't regress tuple correlation.
declare const narrowResult: Extract<
  CorrelatedToolEventUnion<Tools>,
  {
    type: 'tool.result';
  }
>;
if (narrowResult.toolName === 'weather') {
  expectTypeOf(narrowResult.result).toEqualTypeOf<
    | {
        tempC: number;
      }
    | {
        error: string;
      }
  >();
}
// --- Source compatibility: legacy hand-constructed shapes still compile ----
//
// `ServerToolBase.id` and the `toolName` field on the wide (non-correlated)
// event types were made optional so that values built by hand before these
// fields existed keep compiling under a minor release, without loosening the
// strongly-typed literal guarantees on `serverTool()` output or on the
// per-tool "correlated" event helpers below.

// A legacy server tool literal that predates `id` compiles as `ServerToolBase`.
const legacyServerTool: ServerToolBase = {
  _brand: 'server-tool',
  config: {
    type: 'openrouter:datetime',
  },
};
expectTypeOf(legacyServerTool).toExtend<Tool>();
expectTypeOf(legacyServerTool.id).toEqualTypeOf<string | undefined>();

// A legacy preliminary-result event literal that predates `toolName` compiles.
const legacyPreliminary: ToolPreliminaryResultEvent = {
  type: 'tool.preliminary_result',
  toolCallId: 'call_1',
  result: {
    stage: 'start',
  },
  timestamp: Date.now(),
};
expectTypeOf(legacyPreliminary.toolName).toEqualTypeOf<string | undefined>();

// A legacy result event literal that predates `toolName` compiles.
const legacyResult: ToolResultEvent = {
  type: 'tool.result',
  toolCallId: 'call_1',
  source: 'client',
  result: {
    tempC: 20,
  },
  timestamp: Date.now(),
};
expectTypeOf(legacyResult.toolName).toEqualTypeOf<string | undefined>();

// A legacy `getToolStream` preliminary event literal that predates `toolName`.
const legacyToolStreamEvent: ToolStreamEvent = {
  type: 'preliminary_result',
  toolCallId: 'call_1',
  result: {
    stage: 'start',
  },
};
expectTypeOf(legacyToolStreamEvent.toolName).toEqualTypeOf<string | undefined>();

// A legacy `getFullChatStream` preliminary event literal that predates `toolName`.
const legacyChatStreamEvent: ChatStreamEvent = {
  type: 'tool.preliminary_result',
  toolCallId: 'call_1',
  result: {
    stage: 'start',
  },
};
expectTypeOf(legacyChatStreamEvent.toolName).toEqualTypeOf<string | undefined>();

// --- serverTool() factory output stays required + literal -------------------

const publicSearch = serverTool(
  {
    type: 'web_search_2025_08_26',
  },
  {
    id: 'server:public_search',
  },
);
expectTypeOf(publicSearch.id).toEqualTypeOf<'server:public_search'>();
expectTypeOf(publicSearch).toExtend<ServerTool<'web_search_2025_08_26', 'server:public_search'>>();
// @ts-expect-error ServerTool<T, TId> still requires a literal `id`, not `string | undefined`
const _missingId: ServerTool<'web_search_2025_08_26'> = {
  _brand: 'server-tool',
  config: {
    type: 'web_search_2025_08_26',
  },
};
void _missingId;

// --- Correlated per-tool helpers still require + provide literal names -----

expectTypeOf<
  CorrelatedToolPreliminaryResultEvent<typeof progress>['toolName']
>().toEqualTypeOf<'progress_tool'>();
expectTypeOf<CorrelatedToolPreliminaryResultEvent<typeof progress>['result']>().toEqualTypeOf<{
  stage: string;
}>();

// @ts-expect-error correlated preliminary events require a literal `toolName`, not optional
const _preliminaryMissingName: CorrelatedToolPreliminaryResultEvent<typeof progress> = {
  type: 'tool.preliminary_result',
  toolCallId: 'call_1',
  result: {
    stage: 'start',
  },
  timestamp: Date.now(),
};
void _preliminaryMissingName;

// @ts-expect-error correlated result events require a literal `toolName`, not optional
const _resultMissingName: CorrelatedToolResultEvent<typeof weather> = {
  type: 'tool.result',
  toolCallId: 'call_1',
  source: 'client',
  result: {
    tempC: 20,
  },
  timestamp: Date.now(),
};
void _resultMissingName;

// Correlated tuple-typed unions still discriminate on a required literal `toolName`.
expectTypeOf<CorrelatedToolEventUnion<Tools>['toolName']>().toEqualTypeOf<
  'weather' | 'progress_tool' | 'manual_tool' | 'hitl_tool'
>();
expectTypeOf<Stream['toolName' & keyof Stream]>().not.toEqualTypeOf<string | undefined>();
expectTypeOf<ToolStream['toolName' & keyof ToolStream]>().not.toEqualTypeOf<string | undefined>();
