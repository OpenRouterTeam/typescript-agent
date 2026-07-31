import type { OpenRouterCore } from '@openrouter/sdk/core';
import type { RequestOptions } from '@openrouter/sdk/lib/sdks';
import type * as models from '@openrouter/sdk/models';
import type { CallModelInput } from '../lib/async-params.js';
import { appendToMessages, updateState } from '../lib/conversation-state.js';
import type { ModelResult } from '../lib/model-result.js';
import { validateToolOutput } from '../lib/tool-executor.js';
import type { PendingAsyncTool, StateAccessor, Tool } from '../lib/tool-types.js';
import { isClientTool, isDeferredTool } from '../lib/tool-types.js';
import { callModel } from './call-model.js';

/**
 * Thrown by {@link resumeToolResults} (and the deferred tool `.resolve()` /
 * `.fail()` / `.cancel()` methods) when the target task was already settled —
 * the at-most-once guard against double resolution and replayed webhooks.
 * Opt out per call with `ifSettled: 'ignore'`.
 */
export class ToolTaskAlreadySettledError extends Error {
  readonly taskId: string;
  readonly callId: string;

  constructor(taskId: string, callId: string) {
    super(`Tool task "${taskId}" (call ${callId}) has already been settled`);
    this.name = 'ToolTaskAlreadySettledError';
    this.taskId = taskId;
    this.callId = callId;
  }
}

/**
 * One task resolution: identified by `taskId` (typical — it's what the
 * external system knows) or `callId`, carrying either a successful `output`
 * or an `error`. `status` refines error deliveries (default `'failed'`).
 */
export type ResumeToolResultEntry = (
  | {
      taskId: string;
      callId?: never;
    }
  | {
      callId: string;
      taskId?: never;
    }
) &
  (
    | {
        output: unknown;
        error?: never;
      }
    | {
        error: string;
        output?: never;
        status?: 'failed' | 'cancelled' | 'expired';
      }
  );

/**
 * Run configuration for continuing the conversation immediately after
 * recording the results. Any `CallModelInput` field except `state` / `input`
 * (the SDK supplies both — the resumed history already carries everything).
 */
export type ResumeRunConfig<TTools extends readonly Tool[]> = Omit<
  CallModelInput<TTools>,
  'state' | 'input' | 'approveToolCalls' | 'rejectToolCalls'
>;

/**
 * The `tool_task_result` envelope injected as a user-role message when an
 * async tool's result arrives. Never a second `function_call_output` — the
 * pending placeholder already paired the original `function_call` in
 * history, and providers reject duplicate outputs for one callId.
 */
export interface ToolTaskResultEnvelope {
  type: 'tool_task_result';
  tool: string;
  taskId: string;
  callId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'expired';
  result?: unknown;
  error?: string;
}

/** Build the user-role message carrying a task-result envelope. */
export function buildTaskResultMessage(envelope: ToolTaskResultEnvelope): models.BaseInputsUnion {
  return {
    role: 'user',
    content: JSON.stringify(envelope),
  } as models.BaseInputsUnion;
}

/**
 * Deliver results for pending async tool tasks (started by `tool.deferred`,
 * or background tasks orphaned across a run boundary) into a persisted
 * conversation — typically from a different process than the one that
 * started them (a webhook handler, a queue worker).
 *
 * This is the low-level, untyped entry point; prefer the typed `.resolve()`
 * / `.fail()` / `.cancel()` methods on the deferred tool itself, which
 * check `output` against the tool's `outputSchema` at compile time.
 *
 * Behavior:
 * 1. Loads the conversation via `state`, resolves each entry to a pending
 *    task (by `taskId` or `callId`).
 * 2. Enforces at-most-once settlement: an already-settled task throws
 *    {@link ToolTaskAlreadySettledError} (or is skipped with
 *    `ifSettled: 'ignore'`).
 * 3. Validates each `output` against the named tool's `outputSchema` when
 *    the tool is present in `tools` — an invalid payload throws before
 *    anything is persisted or dispatched.
 * 4. Appends a `tool_task_result` envelope (user-role message) per entry,
 *    marks the tasks settled, and persists the state. The conversation
 *    status becomes `'in_progress'` (or stays `'awaiting_async_tools'` when
 *    other tasks are still pending).
 * 5. With `run` config: continues the conversation immediately and returns
 *    the `ModelResult`. Without: returns `null` — the recorded results ride
 *    along on the next `callModel({ state })`.
 *
 * SECURITY: this call injects a value the model will treat as a tool
 * result. Authenticate the webhook/caller BEFORE invoking it — the SDK
 * cannot do that for you.
 */
