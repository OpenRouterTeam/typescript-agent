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
 * was called with. The engine declares that set before scoring any of the
 * round's calls, so every call in a round reports the round's streak and the
 * comparison is between whole rounds.
 *
 * Scoring the set as it accumulated instead — the first attempt at this fix —
 * made a round that is a strict *superset* of the previous one transiently
 * equal it while filling, so `[a,b]`, `[a,b]`, `[a,b,c]` blocked the `b` call
 * of a round that had added new work, and did so only for that emission order.
 * The superset, order-permutation, and expanding-fan-out cases below guard
 * that; the subset case alone did not catch it.
 */
import { describe, expect, it } from 'vitest';

import { DoomLoopMonitor, resolveDoomLoopOption } from '../../src/lib/doom-loop.js';

type RecordedAction = string;

const monitor = (): DoomLoopMonitor => new DoomLoopMonitor(resolveDoomLoopOption(true));

/**
 * Plays each fan-out as one round, declaring the round's calls first — the
 * engine does the same at every execution-batch boundary, so the round's
 * fingerprint set is complete before any of its calls is scored.
 */
async function playRounds(fanouts: readonly (readonly string[])[]): Promise<RecordedAction[][]> {
  const detector = monitor();
  const actions: RecordedAction[][] = [];
  for (const [round, paths] of fanouts.entries()) {
    await detector.declareRound(
      round,
      paths.map((path) => ({
        toolName: 'read',
        keyMaterial: {
          path,
        },
      })),
    );
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

    /*
     * Round 0 is the baseline. Every call in a repeating round reports that
     * round's streak — the round is the unit of evidence, so the ladder
     * applies to the whole fan-out rather than only to whichever call
     * happened to complete the match. At the block rung that means the
     * repeating fan-out stops spending, not just its last call.
     */
    expect(actions[0]).toEqual([
      'none',
      'none',
      'none',
    ]);
    expect(actions[1]).toEqual([
      'observe',
      'observe',
      'observe',
    ]);
    expect(actions[2]).toEqual([
      'block',
      'block',
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

    /* Whole round, not just its last call: the set is what matched. */
    expect(actions[1]).toEqual([
      'observe',
      'observe',
      'observe',
    ]);
    expect(actions[2]).toEqual([
      'block',
      'block',
      'block',
    ]);
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

    expect(actions[1]).toEqual([
      'observe',
      'observe',
    ]);
    /* Different set: this is progress, not repetition. */
    expect(actions[2]).toEqual([
      'none',
      'none',
    ]);
    expect(actions[3]).toEqual([
      'observe',
      'observe',
    ]);
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

  it('does not treat a superset round as a repeat', async () => {
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
        'b',
        'c',
      ],
    ]);

    /*
     * The third round added new work, so it is progress and nothing fires.
     * Scoring the set as it accumulated used to make this round transiently
     * equal `[a,b]` on its `b` call and score streak 3 -> block, refusing a
     * legitimate call. Guards the direction the subset test above does not.
     */
    expect(actions[1]).toEqual([
      'observe',
      'observe',
    ]);
    expect(actions[2]).toEqual([
      'none',
      'none',
      'none',
    ]);
  });

  it('scores a superset round the same whatever order it is emitted in', async () => {
    const inOrder = await playRounds([
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
        'b',
        'c',
      ],
    ]);
    const permuted = await playRounds([
      [
        'a',
        'b',
      ],
      [
        'a',
        'b',
      ],
      [
        'c',
        'a',
        'b',
      ],
    ]);

    /*
     * Emission order must not decide whether a call is refused. While the set
     * accumulated, `[a,b,c]` blocked its `b` call and `[c,a,b]` fired nothing
     * — same calls, same history, different outcome.
     */
    expect(permuted[2]).toEqual(inOrder[2]);
    expect(inOrder[2]).toEqual([
      'none',
      'none',
      'none',
    ]);
  });

  it('does not accumulate a streak while a fan-out keeps expanding', async () => {
    const actions = await playRounds([
      [
        'a',
      ],
      [
        'a',
        'b',
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
        'd',
      ],
    ]);

    /* Every round adds work, so no round repeats its predecessor. */
    expect(
      actions
        .slice(1)
        .flat()
        .every((action) => action === 'none'),
    ).toBe(true);
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

  it('falls back to per-call scoring when a round is never declared', async () => {
    /*
     * The engine declares every executed batch, but server-tool records go
     * through `checkDoomLoopForResponse` undeclared, as do direct callers and
     * ports. A round's membership is unknowable there, so each call is scored
     * on its own identity against the previous round — the pre-fan-out
     * semantics. Sharing a round streak here instead let a brand-new call
     * inherit an earlier call's count: `[a]` then `[a, b]` scored `b` as a
     * 2-round repeat and emitted a verdict quoting `b`'s own fingerprint,
     * for a call the model had just made for the first time.
     */
    const detector = monitor();
    await detector.recordToolCall(
      'server:web_search',
      {
        q: 'x',
      },
      0,
    );
    const repeated = await detector.recordToolCall(
      'server:web_search',
      {
        q: 'x',
      },
      1,
    );
    const fresh = await detector.recordToolCall(
      'server:web_search',
      {
        q: 'y',
      },
      1,
    );

    /* The genuine repeat still accumulates. */
    expect(repeated.streak).toBe(2);
    /* The first-ever call does not inherit it. */
    expect(fresh.streak).toBe(1);
    expect(fresh.verdict).toBeUndefined();
  });

  it('gives every call of a repeating round the SAME message so steer dedupes', async () => {
    /*
     * `queueDoomLoopSteer` dedupes queued guidance by exact message text. Now
     * that every call of a repeating round emits a verdict, quoting the
     * individual call's fingerprint would queue one near-identical correction
     * per call — three user messages for one round of evidence. A multi-call
     * round therefore quotes the ROUND's identity instead.
     */
    const detector = new DoomLoopMonitor(
      resolveDoomLoopOption({
        ladder: {
          steer: 2,
        },
      }),
    );
    const paths = [
      'a',
      'b',
      'c',
    ];
    const messages: string[] = [];
    for (const round of [
      0,
      1,
    ]) {
      await detector.declareRound(
        round,
        paths.map((path) => ({
          toolName: 'read',
          keyMaterial: {
            path,
          },
        })),
      );
      for (const path of paths) {
        const record = await detector.recordToolCall(
          'read',
          {
            path,
          },
          round,
        );
        if (round === 1 && record.verdict) {
          messages.push(record.verdict.message);
        }
      }
    }

    expect(messages).toHaveLength(3);
    expect(new Set(messages).size).toBe(1);
    /* Names the shape rather than one member's hash. */
    expect(messages[0]).toContain('3 parallel calls');
  });

  it('restarts a resumed FAN-OUT streak at 1, unlike a single-call streak', async () => {
    const detector = monitor();
    for (const round of [
      0,
      1,
    ]) {
      const paths = [
        'a',
        'b',
      ];
      await detector.declareRound(
        round,
        paths.map((path) => ({
          toolName: 'read',
          keyMaterial: {
            path,
          },
        })),
      );
      for (const path of paths) {
        await detector.recordToolCall(
          'read',
          {
            path,
          },
          round,
        );
      }
    }

    /*
     * Only the last fingerprint survives serialization, so the round SET is
     * lost across a resume and the fan-out starts over — a doom loop spanning
     * a serialize/resume boundary gets a fresh grace window before it trips
     * again. Pinned deliberately: the round set is run-local by design
     * (persisting it would change the state shape), and the single-call case
     * above shows the contrast.
     */
    const resumed = new DoomLoopMonitor(resolveDoomLoopOption(true), detector.getState());
    await resumed.declareRound(
      0,
      [
        'a',
        'b',
      ].map((path) => ({
        toolName: 'read',
        keyMaterial: {
          path,
        },
      })),
    );
    const record = await resumed.recordToolCall(
      'read',
      {
        path: 'a',
      },
      0,
    );

    expect(record.streak).toBe(1);
  });
});
