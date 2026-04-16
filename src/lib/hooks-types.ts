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
 * Context provided to every hook handler invocation.
 */
export interface HookContext {
  readonly signal: AbortSignal;
  readonly hookName: string;
  readonly sessionId: string;
}

/**
 * Returned by a handler to signal fire-and-forget mode.
 * The agent proceeds immediately without waiting for completion.
 */
export interface AsyncOutput {
  readonly async: true;
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
  context: HookContext,
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
}

//#endregion

//#region Options

export interface HooksManagerOptions {
  /**
   * If true, a throwing handler stops the chain and propagates the error.
   * If false (default), the error is logged as a warning and execution continues.
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

export interface PostToolUseFailurePayload {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly error: unknown;
  readonly sessionId: string;
}

export interface StopPayload {
  readonly reason: 'end_turn' | 'max_tokens' | 'stop_sequence';
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
    // biome-ignore lint/suspicious/noConfusingVoidType: void signals no meaningful result
    result: void;
  };
  PostToolUseFailure: {
    payload: PostToolUseFailurePayload;
    // biome-ignore lint/suspicious/noConfusingVoidType: void signals no meaningful result
    result: void;
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
    // biome-ignore lint/suspicious/noConfusingVoidType: void signals no meaningful result
    result: void;
  };
  SessionEnd: {
    payload: SessionEndPayload;
    // biome-ignore lint/suspicious/noConfusingVoidType: void signals no meaningful result
    result: void;
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
    BuiltInHookDefinitions[K]['result'] extends void ? void : BuiltInHookDefinitions[K]['result']
  >[];
};

//#endregion

//#region Helper Types

/**
 * Checks if a value is an AsyncOutput signal.
 */
export function isAsyncOutput(value: unknown): value is AsyncOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'async' in value &&
    (
      value as {
        async: unknown;
      }
    ).async === true
  );
}

/**
 * Mutation field mapping for payload piping.
 * Maps result field names to the payload field they replace.
 */
export const MUTATION_FIELD_MAP: Record<string, string> = {
  mutatedInput: 'toolInput',
  mutatedPrompt: 'prompt',
};

/**
 * Hook names that support short-circuit blocking.
 */
export const BLOCK_HOOKS = new Set<string>([
  'PreToolUse',
  'UserPromptSubmit',
]);

/**
 * Result fields that trigger short-circuit.
 */
export const BLOCK_FIELDS: Record<string, string> = {
  PreToolUse: 'block',
  UserPromptSubmit: 'reject',
};

//#endregion
