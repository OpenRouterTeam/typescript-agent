/**
 * Consumer-facing contract for driving `DoomLoopMonitor` directly: everything
 * here imports from the package entrypoint ONLY, exactly as an npm consumer
 * or an SDK port would. `DoomLoopMonitor` was exported without
 * `resolveDoomLoopOption`, so the documented construction failed at runtime
 * and the class was unusable outside `callModel` — the changeset example was
 * only caught because it was executed rather than eyeballed.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DOOM_LOOP_LADDER,
  DoomLoopMonitor,
  resolveDoomLoopOption,
} from '../../src/index.js';

describe('DoomLoopMonitor via the public entrypoint', () => {
  it('constructs with defaults, detects a repeating fan-out, and honors the exported ladder', async () => {
    const monitor = new DoomLoopMonitor(resolveDoomLoopOption(true));
    const paths = [
      'a',
      'b',
      'c',
    ];

    let verdictAction: string | undefined;
    let verdictStreak: number | undefined;
    for (const round of [
      0,
      1,
      2,
    ]) {
      await monitor.declareRound(
        round,
        paths.map((path) => ({
          toolName: 'read',
          keyMaterial: {
            path,
          },
        })),
      );
      for (const path of paths) {
        const record = await monitor.recordToolCall(
          'read',
          {
            path,
          },
          round,
        );
        if (record.verdict) {
          verdictAction = record.verdict.action;
          verdictStreak = record.verdict.streak;
        }
      }
    }

    /* Third identical round crosses the exported default block threshold. */
    expect(verdictStreak).toBe(DEFAULT_DOOM_LOOP_LADDER.block);
    expect(verdictAction).toBe('block');
  });

  it('accepts a config object and honors a custom ladder', async () => {
    const monitor = new DoomLoopMonitor(
      resolveDoomLoopOption({
        ladder: {
          observe: 2,
          block: false,
          stop: 4,
        },
      }),
    );

    let last: string | undefined;
    for (const round of [
      0,
      1,
      2,
      3,
    ]) {
      const record = await monitor.recordToolCall(
        'search',
        {
          q: 'same',
        },
        round,
      );
      last = record.verdict?.action;
    }
    /* block disabled; the streak of 4 reaches the custom stop rung. */
    expect(last).toBe('stop');
  });

  it('round-trips state across a process boundary via plain JSON', async () => {
    const first = new DoomLoopMonitor(resolveDoomLoopOption(true));
    await first.recordToolCall(
      'search',
      {
        q: 'same',
      },
      0,
    );
    await first.recordToolCall(
      'search',
      {
        q: 'same',
      },
      1,
    );

    /* Simulate the serverless pattern: serialize, "new process", restore. */
    const wire = JSON.stringify(first.getState());
    const second = new DoomLoopMonitor(resolveDoomLoopOption(true), JSON.parse(wire));
    const resumed = await second.recordToolCall(
      'search',
      {
        q: 'same',
      },
      0,
    );

    /* Single-call streak continues across the boundary: 2 -> 3. */
    expect(resumed.streak).toBe(3);
  });
});
