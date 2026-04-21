/**
 * Regression coverage for two consumer-facing type gaps reported against
 * v0.4.0 that previously required `as any`:
 *
 * 1. Mixing `tool()` + `serverTool()` results in a single array typed as
 *    `Array<ClientTool | ServerTool>` must assign to `callModel`'s `tools`
 *    parameter without a cast. `serverTool<T>()` returns the narrow
 *    `ServerTool<T>` (a `ServerToolBase` intersection), which must flow
 *    into the bare `ServerTool` — bare `ServerTool` collapses to
 *    `ServerToolBase` via its `never` default.
 *
 * 2. `fromChatMessages()` returns the SDK's `InputsUnion`, which must be
 *    directly assignable to `callModel`'s `request.input` without a cast.
 *    Previously the input was typed as `Item[] | string`, which is a
 *    narrower union that `InputsUnion` does not extend.
 */

import type * as models from '@openrouter/sdk/models';
import { expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import type { CallModelInput } from '../../src/lib/async-params.js';
import { fromChatMessages } from '../../src/lib/chat-compat.js';
import { serverTool, tool } from '../../src/lib/tool.js';
import type { ClientTool, ServerTool, ServerToolBase, Tool } from '../../src/lib/tool-types.js';

// --- Issue 1: mixed arrays assign without `as any` --------------------------

// Specific narrow factory return types must flow to the bare `ServerTool`
// form (which collapses to `ServerToolBase`) via intersection subtyping.
expectTypeOf<ServerTool<'openrouter:datetime'>>().toExtend<ServerTool>();
expectTypeOf<ServerTool<'openrouter:datetime'>>().toExtend<ServerToolBase>();
expectTypeOf<ServerTool<'openrouter:datetime'>>().toExtend<Tool>();

// ServerTool (bare, no generic) is the structural base — it should accept
// any narrow variant assigned to it.
const _dt: ServerTool = serverTool({
  type: 'openrouter:datetime',
});
const _ws: ServerTool = serverTool({
  type: 'openrouter:web_search',
});
void _dt;
void _ws;

// Array<ClientTool | ServerTool> accepts a mix without cast.
const _mixed: Array<ClientTool | ServerTool> = [
  tool({
    name: 'save_note',
    inputSchema: z.object({
      title: z.string(),
    }),
    execute: async () => ({
      ok: true,
    }),
  }),
  serverTool({
    type: 'openrouter:datetime',
  }),
  serverTool({
    type: 'openrouter:web_search',
  }),
];
void _mixed;

// Tool[] accepts the same mix.
const _asTool: Tool[] = [
  tool({
    name: 'save_note',
    inputSchema: z.object({
      title: z.string(),
    }),
    execute: async () => ({
      ok: true,
    }),
  }),
  serverTool({
    type: 'openrouter:datetime',
  }),
];
void _asTool;

// --- Issue 2: fromChatMessages() output is assignable to input -------------

// A `CallModelInput`'s `input` field accepts `InputsUnion` directly. We use
// `Extract` instead of `toExtend` because `input` is a field-or-fn union; we
// just need the plain data variant to accept `InputsUnion`.
type _InputField = CallModelInput['input'];
expectTypeOf<models.InputsUnion>().toExtend<_InputField>();

// And the concrete return of `fromChatMessages()` must be assignable.
const _converted = fromChatMessages([
  {
    role: 'user',
    content: 'hi',
  },
]);
const _asInput: _InputField = _converted;
void _asInput;
