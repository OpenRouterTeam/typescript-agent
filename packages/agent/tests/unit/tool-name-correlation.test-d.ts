/**
 * Type-level tests: `tool()` preserves literal names, and name-correlated
 * stream/result event unions narrow `result` from `event.toolName`.
 */

import { expectTypeOf } from 'vitest';
import * as z from 'zod';
import { tool } from '../../src/lib/tool.js';
import type {
  CorrelatedResponseStreamEvent,
  CorrelatedToolEventUnion,
  CorrelatedToolResultEvent,
  CorrelatedToolStreamEvent,
  CorrelatedToolStreamPreliminaryUnion,
  InferToolName,
  Tool,
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
declare const correlated: Events;
if (correlated.type === 'tool.result' && correlated.toolName === 'weather') {
  expectTypeOf(correlated.result).toEqualTypeOf<{
    tempC: number;
  }>();
  expectTypeOf(correlated.toolName).toEqualTypeOf<'weather'>();
}
if (correlated.type === 'tool.result' && correlated.toolName === 'progress_tool') {
  expectTypeOf(correlated.result).toEqualTypeOf<{
    done: boolean;
  }>();
}
if (correlated.type === 'tool.result' && correlated.toolName === 'hitl_tool') {
  expectTypeOf(correlated.result).toEqualTypeOf<{
    answer: string;
  }>();
}
if (correlated.type === 'tool.preliminary_result' && correlated.toolName === 'progress_tool') {
  expectTypeOf(correlated.result).toEqualTypeOf<{
    stage: string;
  }>();
}

// Stream method view uses the same correlated union for tool events
declare const streamEvent: Stream;
if (streamEvent.type === 'tool.result' && streamEvent.toolName === 'weather') {
  expectTypeOf(streamEvent.result).toEqualTypeOf<{
    tempC: number;
  }>();
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
expectTypeOf<CorrelatedToolResultEvent<typeof weather>['result']>().toEqualTypeOf<{
  tempC: number;
}>();

// --- Generic `readonly Tool[]` must not collapse to `never` -----------------
//
// A tool handle whose concrete tuple isn't known at the type level (e.g. an
// `@openrouter/mcp` tool array typed as `readonly Tool[]`) must still produce
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
expectTypeOf<Extract<WideEvents, { type: 'tool.result' }>>().not.toBeNever();
expectTypeOf<Extract<WideEvents, { type: 'tool.preliminary_result' }>>().not.toBeNever();
expectTypeOf<Extract<WideStream, { type: 'tool.result' }>>().not.toBeNever();
expectTypeOf<Extract<WideStream, { type: 'tool.preliminary_result' }>>().not.toBeNever();
expectTypeOf<Extract<WideToolStream, { type: 'preliminary_result' }>>().not.toBeNever();
expectTypeOf<Extract<WidePreliminaryUnion, { type: 'preliminary_result' }>>().not.toBeNever();

// `toolName`/`result` degrade gracefully to `string`/`unknown` for the wide
// case (no correlation possible without a concrete tuple).
declare const wideResult: Extract<WideEvents, { type: 'tool.result' }>;
expectTypeOf(wideResult.toolName).toEqualTypeOf<string>();
expectTypeOf(wideResult.result).toEqualTypeOf<unknown>();

// --- Concrete tuples still retain full name correlation ----------------------
//
// Passing a real tuple (not the wide `readonly Tool[]`) must keep narrowing
// `result` from a literal `toolName`, proving the wide-case fallback above
// doesn't regress tuple correlation.
declare const narrowResult: Extract<CorrelatedToolEventUnion<Tools>, { type: 'tool.result' }>;
if (narrowResult.toolName === 'weather') {
  expectTypeOf(narrowResult.result).toEqualTypeOf<{
    tempC: number;
  }>();
}
