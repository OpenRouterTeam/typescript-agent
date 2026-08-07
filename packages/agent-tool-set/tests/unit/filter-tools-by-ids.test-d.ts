/**
 * Type-level tests: `FilterToolsByIds` keeps exact tuple filtering for
 * concrete tuples, and must not collapse to `readonly []` for a dynamic
 * (non-tuple) `readonly Tool[]`.
 */

import type { Tool } from '@openrouter/agent';
import { tool } from '@openrouter/agent';
import { expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import type { FilterToolsByIds } from '../../src/index.js';

const a = tool({
  name: 'a',
  inputSchema: z.object({}),
  execute: async () => ({
    a: true,
  }),
});

const b = tool({
  name: 'b',
  inputSchema: z.object({}),
  execute: async () => ({
    b: true,
  }),
});

const c = tool({
  name: 'c',
  inputSchema: z.object({}),
  execute: async () => ({
    c: true,
  }),
});

type Tools = readonly [
  typeof a,
  typeof b,
  typeof c,
];

// --- Concrete tuples: exact filtering, order preserved, types kept ---------

type NarrowedAC = FilterToolsByIds<Tools, 'a' | 'c'>;
expectTypeOf<NarrowedAC>().toEqualTypeOf<
  readonly [
    typeof a,
    typeof c,
  ]
>();

type NarrowedNone = FilterToolsByIds<Tools, never>;
expectTypeOf<NarrowedNone>().toEqualTypeOf<readonly []>();

type NarrowedAll = FilterToolsByIds<Tools, 'a' | 'b' | 'c'>;
expectTypeOf<NarrowedAll>().toEqualTypeOf<Tools>();

// Middle element dropped, order of survivors preserved (not sorted/reordered).
type NarrowedBOnly = FilterToolsByIds<Tools, 'b'>;
expectTypeOf<NarrowedBOnly>().toEqualTypeOf<
  readonly [
    typeof b,
  ]
>();

// --- Dynamic `readonly Tool[]` must not collapse to `readonly []` ----------
//
// A tool handle whose concrete tuple isn't known at the type level (e.g. an
// `@openrouter/mcp` tool array typed as `readonly Tool[]`) must still filter
// to a usable, non-empty array shape instead of always bottoming out at the
// tuple recursion's `readonly []` base case. `number extends T['length']`
// detects this dynamic-array case (true for general arrays, false for
// literal tuples) so filtering falls back to a distributive per-element
// check instead of head/tail recursion.
type WideFiltered = FilterToolsByIds<readonly Tool[], 'a' | 'c'>;

expectTypeOf<WideFiltered>().not.toEqualTypeOf<readonly []>();
expectTypeOf<WideFiltered>().toExtend<readonly Tool[]>();

declare const wideEl: WideFiltered[number];
expectTypeOf(wideEl).toExtend<Tool>();

// A concrete tool assignable to the active-id-filtered wide array still
// type-checks (proving the wide branch doesn't degrade to `never[]`).
const wideArray: WideFiltered = [
  a,
  c,
];
void wideArray;
