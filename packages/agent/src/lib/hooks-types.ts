import * as z4 from 'zod/v4';
import type { $ZodType } from 'zod/v4/core';

//#region Hook Names

export const HookName = {
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  UserPromptSubmit: 'UserPromptSubmit',
  Stop: 'Stop',
  PermissionRequest: 'PermissionRequest',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
} as const;

export type HookName = (typeof HookName)[keyof typeof HookName];

//#endregion

//#region Core Types

/**
 * A hook definition is a pair of Zod schemas: one for the payload and one for the result.
 */
export interface HookDefinition {
  readonly payload: $ZodType;
  readonly result: $ZodType;
}

/**
 * A registry maps hook names to their definitions.
 */
export type HookRegistry = Record<string, HookDefinition>;

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
  /** Sync results from handlers that returned a hook-specific value. */
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

//#region Payload Types

export interface PreToolUsePayload {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly sessionId: string;
}

export interface PostToolUsePayload {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly toolOutput: unknown;
  readonly durationMs: number;
  readonly sessionId: string;
}

/**
 * Fired when a tool EXECUTION throws or returns an error.
 *
 * Deliberately NOT fired when a tool never ran: a PermissionRequest 'deny',
 * a user rejection on approval resume, or a PreToolUse block all synthesize
 * a rejected result without execution, so no failure event is emitted.
 * Observe those outcomes via the PermissionRequest / PreToolUse hooks
 * themselves.
 */
export interface PostToolUseFailurePayload {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly error: unknown;
  readonly sessionId: string;
}

export interface StopPayload {
  readonly reason: 'max_turns';
  readonly sessionId: string;
}

export interface PermissionRequestPayload {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly riskLevel: 'low' | 'medium' | 'high';
  readonly sessionId: string;
}

export interface UserPromptSubmitPayload {
  readonly prompt: string;
  readonly sessionId: string;
}

export interface SessionStartPayload {
  readonly sessionId: string;
  readonly config: Record<string, unknown> | undefined;
}

export interface SessionEndPayload {
  readonly sessionId: string;
  readonly reason: 'user' | 'error' | 'max_turns' | 'complete';
}

//#endregion

//#region Result Types

export interface PreToolUseResult {
  readonly mutatedInput?: Record<string, unknown>;
  readonly block?: boolean | string;
}

/**
 * Result of a Stop hook handler.
 *
 * `forceResume: true` alone does NOT change any state: the stop condition
 * (e.g. `stepCountIs`) will typically fire again immediately on the next
 * iteration, so a bare forceResume burns through the consecutive-override
 * cap (3) in rapid succession and then stops. To make resumption useful,
 * pair it with `appendPrompt` (which injects a user message, advancing the
 * conversation) or use a stop condition whose predicate can change between
 * iterations. This is by design: the engine caps rather than blocks bare
 * forceResume so a handler that coordinates external state (e.g. waiting on
 * an async gate that flips the stop condition) still has a few iterations
 * to do so.
 *
 * `appendPrompt` is honored independently of `forceResume` — a handler can
 * nudge the next turn without forcing a resume. Multiple handlers'
 * appendPrompts are concatenated with newlines.
 *
 * The override counter resets when a tool round produces outputs or a fresh
 * model response lands. Note that hook-blocked and rejected tool outputs
 * count as progress: the model receives the block/denial feedback and can
 * change course, which is observable forward motion even though no tool
 * body executed.
 */
export interface StopResult {
  readonly forceResume?: boolean;
  readonly appendPrompt?: string;
}

export interface PermissionRequestResult {
  readonly decision: 'allow' | 'deny' | 'ask_user';
  readonly reason?: string;
}

export interface UserPromptSubmitResult {
  readonly mutatedPrompt?: string;
  readonly reject?: boolean | string;
}

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
 * Mutation field mapping for payload piping, per hook name.
 *
 * The outer key is the hook name; the inner map is from result field name to
 * the payload field it replaces. Only the built-in hooks listed here support
 * mutation piping; custom hooks do not participate.
 */
export const MUTATION_FIELD_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({
    PreToolUse: Object.freeze({
      mutatedInput: 'toolInput',
    }),
    UserPromptSubmit: Object.freeze({
      mutatedPrompt: 'prompt',
    }),
  });

/**
 * Hook names that support short-circuit blocking.
 */
export const BLOCK_HOOKS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'UserPromptSubmit',
]);

/**
 * Result fields that trigger short-circuit.
 */
export const BLOCK_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  PreToolUse: 'block',
  UserPromptSubmit: 'reject',
});

//#endregion
