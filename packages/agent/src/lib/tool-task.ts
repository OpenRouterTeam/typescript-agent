/**
 * Lifecycle status of a tool task. Deliberately matches the MCP Tasks
 * extension (SEP 2663) status vocabulary so MCP task handles can map onto
 * this without translation.
 *
 * Defined here (not tool-types.ts) because ToolTask is the primary
 * consumer and tool-types already imports task types from this module —
 * defining it there would create an import cycle. Re-exported from
 * tool-types alongside PendingAsyncTool.
 */
export type ToolTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/**
 * One entry in a task's log. Yields from a tool's `run` (and `ctx.log()`
 * calls) become these; agent tools append one per child turn; the engine
 * appends `system` entries for lifecycle transitions.
 */
export interface TaskLogEntry {
  /** Monotonic per-task sequence number, 1-based. Counts dropped entries. */
  seq: number;
  /** Unix ms. */
  at: number;
  /**
   * The logged value. When the tool declares `eventSchema` this is the
   * validated event; otherwise the raw yield / log argument.
   */
  data: unknown;
  /**
   * Rendering hint: `'event'` for structured yields, `'text'` for bare
   * strings, `'turn'` for agent-tool per-turn summaries, `'system'` for
   * engine-authored entries (started / cancelled / timed out).
   */
  kind: 'event' | 'text' | 'turn' | 'system';
}

/** Bounds for a task's in-memory log ring buffer. */
export interface TaskLogLimits {
  /** Max retained entries (oldest dropped). Default 200. */
  maxEntries: number;
  /** Max retained bytes across entries (oldest dropped first). Default 256_000. */
  maxBytes: number;
  /** Per-entry serialized cap; longer entries are truncated. Default 4_000. */
  maxEntryBytes: number;
}

export const DEFAULT_TASK_LOG_LIMITS: TaskLogLimits = {
  maxEntries: 200,
  maxBytes: 256_000,
  maxEntryBytes: 4_000,
};

/**
 * Pluggable transcript producer for the check-in `transcript` view.
 * Plain tools render their log entries; agent tools render the child
 * conversation.
 */
export interface TaskTranscriptSource {
  /** Human-readable transcript, truncated to `maxChars` keeping the TAIL. */
  render(maxChars: number): string;
  /** Extra `status`-view fields (agent tools: turnsCompleted, currentActivity). */
  statusExtras?(): Record<string, unknown>;
}

/** How a task escapes the round. */
export type ToolTaskMode = 'background' | 'defer' | 'agent';

/** The `status` check-view payload. */
export interface ToolTaskStatusView {
  taskId: string;
  toolName: string;
  mode: ToolTaskMode;
  status: ToolTaskStatus;
  startedAt: number;
  elapsedMs: number;
  logCount: number;
  lastLog?: unknown;
  pollAfterMs?: number;
  expiresAt?: number;
  orphaned?: boolean;
  [key: string]: unknown;
}

/** Approximate byte size of a log entry's data (JSON length; fallback 64). */
function entryBytes(data: unknown): number {
  try {
    const serialized = typeof data === 'string' ? data : JSON.stringify(data);
    return serialized?.length ?? 64;
  } catch {
    return 64;
  }
}

/** Truncate an entry's data to the per-entry byte cap (string forms only). */
function truncateEntry(data: unknown, maxEntryBytes: number): unknown {
  if (typeof data === 'string' && data.length > maxEntryBytes) {
    return `${data.slice(0, maxEntryBytes)}…[truncated]`;
  }
  try {
    const serialized = JSON.stringify(data);
    if (serialized && serialized.length > maxEntryBytes) {
      return {
        truncated: true,
        preview: `${serialized.slice(0, maxEntryBytes)}…`,
      };
    }
  } catch {
    // Unserializable data passes through untruncated; entryBytes falls back.
  }
  return data;
}

/**
 * Runtime state for one async tool task (background, deferred, or agent).
 * Owned by the AsyncToolRegistry. Carries a bounded log ring buffer (the
 * source for check-in `logs`/`transcript` views and
 * `accumulatedYieldedEvents`), a steering inbox, and an optional transcript
 * source for agent tools.
 */
export class ToolTask {
  readonly taskId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly mode: ToolTaskMode;
  readonly startedAt: number;
  status: ToolTaskStatus;
  settledAt?: number;
  expiresAt?: number;
  pollAfterMs?: number;
  orphaned?: boolean;
  result?: unknown;
  error?: string;
  /** Background/agent only: aborts ctx.signal. Dropped on settle (leak guard). */
  controller?: AbortController | undefined;
  /** Agent tools attach a live child-conversation transcript source. */
  transcriptSource?: TaskTranscriptSource;

  private readonly limits: TaskLogLimits;
  private readonly logs: TaskLogEntry[] = [];
  private logBytes = 0;
  private totalAppended = 0;

