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

  it('scores each call individually when the fan-out membership changes', async () => {
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
    /*
     * Round 3 changes a member: the ROUND identity resets (progress), but `a`
     * itself is on its third consecutive round — the per-call detector flags
     * it while the genuinely new `z` runs free. Swapping one argument while
     * re-issuing the rest is not a loop escape.
     */
    expect(actions[2]).toEqual([
      'block',
      'none',
    ]);
    expect(actions[3]).toEqual([
      'block',
      'observe',
    ]);
  });

  it('flags the calls of a partial repeat that actually repeated', async () => {
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

    /*
     * A strict subset is a different ROUND, but `a` and `b` are each on their
     * second consecutive round: doing strictly less work does not make the
     * re-issued calls progress. Observe only — dropping work never escalates
     * faster than repeating it.
     */
    expect(actions[1]).toEqual([
      'observe',
      'observe',
    ]);
  });

  it('flags the repeated members of a superset round, never the new one', async () => {
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
     * Round 3 adds `c`: the ROUND is progress, and `c` must run — the original
     * superset bug blocked it via a transient identity match, order-
     * dependently. Under per-call scoring `a` and `b` are flagged because each
     * genuinely IS on its third consecutive round (the model re-read both
     * while adding one file), while `c` executes untouched. Unlike the old
     * bug, this is order-independent — see the permutation test below.
     */
    expect(actions[1]).toEqual([
      'observe',
      'observe',
    ]);
    expect(actions[2]).toEqual([
      'block',
      'block',
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
     * Emission order must not decide any call's outcome. While the set
     * accumulated, `[a,b,c]` blocked its `b` call and `[c,a,b]` fired nothing
     * — same calls, same history, different outcome. Per-call verdicts follow
     * each call's own identity, so a permutation reorders the verdicts with
     * the calls but never changes what any call receives.
     */
    expect(inOrder[2]).toEqual([
      'block',
      'block',
      'none',
    ]);
    expect(permuted[2]).toEqual([
      'none',
      'block',
      'block',
    ]);
  });

  it('scores an expanding fan-out per call: repeats climb, each new call runs free', async () => {
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

    /*
     * Every round adds work, so no ROUND repeats its predecessor — but `a` is
     * re-issued in all four rounds and `b` in three. Per-call evidence tracks
     * each: the newest call is always clean, the oldest climbs the ladder.
     * (Genuine incremental exploration re-reads nothing and stays silent; a
     * tool that legitimately re-reads its anchors opts out via `loopKey`.)
     */
    expect(actions).toEqual([
      [
        'none',
      ],
      [
        'observe',
        'none',
      ],
      [
        'block',
        'observe',
        'none',
      ],
      [
        'block',
        'block',
        'observe',
        'none',
      ],
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

  it('scores an UNDECLARED multi-call round per call, order-independently', async () => {
    /*
     * Pins the undeclared path (server-tool records, direct callers). The
     * round SET is unknowable there, but per-call evidence needs no
     * declaration: every repeated fingerprint accumulates its own count, so a
     * repeating undeclared fan-out now flags EVERY repeated member instead of
     * only whichever happened to be recorded last, and flipping the emission
     * order no longer changes any call's outcome.
     *
     * Still worth pinning: verdicts here can reach `stop` at the default
     * ladder's streak 6 (server-tool verdicts cannot `block`, but they can
     * stop a run), and a repeat inside a *varying* round accumulates on the
     * repeated member exactly as on the declared path.
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

    /* Both repeated members accumulate, not just the last-recorded one. */
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
        '2:observe',
        '2:observe',
      ],
    ]);

    /* Flipping the order changes nothing about any call's outcome. */
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
        '2:observe',
      ],
    ]);

    /* A varying round accumulates on the repeated member wherever it sits. */
    expect(
      await undeclared([
        [
          'b',
          'a',
        ],
        [
          'b',
          'c',
        ],
        [
          'b',
          'd',
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
      [
        '3:block',
        '1:none',
      ],
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
    /* Recorded with a fallback identity, as the engine would — for the
     * FIRST time; earlier rounds never recorded it. */
    const dropped = await detector.recordToolCall(
      'read',
      {
        size: 'fallback-identity',
      },
      2,
    );

    /* The real repeat accumulates. */
    expect(member.streak).toBe(3);
    /* The non-member's first-ever appearance inherits nothing — not the
     * round streak, and (never having been recorded) no per-call count. */
    expect(dropped.streak).toBe(1);
    expect(dropped.verdict).toBeUndefined();
  });

  it('accumulates per-call evidence for an unhashable call reissued verbatim', async () => {
    /*
     * A call dropped from the declaration (unhashable key material) records
     * under a fallback identity as a NON-member: it can never inherit or move
     * the round's counters. Its OWN repetition is still evidence — before
     * per-call streaks it was pinned at 1 forever, a documented detection
     * loss ("costs detection for its own call only"). Now the fallback
     * identity accumulates like any repeat, while the round members are
     * unaffected either way.
     */
    const detector = monitor();
    const droppedStreaks: number[] = [];
    const memberStreaks: number[] = [];
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
      2,
      3,
    ]);
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

    /*
     * The non-member was genuinely recorded in both rounds, so on resume its
     * OWN per-call count continues (2 -> 3) — earned evidence, not the round
     * streak leaking. The K2 bug this test pins was different: the saved
     * ROUND count attached to the non-member's fingerprint, so it inherited
     * evidence it never earned while the real repeat lost its own. The guard
     * for that is the identity pairing, asserted below via the member.
     */
    const resumedNonMember = new DoomLoopMonitor(resolveDoomLoopOption(true), detector.getState());
    const ownRepeat = await resumedNonMember.recordToolCall(
      'read',
      {
        size: 'fallback-identity',
      },
      0,
    );
    expect(ownRepeat.streak).toBe(3);

    /* A call NEVER recorded before the save inherits nothing on resume. */
    const resumedFresh = new DoomLoopMonitor(resolveDoomLoopOption(true), detector.getState());
    const fresh = await resumedFresh.recordToolCall(
      'read',
      {
        size: 'never-seen-before',
      },
      0,
    );
    expect(fresh.streak).toBe(1);
    expect(fresh.verdict).toBeUndefined();

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

  it('keeps counting a recorded call when a declared-but-never-recorded member disappears', async () => {
    /*
     * A phantom member — declared but never recorded (a manual tool, a
     * PermissionRequest denial) — inflates the ROUND's identity, so the round
     * streak resets when the phantom stops being emitted. That used to zero
     * detection for the sibling that WAS recorded every round; per-call
     * evidence is immune, because it follows the call's own fingerprint
     * rather than the round set. The engine still filters phantoms out of
     * declarations (`isAutoResolvableTool`, `hookDeniedCalls` in
     * `beginDoomLoopRound`) so the ROUND streak stays meaningful too.
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

    /* Identical call, four consecutive rounds: uninterrupted evidence. */
    expect(streaks).toEqual([
      1,
      2,
      3,
      4,
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

  it('continues a resumed FAN-OUT streak, exactly like a single-call streak', async () => {
    /*
     * The round SET is persisted (when multi-call), so a doom loop spanning a
     * serialize/resume boundary is still a doom loop: the resumed identical
     * fan-out picks its count back up instead of getting a fresh grace window.
     * Losing this across every save meant approval pauses reset condemned
     * fan-outs and per-turn-resume topologies never accumulated at all.
     */
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

    /* JSON round-trip: the set must survive real serialization. */
    const wire = JSON.parse(JSON.stringify(detector.getState())) as unknown;
    const resumed = new DoomLoopMonitor(resolveDoomLoopOption(true), wire);
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

    /* Streak was 2 at save; the identical resumed fan-out continues to 3. */
    expect(record.streak).toBe(3);
    expect(record.verdict?.action).toBe('block');
  });

  it('keeps counting a repeat when a paused HITL member drops from the resumed round', async () => {
    /*
     * A HITL member that pauses is recorded in the round where it pauses, but
     * the resumed batch no longer contains it — so the tool's ROUND identity
     * differs and the round streak resets. Before per-call evidence, that
     * granted the loop a fresh grace window on every pause. The repeated
     * working call now carries its own count through the membership change.
     */
    const detector = monitor();
    const workStreaks: string[] = [];
    for (const round of [
      0,
      1,
      2,
    ]) {
      /* Round 0 includes the gated call; the resumed rounds do not. */
      const members =
        round === 0
          ? [
              'work',
              'gated',
            ]
          : [
              'work',
            ];
      await detector.declareRound(
        round,
        members.map((path) => ({
          toolName: 'deploy',
          keyMaterial: {
            path,
          },
        })),
      );
      for (const path of members) {
        const record = await detector.recordToolCall(
          'deploy',
          {
            path,
          },
          round,
        );
        if (path === 'work') {
          workStreaks.push(`${record.streak}:${record.verdict?.action ?? 'none'}`);
        }
      }
    }

    expect(workStreaks).toEqual([
      '1:none',
      '2:observe',
      '3:block',
    ]);
  });

  it('bounds a mixed-evidence round to one message per distinct fact', async () => {
    /*
     * One round can carry TWO pieces of evidence: `[a]`, `[a,b]`, `[a,b]` —
     * by round 3, `a` is a 3-peat call (per-call branch) while `{a,b}` is a
     * 2-peat set (round branch), so the round legitimately renders two
     * DIFFERENT messages stating two different facts. What must hold is the
     * bound: same evidence -> byte-identical text, so the steer queue carries
     * at most one message per distinct fact per tool per round — never one
     * per call. The wide-round test below pins the N-collapses-to-1 case;
     * this pins the two-facts case at exactly 2, with the members of each
     * fact sharing text.
     */
    const detector = new DoomLoopMonitor(
      resolveDoomLoopOption({
        ladder: {
          steer: 2,
        },
      }),
    );
    const rounds = [
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
      ],
    ];
    const lastRound = rounds.length - 1;
    const messages: string[] = [];
    for (const [round, paths] of rounds.entries()) {
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
        if (round === lastRound && record.verdict) {
          messages.push(record.verdict.message);
        }
      }
    }

    /*
     * Final round: `a` is a 3-peat call (per-call branch, count 3) while
     * `{a,b}` is a 2-peat set (`b` ties the round streak, round-set branch).
     * Two verdicts, two distinct messages — one per fact, not one per call.
     */
    expect(messages).toHaveLength(2);
    expect(new Set(messages).size).toBe(2);
    expect(messages[0]).toContain('3 consecutive rounds');
    expect(messages[1]).toContain('same set of 2 parallel calls');
  });

  it('collapses per-call steer messages across a wide repeating round', async () => {
    /*
     * When per-call counts decide for MANY members at once (a wide fan-out
     * repeated, then widened by one call), each member gets its own verdict.
     * The steer rung dedupes by exact message text, so per-call messages must
     * not embed the individual fingerprint — same tool + same count must be
     * byte-identical, or a 20-wide round queues 20 near-identical corrections
     * into one injected prompt. The refused call is identified by the block
     * output's position and the verdict payload's `fingerprint`; the message
     * text does not need to repeat it.
     */
    const detector = new DoomLoopMonitor(
      resolveDoomLoopOption({
        ladder: {
          steer: 2,
        },
      }),
    );
    const wide = Array.from(
      {
        length: 20,
      },
      (_, index) => `f${index}`,
    );
    const messages = new Set<string>();
    let verdictCount = 0;
    for (const [round, paths] of [
      wide,
      wide,
      [
        ...wide,
        'new',
      ],
    ].entries()) {
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
        if (round === 2 && record.verdict) {
          verdictCount++;
          messages.add(record.verdict.message);
        }
      }
    }

    /* All 20 repeated members fire; the steer queue sees ONE correction. */
    expect(verdictCount).toBe(20);
    expect(messages.size).toBe(1);
  });

  it('persists per-call evidence when the round has shrunk to a single call', async () => {
    /*
     * When a round SHRINKS (a paused HITL member drops out), the round streak
     * resets while the per-call count keeps climbing — per-call evidence is
     * then the ONLY evidence, held by a single-call round. The save-time
     * omission of `callStreaks` for "plain" single-call rounds must not fire
     * here: dropping the count handed the repeat a fresh grace window on
     * resume, reaching block a full round later than the in-memory behavior.
     */
    const detector = monitor();
    await detector.declareRound(0, [
      {
        toolName: 'deploy',
        keyMaterial: {
          path: 'work',
        },
      },
      {
        toolName: 'deploy',
        keyMaterial: {
          path: 'gated',
        },
      },
    ]);
    await detector.recordToolCall(
      'deploy',
      {
        path: 'work',
      },
      0,
    );
    await detector.recordToolCall(
      'deploy',
      {
        path: 'gated',
      },
      0,
    );
    /* The gated call paused; the resumed round is just the working call. */
    await detector.declareRound(1, [
      {
        toolName: 'deploy',
        keyMaterial: {
          path: 'work',
        },
      },
    ]);
    const beforeSave = await detector.recordToolCall(
      'deploy',
      {
        path: 'work',
      },
      1,
    );
    expect(beforeSave.streak).toBe(2);

    /* Save/resume mid-loop (approval pause): the count must survive. */
    const wire = JSON.parse(JSON.stringify(detector.getState())) as unknown;
    const resumed = new DoomLoopMonitor(resolveDoomLoopOption(true), wire);
    await resumed.declareRound(0, [
      {
        toolName: 'deploy',
        keyMaterial: {
          path: 'work',
        },
      },
    ]);
    const afterResume = await resumed.recordToolCall(
      'deploy',
      {
        path: 'work',
      },
      0,
    );
    expect(afterResume.streak).toBe(3);
    expect(afterResume.verdict?.action).toBe('block');
  });

  it('scores a resumed SINGLE call on its own earned evidence, never inherited', async () => {
    /*
     * Both the round set and the per-call counts persist, so evidence follows
     * whoever EARNED it. A member of the saved fan-out resumed alone continues
     * its own count — it genuinely appeared in consecutive rounds, and which
     * member it is no longer matters (the original bug attached the whole
     * fan-out count to whichever call was recorded last, arbitrarily by
     * emission order). A call never recorded before the save inherits nothing.
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
    /* The streak survives the save, paired with its set and per-call counts. */
    const saved = detector.getState() as {
      tools: Record<
        string,
        {
          streak: number;
          roundFingerprints?: string[];
          callStreaks?: Record<string, number>;
        }
      >;
    };
    expect(saved.tools.read.streak).toBe(2);
    expect(saved.tools.read.roundFingerprints).toHaveLength(3);
    /*
     * Steady state — every member's per-call count equals the round streak —
     * is exactly the case where `callStreaks` carries no information beyond
     * the set, so getState() omits it (persisting it stored each 64-char hash
     * twice). restore() rebuilds `{member: streak}` for the whole set; the
     * resume assertions below are what actually pin that reconstruction.
     */
    expect(saved.tools.read.callStreaks).toBeUndefined();

    /*
     * ANY member resumed alone continues its own earned count (2 -> 3): a
     * third consecutive re-read of the same file is a repeat regardless of
     * what happened to its former round-mates. Emission order is irrelevant —
     * every member carries the same earned evidence.
     */
    for (const path of paths) {
      const resumed = new DoomLoopMonitor(resolveDoomLoopOption(true), detector.getState());
      await resumed.declareRound(0, [
        {
          toolName: 'read',
          keyMaterial: {
            path,
          },
        },
      ]);
      const solo = await resumed.recordToolCall(
        'read',
        {
          path,
        },
        0,
      );
      expect(solo.streak).toBe(3);
      expect(solo.verdict?.action).toBe('block');
    }

    /* A call never recorded before the save inherits nothing. */
    const resumedFresh = new DoomLoopMonitor(resolveDoomLoopOption(true), detector.getState());
    await resumedFresh.declareRound(0, [
      {
        toolName: 'read',
        keyMaterial: {
          path: 'never-before',
        },
      },
    ]);
    const fresh = await resumedFresh.recordToolCall(
      'read',
      {
        path: 'never-before',
      },
      0,
    );
    expect(fresh.streak).toBe(1);
    expect(fresh.verdict).toBeUndefined();
  });

  /*
   * The steer rung dedupes queued guidance on exact message text, so one round
   * of evidence must render ONE string. On the undeclared path (server-tool
   * records, direct monitor consumers, the SDK ports) each call is recorded
   * alone, so a round's `callSet` holds only that call: the last-recorded call
   * tied at `roundStreak == callStreak` and rendered the fingerprint-bearing
   * single-call text, while its round-mates rendered the fingerprint-free
   * per-call text — two strings for one round, defeating the dedupe.
   */
  it('renders one verdict text per undeclared multi-call round', async () => {
    const detector = new DoomLoopMonitor(resolveDoomLoopOption(true));
    for (let round = 1; round <= 4; round++) {
      const texts: string[] = [];
      for (const cmd of [
        'a',
        'b',
      ]) {
        const result = await detector.recordToolCall(
          'sh',
          {
            cmd,
          },
          round,
          {
            allowBlock: false,
          },
        );
        if (result.verdict) {
          texts.push(result.verdict.message);
        }
      }
      // Either the round produced no verdict yet, or every member of it
      // produced byte-identical text.
      expect(new Set(texts).size).toBeLessThanOrEqual(1);
    }
  });

  /* A DECLARED single-call round still names the argument fingerprint. */
  it('keeps the fingerprint-bearing text for a genuine single-call round', async () => {
    const detector = new DoomLoopMonitor(resolveDoomLoopOption(true));
    let last: string | undefined;
    for (let round = 1; round <= 3; round++) {
      await detector.declareRound(round, [
        {
          toolName: 'read',
          keyMaterial: {
            path: 'same',
          },
        },
      ]);
      const result = await detector.recordToolCall(
        'read',
        {
          path: 'same',
        },
        round,
      );
      last = result.verdict?.message ?? last;
    }
    expect(last).toContain('identical arguments (fingerprint');
  });
});
