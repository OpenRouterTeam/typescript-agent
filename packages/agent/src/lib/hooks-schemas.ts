import * as z4 from 'zod/v4';
import type { $ZodType } from 'zod/v4/core';

//#region Hook Names & Definition Shape
//
// HookName, HookDefinition, and HookRegistry live HERE (with the schemas
// they key/describe) rather than in hooks-types.ts, so the dependency
// between the two modules stays one-directional (hooks-types -> hooks-
// schemas) and no import cycle exists. hooks-types re-exports them, so the
// public import surface is unchanged.

export const HookName = {
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  UserPromptSubmit: 'UserPromptSubmit',
  Stop: 'Stop',
  PermissionRequest: 'PermissionRequest',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  PostModelCall: 'PostModelCall',
  DoomLoopDetected: 'DoomLoopDetected',
} as const;

export type HookName = (typeof HookName)[keyof typeof HookName];

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

//#endregion

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

const ModelCallUsageSchema = z4.object({
  inputTokens: z4.number(),
  outputTokens: z4.number(),
  totalTokens: z4.number(),
  cachedTokens: z4.number(),
  reasoningTokens: z4.number(),
  cost: z4.number().optional(),
});

export type ModelCallUsage = Readonly<z4.infer<typeof ModelCallUsageSchema>>;

export type SessionStartPayload = Readonly<z4.infer<typeof SessionStartPayloadSchema>>;

const SessionUsageTotalsSchema = ModelCallUsageSchema.extend({
  modelCalls: z4.number(),
});
export const SessionEndPayloadSchema = z4.object({
  reason: z4.enum([
    'user',
    'error',
    'max_turns',
    'complete',
    'doom_loop',
  ]),
  totalUsage: SessionUsageTotalsSchema.optional(),
});

export const PostModelCallPayloadSchema = z4.object({
  sessionId: z4.string(),
  responseId: z4.string(),
  model: z4.string(),
  durationMs: z4.number(),
  turnType: z4.enum([
    'initial',
    'resume',
    'tool_round',
    'final',
    'retry',
  ]),
  turnNumber: z4.number(),
  usage: ModelCallUsageSchema.optional(),
});

export const DoomLoopDetectedPayloadSchema = z4.object({
  /** Which detector fired: consecutive identical tool calls, or repeated text. */
  detector: z4.enum([
    'tool-fingerprint',
    'text-repetition',
    'text-streak',
  ]),
  /** The ladder action the engine resolved for this streak. */
  action: z4.enum([
    'observe',
    'steer',
    'block',
    'stop',
  ]),
  /** Consecutive repetition count that crossed a ladder rung. */
  streak: z4.number(),
  /** Deterministic fingerprint of the repeated unit (call identity or text). */
  fingerprint: z4.string(),
  /** Present for tool-fingerprint verdicts. */
  toolName: z4.string().optional(),
  /** Present for tool-fingerprint verdicts: the repeated call's arguments. */
  toolInput: z4.record(z4.string(), z4.unknown()).optional(),
  /** Explanation used for block outputs / steer messages. */
  message: z4.string(),
});

export type DoomLoopDetectedPayload = Readonly<z4.infer<typeof DoomLoopDetectedPayloadSchema>>;

export type SessionEndPayload = Readonly<z4.infer<typeof SessionEndPayloadSchema>>;
export type PostModelCallPayload = Readonly<z4.infer<typeof PostModelCallPayloadSchema>>;
export type SessionUsageTotals = Readonly<z4.infer<typeof SessionUsageTotalsSchema>>;

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

export const DoomLoopDetectedResultSchema = z4.object({
  /**
   * Override the engine's resolved action for THIS event — de-escalate
   * (`'observe'` on a would-be block) or escalate (`'stop'` immediately).
   * When several handlers override, the last override wins. Text verdicts
   * cannot be blocked (the tokens are already emitted); an `overrideAction:
   * 'block'` on a text verdict downgrades to `'observe'`.
   */
  overrideAction: z4
    .enum([
      'observe',
      'steer',
      'block',
      'stop',
    ])
    .optional(),
});

export type DoomLoopDetectedResult = Readonly<z4.infer<typeof DoomLoopDetectedResultSchema>>;

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
  PostModelCall: {
    payload: PostModelCallPayloadSchema,
    result: VoidResultSchema,
  },
  [HookName.DoomLoopDetected]: {
    payload: DoomLoopDetectedPayloadSchema,
    result: DoomLoopDetectedResultSchema,
  },
};

export const BUILT_IN_HOOK_NAMES = new Set(Object.keys(BUILT_IN_HOOKS));
// NOTE: void-result hooks are detected by schema shape (`isVoidSchema` in
// hooks-manager.ts), not by a name list, so custom hooks with `result:
// z.void()` behave identically to the built-in void hooks.

//#endregion
