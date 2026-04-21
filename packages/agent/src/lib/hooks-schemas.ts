import * as z4 from 'zod/v4';
import type { HookDefinition } from './hooks-types.js';

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

export const BUILT_IN_HOOKS: Record<string, HookDefinition> = {
  PreToolUse: {
    payload: PreToolUsePayloadSchema,
    result: PreToolUseResultSchema,
  },
  PostToolUse: {
    payload: PostToolUsePayloadSchema,
    result: VoidResultSchema,
  },
  PostToolUseFailure: {
    payload: PostToolUseFailurePayloadSchema,
    result: VoidResultSchema,
  },
  UserPromptSubmit: {
    payload: UserPromptSubmitPayloadSchema,
    result: UserPromptSubmitResultSchema,
  },
  Stop: {
    payload: StopPayloadSchema,
    result: StopResultSchema,
  },
  PermissionRequest: {
    payload: PermissionRequestPayloadSchema,
    result: PermissionRequestResultSchema,
  },
  SessionStart: {
    payload: SessionStartPayloadSchema,
    result: VoidResultSchema,
  },
  SessionEnd: {
    payload: SessionEndPayloadSchema,
    result: VoidResultSchema,
  },
};

export const BUILT_IN_HOOK_NAMES = new Set(Object.keys(BUILT_IN_HOOKS));

/**
 * Set of built-in hook names whose result schema is `z4.void()`. These hooks
 * have no meaningful result object, so the emit pipeline skips result
 * validation for them (allowing handlers to return arbitrary values that are
 * then collected as opaque results without complaint).
 */
export const VOID_RESULT_HOOKS = new Set<string>([
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
]);

//#endregion
