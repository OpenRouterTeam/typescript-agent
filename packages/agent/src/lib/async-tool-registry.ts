import type { PendingAsyncTool, ToolTaskStatus } from './tool-types.js';

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

interface TrackedTask {
  callId: string;
  taskId: string;
  name: string;
  mode: 'background' | 'defer';
  status: ToolTaskStatus;
  startedAt: number;
  expiresAt?: number;
  pollAfterMs?: number;
  /** Background only: aborts the task's ctx.signal. Dropped on settle. */
  controller?: AbortController | undefined;
}

/**
 * Per-run registry of async tool tasks (background + deferred).
 *
 * Owns the in-process half of async tool support:
 * - background tasks: tracks the in-flight work, queues settled outcomes for
 *   turn-boundary harvesting, supports drain / cancel / abort-all at run end;
 * - deferred tasks: tracks identity only (the work lives outside the
 *   process); the durable copy is mirrored to
 *   `ConversationState.pendingAsyncTools` by the engine.
 *
 * The registry knows nothing about the tool loop or concurrency pools — the
 * engine (`ModelResult`) owns semaphores and decides when to harvest and how
 * to deliver. Settlement is first-writer-wins: a task settles exactly once
 * (cancel racing completion is safe), and settled tasks drop their promise /
 * controller references so they cannot retain the run graph.
 */
export class AsyncToolRegistry {
  private readonly tasks = new Map<string, TrackedTask>();
  /** Settled outcomes not yet harvested by the engine. */
  private settledQueue: SettledToolTask[] = [];
  private taskCounter = 0;
  /** Resolvers waiting on "any task settled" (drain support). */
  private settleWaiters: Array<() => void> = [];

  /** Generate a task id for background tasks (deferred tasks bring their own). */
  generateTaskId(): string {
    this.taskCounter++;
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return `task_${crypto.randomUUID()}`;
    }
    return `task_${Date.now()}_${this.taskCounter}`;
  }

  /**
   * Track an already-started background task. `work` is the tool's in-flight
   * execute promise (output-validated). When `timeoutMs` is set the task is
   * raced against it, so a body that ignores its abort signal still settles
   * as `timed_out` instead of hanging the drain.
   */
  trackBackground(
    entry: {
      callId: string;
      taskId: string;
      name: string;
      controller: AbortController;
      timeoutMs?: number;
      expiresAt?: number;
      pollAfterMs?: number;
    },
    work: Promise<unknown>,
    onSettle?: () => void,
  ): void {
    const tracked: TrackedTask = {
      callId: entry.callId,
      taskId: entry.taskId,
      name: entry.name,
      mode: 'background',
      status: 'working',
      startedAt: Date.now(),
      ...(entry.expiresAt !== undefined && {
        expiresAt: entry.expiresAt,
      }),
      ...(entry.pollAfterMs !== undefined && {
        pollAfterMs: entry.pollAfterMs,
      }),
      controller: entry.controller,
    };
    this.tasks.set(entry.callId, tracked);

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (entry.timeoutMs !== undefined && entry.timeoutMs > 0) {
      timer = setTimeout(() => {
        const timeoutError = new Error(
          `Background tool "${entry.name}" timed out after ${entry.timeoutMs}ms`,
        );
        this.settle(entry.callId, {
          status: 'timed_out',
          error: timeoutError.message,
        });
        entry.controller.abort(timeoutError);
      }, entry.timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    }

    work
      .then(
        (result) => {
          this.settle(entry.callId, {
            status: 'completed',
            result,
          });
        },
        (error: unknown) => {
          const cancelled = entry.controller.signal.aborted;
          this.settle(entry.callId, {
            status: cancelled ? 'cancelled' : 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        },
      )
      .finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        onSettle?.();
      });
  }

  /** Track a deferred task (identity only; work lives outside the process). */
  trackDeferred(entry: {
    callId: string;
    taskId: string;
    name: string;
    expiresAt?: number;
    pollAfterMs?: number;
  }): void {
    this.tasks.set(entry.callId, {
      callId: entry.callId,
      taskId: entry.taskId,
      name: entry.name,
      mode: 'defer',
      status: 'working',
      startedAt: Date.now(),
      ...(entry.expiresAt !== undefined && {
        expiresAt: entry.expiresAt,
      }),
      ...(entry.pollAfterMs !== undefined && {
        pollAfterMs: entry.pollAfterMs,
      }),
    });
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
    const tracked = this.tasks.get(callId);
    if (!tracked || tracked.status !== 'working') {
      return; // first writer wins
    }
    tracked.status =
      outcome.status === 'completed'
        ? 'completed'
        : outcome.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
    // Leak guard: a settled task must not retain the run graph.
    tracked.controller = undefined;
    this.settledQueue.push({
      callId,
      taskId: tracked.taskId,
      name: tracked.name,
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

  /** True when any background task is still in flight. */
  hasInFlight(): boolean {
    for (const task of this.tasks.values()) {
      if (task.mode === 'background' && task.status === 'working') {
        return true;
      }
    }
    return false;
  }

  /** True when any settled outcome awaits harvesting. */
  hasUnharvestedSettled(): boolean {
    return this.settledQueue.length > 0;
  }

  /** True when any task (either mode) has been tracked this run. */
  hasTasks(): boolean {
    return this.tasks.size > 0;
  }

  /** Mark every still-working background task as orphaned (detach mode). */
  markWorkingAsOrphaned(): PendingAsyncTool[] {
    const orphaned: PendingAsyncTool[] = [];
    for (const task of this.tasks.values()) {
      if (task.mode === 'background' && task.status === 'working') {
        orphaned.push({
          callId: task.callId,
          taskId: task.taskId,
          name: task.name,
          mode: task.mode,
          status: task.status,
          startedAt: task.startedAt,
          orphaned: true,
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
      name: t.name,
      mode: t.mode,
      status: t.status,
      startedAt: t.startedAt,
      ...(t.expiresAt !== undefined && {
        expiresAt: t.expiresAt,
      }),
      ...(t.pollAfterMs !== undefined && {
        pollAfterMs: t.pollAfterMs,
      }),
    }));
  }

  /**
   * Cancel one task by task id. Settles it as 'cancelled' immediately
   * (first-writer-wins makes the racing body's own settlement a no-op) and
   * aborts the background controller so cooperative bodies stop working.
   * @returns true when a working task was found and cancelled.
   */
  cancelTask(taskId: string, reason?: string): boolean {
    for (const task of this.tasks.values()) {
      if (task.taskId !== taskId || task.status !== 'working') {
        continue;
      }
      const controller = task.controller;
      this.settle(task.callId, {
        status: 'cancelled',
        error: reason ?? `Task ${taskId} cancelled`,
      });
      controller?.abort(new Error(reason ?? `Task ${taskId} cancelled`));
      return true;
    }
    return false;
  }

  /** Abort every in-flight background task (run abort / onRunEnd: 'cancel'). */
  abortAll(reason?: string): void {
    for (const task of this.tasks.values()) {
      if (task.mode === 'background' && task.status === 'working') {
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
   * Wait until every in-flight background task settles or `timeoutMs`
   * elapses, whichever comes first. Returns true when everything settled.
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