export async function resumeToolResults<TTools extends readonly Tool[]>(
  client: OpenRouterCore,
  request: {
    state: StateAccessor<TTools>;
    /** Tools list — used to validate outputs against each tool's outputSchema. */
    tools?: TTools;
    results: ReadonlyArray<ResumeToolResultEntry>;
    /** Behavior when a task is already settled. Default 'throw'. */
    ifSettled?: 'throw' | 'ignore';
    /** Continue the conversation immediately with this run configuration. */
    run?: ResumeRunConfig<TTools>;
  },
  options?: RequestOptions,
): Promise<ModelResult<TTools> | null> {
  const state = await request.state.load();
  if (!state) {
    throw new Error('resumeToolResults: no conversation state found for the given StateAccessor');
  }

  const pending: PendingAsyncTool[] = state.pendingAsyncTools ?? [];
  const settledIds = new Set(state.settledAsyncCallIds ?? []);

  const envelopes: models.BaseInputsUnion[] = [];
  const settledNow: string[] = [];

  for (const entry of request.results) {
    const task = pending.find((t) =>
      'taskId' in entry && entry.taskId !== undefined
        ? t.taskId === entry.taskId
        : t.callId === entry.callId,
    );
    if (!task) {
      const key = entry.taskId ?? entry.callId;
      throw new Error(`resumeToolResults: no pending async tool task found for "${key}"`);
    }

    // Settled tasks stay in the table (with terminal status) precisely so a
    // replayed webhook resolves to THIS error instead of "not found".
    if (settledIds.has(task.callId) || task.status !== 'working') {
      if (request.ifSettled === 'ignore') {
        continue;
      }
      throw new ToolTaskAlreadySettledError(task.taskId, task.callId);
    }

    let envelope: ToolTaskResultEnvelope;
    if ('output' in entry && entry.error === undefined) {
      // Validate against the tool's outputSchema when the tool is available.
      const tool = request.tools?.find((t) => isClientTool(t) && t.function.name === task.name);
      let output = entry.output;
      if (tool && isDeferredTool(tool)) {
        output = validateToolOutput(tool.function.outputSchema, output);
      }
      envelope = {
        type: 'tool_task_result',
        tool: task.name,
        taskId: task.taskId,
        callId: task.callId,
        status: 'completed',
        result: output,
      };
    } else {
      envelope = {
        type: 'tool_task_result',
        tool: task.name,
        taskId: task.taskId,
        callId: task.callId,
        status: entry.status ?? 'failed',
        error: entry.error ?? 'Task failed',
      };
    }

    envelopes.push(buildTaskResultMessage(envelope));
    settledNow.push(task.callId);
    settledIds.add(task.callId);
  }

  if (envelopes.length === 0) {
    // Every entry was already settled and ignored — nothing to record.
    return null;
  }

  // Keep settled entries with a terminal status (rather than dropping them)
  // so a replayed resolution surfaces as ToolTaskAlreadySettledError.
  const nextPending = pending.map((t) =>
    settledNow.includes(t.callId)
      ? {
          ...t,
          status: 'completed' as const,
        }
      : t,
  );
  const updated = updateState(state, {
    messages: appendToMessages(state.messages, envelopes),
    settledAsyncCallIds: [
      ...(state.settledAsyncCallIds ?? []),
      ...settledNow,
    ],
    status: nextPending.some((t) => t.status === 'working')
      ? 'awaiting_async_tools'
      : 'in_progress',
    pendingAsyncTools: nextPending,
  });
  await request.state.save(updated);

  if (!request.run) {
    return null;
  }

  // Continue the conversation: the envelopes are already in persisted
  // history, so no fresh input is supplied.
  return callModel(
    client,
    {
      ...request.run,
      input: [],
      tools: request.run.tools ?? request.tools,
      state: request.state,
    } as CallModelInput<TTools> & {
      state: StateAccessor<TTools>;
    },
    options,
  );
}
