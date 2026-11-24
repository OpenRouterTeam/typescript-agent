/**
 * Regression coverage for a consumer-facing type gap reported against
 * v0.4.0 that previously required `as any`: mixing `tool()` +
 * `serverTool()` results in a single array typed as
 * `Array<ClientTool | ServerTool>` (or annotating a `serverTool()` result
 * as bare `ServerTool`) must typecheck without a cast. `serverTool<T>()`
 * returns the narrow `ServerTool<T>` (a `ServerToolBase` intersection),
 * which must flow into the bare `ServerTool`, which collapses to
 * `ServerToolBase` via its `never` default.
 *
 * Also pins that `fromChatMessages()` output (typed precisely since #93)
 * stays assignable to `callModel`'s `input` without a cast.
 */

import { expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import type { CallModelInput } from '../../src/lib/async-params.js';
import { fromChatMessages } from '../../src/lib/chat-compat.js';
import { serverTool, tool } from '../../src/lib/tool.js';
import type { ClientTool, ServerTool, ServerToolBase, Tool } from '../../src/lib/tool-types.js';

// --- Mixed arrays assign without `as any` ---------------------------------

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

// The mixed array is accepted by `callModel`'s `tools` parameter.
expectTypeOf(_mixed).toExtend<NonNullable<CallModelInput['tools']>>();

// --- fromChatMessages() output is assignable to input ----------------------

type _InputField = CallModelInput['input'];
const _converted = fromChatMessages([
  {
    role: 'user',
    content: 'hi',
  },
]);
const _asInput: _InputField = _converted;
void _asInput;
