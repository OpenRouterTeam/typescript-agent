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
