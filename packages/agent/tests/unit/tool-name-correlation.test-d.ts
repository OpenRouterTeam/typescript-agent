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
expectTypeOf(hitl.function.name).toEqualTypeOf<'hitl_tool'>();

expectTypeOf<InferToolName<typeof weather>>().toEqualTypeOf<'weather'>();
expectTypeOf<InferToolName<typeof progress>>().toEqualTypeOf<'progress_tool'>();
expectTypeOf<InferToolName<typeof manual>>().toEqualTypeOf<'manual_tool'>();
expectTypeOf<InferToolName<typeof hitl>>().toEqualTypeOf<'hitl_tool'>();

// Wide defaults still assign to Tool
expectTypeOf(weather).toExtend<Tool>();
expectTypeOf(progress).toExtend<Tool>();
expectTypeOf(manual).toExtend<Tool>();
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
