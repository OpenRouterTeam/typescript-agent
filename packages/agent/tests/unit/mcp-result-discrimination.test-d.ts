/**
 * Type-level tests proving that mixing an MCP-branded tool (whose output is
 * `unknown`) with fully-typed client tools does NOT collapse the result types
 * to `unknown`. The `source` discriminant isolates the MCP branch so typed
 * tools keep their precise, schema-derived results.
 *
 * Assertions go through `ToolExecutionResultUnion`, NOT `InferToolOutput`: the
 * `tool()` factory widens a tool value's standalone output type, but
 * `ToolExecutionResult<T>['result']` infers precisely from
 * `ToolWithExecute<…, infer O>`. Using real factory values is the point — it
 * mirrors what callers (and `wrapMcpTool`) actually build.
 *
 * Note on `toolName`: the `tool()` factory also widens the `name` literal to
 * `string` (the same widening documented in has-approval-tools.test-d.ts), so
 * discrimination is by `source`, not by `toolName`. That is exactly why the
 * discriminant added to the result types is `source`.
 */

import { expectTypeOf } from 'vitest';
import * as z from 'zod';
import { markMcp, tool } from '../../src/lib/tool.js';
import type { ToolExecutionResult, ToolExecutionResultUnion } from '../../src/lib/tool-types.js';

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

const db = tool({
  name: 'db',
  inputSchema: z.object({
    q: z.string(),
  }),
  outputSchema: z.object({
    rows: z.number(),
  }),
  execute: async () => ({
    rows: 3,
  }),
});

// An MCP-wrapped tool: unknown output schema, then marked with the MCP brand —
// exactly what `wrapMcpTool` produces.
const mcpTool = markMcp(
  tool({
    name: 'mcp_search',
    inputSchema: z.object({}).catchall(z.unknown()),
    outputSchema: z.unknown(),
    execute: async () => ({}) as unknown,
  }),
);

type Weather = typeof weather;
type Db = typeof db;
type Mcp = typeof mcpTool;

// --- Baseline: a typed tool's result is precise, source is 'client' ----------
expectTypeOf<ToolExecutionResult<Weather>['result']>().toEqualTypeOf<{
  tempC: number;
}>();
expectTypeOf<ToolExecutionResult<Weather>['source']>().toEqualTypeOf<'client'>();

// --- The MCP-branded tool is isolated ----------------------------------------
expectTypeOf<ToolExecutionResult<Mcp>['source']>().toEqualTypeOf<'mcp'>();
expectTypeOf<ToolExecutionResult<Mcp>['result']>().toEqualTypeOf<unknown>();

// --- Mixed tuple: narrowing by `source` keeps client results precise ---------
type MixedResults = ToolExecutionResultUnion<
  readonly [
    Weather,
    Db,
    Mcp,
  ]
>;

// The client branch is the union of the typed tools' precise results — NOT
// `unknown`. If the MCP `unknown` had leaked across the union this would be
// `unknown` (or the Extract would be `never`).
type ClientResults = Extract<
  MixedResults,
  {
    source: 'client';
  }
>;
expectTypeOf<ClientResults['result']>().toEqualTypeOf<
  | {
      tempC: number;
    }
  | {
      rows: number;
    }
>();

// The MCP branch stays opaque, on its own discriminated arm.
type McpResults = Extract<
  MixedResults,
  {
    source: 'mcp';
  }
>;
expectTypeOf<McpResults['result']>().toEqualTypeOf<unknown>();

// Sanity: the client branch is actually inhabited (Extract did not collapse it).
expectTypeOf<ClientResults>().not.toEqualTypeOf<never>();
