/**
 * Regression suite for the same-tool fan-out gap.
 *
 * A streak keyed on a tool's *last* fingerprint cannot see a repeating
 * fan-out: `read(a), read(b), read(c)` reissued verbatim has a different last
 * call every round, so each round's first call reset the streak to 1 and the
 * run never accumulated evidence. Measured before the fix: 8 identical rounds
 * of a 3-call fan-out produced zero detections, while single-call rounds
 * tripped at round 2.
 *
 * A round's identity for one tool is therefore the *set* of fingerprints it
 * was called with. The set is only complete once every call has arrived, so a
 * fan-out scores on the call that completes the match — the round's earlier
 * calls legitimately report the pre-match streak.
 */
import { describe, expect, it } from 'vitest';

import { DoomLoopMonitor, resolveDoomLoopOption } from '../../src/lib/doom-loop.js';

type RecordedAction = string;

const monitor = (): DoomLoopMonitor => new DoomLoopMonitor(resolveDoomLoopOption(true));

async function playRounds(fanouts: readonly (readonly string[])[]): Promise<RecordedAction[][]> {
  const detector = monitor();
  const actions: RecordedAction[][] = [];
  for (const [round, paths] of fanouts.entries()) {
    const roundActions: RecordedAction[] = [];
    for (const path of paths) {
      const record = await detector.recordToolCall(
        'read',
        {
          path,
        },
        round,
      );
      roundActions.push(record.verdict?.action ?? 'none');
    }
    actions.push(roundActions);
  }
  return actions;
}

describe('same-tool fan-out streaks', () => {
  it('accumulates across rounds that repeat a distinct-argument fan-out', async () => {
    const actions = await playRounds([
      [
        'a',
        'b',
        'c',
      ],
      [
        'a',
        'b',
        'c',
      ],
      [
        'a',
        'b',
        'c',
      ],
    ]);

    /* Round 0 is the baseline; each later round scores as its set completes. */
    expect(actions[0]).toEqual([
      'none',
      'none',
      'none',
    ]);
    expect(actions[1]).toEqual([
      'none',
      'none',
      'observe',
    ]);
    expect(actions[2]).toEqual([
      'none',
      'none',
      'block',
    ]);
  });

  it('is order-insensitive within the round', async () => {
    const actions = await playRounds([
      [
        'a',
        'b',
        'c',
      ],
      [
        'c',
        'a',
        'b',
      ],
      [
        'b',
        'c',
        'a',
      ],
    ]);

    expect(actions[1]?.at(-1)).toBe('observe');
    expect(actions[2]?.at(-1)).toBe('block');
  });

  it('resets when the fan-out membership changes', async () => {
    const actions = await playRounds([
      [
        'a',
        'b',
      ],
      [
        'a',
        'b',
      ],
      [
        'a',
        'z',
      ],
      [
        'a',
        'z',
      ],
    ]);

    expect(actions[1]?.at(-1)).toBe('observe');
    /* Different set: this is progress, not repetition. */
    expect(actions[2]).toEqual([
      'none',
      'none',
    ]);
    expect(actions[3]?.at(-1)).toBe('observe');
  });

  it('does not treat a partial repeat as a repeat', async () => {
    const actions = await playRounds([
      [
        'a',
        'b',
        'c',
      ],
      [
        'a',
        'b',
      ],
    ]);

    /* A strict subset is a different round, so no verdict fires. */
    expect(actions[1]).toEqual([
      'none',
      'none',
    ]);
  });

  it('leaves single-call rounds behaving exactly as before', async () => {
    const actions = await playRounds([
      [
        'a',
      ],
      [
        'a',
      ],
      [
        'a',
      ],
      [
        'a',
      ],
    ]);

    expect(actions.flat()).toEqual([
      'none',
      'observe',
      'block',
      'block',
    ]);
  });

  it('still counts identical duplicates within one round only once', async () => {
    const detector = monitor();
    const first = await detector.recordToolCall(
      'read',
      {
        path: 'a',
      },
      0,
    );
    const second = await detector.recordToolCall(
      'read',
      {
        path: 'a',
      },
      0,
    );

    expect(first.duplicateInRound).toBe(false);
    expect(second.duplicateInRound).toBe(true);
    expect(second.streak).toBe(first.streak);
  });

  it('keeps a resumed single-call streak incrementing after restore', async () => {
    const detector = monitor();
    await detector.recordToolCall(
      'read',
      {
        path: 'a',
      },
      0,
    );
    await detector.recordToolCall(
      'read',
      {
        path: 'a',
      },
      1,
    );

    const resumed = new DoomLoopMonitor(resolveDoomLoopOption(true), detector.getState());
    const record = await resumed.recordToolCall(
      'read',
      {
        path: 'a',
      },
      0,
    );

    expect(record.streak).toBe(3);
  });
});
