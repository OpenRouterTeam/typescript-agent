/**
 * Type-level narrowing fixtures for `StreamableOutputItem<TTools>`.
 *
 * No runtime assertions here — vitest's `expectTypeOf` reports mismatches
 * at typecheck time. The purpose is to pin down what `getItemsStream()`
 * yields given various tool configurations so a future regression (a
 * widening of the default, a broken KnownServerToolOutputs map entry, or
 * a drift in HasClientTool) surfaces as a type error, not a runtime bug.
 */

import type * as models from '@openrouter/sdk/models';
import { expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import type { StreamableOutputItem } from '../../src/lib/stream-transformers.js';
import { serverTool, tool } from '../../src/lib/tool.js';
import type { ServerToolNarrow, ServerToolType, Tool } from '../../src/lib/tool-types.js';

// --- Default (unconstrained TTools): widest possible union ------------------

type Default = StreamableOutputItem;
expectTypeOf<models.OutputMessage>().toExtend<Default>();
expectTypeOf<models.OutputReasoningItem>().toExtend<Default>();
expectTypeOf<models.OutputFunctionCallItem>().toExtend<Default>();
expectTypeOf<models.FunctionCallOutputItem>().toExtend<Default>();
expectTypeOf<models.OutputWebSearchCallItem>().toExtend<Default>();
expectTypeOf<models.OutputFileSearchCallItem>().toExtend<Default>();
expectTypeOf<models.OutputImageGenerationCallItem>().toExtend<Default>();
expectTypeOf<models.OutputServerToolItem>().toExtend<Default>();

// --- Explicit `readonly Tool[]`: same as default ----------------------------

type AnyTools = StreamableOutputItem<readonly Tool[]>;
expectTypeOf<models.OutputFunctionCallItem>().toExtend<AnyTools>();
expectTypeOf<models.OutputWebSearchCallItem>().toExtend<AnyTools>();

// --- Only a datetime server tool: narrow to message / reasoning / datetime --

type DatetimeOnly = StreamableOutputItem<
  readonly [
    ServerToolNarrow<'openrouter:datetime'>,
  ]
>;
expectTypeOf<models.OutputMessage>().toExtend<DatetimeOnly>();
expectTypeOf<models.OutputReasoningItem>().toExtend<DatetimeOnly>();
expectTypeOf<models.OutputServerToolItem>().toExtend<DatetimeOnly>();
// Function items must NOT be in this narrowed union.
expectTypeOf<models.OutputFunctionCallItem>().not.toExtend<DatetimeOnly>();
expectTypeOf<models.FunctionCallOutputItem>().not.toExtend<DatetimeOnly>();
// Web search specifically must NOT be in this narrowed union.
expectTypeOf<models.OutputWebSearchCallItem>().not.toExtend<DatetimeOnly>();

// --- One web_search + one client tool: function items appear, not image_gen -

const datetimeT = serverTool({
  type: 'openrouter:datetime',
});
const webSearchT = serverTool({
  type: 'web_search_2025_08_26',
  engine: 'exa',
});
const clientT = tool({
  name: 'greet',
  inputSchema: z.object({
    name: z.string(),
  }),
  execute: ({ name }) => `hi ${name}`,
});

type MixedTools = readonly [
  typeof webSearchT,
  typeof clientT,
];
type Mixed = StreamableOutputItem<MixedTools>;
expectTypeOf<models.OutputFunctionCallItem>().toExtend<Mixed>();
expectTypeOf<models.FunctionCallOutputItem>().toExtend<Mixed>();
expectTypeOf<models.OutputWebSearchCallItem>().toExtend<Mixed>();
// image_generation wasn't in tools — its output should not be in the union.
expectTypeOf<models.OutputImageGenerationCallItem>().not.toExtend<Mixed>();

// --- Unknown/new-in-SDK server tool types fall back to OutputServerToolItem -

type FutureToolOnly = StreamableOutputItem<
  readonly [
    ServerToolNarrow<ServerToolType>,
  ]
>;
// The widest `ServerToolType` includes every known literal; the inferred
// server-tool output union therefore includes OutputServerToolItem (the
// catch-all). Any future SDK server-tool type literal added to the
// `ServerToolConfig` union will flow through automatically.
expectTypeOf<models.OutputServerToolItem>().toExtend<FutureToolOnly>();

// Reference vars so nothing is unused.
void datetimeT;
void webSearchT;
void clientT;
