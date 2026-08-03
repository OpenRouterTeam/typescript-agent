import type { TaskLogEntry } from './tool-task.js';
import { ToolTask } from './tool-task.js';
import type { PendingAsyncTool } from './tool-types.js';

/**
 * Outcome of a settled async tool task, harvested by the engine at turn
 * boundaries (`flushAsyncToolDeliveries`) or during end-of-run drain.
 */
export interface SettledToolTask {
  callId: string;
  taskId: string;
  name: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  /** Present when status is 'completed'. */
  result?: unknown;
  /** Present otherwise. */
  error?: string;
}

/**
 * Per-run registry of async tool tasks (background, deferred, agent).
 *
 * Owns the in-process half of async tool support:
 * - background/agent tasks: tracks the in-flight work + ToolTask (logs,
 *   inbox, transcript source), queues settled outcomes for turn-boundary
 *   harvesting, supports drain / cancel / abort-all at run end;
 * - deferred tasks: tracks identity only (the work lives outside the
 *   process); the durable copy is mirrored to
 *   `ConversationState.pendingAsyncTools` by the engine.
 *
 * The registry knows nothing about the tool loop or concurrency pools — the
 * engine (`ModelResult`) owns semaphores and decides when to harvest and how
 * to deliver. Settlement is first-writer-wins: a task settles exactly once
 * (cancel racing completion is safe), and settled tasks drop their
 * controller references so they cannot retain the run graph.
 */
export class AsyncToolRegistry {
  private readonly tasks = new Map<string, ToolTask>();
  /** Settled outcomes not yet harvested by the engine. */
  private settledQueue: SettledToolTask[] = [];
  private taskCounter = 0;
  /** Resolvers waiting on "any task settled" (drain support). */
  private settleWaiters: Array<() => void> = [];

