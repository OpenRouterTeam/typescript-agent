import * as z4 from 'zod/v4';
import type { $ZodObject, $ZodShape } from 'zod/v4/core';
import type { PendingAsyncTool, Tool, ToolCheckConfig, TurnContext } from './tool-types.js';
import { isLongRunningTool, isUnifiedTool } from './tool-types.js';

/**
 * The default check-parameter schema for long-running tools that don't
 * declare their own `check.schema`.
 */
export const DefaultCheckParamsSchema = z4.object({
  view: z4
    .enum([
      'status',
      'logs',
      'transcript',
    ])
    .optional()
    .describe(
      "'status' (default): current state + last progress entry. 'logs': recent progress entries. 'transcript': full detail.",
    ),
  tail: z4
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('For view=logs: how many recent entries to return. Default 20.'),
});

export type DefaultCheckParams = z4.infer<typeof DefaultCheckParamsSchema>;

/** Resolve a tool's check config to `{ schema, execute }` with defaults. */
export function resolveCheckConfig(check: ToolCheckConfig | undefined): {
  schema: $ZodObject<$ZodShape>;
  execute:
    | ((params: Record<string, unknown>, turnContext: TurnContext) => unknown | Promise<unknown>)
    | undefined;
} {
  if (check === undefined || check === true) {
    return {
      schema: DefaultCheckParamsSchema as unknown as $ZodObject<$ZodShape>,
      execute: undefined,
    };
  }
  return {
    schema: (check.schema ?? DefaultCheckParamsSchema) as unknown as $ZodObject<$ZodShape>,
    execute: check.execute,
  };
}

/**
 * Build the wire-level check schema for a long-running tool: the author's
 * (or default) check params plus a REQUIRED `taskId`. The engine
 * discriminates start-vs-check calls on the presence of a known `taskId`.
 */
export function buildCheckJsonSchema(
  tool: Tool,
  convertZod: (schema: $ZodObject<$ZodShape>) => Record<string, unknown>,
): Record<string, unknown> {
  const config = isUnifiedTool(tool) ? tool.function.check : undefined;
  const { schema } = resolveCheckConfig(config);
  const paramsSchema = convertZod(schema);
  const properties = {
    taskId: {
      type: 'string',
      description:
        'Task id of a previously-started call of this tool (from its pending output). Providing it checks on / interacts with that task instead of starting new work.',
    },
    ...((paramsSchema['properties'] as Record<string, unknown> | undefined) ?? {}),
  };
  return {
    type: 'object',
    properties,
    required: [
      'taskId',
    ],
    additionalProperties: false,
  };
}

/**
 * Wrap a long-running tool's start schema into `anyOf: [start, check]` so
 * one tool serves both purposes. Non-long-running tools pass through.
 */
export function buildToolParametersWithCheck(
  tool: Tool,
  startSchema: Record<string, unknown>,
  convertZod: (schema: $ZodObject<$ZodShape>) => Record<string, unknown>,
): Record<string, unknown> {
  if (!isLongRunningTool(tool)) {
    return startSchema;
  }
  return {
    anyOf: [
      startSchema,
      buildCheckJsonSchema(tool, convertZod),
    ],
  };
}

/** The SDK default check handler: status / logs / transcript views. */
export function defaultCheckResult(
  params: DefaultCheckParams,
  turnContext: TurnContext,
  options: {
    maxTranscriptChars: number;
  },
): unknown {
  const task = turnContext.task;
  if (!task) {
    return {
      error: 'unknown_task',
      hint: 'No task context available for this check call.',
    };
  }
  const view = params.view ?? 'status';
  const statusView = task.statusView();

  if (view === 'logs') {
    const tail = params.tail ?? 20;
    return {
      ...statusView,
      logs: task.tailLogs(tail),
    };
  }
  if (view === 'transcript') {
    return {
      ...statusView,
      transcript: task.transcript(options.maxTranscriptChars),
    };
  }
  return statusView;
}

/**
 * Answer a check call against a PERSISTED task (deferred / cross-process,
 * after a restart — no live registry entry). Only `status`-grade data
 * survives: identity, timing, `lastLog`.
 */
export function persistedTaskCheckResult(
  params: DefaultCheckParams,
  pending: PendingAsyncTool,
): unknown {
  const base = {
    taskId: pending.taskId,
    toolName: pending.name,
    mode: pending.mode,
    status: pending.status,
    startedAt: pending.startedAt,
    elapsedMs: Date.now() - pending.startedAt,
    ...(pending.lastLog !== undefined && {
      lastLog: pending.lastLog.text,
    }),
    ...(pending.pollAfterMs !== undefined && {
      pollAfterMs: pending.pollAfterMs,
    }),
    ...(pending.expiresAt !== undefined && {
      expiresAt: pending.expiresAt,
    }),
    ...(pending.orphaned === true && {
      orphaned: true,
      note: 'This task was detached; its result will not be delivered.',
    }),
  };
  const view = params.view ?? 'status';
  if (view === 'logs') {
    return {
      ...base,
      logs: pending.lastLog
        ? [
            {
              at: pending.lastLog.at,
              data: pending.lastLog.text,
            },
          ]
        : [],
      note: 'Full logs are not retained across processes.',
    };
  }
  if (view === 'transcript') {
    return {
      ...base,
      transcript: '',
      note:
        pending.mode === 'defer'
          ? 'No transcript available — this task is owned by an external system.'
          : 'No transcript available — the task ran in a previous process.',
    };
  }
  return base;
}