  // Steering inbox: queued until a handler registers; delivered immediately
  // after. One handler per task (last registration wins).
  private inboxQueue: unknown[] = [];
  private inboxHandler: ((message: unknown) => void) | null = null;

  constructor(entry: {
    taskId: string;
    callId: string;
    toolName: string;
    mode: ToolTaskMode;
    expiresAt?: number;
    pollAfterMs?: number;
    controller?: AbortController;
    limits?: Partial<TaskLogLimits>;
  }) {
    this.taskId = entry.taskId;
    this.callId = entry.callId;
    this.toolName = entry.toolName;
    this.mode = entry.mode;
    this.status = 'working';
    this.startedAt = Date.now();
    if (entry.expiresAt !== undefined) {
      this.expiresAt = entry.expiresAt;
    }
    if (entry.pollAfterMs !== undefined) {
      this.pollAfterMs = entry.pollAfterMs;
    }
    if (entry.controller !== undefined) {
      this.controller = entry.controller;
    }
    this.limits = {
      ...DEFAULT_TASK_LOG_LIMITS,
      ...entry.limits,
    };
  }

  /** Append a log entry, evicting oldest entries past the ring-buffer caps. */
  appendLog(data: unknown, kind: TaskLogEntry['kind'] = 'event'): TaskLogEntry {
    this.totalAppended++;
    const bounded = truncateEntry(data, this.limits.maxEntryBytes);
    const entry: TaskLogEntry = {
      seq: this.totalAppended,
      at: Date.now(),
      data: bounded,
      kind,
    };
    this.logs.push(entry);
    this.logBytes += entryBytes(bounded);

    while (
      this.logs.length > this.limits.maxEntries ||
      (this.logBytes > this.limits.maxBytes && this.logs.length > 1)
    ) {
      const dropped = this.logs.shift();
      if (dropped) {
        this.logBytes -= entryBytes(dropped.data);
      }
    }
    return entry;
  }

  /** Last `n` retained entries, oldest first. `n <= 0` returns none. */
  tailLogs(n: number): TaskLogEntry[] {
    const count = Math.max(0, Math.floor(n));
    return count === 0 ? [] : this.logs.slice(-count);
  }

  get lastLog(): TaskLogEntry | undefined {
    return this.logs[this.logs.length - 1];
  }

  /** Total entries ever appended (including evicted ones). */
  get logCount(): number {
    return this.totalAppended;
  }

  get elapsedMs(): number {
    return (this.settledAt ?? Date.now()) - this.startedAt;
  }

  /**
   * The data of retained event/text entries, oldest first — the
   * `turnContext.accumulatedYieldedEvents` payload for check calls.
   */
  get accumulatedYieldedEvents(): unknown[] {
    return this.logs
      .filter((entry) => entry.kind === 'event' || entry.kind === 'text')
      .map((entry) => entry.data);
  }

  /** Queue (or immediately deliver) a steering message to the run body. */
  send(message: unknown): void {
    if (this.inboxHandler) {
      this.inboxHandler(message);
      return;
    }
    this.inboxQueue.push(message);
  }

  /**
   * Register the run body's steering handler. Queued messages are flushed
   * to it immediately, in send order.
   */
  onMessage(handler: (message: unknown) => void): void {
    this.inboxHandler = handler;
    const queued = this.inboxQueue;
    this.inboxQueue = [];
    for (const message of queued) {
      handler(message);
    }
  }

  /** JSON summary for the `status` check view. */
  toStatusView(): ToolTaskStatusView {
    const extras = this.transcriptSource?.statusExtras?.() ?? {};
    return {
      taskId: this.taskId,
      toolName: this.toolName,
      mode: this.mode,
      status: this.status,
      startedAt: this.startedAt,
      elapsedMs: this.elapsedMs,
      logCount: this.logCount,
      ...(this.lastLog !== undefined && {
        lastLog: this.lastLog.data,
      }),
      ...(this.pollAfterMs !== undefined && {
        pollAfterMs: this.pollAfterMs,
      }),
      ...(this.expiresAt !== undefined && {
        expiresAt: this.expiresAt,
      }),
      ...(this.orphaned === true && {
        orphaned: true,
      }),
      ...extras,
    };
  }

  /** Render the transcript view: delegated source or the log entries. */
  renderTranscript(maxChars: number): string {
    if (this.transcriptSource) {
      return this.transcriptSource.render(maxChars);
    }
    const lines = this.logs.map((entry) => {
      const offset = ((entry.at - this.startedAt) / 1000).toFixed(1);
      const body = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data);
      return `[+${offset}s] ${body}`;
    });
    const full = lines.join('\n');
    if (full.length <= maxChars) {
      return full;
    }
    const tail = full.slice(-maxChars);
    return `…[truncated ${full.length - maxChars} chars]\n${tail}`;
  }
}
