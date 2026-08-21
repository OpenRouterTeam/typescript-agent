import * as z4 from 'zod/v4';
import type {
  DoomLoopDetectedPayload,
  DoomLoopDetectedResult,
  PermissionRequestPayload,
  PermissionRequestResult,
  PostModelCallPayload,
  PostToolUseFailurePayload,
  PostToolUsePayload,
  PreToolUsePayload,
  PreToolUseResult,
  SessionEndPayload,
  SessionStartPayload,
  StopPayload,
  StopResult,
  UserPromptSubmitPayload,
  UserPromptSubmitResult,
} from './hooks-schemas.js';
import { HookName } from './hooks-schemas.js';

//#region Hook Names & Core Registry Types (re-exported from hooks-schemas)

export type { HookDefinition, HookRegistry } from './hooks-schemas.js';
// HookName / HookDefinition / HookRegistry are declared in hooks-schemas.ts
// next to the schemas they describe; re-exported here so the public import
// surface is unchanged and the module dependency stays one-directional
// (hooks-types -> hooks-schemas, no cycle).
export { HookName } from './hooks-schemas.js';

//#endregion

/**
 * Context provided to every lifecycle-hook handler invocation.
 *
 * - `signal` is aborted if the manager's `abortInflight()` is called while the
 *   emit is still running. Handlers that kick off background work via
 *   {@link AsyncOutput} should observe the signal for cancellation.
 */
export interface LifecycleHookContext {
  readonly signal: AbortSignal;
  readonly hookName: string;
  /**
   * The current session id. This is the single source for session identity in
   * handlers -- payloads deliberately do not repeat it. The engine threads it
   * per emit (safe for a manager shared across concurrent runs); direct
   * `emit()` callers get the manager-level default from `setSessionId()`
   * unless they pass a per-emit override.
   */
  readonly sessionId: string;
}

/**
 * Returned by a handler to signal fire-and-forget mode.
 *
 * The chain proceeds immediately without waiting for completion. Any background
 * work the handler has kicked off should be attached as `work` so the manager
 * can track it for `drain()` and enforce the `asyncTimeout`.
 *
 * The handler is expected to construct and return this object synchronously (or
 * resolve to it quickly). The `work` promise is the detached work to track.
 */
export interface AsyncOutput {
  readonly async: true;
  /**
   * Background work the manager should track for `drain()` and time out after
   * `asyncTimeout` ms. Omit if there is no work to track.
   */
  readonly work?: Promise<unknown>;
  /** Milliseconds before the async handler is aborted. Default: 30000 */
  readonly asyncTimeout?: number;
}

const DEFAULT_ASYNC_TIMEOUT = 30_000;

export { DEFAULT_ASYNC_TIMEOUT };

/**
 * A handler may return a sync result, an async signal, or void.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: void here allows handlers to have no return
export type HookReturn<R> = R | AsyncOutput | void;

/**
 * A hook handler receives the validated payload and context.
 */
export type HookHandler<P, R> = (
  payload: P,
  context: LifecycleHookContext,
) => HookReturn<R> | Promise<HookReturn<R>>;

/**
 * Matcher for tool-scoped hooks. Filters handler invocation by tool name.
 */
export type ToolMatcher = string | RegExp | ((toolName: string) => boolean);

/**
 * An entry registered for a specific hook.
 */
export interface HookEntry<P, R> {
  readonly handler: HookHandler<P, R>;
  readonly matcher?: ToolMatcher;
  readonly filter?: (payload: P) => boolean;
}

/**
 * Result of emitting a hook through the handler chain.
 */
export interface EmitResult<R, P> {
  /**
   * Sync results from handlers that returned a hook-specific value.
   *
   * INVARIANT: every entry passed the hook's result schema (invalid results
   * are skipped or thrown per the error policy, never collected), so
   * consumers can rely on the static type `R` without re-narrowing. For
   * void-result hooks (no schema) entries are opaque and `R` is `undefined`
   * -- treat them accordingly.
   */
  readonly results: R[];
  /** Handles to detached async handler work. */
  readonly pending: Promise<void>[];
  /** The payload after all mutation piping has been applied. */
  readonly finalPayload: P;
  /** True if any handler triggered a block/reject short-circuit. */
  readonly blocked: boolean;
  /**
   * True if any handler's result actually piped a mutation into the payload
   * (e.g. PreToolUse `mutatedInput`, UserPromptSubmit `mutatedPrompt`).
   * Callers should use this rather than comparing `finalPayload` references,
   * since payload validation may clone the object even when no handler
   * mutated it.
   */
  readonly mutated: boolean;
}

//#endregion

//#region Options

export interface HooksManagerOptions {
  /**
   * If true, a throwing handler or a schema-validation failure stops the chain
   * and propagates the error. If false (default), the error is logged as a
   * warning and execution continues.
   */
  readonly throwOnHandlerError?: boolean;
}

