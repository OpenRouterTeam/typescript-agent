import * as z4 from 'zod/v4';
import type { HookDefinition } from './hooks-types.js';
import { HookName } from './hooks-types.js';

//#region Payload Schemas + Derived Types
//
// Each payload/result type is DERIVED from its Zod schema (single source of
// truth) so the static types can never drift from what the runtime actually
// validates -- the same discipline custom hooks get via `zodInfer` in
// hooks-manager.ts. `Readonly<...>` matches the immutability contract
// handlers are given (top-level, like the previous hand-written interfaces).
//
// Note: payloads deliberately do NOT carry `sessionId`. The session id is
// ambient context, not event data -- handlers read it from
// `context.sessionId` (LifecycleHookContext), which the manager populates
// via `setSessionId()`.

export const PreToolUsePayloadSchema = z4.object({
  toolName: z4.string(),
  toolInput: z4.record(z4.string(), z4.unknown()),
});

export type PreToolUsePayload = Readonly<z4.infer<typeof PreToolUsePayloadSchema>>;

export const PostToolUsePayloadSchema = z4.object({
  toolName: z4.string(),
  toolInput: z4.record(z4.string(), z4.unknown()),
  toolOutput: z4.unknown(),
  durationMs: z4.number(),
});

export type PostToolUsePayload = Readonly<z4.infer<typeof PostToolUsePayloadSchema>>;

export const PostToolUseFailurePayloadSchema = z4.object({
  toolName: z4.string(),
  toolInput: z4.record(z4.string(), z4.unknown()),
  error: z4.unknown(),
});

/**
 * Fired when a tool EXECUTION throws or returns an error.
 *
 * Deliberately NOT fired when a tool never ran: a PermissionRequest 'deny',
 * a user rejection on approval resume, or a PreToolUse block all synthesize
 * a rejected result without execution, so no failure event is emitted.
 * Observe those outcomes via the PermissionRequest / PreToolUse hooks
 * themselves.
 */
export type PostToolUseFailurePayload = Readonly<z4.infer<typeof PostToolUseFailurePayloadSchema>>;

export const StopPayloadSchema = z4.object({
  reason: z4.enum([
    'max_turns',
  ]),
});

export type StopPayload = Readonly<z4.infer<typeof StopPayloadSchema>>;

export const PermissionRequestPayloadSchema = z4.object({
  toolName: z4.string(),
  toolInput: z4.record(z4.string(), z4.unknown()),
  riskLevel: z4.enum([
    'low',
    'medium',
    'high',
  ]),
});

export type PermissionRequestPayload = Readonly<z4.infer<typeof PermissionRequestPayloadSchema>>;

export const UserPromptSubmitPayloadSchema = z4.object({
  prompt: z4.string(),
});

export type UserPromptSubmitPayload = Readonly<z4.infer<typeof UserPromptSubmitPayloadSchema>>;

export const SessionStartPayloadSchema = z4.object({
  config: z4.record(z4.string(), z4.unknown()).optional(),
});

export type SessionStartPayload = Readonly<z4.infer<typeof SessionStartPayloadSchema>>;

export const SessionEndPayloadSchema = z4.object({
  reason: z4.enum([
    'user',
    'error',
    'max_turns',
    'complete',
  ]),
});

export type SessionEndPayload = Readonly<z4.infer<typeof SessionEndPayloadSchema>>;

//#endregion

//#region Result Schemas + Derived Types

export const PreToolUseResultSchema = z4.object({
  mutatedInput: z4.record(z4.string(), z4.unknown()).optional(),
  block: z4
    .union([
      z4.boolean(),
      z4.string(),
    ])
    .optional(),
});

export type PreToolUseResult = Readonly<z4.infer<typeof PreToolUseResultSchema>>;

export const StopResultSchema = z4.object({
  forceResume: z4.boolean().optional(),
  appendPrompt: z4.string().optional(),
});

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
export type StopResult = Readonly<z4.infer<typeof StopResultSchema>>;

export const PermissionRequestResultSchema = z4.object({
  decision: z4.enum([
    'allow',
    'deny',
    'ask_user',
  ]),
  reason: z4.string().optional(),
});

export type PermissionRequestResult = Readonly<z4.infer<typeof PermissionRequestResultSchema>>;

export const UserPromptSubmitResultSchema = z4.object({
  mutatedPrompt: z4.string().optional(),
  reject: z4
    .union([
      z4.boolean(),
      z4.string(),
    ])
    .optional(),
});

export type UserPromptSubmitResult = Readonly<z4.infer<typeof UserPromptSubmitResultSchema>>;

const VoidResultSchema = z4.void();

//#endregion

//#region Built-in Hook Registry

// Keyed by the HookName enum object (not string literals) and typed as
// Record<HookName, ...> so adding a name to HookName without registering
// schemas here is a compile error.
export const BUILT_IN_HOOKS: Record<HookName, HookDefinition> = {
  [HookName.PreToolUse]: {
    payload: PreToolUsePayloadSchema,
    result: PreToolUseResultSchema,
  },
  [HookName.PostToolUse]: {
    payload: PostToolUsePayloadSchema,
    result: VoidResultSchema,
  },
  [HookName.PostToolUseFailure]: {
    payload: PostToolUseFailurePayloadSchema,
    result: VoidResultSchema,
  },
  [HookName.UserPromptSubmit]: {
    payload: UserPromptSubmitPayloadSchema,
    result: UserPromptSubmitResultSchema,
  },
  [HookName.Stop]: {
    payload: StopPayloadSchema,
    result: StopResultSchema,
  },
  [HookName.PermissionRequest]: {
    payload: PermissionRequestPayloadSchema,
    result: PermissionRequestResultSchema,
  },
  [HookName.SessionStart]: {
    payload: SessionStartPayloadSchema,
    result: VoidResultSchema,
  },
  [HookName.SessionEnd]: {
    payload: SessionEndPayloadSchema,
    result: VoidResultSchema,
  },
};

export const BUILT_IN_HOOK_NAMES = new Set(Object.keys(BUILT_IN_HOOKS));
// NOTE: void-result hooks are detected by schema shape (`isVoidSchema` in
// hooks-manager.ts), not by a name list, so custom hooks with `result:
// z.void()` behave identically to the built-in void hooks.

//#endregion
