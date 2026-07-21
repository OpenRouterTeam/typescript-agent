/**
 * Unit tests for the doom-loop detection primitives (src/lib/doom-loop.ts).
 *
 * Everything here is pure and deterministic: fingerprints, canonicalization,
 * text-repetition detection, ladder resolution, and the DoomLoopMonitor state
 * machine. Loop integration (blocking, steering, stopping a real run) is
 * covered by doom-loop-integration.test.ts against scripted model responses.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DoomLoopOption, DoomLoopVerdict } from '../../src/lib/doom-loop.js';
import {
  canonicalizeKeyMaterial,
  DEFAULT_DOOM_LOOP_LADDER,
  DoomLoopMonitor,
  detectTextRepetition,
  fingerprintKeyMaterial,
  fingerprintToolCall,
  resolveDoomLoopOption,
  resolveLadderAction,
} from '../../src/lib/doom-loop.js';

// ---------------------------------------------------------------------------
// Canonicalization & fingerprints
// ---------------------------------------------------------------------------

describe('canonicalizeKeyMaterial', () => {
  it('is insensitive to object key order, recursively', () => {
    expect(
      canonicalizeKeyMaterial({
        b: 2,
        a: {
          d: 4,
          c: 3,
        },
      }),
    ).toBe(
      canonicalizeKeyMaterial({
        a: {
          c: 3,
          d: 4,
        },
        b: 2,
      }),
    );
  });

  it('distinguishes array order (arrays are ordered data)', () => {
    expect(
      canonicalizeKeyMaterial([
        1,
        2,
      ]),
    ).not.toBe(
      canonicalizeKeyMaterial([
        2,
        1,
      ]),
    );
  });

  it('drops undefined object entries, matching JSON semantics', () => {
    expect(
      canonicalizeKeyMaterial({
        a: 1,
        b: undefined,
      }),
    ).toBe(
      canonicalizeKeyMaterial({
        a: 1,
      }),
    );
  });

  it('canonicalizes primitives and null deterministically', () => {
    expect(canonicalizeKeyMaterial('query')).toBe('"query"');
    expect(canonicalizeKeyMaterial(42)).toBe('42');
    expect(canonicalizeKeyMaterial(null)).toBe('null');
    expect(canonicalizeKeyMaterial(Number.NaN)).toBe('null');
  });

  it('throws on circular key material instead of hanging', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => canonicalizeKeyMaterial(circular)).toThrow(/circular/i);
  });
});

describe('fingerprints', () => {
  it('produces identical fingerprints for identical calls', () => {
    expect(
      fingerprintToolCall('web_search', {
        query: 'openrouter agent sdk',
      }),
    ).toBe(
      fingerprintToolCall('web_search', {
        query: 'openrouter agent sdk',
      }),
    );
  });

  it('distinguishes different arguments', () => {
    expect(
      fingerprintToolCall('web_search', {
        query: 'a',
      }),
    ).not.toBe(
      fingerprintToolCall('web_search', {
        query: 'b',
      }),
    );
  });

  it('includes the tool name: same args on different tools never collide by construction', () => {
    expect(
      fingerprintToolCall('web_search', {
        q: 'x',
      }),
    ).not.toBe(
      fingerprintToolCall('fetch_page', {
        q: 'x',
      }),
    );
  });

  it('is stable across processes (documented vector for the Python/Go ports)', () => {
    // If this vector changes, the fingerprint algorithm changed — a breaking
    // cross-port contract change, not a refactor.
    expect(
      fingerprintToolCall('bash', {
        command: 'ls -la',
        cwd: '/tmp',
      }),
    ).toBe('0a7c2d7e481421');
    expect(fingerprintKeyMaterial('I am stuck.')).toBe('1dc6b803db9a8e');
  });
});

// ---------------------------------------------------------------------------
// Text repetition
// ---------------------------------------------------------------------------

describe('detectTextRepetition', () => {
  it('detects a single repeated token ("no no no ...")', () => {
    const result = detectTextRepetition('no no no no no no no no no no no no');
    expect(result).not.toBeNull();
    expect(result?.periodTokens).toBe(1);
    expect(result?.repeats).toBe(12);
    expect(result?.sample).toBe('no');
  });

  it('detects a repeating phrase block', () => {
    const phrase = 'I am stuck in a loop.';
    const result = detectTextRepetition(Array(6).fill(phrase).join(' '));
    expect(result).not.toBeNull();
    expect(result?.periodTokens).toBe(6);
    expect(result?.repeats).toBe(6);
    expect(result?.sample).toBe(phrase);
  });

  it('only counts repetition at the tail — recovered output does not fire', () => {
    const looping = Array(6).fill('retry now').join(' ');
    const recovered = `${looping} but then I found the actual answer to your question about databases`;
    expect(detectTextRepetition(recovered)).toBeNull();
  });

  it('stays quiet on ordinary prose', () => {
    expect(
      detectTextRepetition(
        'The quick brown fox jumps over the lazy dog and then runs far away into the woods.',
      ),
    ).toBeNull();
  });

  it('stays quiet below the repeat threshold (legit emphasis)', () => {
    // "very very very good" — 3 repeats of a 1-token block, under minRepeats=4.
    expect(
      detectTextRepetition('this is very very very good and quite long enough overall'),
    ).toBeNull();
  });

  it('is deterministic: same input, same result object', () => {
    const text = Array(8).fill('loop detected').join(' ');
    expect(detectTextRepetition(text)).toEqual(detectTextRepetition(text));
  });

  it('honors custom thresholds', () => {
    const text = 'ha ha ha';
    expect(detectTextRepetition(text)).toBeNull(); // default minRepeats=4, minCoveredTokens=12
    expect(
      detectTextRepetition(text, {
        minRepeats: 3,
        minCoveredTokens: 3,
      }),
    ).toMatchObject({
      repeats: 3,
      periodTokens: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Ladder
// ---------------------------------------------------------------------------

describe('resolveLadderAction', () => {
  const ladder = {
    observe: 2,
    steer: false as const,
    block: 3,
    stop: 6,
  };

  it('maps streaks onto rungs with >= semantics, strongest wins', () => {
    expect(
      resolveLadderAction(ladder, 1, {
        allowBlock: true,
      }),
    ).toBeUndefined();
    expect(
      resolveLadderAction(ladder, 2, {
        allowBlock: true,
      }),
    ).toBe('observe');
    expect(
      resolveLadderAction(ladder, 3, {
        allowBlock: true,
      }),
    ).toBe('block');
    expect(
      resolveLadderAction(ladder, 5, {
        allowBlock: true,
      }),
    ).toBe('block');
    expect(
      resolveLadderAction(ladder, 6, {
        allowBlock: true,
      }),
    ).toBe('stop');
  });

  it('falls through block for text verdicts (allowBlock: false)', () => {
    expect(
      resolveLadderAction(ladder, 3, {
        allowBlock: false,
      }),
    ).toBe('observe');
    expect(
      resolveLadderAction(ladder, 6, {
        allowBlock: false,
      }),
    ).toBe('stop');
  });

  it('respects disabled rungs', () => {
    expect(
      resolveLadderAction(
        {
          observe: false,
          steer: false,
          block: false,
          stop: 4,
        },
        3,
        {
          allowBlock: true,
        },
      ),
    ).toBeUndefined();
  });
});

describe('resolveDoomLoopOption', () => {
  it('returns null for undefined/false (detection off by default)', () => {
    expect(resolveDoomLoopOption(undefined)).toBeNull();
    expect(resolveDoomLoopOption(false)).toBeNull();
  });

  it('true resolves to the documented defaults', () => {
    const resolved = resolveDoomLoopOption(true);
    expect(resolved?.ladder).toEqual(DEFAULT_DOOM_LOOP_LADDER);
    expect(resolved?.text.enabled).toBe(true);
  });

  it('merges partial ladders and clamps invalid thresholds to defaults', () => {
    const resolved = resolveDoomLoopOption({
      ladder: {
        block: 5,
        stop: 0, // invalid (< 1) → default
      },
    });
    expect(resolved?.ladder.block).toBe(5);
    expect(resolved?.ladder.stop).toBe(DEFAULT_DOOM_LOOP_LADDER.stop);
    expect(resolved?.ladder.observe).toBe(DEFAULT_DOOM_LOOP_LADDER.observe);
  });

  it('text: false disables text detection', () => {
    expect(
      resolveDoomLoopOption({
        text: false,
      })?.text.enabled,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Monitor state machine
// ---------------------------------------------------------------------------

function makeMonitor(overrides?: DoomLoopOption) {
  const config = resolveDoomLoopOption(overrides ?? true);
  if (!config) {
    throw new Error('test setup: config must resolve');
  }
  return new DoomLoopMonitor(config);
}

describe('DoomLoopMonitor — tool-call streaks', () => {
  it('fires observe at 2 and block at 3 identical calls (default ladder)', () => {
    const monitor = makeMonitor();
    const args = {
      query: 'same thing',
    };
    expect(monitor.recordToolCall('search', args)).toBeUndefined();
    expect(monitor.recordToolCall('search', args)).toMatchObject({
      action: 'observe',
      streak: 2,
      detector: 'tool-fingerprint',
      toolName: 'search',
    });
    expect(monitor.recordToolCall('search', args)).toMatchObject({
      action: 'block',
      streak: 3,
    });
  });

  it('escalates to stop at the stop threshold', () => {
    const monitor = makeMonitor();
    let last: DoomLoopVerdict | undefined;
    for (let i = 0; i < 6; i++) {
      last = monitor.recordToolCall('search', {
        q: 'x',
      });
    }
    expect(last).toMatchObject({
      action: 'stop',
      streak: 6,
    });
  });

  it('different arguments reset the streak', () => {
    const monitor = makeMonitor();
    monitor.recordToolCall('search', {
      q: 'a',
    });
    monitor.recordToolCall('search', {
      q: 'a',
    });
    // change breaks the streak…
    expect(
      monitor.recordToolCall('search', {
        q: 'b',
      }),
    ).toBeUndefined();
    // …and the next identical call counts from the new base.
    expect(
      monitor.recordToolCall('search', {
        q: 'b',
      }),
    ).toMatchObject({
      streak: 2,
    });
  });

  it('interleaved calls to OTHER tools do not reset a tool streak', () => {
    // search X, read file, search X, read file, search X → search streak = 3.
    const monitor = makeMonitor();
    const search = {
      q: 'x',
    };
    monitor.recordToolCall('search', search);
    monitor.recordToolCall('read_file', {
      path: '/a',
    });
    expect(monitor.recordToolCall('search', search)).toMatchObject({
      action: 'observe',
      streak: 2,
    });
    monitor.recordToolCall('read_file', {
      path: '/b',
    });
    expect(monitor.recordToolCall('search', search)).toMatchObject({
      action: 'block',
      streak: 3,
    });
  });

  it('argument key order does not defeat detection', () => {
    const monitor = makeMonitor();
    monitor.recordToolCall('run', {
      cmd: 'ls',
      cwd: '/tmp',
    });
    expect(
      monitor.recordToolCall('run', {
        cwd: '/tmp',
        cmd: 'ls',
      }),
    ).toMatchObject({
      streak: 2,
    });
  });

  it('repeated EMPTY calls trip the detector (the empty-tool-call doom loop)', () => {
    const monitor = makeMonitor();
    expect(monitor.recordToolCall('list_tasks', {})).toBeUndefined();
    expect(monitor.recordToolCall('list_tasks', {})).toMatchObject({
      action: 'observe',
      streak: 2,
    });
    expect(monitor.recordToolCall('list_tasks', {})).toMatchObject({
      action: 'block',
      streak: 3,
    });
  });

  it('is deterministic: two monitors fed the same sequence agree exactly', () => {
    const script: Array<
      [
        string,
        unknown,
      ]
    > = [
      [
        'a',
        {
          x: 1,
        },
      ],
      [
        'b',
        {},
      ],
      [
        'a',
        {
          x: 1,
        },
      ],
      [
        'a',
        {
          x: 2,
        },
      ],
      [
        'a',
        {
          x: 2,
        },
      ],
    ];
    const run = () => {
      const monitor = makeMonitor();
      return script.map(([name, args]) => monitor.recordToolCall(name, args) ?? null);
    };
    expect(run()).toEqual(run());
  });
});

describe('DoomLoopMonitor — text', () => {
  it('within-response repetition can stop immediately when repeats cross the stop rung', () => {
    const monitor = makeMonitor();
    const verdict = monitor.recordAssistantText(Array(20).fill('I am stuck.').join(' '));
    expect(verdict).toMatchObject({
      detector: 'text-repetition',
      action: 'stop',
      streak: 20,
    });
  });

  it('cross-step identical text builds a streak (block downgrades to observe for text)', () => {
    const monitor = makeMonitor();
    expect(monitor.recordAssistantText('Let me try that again.')).toBeUndefined();
    expect(monitor.recordAssistantText('Let me try that again.')).toMatchObject({
      detector: 'text-streak',
      action: 'observe',
      streak: 2,
    });
    // Streak 3 crosses the block rung, but text cannot be blocked → observe.
    expect(monitor.recordAssistantText('Let me try that again.')).toMatchObject({
      detector: 'text-streak',
      action: 'observe',
      streak: 3,
    });
    for (let i = 0; i < 2; i++) {
      monitor.recordAssistantText('Let me try that again.');
    }
    expect(monitor.recordAssistantText('Let me try that again.')).toMatchObject({
      action: 'stop',
      streak: 6,
    });
  });

  it('whitespace-only differences do not defeat the cross-step streak', () => {
    const monitor = makeMonitor();
    monitor.recordAssistantText('Retrying   the\nsame plan.');
    expect(monitor.recordAssistantText('Retrying the same plan.')).toMatchObject({
      streak: 2,
    });
  });

  it('empty text (tool-only turns) neither counts nor resets', () => {
    const monitor = makeMonitor();
    monitor.recordAssistantText('same');
    monitor.recordAssistantText('');
    monitor.recordAssistantText('   ');
    expect(monitor.recordAssistantText('same')).toMatchObject({
      streak: 2,
    });
  });

  it('text: false disables both text detectors', () => {
    const monitor = makeMonitor({
      text: false,
    });
    expect(monitor.recordAssistantText(Array(30).fill('loop').join(' '))).toBeUndefined();
  });
});

describe('DoomLoopMonitor — state round-trip', () => {
  it('serializes to plain JSON and resumes counting where it left off', () => {
    const monitor = makeMonitor();
    monitor.recordToolCall('search', {
      q: 'x',
    });
    monitor.recordToolCall('search', {
      q: 'x',
    });

    // Simulate serialize → store → resume (JSON round-trip proves plainness).
    const blob = JSON.parse(JSON.stringify(monitor.getState()));
    const config = resolveDoomLoopOption(true);
    if (!config) {
      throw new Error('unreachable');
    }
    const resumed = new DoomLoopMonitor(config, blob);

    expect(
      resumed.recordToolCall('search', {
        q: 'x',
      }),
    ).toMatchObject({
      action: 'block',
      streak: 3, // 2 before the round-trip + 1 after
    });
  });

  it('ignores corrupt persisted state instead of crashing the run', () => {
    const config = resolveDoomLoopOption(true);
    if (!config) {
      throw new Error('unreachable');
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const monitor = new DoomLoopMonitor(config, 'not an object');
      expect(
        monitor.recordToolCall('search', {
          q: 'x',
        }),
      ).toBeUndefined(); // fresh state, streak 1
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('getState returns a snapshot, not a live reference', () => {
    const monitor = makeMonitor();
    monitor.recordToolCall('a', {});
    const snapshot = monitor.getState();
    monitor.recordToolCall('a', {});
    expect(snapshot.tools['a']?.streak).toBe(1);
    expect(monitor.getState().tools['a']?.streak).toBe(2);
  });
});
