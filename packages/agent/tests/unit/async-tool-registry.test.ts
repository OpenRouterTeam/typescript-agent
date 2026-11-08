import { describe, expect, it, vi } from 'vitest';
import { AsyncToolRegistry } from '../../src/lib/async-tool-registry.js';
import { ToolTask } from '../../src/lib/tool-task.js';

function makeTask(callId: string, controller?: AbortController): ToolTask {
  return new ToolTask({
    taskId: `task_${callId}`,
    callId,
    toolName: 'render_video',
    mode: 'background',
    ...(controller !== undefined && {
      controller,
    }),
  });
}

describe('AsyncToolRegistry — timeout settlement', () => {
  it('deadline expiry aborts the running body (controller captured before settle clears it)', async () => {
    vi.useFakeTimers();
    try {
      const registry = new AsyncToolRegistry();
      const controller = new AbortController();
      const task = makeTask('call_t1', controller);

      // Work that only settles when its abort signal fires — the shape of a
      // cooperative long-running body.
      const work = new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        });
      });
      registry.trackBackground(task, work, {
        timeoutMs: 50,
      });

      await vi.advanceTimersByTimeAsync(60);

      // The body's signal MUST have fired — a timed-out task is told to stop.
      expect(controller.signal.aborted).toBe(true);
      expect(String(controller.signal.reason)).toContain('timed out after 50ms');

      const settled = registry.takeSettled();
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        callId: 'call_t1',
        status: 'timed_out',
      });
      // Leak guard still holds after settlement.
      expect(task.controller).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('work settling before the deadline wins the race (no timeout abort)', async () => {
    vi.useFakeTimers();
    try {
      const registry = new AsyncToolRegistry();
      const controller = new AbortController();
      const task = makeTask('call_t2', controller);

      registry.trackBackground(
        task,
        Promise.resolve({
          url: 'https://done',
        }),
        {
          timeoutMs: 50,
        },
      );
      await vi.advanceTimersByTimeAsync(0); // let the resolution land

      const settled = registry.takeSettled();
      expect(settled[0]).toMatchObject({
        callId: 'call_t2',
        status: 'completed',
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AsyncToolRegistry — deferred input', () => {
  it('retains input in settlement and persistence snapshots', () => {
    const registry = new AsyncToolRegistry();
    const task = registry.trackDeferred({
      callId: 'call_d1',
      taskId: 'task_d1',
      name: 'weather',
      input: {
        city: 'Lisbon',
      },
    });

    expect(task.input).toEqual({
      city: 'Lisbon',
    });
    expect(registry.snapshot()[0]).toMatchObject({
      input: {
        city: 'Lisbon',
      },
    });
    registry.cancelTask('task_d1');
    expect(registry.takeSettled()[0]).toMatchObject({
      input: {
        city: 'Lisbon',
      },
    });
  });
});

describe('AsyncToolRegistry — grace-window visibility (register/untrack)', () => {
  it('a registered (not yet tracked) task is reachable by steer and cancel', () => {
    const registry = new AsyncToolRegistry();
    const controller = new AbortController();
    const task = makeTask('call_g1', controller);
    registry.register(task);

    // Visible to snapshots and lookups during the grace window.
    expect(registry.getTask(task.taskId)).toBe(task);
    expect(registry.snapshot()).toHaveLength(1);

    // Steering queues into the task inbox instead of returning false.
    expect(registry.sendToTask(task.taskId, 'go faster')).toBe(true);
    const received: unknown[] = [];
    task.onMessage((m) => received.push(m));
    expect(received).toEqual([
      'go faster',
    ]);

    // Cancel aborts the controller (the grace race observes the rejection).
    expect(registry.cancelTask(task.taskId, 'changed my mind')).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('untrack removes the task and any settlement queued for it', () => {
    const registry = new AsyncToolRegistry();
    const controller = new AbortController();
    const task = makeTask('call_g2', controller);
    registry.register(task);
    registry.cancelTask(task.taskId, 'racing in-window settle');

    // In-window settle path: the sync output already reports the outcome —
    // no envelope may remain queued.
    registry.untrack('call_g2');
    expect(registry.takeSettled()).toEqual([]);
    expect(registry.getTask(task.taskId)).toBeUndefined();
    expect(registry.hasTasks()).toBe(false);
  });
});

describe('ToolTask — tailLogs bounds', () => {
  it('tailLogs(0) returns no entries, not the whole log', () => {
    const task = makeTask('call_t3');
    task.appendLog('one');
    task.appendLog('two');
    expect(task.tailLogs(0)).toEqual([]);
    expect(task.tailLogs(-3)).toEqual([]);
    expect(task.tailLogs(1.9)).toHaveLength(1);
    expect(task.tailLogs(2)).toHaveLength(2);
  });
});