//#endregion

//#region Payload & Result Types (derived from schemas)

// Payload and result types are DERIVED from the Zod schemas in
// hooks-schemas.ts (single source of truth; drift between the static type
// and the runtime validation is structurally impossible). Re-exported here
// so the public import surface is unchanged.
export type {
  DoomLoopDetectedPayload,
  DoomLoopDetectedResult,
  ModelCallUsage,
  PermissionRequestPayload,
  PermissionRequestResult,
  PostModelCallPayload,
  PostToolUseFailurePayload,
  PostToolUsePayload,
  PreToolUsePayload,
  PreToolUseResult,
  SessionEndPayload,
  SessionStartPayload,
  SessionUsageTotals,
  StopPayload,
  StopResult,
  UserPromptSubmitPayload,
  UserPromptSubmitResult,
} from './hooks-schemas.js';

//#endregion

//#region Built-in Hook Registry (type-level)

export interface BuiltInHookDefinitions {
  PreToolUse: {
    payload: PreToolUsePayload;
    result: PreToolUseResult;
  };
  PostToolUse: {
    payload: PostToolUsePayload;
    /** Observation-only hook: handlers have no meaningful result. */
    result: undefined;
  };
  PostToolUseFailure: {
    payload: PostToolUseFailurePayload;
    /** Observation-only hook: handlers have no meaningful result. */
    result: undefined;
  };
  UserPromptSubmit: {
    payload: UserPromptSubmitPayload;
    result: UserPromptSubmitResult;
  };
  Stop: {
    payload: StopPayload;
    result: StopResult;
  };
  PermissionRequest: {
    payload: PermissionRequestPayload;
    result: PermissionRequestResult;
  };
  SessionStart: {
    payload: SessionStartPayload;
    /** Observation-only hook: handlers have no meaningful result. */
    result: undefined;
  };
  SessionEnd: {
    payload: SessionEndPayload;
    /** Observation-only hook: handlers have no meaningful result. */
    result: undefined;
  };
  PostModelCall: {
    payload: PostModelCallPayload;
    /** Observation-only hook: handlers have no meaningful result. */
    result: undefined;
  };
  DoomLoopDetected: {
    payload: DoomLoopDetectedPayload;
    result: DoomLoopDetectedResult;
  };
}

//#endregion

//#region Inline Config

/**
 * Inline hook config passed directly to callModel.
 * Only supports built-in hooks. For custom hooks, use a HooksManager instance.
 */
export type InlineHookConfig = {
  [K in keyof BuiltInHookDefinitions]?: HookEntry<
    BuiltInHookDefinitions[K]['payload'],
    BuiltInHookDefinitions[K]['result']
  >[];
};

//#endregion

//#region Helper Types

/**
 * Strict schema for an {@link AsyncOutput} signal: `async` must be literally
 * `true`, `work`/`asyncTimeout` must match their declared types, and any
 * foreign key fails the parse. A handler that accidentally returns
 * `{ async: true, mutatedInput: {...} }` is therefore treated as a result
 * (so the mutation is not silently discarded), not as fire-and-forget.
 */
const AsyncOutputSchema = z4.strictObject({
  async: z4.literal(true),
  work: z4.instanceof(Promise).optional(),
  asyncTimeout: z4.number().optional(),
});

/**
 * Checks if a value is an AsyncOutput signal (see {@link AsyncOutputSchema}).
 */
export function isAsyncOutput(value: unknown): value is AsyncOutput {
  return AsyncOutputSchema.safeParse(value).success;
}

/**
 * Per-hook chain behavior: which result fields pipe mutations back into the
 * payload, and which result field short-circuits the chain.
 *
 * Keyed by {@link HookName} so a typo'd hook name is a compile error rather
 * than a silent no-behavior lookup. Hooks absent from this table are
 * observation-only: their handlers' results are collected but never alter
 * the payload or stop the chain. Custom hooks never participate.
 */
export interface HookBehavior {
  /** result field name -> payload field it replaces (mutation piping) */
  readonly mutations?: Readonly<Record<string, string>>;
  /** result field that short-circuits the chain when `true` or a non-empty string */
  readonly blockField?: string;
}

export const HOOK_BEHAVIOR: Readonly<Partial<Record<HookName, HookBehavior>>> = Object.freeze({
  [HookName.PreToolUse]: Object.freeze({
    mutations: Object.freeze({
      mutatedInput: 'toolInput',
    }),
    blockField: 'block',
  }),
  [HookName.UserPromptSubmit]: Object.freeze({
    mutations: Object.freeze({
      mutatedPrompt: 'prompt',
    }),
    blockField: 'reject',
  }),
});

//#endregion
