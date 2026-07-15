import * as z4 from 'zod/v4';
import type { HookDefinition } from './hooks-types.js';
import { HookName } from './hooks-types.js';

//#region Payload Schemas

export const PreToolUsePayloadSchema = z4.object({
  toolName: z4.string(),
  toolInput: z4.record(z4.string(), z4.unknown()),
  sessionId: z4.string(),
});

export const PostToolUsePayloadSchema = z4.object({
  toolName: z4.string(),
  toolInput: z4.record(z4.string(), z4.unknown()),
  toolOutput: z4.unknown(),
  durationMs: z4.number(),
  sessionId: z4.string(),
});

export const PostToolUseFailurePayloadSchema = z4.object({
  toolName: z4.string(),
  toolInput: z4.record(z4.string(), z4.unknown()),
  error: z4.unknown(),
  sessionId: z4.string(),
});

export const StopPayloadSchema = z4.object({
  reason: z4.enum([
    'max_turns',
  ]),
  sessionId: z4.string(),
});

export const PermissionRequestPayloadSchema = z4.object({
  toolName: z4.string(),
  toolInput: z4.record(z4.string(), z4.unknown()),
  riskLevel: z4.enum([
    'low',
    'medium',
    'high',
  ]),
  sessionId: z4.string(),
});

export const UserPromptSubmitPayloadSchema = z4.object({
  prompt: z4.string(),
  sessionId: z4.string(),
});

export const SessionStartPayloadSchema = z4.object({
  sessionId: z4.string(),
  config: z4.record(z4.string(), z4.unknown()).optional(),
});

export const SessionEndPayloadSchema = z4.object({
  sessionId: z4.string(),
  reason: z4.enum([
    'user',
    'error',
    'max_turns',
    'complete',
  ]),
});

//#endregion

//#region Result Schemas

export const PreToolUseResultSchema = z4.object({
  mutatedInput: z4.record(z4.string(), z4.unknown()).optional(),
  block: z4
    .union([
      z4.boolean(),
      z4.string(),
    ])
    .optional(),
});

export const StopResultSchema = z4.object({
  forceResume: z4.boolean().optional(),
  appendPrompt: z4.string().optional(),
});

export const PermissionRequestResultSchema = z4.object({
  decision: z4.enum([
    'allow',
    'deny',
    'ask_user',
  ]),
  reason: z4.string().optional(),
});

export const UserPromptSubmitResultSchema = z4.object({
  mutatedPrompt: z4.string().optional(),
  reject: z4
    .union([
      z4.boolean(),
      z4.string(),
    ])
    .optional(),
});

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
