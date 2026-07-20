/**
 * Type-level tests for contextSchema → TContext / ToolContextMap inference (PR-3).
 *
 * Pins the exact consumer shape that previously required `as any`
 * (see agents/pr-review FRICTION.md #2):
 * - execute's `ctx.local` is inferred from `contextSchema` (no cast)
 * - `callModel`'s `context` map accepts the correct per-tool shape
 * - wrong shapes are rejected
 * - tools without `contextSchema` keep `Record<string, never>` map slots
 * - concrete tools remain assignable to the wide `Tool` union
 *
 * Assertions are assignability-based (the actual consumer experience)
 * rather than strict type equality, which is brittle against incidental
 * modifier differences in the mapped types.
 */

import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import { tool } from '../../src/lib/tool.js';
import type { Tool, ToolContextMap } from '../../src/lib/tool-types.js';

// --- (a) ctx.local inferred from contextSchema --------------------------------

const readFileTool = tool({
  name: 'read_file',
  inputSchema: z.object({
    path: z.string(),
  }),
  contextSchema: z.object({
    token: z.string(),
    owner: z.string(),
  }),
  execute: async ({ path }, ctx) => {
    // Acceptance: no cast required — local is typed from contextSchema.
    const token: string = ctx!.local.token;
    const owner: string = ctx!.local.owner;
    expectTypeOf(ctx!.local.token).toEqualTypeOf<string>();
    expectTypeOf(ctx!.local.owner).toEqualTypeOf<string>();
    return {
      ok: true as const,
      path,
      token,
      owner,
    };
  },
});

// --- (b) concrete tools stay assignable to the wide Tool union ----------------

const asWide: Tool = readFileTool;
const asWideArray: readonly Tool[] = [
  readFileTool,
] as const;
void asWide;
void asWideArray;

// --- (c) context map accepts the correct shape, rejects wrong ones ------------

type ReadFileMap = ToolContextMap<
  readonly [
    typeof readFileTool,
  ]
>;

const goodContext: ReadFileMap = {
  read_file: {
    token: 'x',
    owner: 'y',
  },
};
void goodContext;

// wrong shape must be rejected
declare const wrongShape: {
  read_file: {
    wrong: number;
  };
};
// @ts-expect-error 'wrong' is not part of the read_file context shape
const badContext: ReadFileMap = wrongShape;
void badContext;

// missing required key must be rejected
declare const missingKey: {
  read_file: {
    token: string;
  };
};
// @ts-expect-error 'owner' is required in the read_file context shape
const missingKeyContext: ReadFileMap = missingKey;
void missingKeyContext;

// --- (d) tool without contextSchema keeps Record<string, never> ---------------

const plainTool = tool({
  name: 'plain',
  inputSchema: z.object({
    q: z.string(),
  }),
  execute: async ({ q }) => ({
    q,
  }),
});

type PlainMap = ToolContextMap<
  readonly [
    typeof plainTool,
  ]
>;
const emptyOk: PlainMap = {
  plain: {},
};
void emptyOk;

declare const plainWithValues: {
  plain: {
    anything: number;
  };
};
// @ts-expect-error context values are not allowed for tools without a contextSchema
const plainRejects: PlainMap = plainWithValues;
void plainRejects;

// --- (e) mixed array infers per-slot -------------------------------------------

type MixedMap = ToolContextMap<
  readonly [
    typeof readFileTool,
    typeof plainTool,
  ]
>;

const mixedGood: MixedMap = {
  read_file: {
    token: 'x',
    owner: 'y',
  },
  plain: {},
};
void mixedGood;

declare const mixedWrong: {
  read_file: {
    token: string;
    owner: string;
  };
  plain: {
    nope: boolean;
  };
};
// @ts-expect-error per-slot shapes are enforced independently
const mixedBad: MixedMap = mixedWrong;
void mixedBad;

// --- (f) manual tools (execute: false) carry context types too ----------------

const manualTool = tool({
  name: 'approve_thing',
  inputSchema: z.object({
    id: z.string(),
  }),
  contextSchema: z.object({
    requester: z.string(),
  }),
  execute: false,
});

const manualAsWide: Tool = manualTool;
void manualAsWide;

type ManualMap = ToolContextMap<
  readonly [
    typeof manualTool,
  ]
>;
const manualGood: ManualMap = {
  approve_thing: {
    requester: 'me',
  },
};
void manualGood;
