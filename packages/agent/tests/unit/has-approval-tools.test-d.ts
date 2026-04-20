/**
 * Type-level tests for `HasApprovalTools` and `ToolHasApproval` when
 * server tools are mixed into the tuple.
 *
 * Pre-existing limitation: the `tool()` factory widens the caller's
 * `requireApproval: true` literal to `boolean`, so `ToolHasApproval`
 * against factory-built tools falls through to `boolean`. These tests
 * therefore exercise the type machinery directly against hand-rolled
 * tool shapes, which is the only way to prove the recursive walk
 * still behaves correctly when server tools appear alongside client
 * tools. Server tools lack `function.requireApproval` entirely, so
 * `ToolHasApproval<ServerTool>` resolves to `boolean` (the "uncertain"
 * fallback) — importantly NOT to `true`, and the recursion does not
 * short-circuit on their presence.
 */

import { expectTypeOf } from 'vitest';
import type { $ZodObject, $ZodShape, $ZodType } from 'zod/v4/core';
import type {
  HasApprovalTools,
  ManualTool,
  ServerTool,
  ToolHasApproval,
  ToolWithExecute,
} from '../../src/lib/tool-types.js';

// Hand-rolled tool shapes that preserve the `requireApproval` literal
// through the type system (the `tool()` factory widens it away).
type ExplicitApproval = ToolWithExecute<$ZodObject<$ZodShape>, $ZodType<unknown>> & {
  function: {
    requireApproval: true;
  };
};
type ExplicitNoApproval = ToolWithExecute<$ZodObject<$ZodShape>, $ZodType<unknown>> & {
  function: {
    requireApproval: false;
  };
};
type UnknownApproval = ManualTool<$ZodObject<$ZodShape>, $ZodType<unknown>>;

// --- Server tool on its own: never requires approval -------------------------
expectTypeOf<ToolHasApproval<ServerTool<'openrouter:datetime'>>>().toEqualTypeOf<boolean>();
expectTypeOf<
  HasApprovalTools<
    readonly [
      ServerTool<'openrouter:datetime'>,
    ]
  >
>().toEqualTypeOf<false>();
expectTypeOf<
  HasApprovalTools<
    readonly [
      ServerTool<'openrouter:datetime'>,
      ServerTool<'web_search_2025_08_26'>,
    ]
  >
>().toEqualTypeOf<false>();

// --- Server tool + client tool with explicit approval: true ------------------
expectTypeOf<
  HasApprovalTools<
    readonly [
      ExplicitApproval,
      ServerTool<'openrouter:datetime'>,
    ]
  >
>().toEqualTypeOf<true>();
expectTypeOf<
  HasApprovalTools<
    readonly [
      ServerTool<'openrouter:datetime'>,
      ExplicitApproval,
    ]
  >
>().toEqualTypeOf<true>();
expectTypeOf<
  HasApprovalTools<
    readonly [
      ServerTool<'openrouter:datetime'>,
      ExplicitApproval,
      ServerTool<'web_search_2025_08_26'>,
    ]
  >
>().toEqualTypeOf<true>();

// --- Server tool + client tool with explicit non-approval: false -------------
// `ToolHasApproval<ExplicitNoApproval>` resolves to `false`, so the recursion
// moves on. With only server tools remaining the final answer is `false`.
expectTypeOf<
  HasApprovalTools<
    readonly [
      ExplicitNoApproval,
      ServerTool<'openrouter:datetime'>,
    ]
  >
>().toEqualTypeOf<false>();

// --- Server tool + client tool with uncertain approval: recursion continues --
// `ToolHasApproval<UnknownApproval>` is `boolean` (the fallback); recursion
// proceeds to the server tool, which also yields `boolean`, final answer `false`.
expectTypeOf<
  HasApprovalTools<
    readonly [
      UnknownApproval,
      ServerTool<'openrouter:datetime'>,
    ]
  >
>().toEqualTypeOf<false>();

// --- Sanity: empty tuple stays false -----------------------------------------
expectTypeOf<HasApprovalTools<readonly []>>().toEqualTypeOf<false>();
