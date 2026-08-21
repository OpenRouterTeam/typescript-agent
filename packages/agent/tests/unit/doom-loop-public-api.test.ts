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

  it('accumulates a fan-out streak across per-turn process boundaries', async () => {
    /*
     * The serverless pattern: one round per callModel run, state persisted
     * between turns. A repeating fan-out must accumulate across those
     * boundaries — this is why the round's fingerprint SET is persisted.
     * Before that, each resume re-baselined the fan-out and a loop that
     * repeated once per turn never tripped anything.
     */
    const paths = [
      'a',
      'b',
      'c',
    ];
    let wire: unknown;
    const perTurn: string[] = [];
    for (let turn = 0; turn < 4; turn++) {
      const monitor = new DoomLoopMonitor(resolveDoomLoopOption(true), wire);
      await monitor.declareRound(
        0,
        paths.map((path) => ({
          toolName: 'read',
          keyMaterial: {
            path,
          },
        })),
      );
      let last = '';
      for (const path of paths) {
        const record = await monitor.recordToolCall(
          'read',
          {
            path,
          },
          0,
        );
        last = `${record.streak}:${record.verdict?.action ?? 'none'}`;
      }
      perTurn.push(last);
      wire = JSON.parse(JSON.stringify(monitor.getState()));
    }

    expect(perTurn).toEqual([
      '1:none',
      '2:observe',
      '3:block',
      '4:block',
    ]);
  });

  it('restores a legacy blob (no roundFingerprints) with single-call semantics', async () => {
    /*
     * Pre-existing persisted state has no `roundFingerprints` field. It must
     * restore exactly as before: the lone fingerprint describes the round, a
     * different call resets to 1, the same call continues. Malformed sets
     * (non-string entries) degrade the same way instead of being dropped.
     */
    const legacy = {
      tools: {
        read: {
          fingerprint: 'not-a-real-fingerprint',
          streak: 2,
        },
      },
    };
    const monitor = new DoomLoopMonitor(resolveDoomLoopOption(true), legacy);
    const different = await monitor.recordToolCall(
      'read',
      {
        path: 'x',
      },
      0,
    );
    expect(different.streak).toBe(1);

    const hostile = {
      tools: {
        read: {
          fingerprint: 'ab',
          streak: 2,
          roundFingerprints: [
            1,
            {},
            null,
          ],
        },
      },
    };
    const survives = new DoomLoopMonitor(resolveDoomLoopOption(true), hostile);
    const record = await survives.recordToolCall(
      'read',
      {
        path: 'x',
      },
      0,
    );
    expect(record.streak).toBe(1);
  });

  it('isolates the live detector from mutations of a saved snapshot', async () => {
    /*
     * `getState()` snapshots are handed to the caller's StateAccessor, and the
     * multi-call round set used to be the live array — shared with the running
     * streak entry and the round declaration. A caller that pushed into (or
     * sorted, or spliced) the saved blob silently corrupted the detector for
     * the rest of the run: the next identical fan-out compared against the
     * mutated set, never matched, and scored 1 instead of block.
     */
    const paths = [
      'a',
      'b',
    ];
    const monitor = new DoomLoopMonitor(resolveDoomLoopOption(true));
    for (const round of [
      0,
      1,
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
        await monitor.recordToolCall(
          'read',
          {
            path,
          },
          round,
        );
      }
    }

    /* A careless (or hostile) caller mutates the saved snapshot in place. */
    const saved = monitor.getState() as {
      tools: Record<
        string,
        {
          roundFingerprints?: string[];
        }
      >;
    };
    saved.tools.read.roundFingerprints?.push('INJECTED');

    /* The live detector must be unaffected: round 3 still blocks. */
    await monitor.declareRound(
      2,
      paths.map((path) => ({
        toolName: 'read',
        keyMaterial: {
          path,
        },
      })),
    );
    let last: {
      streak: number;
      action?: string;
    } = {
      streak: 0,
    };
    for (const path of paths) {
      const record = await monitor.recordToolCall(
        'read',
        {
          path,
        },
        2,
      );
      last = {
        streak: record.streak,
        action: record.verdict?.action,
      };
    }
    expect(last.streak).toBe(3);
    expect(last.action).toBe('block');
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
