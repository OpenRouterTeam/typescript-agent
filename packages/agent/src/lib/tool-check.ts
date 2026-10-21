import * as z4 from 'zod/v4';
import type { ObjectSchema, Schema } from './schema.js';
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

/** Memoized Zod→JSON-Schema conversion — the input schema is static. */
let taskToolParameters: Record<string, unknown> | undefined;

/**
 * The wire definition for the universal task tool. Static — identical
 * regardless of how many long-running tools are registered, so the schema
 * conversion runs once per process (memoized on first call).
 */
export function buildTaskToolApiDefinition(
  convertZod: (schema: Schema) => Record<string, unknown>,
): APITool {
  taskToolParameters ??= convertZod(TaskToolInputSchema);
  return {
    type: 'function',
    name: TASK_TOOL_NAME,
    description:
      'Interact with a long-running task started by another tool: check progress (status, recent logs, or the full transcript), steer it with a message, fetch its result, or cancel it. Task ids come from pending tool outputs.',
    strict: null,
    parameters: taskToolParameters,
  };
}

/**
 * True when a user tool already claims the reserved task-tool name
 * (defense for dynamically-built tool lists that bypass `tool()`).
 *
 * Shared by registration (`needsTaskTool`) and the engine's interception
 * guard (`taskToolActive`) so a collision disables BOTH: the built-in
 * definition is not registered and calls named "task" route to the user's
 * tool instead of being intercepted.
 */
export function hasTaskToolNameCollision(tools: readonly Tool[]): boolean {
  return tools.some(
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
}

/**
 * True when the tool list warrants registering the task tool: at least one
 * long-running-capable tool, and no user tool already claiming the name.
 */
export function needsTaskTool(tools: readonly Tool[]): boolean {
  if (hasTaskToolNameCollision(tools)) {
    // Only worth a warning when something was actually disabled: with no
    // long-running tool in the list, the built-in would not have been
    // registered anyway, and warning on every callModel() is pure noise.
    if (tools.some((t) => isLongRunningTool(t))) {
      console.warn(
        `[AsyncTools] a user tool is named "${TASK_TOOL_NAME}" — the built-in task tool is disabled; models cannot check on long-running tasks.`,
      );
    }
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
      inputSchema: TaskToolInputSchema as unknown as ObjectSchema,
      execute: false as never,
    } as never,
  };
}

/** Resolve a tool's check config to `{ schema, execute }` with defaults. */
export function resolveCheckConfig(check: ToolCheckConfig | undefined): {
  schema: ObjectSchema | undefined;
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
    // Same character budget as the transcript view: entries can be up to
    // maxEntryBytes each (4k default, tool-raisable), so 200 uncapped
    // entries could dump hundreds of KB into the model's context. Newest
    // entries win — drop from the OLDEST end when over budget.
    const entries = task.tailLogs(tail);
    let budget = options.maxTranscriptChars;
    let firstKept = entries.length;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const size =
        typeof entry?.data === 'string'
          ? entry.data.length
          : (JSON.stringify(entry?.data)?.length ?? 0);
      if (size > budget) {
        break;
      }
      budget -= size;
      firstKept = i;
    }
    let kept = entries.slice(firstKept);
    // Never answer with NOTHING when progress exists: if even the newest
    // entry alone exceeds the budget, return it truncated to the budget
    // rather than an empty list (a smaller tail could not help, and the
    // transcript view is capped by the same number).
    const newest = entries[entries.length - 1];
    if (kept.length === 0 && newest !== undefined) {
      const body =
        typeof newest.data === 'string'
          ? newest.data
          : (JSON.stringify(newest.data) ?? String(newest.data));
      kept = [
        {
          ...newest,
          data: `${body.slice(0, Math.max(0, options.maxTranscriptChars - 12))}…[truncated]`,
        },
      ];
    }
    return {
      ...statusView,
      logs: kept,
      ...(kept.length < entries.length && {
        note: `Truncated to the ${kept.length} most recent entries (character budget); use view: 'transcript' or a smaller tail for more.`,
      }),
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
  // View-specific explanations must not displace the orphaned warning —
  // "the result will never arrive" is the actionable part.
  const withNote = (viewNote: string) => ('note' in base ? `${base.note} ${viewNote}` : viewNote);
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
      note: withNote('Full logs are not retained across processes.'),
    };
  }
  if (view === 'transcript') {
    return {
      ...base,
      transcript: '',
      note: withNote(
        pending.mode === 'defer'
          ? 'No transcript available — this task is owned by an external system.'
          : 'No transcript available — the task ran in a previous process.',
      ),
    };
  }
  return base;
}
