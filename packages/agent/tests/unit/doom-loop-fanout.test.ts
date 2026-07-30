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
import type { DoomLoopCallRecord } from '../../src/lib/doom-loop.js';
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
     * on its own identity rather than as part of a set. Sharing a round streak
     * here instead let a brand-new call inherit an earlier call's count: `[a]`
     * then `[a, b]` scored `b` as a 2-round repeat and emitted a verdict
     * quoting `b`'s own fingerprint, for a call the model had just made for
     * the first time.
     *
     * Note this is NOT identical to the pre-fan-out per-call comparison for
     * multi-call rounds — see the order-dependence test below.
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

  it('scores an UNDECLARED multi-call round on its last member, order-dependently', async () => {
    /*
     * Pins the undeclared path's real semantics, because they are NOT the
     * pre-fan-out per-call comparison for a multi-call round, and the docs
     * previously claimed they were.
     *
     * Each call of an undeclared round overwrites `roundFingerprints` with its
     * own singleton, so the next round's matching call compares against the
     * previous round's LAST recorded fingerprint. A repeating undeclared
     * fan-out therefore accumulates on whichever member lands last, and
     * flipping the emission order moves the verdict to a different call.
     *
     * Consequences worth pinning: it reaches `stop` at the default ladder's
     * streak 6 (server-tool verdicts cannot `block`, but they can stop a run),
     * and a repeat inside a *varying* round accumulates here even though the
     * declared path treats that as progress.
     */
    const undeclared = async (rounds: readonly (readonly string[])[]): Promise<string[][]> => {
      const detector = monitor();
      const out: string[][] = [];
      for (const [round, paths] of rounds.entries()) {
        const scored: string[] = [];
        for (const path of paths) {
          const record = await detector.recordToolCall(
            'read',
            {
              path,
            },
            round,
          );
          scored.push(`${record.streak}:${record.verdict?.action ?? 'none'}`);
        }
        out.push(scored);
      }
      return out;
    };

    /* The last member accumulates; the first does not. */
    expect(
      await undeclared([
        [
          'a',
          'b',
        ],
        [
          'a',
          'b',
        ],
      ]),
    ).toEqual([
      [
        '1:none',
        '1:none',
      ],
      [
        '1:none',
        '2:observe',
      ],
    ]);

    /* Flipping the order moves the verdict onto the other call. */
    expect(
      await undeclared([
        [
          'a',
          'b',
        ],
        [
          'b',
          'a',
        ],
      ]),
    ).toEqual([
      [
        '1:none',
        '1:none',
      ],
      [
        '2:observe',
        '1:none',
      ],
    ]);

    /* A varying round still accumulates on the stable last member. */
    expect(
      (
        await undeclared([
          [
            'a',
            'b',
          ],
          [
            'c',
            'b',
          ],
          [
            'd',
            'b',
          ],
        ])
      ).map((round) => round.at(-1)),
    ).toEqual([
      '1:none',
      '2:observe',
      '3:block',
    ]);
  });

  it('does not let a call outside the declared set inherit the round streak', async () => {
    /*
     * `declareRound` drops a call whose key material is unhashable (bigint,
     * NaN, circular), but at record time that call still resolves an identity
     * through the caller's fallback chain. Sharing the round's streak is keyed
     * on the call being a MEMBER of the declaration, not merely on the tool
     * having one — otherwise the dropped call inherits the round's accumulated
     * count and can be blocked on its first ever appearance, which is the
     * failure mode declared/undeclared scoring exists to prevent.
     */
    const detector = monitor();
    const hashable = {
      path: 'a',
    };
    /* Establish a streak on the declared member across two rounds. */
    for (const round of [
      0,
      1,
    ]) {
      await detector.declareRound(round, [
        {
          toolName: 'read',
          keyMaterial: hashable,
        },
        /* Unhashable: dropped from the declared set. */
        {
          toolName: 'read',
          keyMaterial: {
            size: 1n,
          },
        },
      ]);
      await detector.recordToolCall('read', hashable, round);
    }

    /* Round 2: the declared member repeats, then the dropped call arrives. */
    await detector.declareRound(2, [
      {
        toolName: 'read',
        keyMaterial: hashable,
      },
      {
        toolName: 'read',
        keyMaterial: {
          size: 1n,
        },
      },
    ]);
    const member = await detector.recordToolCall('read', hashable, 2);
    /* Recorded with a fallback identity, as the engine would. */
    const dropped = await detector.recordToolCall(
      'read',
      {
        size: 'fallback-identity',
      },
      2,
    );

    /* The real repeat accumulates. */
    expect(member.streak).toBe(3);
    /* The non-member does not inherit it. */
    expect(dropped.streak).toBe(1);
    expect(dropped.verdict).toBeUndefined();
  });

  it('keeps accumulating when an unhashable call rides along every round', async () => {
    /*
     * A non-member must not write the round's identity. It used to store its
     * own single-fingerprint set as `roundFingerprints`, so the NEXT round's
     * declared member compared against that singleton, failed to match, and
     * reset to 1 — permanently, for as long as the unhashable call recurred.
     * One unhashable argument therefore disabled detection for that tool for
     * the rest of the run, which is the opposite of the fail-open guarantee
     * (an unhashable value may only cost detection for ITS OWN call).
     *
     * Asserted in both emission orders, since which call opens the round is
     * up to the model.
     */
    const streaksFor = async (droppedFirst: boolean): Promise<number[]> => {
      const detector = monitor();
      const streaks: number[] = [];
      for (const round of [
        0,
        1,
        2,
        3,
      ]) {
        await detector.declareRound(round, [
          {
            toolName: 'read',
            keyMaterial: {
              path: 'a',
            },
          },
          {
            toolName: 'read',
            keyMaterial: {
              size: 1n,
            },
          },
        ]);
        const recordDropped = (): Promise<DoomLoopCallRecord> =>
          detector.recordToolCall(
            'read',
            {
              size: 'fallback-identity',
            },
            round,
          );
        if (droppedFirst) {
          await recordDropped();
        }
        const member = await detector.recordToolCall(
          'read',
          {
            path: 'a',
          },
          round,
        );
        if (!droppedFirst) {
          await recordDropped();
        }
        streaks.push(member.streak);
      }
      return streaks;
    };

    const expected = [
      1,
      2,
      3,
      4,
    ];
    expect(await streaksFor(false)).toEqual(expected);
    /* Order must not matter: the streak is a function of the sets, not arrival. */
    expect(await streaksFor(true)).toEqual(expected);
  });

  it('persists the streak against the member that earned it, not a non-member', async () => {
    /*
     * `fingerprint` is the identity that pairs with `streak` in persisted
     * state. A non-member recorded LAST in the round used to overwrite it, so
     * the saved count was attached to a call that never earned it. Both halves
     * then went wrong on resume: the non-member (a call detection is meant to
     * ignore) matched, inherited the count, and was BLOCKED on its first
     * appearance, while the genuinely repeating call was no longer the saved
     * identity and reset to 1, losing its evidence.
     */
    const detector = monitor();
    for (const round of [
      0,
      1,
    ]) {
      await detector.declareRound(round, [
        {
          toolName: 'read',
          keyMaterial: {
            path: 'a',
          },
        },
        /* Unhashable: dropped from the declared set. */
        {
          toolName: 'read',
          keyMaterial: {
            size: 1n,
          },
        },
      ]);
      await detector.recordToolCall(
        'read',
        {
          path: 'a',
        },
        round,
      );
      /* Recorded LAST, so it used to become the persisted identity. */
      await detector.recordToolCall(
        'read',
        {
          size: 'fallback-identity',
        },
        round,
      );
    }

    /* The ignored call must not be refused the first time it is seen. */
    const resumedNonMember = new DoomLoopMonitor(resolveDoomLoopOption(true), detector.getState());
    const firstSighting = await resumedNonMember.recordToolCall(
      'read',
      {
        size: 'fallback-identity',
      },
      0,
    );
    expect(firstSighting.streak).toBe(1);
    expect(firstSighting.verdict).toBeUndefined();

    /* And the real repeat keeps the evidence it earned. */
    const resumedMember = new DoomLoopMonitor(resolveDoomLoopOption(true), detector.getState());
    await resumedMember.declareRound(0, [
      {
        toolName: 'read',
        keyMaterial: {
          path: 'a',
        },
      },
    ]);
    const realRepeat = await resumedMember.recordToolCall(
      'read',
      {
        path: 'a',
      },
      0,
    );
    expect(realRepeat.streak).toBe(3);
  });

  it('resets a streak when a declared-but-never-recorded member disappears', async () => {
    /*
     * Pins WHY the engine must not declare a call it will never record (a
     * manual tool, a PermissionRequest denial, a malformed call to either).
     * Such a member is a phantom: it inflates the round's identity, so the
     * sibling that IS recorded gets scored against a set it never matches on
     * its own — and the streak resets the moment the phantom stops being
     * emitted, even though the recorded call never changed.
     *
     * This test drives the monitor directly with an over-broad declaration to
     * show the consequence; `beginDoomLoopRound` is what prevents it, by
     * filtering the batch through `isAutoResolvableTool` and `hookDeniedCalls`
     * before declaring.
     */
    const detector = monitor();
    const streaks: number[] = [];
    for (const round of [
      0,
      1,
      2,
      3,
    ]) {
      /* Rounds 0-1 declare a phantom alongside the real call; 2-3 do not. */
      const declaredCalls = [
        {
          toolName: 'read',
          keyMaterial: {
            path: 'a',
          },
        },
        ...(round < 2
          ? [
              {
                toolName: 'read',
                keyMaterial: {
                  path: 'phantom',
                },
              },
            ]
          : []),
      ];
      await detector.declareRound(round, declaredCalls);
      /* Only the real call is ever recorded. */
      streaks.push(
        (
          await detector.recordToolCall(
            'read',
            {
              path: 'a',
            },
            round,
          )
        ).streak,
      );
    }

    /*
     * The recorded call was identical in all four rounds, yet the streak
     * restarts at round 2 when the phantom disappears. An over-broad
     * declaration therefore costs real detection — hence the filtering.
     */
    expect(streaks).toEqual([
      1,
      2,
      1,
      2,
    ]);
  });

  it('holds an unhashable call at streak 1 without stalling its round-mates', async () => {
    /*
     * Bounds the cost of an unhashable argument. Such a call is compared
     * against its tool's declared set, which it is not a member of, so it
     * cannot match and stays at 1 however often it recurs — it is invisible to
     * detection. That is the fail-open contract: the price is paid by that call
     * alone, and its round-mates keep accumulating normally (the regression
     * above covers the case where it used to zero them too).
     *
     * Also pins the asymmetry: a tool whose calls are ALL unhashable has no
     * declared set, so it falls through to the ordinary per-call comparison
     * and DOES accumulate.
     */
    const detector = monitor();
    const memberStreaks: number[] = [];
    const droppedStreaks: number[] = [];
    for (const round of [
      0,
      1,
      2,
    ]) {
      await detector.declareRound(round, [
        {
          toolName: 'read',
          keyMaterial: {
            path: 'a',
          },
        },
        {
          toolName: 'read',
          keyMaterial: {
            size: 1n,
          },
        },
      ]);
      memberStreaks.push(
        (
          await detector.recordToolCall(
            'read',
            {
              path: 'a',
            },
            round,
          )
        ).streak,
      );
      droppedStreaks.push(
        (
          await detector.recordToolCall(
            'read',
            {
              size: 'fallback-identity',
            },
            round,
          )
        ).streak,
      );
    }

    expect(memberStreaks).toEqual([
      1,
      2,
      3,
    ]);
    expect(droppedStreaks).toEqual([
      1,
      1,
      1,
    ]);

    /* No declared set for the tool at all: ordinary per-call accumulation. */
    const allUnhashable = monitor();
    const soloStreaks: number[] = [];
    for (const round of [
      0,
      1,
      2,
    ]) {
      await allUnhashable.declareRound(round, [
        {
          toolName: 'read',
          keyMaterial: {
            size: 1n,
          },
        },
      ]);
      soloStreaks.push(
        (
          await allUnhashable.recordToolCall(
            'read',
            {
              size: 'fallback-identity',
            },
            round,
          )
        ).streak,
      );
    }
    expect(soloStreaks).toEqual([
      1,
      2,
      3,
    ]);
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

  it('does not refuse a resumed SINGLE call that inherits a fan-out streak', async () => {
    /*
     * The persisted shape holds one fingerprint per tool, so it cannot express
     * "this count was earned by the set {a,b,c}". Restoring a fan-out's streak
     * verbatim attached the whole count to whichever call was recorded last:
     * a resumed round consisting of just that one call then matched, inherited
     * the fan-out's evidence, and was BLOCKED on its first appearance — while
     * the model had done strictly less work than before the save. It was also
     * arbitrary, since it depended on which member happened to be last.
     *
     * `getState` therefore persists a multi-call round's streak as 1.
     * Under-counting on resume is the safe direction; the loop is re-observed
     * and re-accumulates from a correct baseline (asserted below).
     */
    const detector = monitor();
    const paths = [
      'a',
      'b',
      'c',
    ];
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
        await detector.recordToolCall(
          'read',
          {
            path,
          },
          round,
        );
      }
    }
    /* Round 1 reached observe (streak 2) before the save. */
    expect(
      (
        detector.getState() as {
          tools: Record<
            string,
            {
              streak: number;
            }
          >;
        }
      ).tools.read.streak,
    ).toBe(1);

    /* Resume with ONE call — the same one that was recorded last. */
    const resumed = new DoomLoopMonitor(resolveDoomLoopOption(true), detector.getState());
    await resumed.declareRound(0, [
      {
        toolName: 'read',
        keyMaterial: {
          path: 'c',
        },
      },
    ]);
    const solo = await resumed.recordToolCall(
      'read',
      {
        path: 'c',
      },
      0,
    );
    expect(solo.streak).toBe(2);
    expect(solo.verdict?.action).not.toBe('block');

    /* Detection is not lost: a repeating fan-out trips again after the resume. */
    const afterResume: number[] = [];
    for (const round of [
      1,
      2,
    ]) {
      await resumed.declareRound(
        round,
        paths.map((path) => ({
          toolName: 'read',
          keyMaterial: {
            path,
          },
        })),
      );
      let last = 0;
      for (const path of paths) {
        last = (
          await resumed.recordToolCall(
            'read',
            {
              path,
            },
            round,
          )
        ).streak;
      }
      afterResume.push(last);
    }
    expect(afterResume).toEqual([
      1,
      2,
    ]);
  });
});