  /** Generate a task id for background/agent tasks (deferred bring their own). */
  generateTaskId(): string {
    this.taskCounter++;
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return `task_${crypto.randomUUID()}`;
    }
    return `task_${Date.now()}_${this.taskCounter}`;
  }

  /**
   * Track an already-started background/agent task. `work` is the tool's
   * in-flight run promise (output-validated). When `timeoutMs` is set the
   * task is raced against it, so a body that ignores its abort signal still
   * settles as `timed_out` instead of hanging the drain.
   */
  trackBackground(
    task: ToolTask,
    work: Promise<unknown>,
    options?: {
      timeoutMs?: number;
    },
  ): void {
    this.tasks.set(task.callId, task);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = options?.timeoutMs;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        const timeoutError = new Error(
          `Tool "${task.toolName}" task timed out after ${timeoutMs}ms`,
        );
        // Capture the controller BEFORE settling — settle() drops the
        // reference as a leak guard, and the running body must still be
        // told to stop (same pattern as cancelTask / abortAll).
        const controller = task.controller;
        this.settle(task.callId, {
          status: 'timed_out',
          error: timeoutError.message,
        });
        controller?.abort(timeoutError);
      }, timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    }

    work
      .then(
        (result) => {
          this.settle(task.callId, {
            status: 'completed',
            result,
          });
        },
        (error: unknown) => {
          const cancelled = task.controller?.signal.aborted ?? false;
          this.settle(task.callId, {
            status: cancelled ? 'cancelled' : 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        },
      )
      .finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
  }

  /** Track a deferred task (identity only; work lives outside the process). */
  trackDeferred(entry: {
    callId: string;
    taskId: string;
    name: string;
    expiresAt?: number;
    pollAfterMs?: number;
  }): ToolTask {
    const task = new ToolTask({
      taskId: entry.taskId,
      callId: entry.callId,
      toolName: entry.name,
      mode: 'defer',
      ...(entry.expiresAt !== undefined && {
        expiresAt: entry.expiresAt,
      }),
      ...(entry.pollAfterMs !== undefined && {
        pollAfterMs: entry.pollAfterMs,
      }),
    });
    this.tasks.set(entry.callId, task);
    return task;
  }

  private settle(
    callId: string,
    outcome:
      | {
          status: 'completed';
          result: unknown;
        }
      | {
          status: 'failed' | 'cancelled' | 'timed_out';
          error: string;
        },
  ): void {
    const task = this.tasks.get(callId);
    if (!task || task.status !== 'working') {
      return; // first writer wins
    }
    task.status =
      outcome.status === 'completed'
        ? 'completed'
        : outcome.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
    task.settledAt = Date.now();
    if (outcome.status === 'completed') {
      task.result = outcome.result;
    } else {
      task.error = outcome.error;
      task.appendLog(outcome.error, 'system');
    }
    // Leak guard: a settled task must not retain the run graph.
    task.controller = undefined;
    this.settledQueue.push({
      callId,
      taskId: task.taskId,
      name: task.toolName,
      ...outcome,
    });
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  /** Harvest (and clear) settled outcomes queued since the last call. */
  takeSettled(): SettledToolTask[] {
    const settled = this.settledQueue;
    this.settledQueue = [];
    return settled;
  }

  /** True when any background/agent task is still in flight. */
  hasInFlight(): boolean {
    for (const task of this.tasks.values()) {
      if (task.mode !== 'defer' && task.status === 'working') {
        return true;
      }
    }
    return false;
  }

  /** True when any settled outcome awaits harvesting. */
  hasUnharvestedSettled(): boolean {
    return this.settledQueue.length > 0;
  }

  /** True when any task (any mode) has been tracked this run. */
  hasTasks(): boolean {
    return this.tasks.size > 0;
  }

  /** Find the live task for a task id. */
  getTask(taskId: string): ToolTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.taskId === taskId) {
        return task;
      }
    }
    return undefined;
  }

  /** Find the live task for a call id. */
  findByCallId(callId: string): ToolTask | undefined {
    return this.tasks.get(callId);
  }

  /** All live tasks. */
  listTasks(): ToolTask[] {
    return Array.from(this.tasks.values());
  }

  /** Append a log entry to a task by call id (engine log sink). */
  appendLog(callId: string, data: unknown, kind?: TaskLogEntry['kind']): void {
    this.tasks.get(callId)?.appendLog(data, kind);
  }

  /** Mark every still-working background/agent task as orphaned (detach mode). */
  markWorkingAsOrphaned(): PendingAsyncTool[] {
    const orphaned: PendingAsyncTool[] = [];
    for (const task of this.tasks.values()) {
      if (task.mode !== 'defer' && task.status === 'working') {
        task.orphaned = true;
        orphaned.push({
          callId: task.callId,
          taskId: task.taskId,
          name: task.toolName,
          mode: task.mode,
          status: task.status,
          startedAt: task.startedAt,
          orphaned: true,
          ...(task.lastLog !== undefined && {
            lastLog: {
              at: task.lastLog.at,
              text: renderLastLog(task.lastLog.data),
            },
          }),
        });
      }
    }
    return orphaned;
  }

  /** Snapshot of every tracked task (for `getAsyncTasks()` / persistence). */
  snapshot(): PendingAsyncTool[] {
    return Array.from(this.tasks.values(), (t) => ({
      callId: t.callId,
      taskId: t.taskId,
      name: t.toolName,
      mode: t.mode,
      status: t.status,
      startedAt: t.startedAt,
      ...(t.expiresAt !== undefined && {
        expiresAt: t.expiresAt,
      }),
      ...(t.pollAfterMs !== undefined && {
        pollAfterMs: t.pollAfterMs,
      }),
      ...(t.orphaned === true && {
        orphaned: true,
      }),
      ...(t.lastLog !== undefined && {
        lastLog: {
          at: t.lastLog.at,
          text: renderLastLog(t.lastLog.data),
        },
      }),
    }));
  }

  /**
   * Send a steering message to a working task's run body. Deferred tasks
   * are owned by an external system — steering them is the caller's job.
   * @returns true when a working in-process task received the message.
   */
  sendToTask(taskId: string, message: unknown): boolean {
    const task = this.getTask(taskId);
    if (!task || task.status !== 'working') {
      return false;
    }
    if (task.mode === 'defer') {
      throw new Error(
        `Task "${taskId}" is deferred — its work runs in an external system; deliver steering messages there instead.`,
      );
    }
    task.send(message);
    return true;
  }

  /**
   * Cancel one task by task id. Settles it as 'cancelled' immediately
   * (first-writer-wins makes the racing body's own settlement a no-op) and
   * aborts the controller so cooperative bodies stop working.
   * @returns true when a working task was found and cancelled.
   */
  cancelTask(taskId: string, reason?: string): boolean {
    const task = this.getTask(taskId);
    if (!task || task.status !== 'working') {
      return false;
    }
    const controller = task.controller;
    this.settle(task.callId, {
      status: 'cancelled',
      error: reason ?? `Task ${taskId} cancelled`,
    });
    controller?.abort(new Error(reason ?? `Task ${taskId} cancelled`));
    return true;
  }

  /** Abort every in-flight background/agent task (run abort / onRunEnd: 'cancel'). */
  abortAll(reason?: string): void {
    for (const task of this.tasks.values()) {
      if (task.mode !== 'defer' && task.status === 'working') {
        const controller = task.controller;
        this.settle(task.callId, {
          status: 'cancelled',
          error: reason ?? 'Run aborted',
        });
        controller?.abort(new Error(reason ?? 'Run aborted'));
      }
    }
  }

  /**
   * Wait until every in-flight task settles or `timeoutMs` elapses,
   * whichever comes first. Returns true when everything settled.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.hasInFlight()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }
      const settled = await this.waitForSettle(remaining);
      if (!settled) {
        return !this.hasInFlight();
      }
    }
    return true;
  }

  /** Resolve true on the next settle event, or false after `timeoutMs`. */
  private waitForSettle(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const onSettle = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.settleWaiters = this.settleWaiters.filter((w) => w !== onSettle);
        resolve(false);
      }, timeoutMs);
      // Don't keep the event loop alive purely for the drain timer.
      if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
        timer.unref();
      }
      this.settleWaiters.push(onSettle);
    });
  }
}

/** Render a log entry's data to the small persisted `lastLog.text` form. */
function renderLastLog(data: unknown): string {
  const text = typeof data === 'string' ? data : (JSON.stringify(data) ?? String(data));
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
