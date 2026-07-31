import * as z4 from 'zod/v4';
import type { $ZodObject, $ZodShape } from 'zod/v4/core';
import type {
  APITool,
  PendingAsyncTool,
  Tool,
  ToolCheckConfig,
  TurnContext,
} from './tool-types.js';
import { isLongRunningTool, ToolType } from './tool-types.js';

/**
 * Reserved name of the single, universal task-interaction tool.
 *
 * Per team decision (2026-07-31): per-tool check schemas bloat every tool's
 * wire definition for a shared set of functionality and scale quadratically
 * with the tool count. Instead, ONE static tool handles every running task —
 * addressed by `taskId` — while the *implementations* stay tool-resident
 * (each tool's `check` config). Best of both: no per-tool context growth,
 * tool-specific behavior preserved.
 */
export const TASK_TOOL_NAME = 'task' as const;

/** Actions the universal task tool supports. */
export const TaskToolInputSchema = z4.object({
  taskId: z4.string().describe('Task id from a pending tool output.'),
  action: z4
    .enum([
      'check',
      'steer',
      'result',
      'cancel',
    ])
    .optional()
    .describe(
      "'check' (default): progress views. 'steer': send guidance to the running task. 'result': the final result if settled, else current status. 'cancel': stop the task.",
    ),
  view: z4
    .enum([
      'status',
      'logs',
      'transcript',
    ])
    .optional()
    .describe(
      "For action=check: 'status' (default) is a one-line state; 'logs' returns recent progress entries; 'transcript' returns full detail.",
    ),
  tail: z4
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('For view=logs: how many recent entries. Default 20.'),
  message: z4.string().optional().describe('For action=steer: the guidance to send.'),
  reason: z4.string().optional().describe('For action=cancel: why.'),
  params: z4
    .record(z4.string(), z4.unknown())
    .optional()
    .describe("Extra parameters for the tool's custom check handler, when it declares one."),
});

export type TaskToolInput = z4.infer<typeof TaskToolInputSchema>;

/**
 * The wire definition for the universal task tool. Static — identical
 * regardless of how many long-running tools are registered.
 */
export function buildTaskToolApiDefinition(
  convertZod: (schema: never) => Record<string, unknown>,
): APITool {
  return {
    type: 'function',
    name: TASK_TOOL_NAME,
    description:
      'Interact with a long-running task started by another tool: check progress (status, recent logs, or the full transcript), steer it with a message, fetch its result, or cancel it. Task ids come from pending tool outputs.',
    strict: null,
    parameters: convertZod(TaskToolInputSchema as never),
  };
}

/**
 * True when the tool list warrants registering the task tool: at least one
 * long-running-capable tool, and no user tool already claiming the name
 * (defense for dynamically-built tool lists that bypass `tool()`).
 */
export function needsTaskTool(tools: readonly Tool[]): boolean {
  const collision = tools.some(
    (t) =>
      'function' in t &&
      (
        t as {
          function: {
            name?: string;
          };
        }
      ).function?.name === TASK_TOOL_NAME,
  );
  if (collision) {
    console.warn(
      `[AsyncTools] a user tool is named "${TASK_TOOL_NAME}" — the built-in task tool is disabled; models cannot check on long-running tasks.`,
    );
    return false;
  }
  return tools.some((t) => isLongRunningTool(t));
}

/**
 * Minimal Tool stub for the engine's internal bookkeeping around task-tool
 * answers (result events, output shaping). Never executed as a user tool.
 */
export function buildTaskToolStub(): Tool {
  return {
    type: ToolType.Function,
    function: {
      name: TASK_TOOL_NAME,
      inputSchema: TaskToolInputSchema as unknown as $ZodObject<$ZodShape>,
      execute: false as never,
    } as never,
  };
}

/** Resolve a tool's check config to `{ schema, execute }` with defaults. */
export function resolveCheckConfig(check: ToolCheckConfig | undefined): {
  schema: $ZodObject<$ZodShape> | undefined;
  execute:
    | ((params: Record<string, unknown>, turnContext: TurnContext) => unknown | Promise<unknown>)
    | undefined;
} {
  if (check === undefined || check === true) {
    return {
      schema: undefined,
      execute: undefined,
    };
  }
  return {
    schema: check.schema,
    execute: check.execute,
  };
}

/** The SDK default check handler: status / logs / transcript views. */
export function defaultCheckResult(
  input: Pick<TaskToolInput, 'view' | 'tail'>,
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
  const view = input.view ?? 'status';
  const statusView = task.statusView();

  if (view === 'logs') {
    const tail = input.tail ?? 20;
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
 * Answer a task-tool call against a PERSISTED task (deferred /
 * cross-process, after a restart — no live registry entry). Only
 * `status`-grade data survives: identity, timing, `lastLog`.
 */
export function persistedTaskCheckResult(
  input: Pick<TaskToolInput, 'view'>,
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
  const view = input.view ?? 'status';
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
