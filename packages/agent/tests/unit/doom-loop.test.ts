/**
 * Unit tests for the doom-loop detection primitives (src/lib/doom-loop.ts).
 *
 * Everything here is pure and deterministic: JCS canonicalization, SHA-256
 * fingerprints (asserted against the cross-port vector file),
 * text-repetition detection, ladder resolution, loopKey resolution, and the
 * DoomLoopMonitor state machine (round-scoped streaks). Loop integration
 * (blocking, steering, stopping a real run) is covered by
 * doom-loop-integration.test.ts against scripted model responses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DoomLoopCallRecord,
  DoomLoopOption,
  DoomLoopVerdict,
} from '../../src/lib/doom-loop.js';
import {
  canonicalizeKeyMaterial,
  DEFAULT_DOOM_LOOP_LADDER,
  DoomLoopMonitor,
  detectTextRepetition,
  fingerprintKeyMaterial,
  fingerprintToolCall,
  MAX_CANONICALIZE_DEPTH,
  resolveDoomLoopOption,
  resolveLadderAction,
  resolveLoopKeyMaterial,
} from '../../src/lib/doom-loop.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Canonicalization (RFC 8785 / JCS semantics)
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

  it('canonicalizes primitives per JCS', () => {
    expect(canonicalizeKeyMaterial('query')).toBe('"query"');
    expect(canonicalizeKeyMaterial(42)).toBe('42');
    expect(canonicalizeKeyMaterial(null)).toBe('null');
    // JCS number serialization is ECMAScript JSON.stringify:
    expect(canonicalizeKeyMaterial(-0)).toBe('0');
    expect(canonicalizeKeyMaterial(1e21)).toBe('1e+21');
  });

  it('REJECTS values RFC 8785 cannot represent (engine falls back)', () => {
    expect(() => canonicalizeKeyMaterial(Number.NaN)).toThrow(/non-finite/i);
    expect(() => canonicalizeKeyMaterial(Number.POSITIVE_INFINITY)).toThrow(/non-finite/i);
    expect(() =>
      canonicalizeKeyMaterial({
        id: 10n,
      }),
    ).toThrow(/bigint/i);
  });

  it('throws on circular key material instead of hanging', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => canonicalizeKeyMaterial(circular)).toThrow(/circular/i);
  });

  it('throws on nesting past MAX_CANONICALIZE_DEPTH instead of overflowing the stack', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < MAX_CANONICALIZE_DEPTH + 10; i++) {
      deep = [
        deep,
      ];
    }
    expect(() => canonicalizeKeyMaterial(deep)).toThrow(/deeper than/i);
  });
});

// ---------------------------------------------------------------------------
// Fingerprints — the cross-port contract
// ---------------------------------------------------------------------------

interface VectorFile {
  toolCallVectors: Array<{
    name: string;
    toolName: string;
    keyMaterial: unknown;
    jcs: string;
    fingerprint: string;
  }>;
  keyMaterialVectors: Array<{
    name: string;
    keyMaterial: unknown;
    jcs: string;
    fingerprint: string;
  }>;
}

const vectors = JSON.parse(
  readFileSync(join(__dirname, '../vectors/doom-loop-fingerprints.json'), 'utf8'),
) as VectorFile;

describe('fingerprints (cross-port vectors)', () => {
  it('reproduces every tool-call vector: sha256(utf8(toolName + "\\n" + jcs))', async () => {
    expect(vectors.toolCallVectors.length).toBeGreaterThan(5);
    for (const vector of vectors.toolCallVectors) {
      expect(canonicalizeKeyMaterial(vector.keyMaterial), vector.name).toBe(vector.jcs);
      expect(await fingerprintToolCall(vector.toolName, vector.keyMaterial), vector.name).toBe(
        vector.fingerprint,
      );
    }
  });

  it('reproduces every bare key-material vector', async () => {
    for (const vector of vectors.keyMaterialVectors) {
      expect(await fingerprintKeyMaterial(vector.keyMaterial), vector.name).toBe(
        vector.fingerprint,
      );
    }
  });

  it('produces 64-char lowercase hex (SHA-256)', async () => {
    const fp = await fingerprintToolCall('t', {});
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes the tool name: same args on different tools never collide by construction', async () => {
    expect(
      await fingerprintToolCall('web_search', {
        q: 'x',
      }),
    ).not.toBe(
      await fingerprintToolCall('fetch_page', {
        q: 'x',
      }),
    );
  });

  it('non-ASCII key material hashes over UTF-8 bytes (the Python/Go parity case)', async () => {
    const vector = vectors.toolCallVectors.find((v) => v.name.includes('non-ascii'));
    expect(vector).toBeDefined();
    if (vector) {
      expect(await fingerprintToolCall(vector.toolName, vector.keyMaterial)).toBe(
        vector.fingerprint,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// loopKey resolution (function | field list | false | absent)
// ---------------------------------------------------------------------------

describe('resolveLoopKeyMaterial', () => {
  const args = {
    command: 'ls',
    cwd: '/tmp',
    verbose: true,
  };

  it('absent declaration → full arguments', () => {
    expect(resolveLoopKeyMaterial(undefined, args)).toEqual({
      kind: 'key',
      keyMaterial: args,
    });
  });

  it('false → statically exempt', () => {
    expect(resolveLoopKeyMaterial(false, args)).toEqual({
      kind: 'exempt',
    });
  });

  it('field array → declarative subset (missing fields simply absent)', () => {
    expect(
      resolveLoopKeyMaterial(
        [
          'command',
          'cwd',
          'not_a_field',
        ],
        args,
      ),
    ).toEqual({
      kind: 'key',
      keyMaterial: {
        command: 'ls',
        cwd: '/tmp',
      },
    });
  });

  it('preserves __proto__ as a declared field', () => {
    const args = JSON.parse('{"__proto__":"declared"}') as Record<string, unknown>;
    const resolution = resolveLoopKeyMaterial(
      [
        '__proto__',
      ],
      args,
    );
    expect(resolution).toEqual({
      kind: 'key',
      keyMaterial: expect.objectContaining({
        ['__proto__']: 'declared',
      }),
    });
    if (resolution.kind === 'key') {
      expect(Object.getPrototypeOf(resolution.keyMaterial)).toBeNull();
    }
  });

  it('function returning a value → that value', () => {
    const resolution = resolveLoopKeyMaterial(
      (a: Record<string, unknown>) => String(a['command']).trim(),
      args,
    );
    expect(resolution).toEqual({
      kind: 'key',
      keyMaterial: 'ls',
    });
  });

  it('function returning null → per-call exemption', () => {
    expect(resolveLoopKeyMaterial(() => null, args)).toEqual({
      kind: 'exempt',
    });
  });

  it('function returning undefined → FALLBACK to full args with warning (not a colliding constant)', () => {
    const resolution = resolveLoopKeyMaterial(() => undefined, args);
    expect(resolution.kind).toBe('fallback');
    if (resolution.kind === 'fallback') {
      expect(resolution.keyMaterial).toBe(args);
      expect(resolution.warning).toMatch(/undefined/);
    }
  });

  it('throwing function → fallback to full args with warning', () => {
    const resolution = resolveLoopKeyMaterial(() => {
      throw new Error('loopKey bug');
    }, args);
    expect(resolution.kind).toBe('fallback');
    if (resolution.kind === 'fallback') {
      expect(resolution.keyMaterial).toBe(args);
      expect(resolution.warning).toMatch(/threw/);
    }
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

  it('DOCUMENTED MISS: paraphrased repetition does not trip (needs exact token blocks)', () => {
    const paraphrased = [
      'I am unable to find the file.',
      'I cannot locate the file.',
      'I am not able to find that file.',
      'The file cannot be found by me.',
      'Finding the file is not possible.',
      'I could not locate that file.',
    ].join(' ');
    expect(detectTextRepetition(paraphrased)).toBeNull();
  });

  it('is deterministic: same input, same result object', () => {
    const text = Array(8).fill('loop detected').join(' ');
    expect(detectTextRepetition(text)).toEqual(detectTextRepetition(text));
  });

  it('handles multi-megabyte input without tokenizing the full text (char-budget tail slice)', () => {
    // 4 MB of unique-ish tokens, ending in a loop. Correctness: still detected.
    const filler = Array.from(
      {
        length: 400_000,
      },
      (_, i) => `w${i}`,
    ).join(' ');
    const doomTail = Array(20).fill('stuck').join(' ');
    const result = detectTextRepetition(`${filler} ${doomTail}`);
    expect(result).toMatchObject({
      periodTokens: 1,
      repeats: 20,
    });
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

  it('falls through block for non-blockable verdicts (allowBlock: false)', () => {
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

  it('warns when block is enabled with stop disabled (unbounded block/re-issue hazard)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveDoomLoopOption({
      ladder: {
        block: 3,
        stop: false,
      },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stop disabled'));
  });

  it('warns on dead rungs (weaker threshold >= enabled stronger threshold)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveDoomLoopOption({
      ladder: {
        observe: 5,
        block: 2,
      },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"observe" (5) can never fire'));
  });

  it('does not warn on the default ladder', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveDoomLoopOption(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Monitor state machine (round-scoped streaks)
// ---------------------------------------------------------------------------

function makeMonitor(overrides?: DoomLoopOption) {
  const config = resolveDoomLoopOption(overrides ?? true);
  if (!config) {
    throw new Error('test setup: config must resolve');
  }
  return new DoomLoopMonitor(config);
}

describe('DoomLoopMonitor — tool-call streaks', () => {
  it('fires observe at 2 and block at 3 identical rounds (default ladder)', async () => {
    const monitor = makeMonitor();
    const args = {
      query: 'same thing',
    };
    expect((await monitor.recordToolCall('search', args, 1)).verdict).toBeUndefined();
    expect((await monitor.recordToolCall('search', args, 2)).verdict).toMatchObject({
      action: 'observe',
      streak: 2,
      detector: 'tool-fingerprint',
      toolName: 'search',
    });
    expect((await monitor.recordToolCall('search', args, 3)).verdict).toMatchObject({
      action: 'block',
      streak: 3,
    });
  });

  it('escalates to stop at the stop threshold', async () => {
    const monitor = makeMonitor();
    let last: DoomLoopCallRecord | undefined;
    for (let round = 1; round <= 6; round++) {
      last = await monitor.recordToolCall(
        'search',
        {
          q: 'x',
        },
        round,
      );
    }
    expect(last?.verdict).toMatchObject({
      action: 'stop',
      streak: 6,
    });
  });

  it('identical calls in the SAME round are duplicates: one streak increment, shared decision', async () => {
    const monitor = makeMonitor();
    const args = {
      q: 'parallel',
    };
    // 6 identical calls fanned out in ONE round — previously walked the
    // ladder to stop; now they are one piece of evidence.
    const first = await monitor.recordToolCall('search', args, 1);
    expect(first).toMatchObject({
      streak: 1,
      duplicateInRound: false,
    });
    for (let i = 0; i < 5; i++) {
      const dup = await monitor.recordToolCall('search', args, 1);
      expect(dup).toMatchObject({
        streak: 1,
        duplicateInRound: true,
      });
      expect(dup.verdict).toBeUndefined();
    }
    // The NEXT round increments normally.
    expect(await monitor.recordToolCall('search', args, 2)).toMatchObject({
      streak: 2,
      duplicateInRound: false,
    });
  });

  it('different arguments reset the streak', async () => {
    const monitor = makeMonitor();
    await monitor.recordToolCall(
      'search',
      {
        q: 'a',
      },
      1,
    );
    await monitor.recordToolCall(
      'search',
      {
        q: 'a',
      },
      2,
    );
    // change breaks the streak…
    expect(
      (
        await monitor.recordToolCall(
          'search',
          {
            q: 'b',
          },
          3,
        )
      ).verdict,
    ).toBeUndefined();
    // …and the next identical call counts from the new base.
    expect(
      (
        await monitor.recordToolCall(
          'search',
          {
            q: 'b',
          },
          4,
        )
      ).verdict,
    ).toMatchObject({
      streak: 2,
    });
  });

  it('interleaved calls to OTHER tools do not reset a tool streak', async () => {
    // search X, read file, search X, read file, search X → search streak = 3.
    const monitor = makeMonitor();
    const search = {
      q: 'x',
    };
    await monitor.recordToolCall('search', search, 1);
    await monitor.recordToolCall(
      'read_file',
      {
        path: '/a',
      },
      2,
    );
    expect((await monitor.recordToolCall('search', search, 3)).verdict).toMatchObject({
      action: 'observe',
      streak: 2,
    });
    await monitor.recordToolCall(
      'read_file',
      {
        path: '/b',
      },
      4,
    );
    expect((await monitor.recordToolCall('search', search, 5)).verdict).toMatchObject({
      action: 'block',
      streak: 3,
    });
  });

  it('argument key order does not defeat detection', async () => {
    const monitor = makeMonitor();
    await monitor.recordToolCall(
      'run',
      {
        cmd: 'ls',
        cwd: '/tmp',
      },
      1,
    );
    expect(
      (
        await monitor.recordToolCall(
          'run',
          {
            cwd: '/tmp',
            cmd: 'ls',
          },
          2,
        )
      ).verdict,
    ).toMatchObject({
      streak: 2,
    });
  });

  it('repeated EMPTY calls trip the detector (the empty-tool-call doom loop)', async () => {
    const monitor = makeMonitor();
    expect((await monitor.recordToolCall('list_tasks', {}, 1)).verdict).toBeUndefined();
    expect((await monitor.recordToolCall('list_tasks', {}, 2)).verdict).toMatchObject({
      action: 'observe',
      streak: 2,
    });
    expect((await monitor.recordToolCall('list_tasks', {}, 3)).verdict).toMatchObject({
      action: 'block',
      streak: 3,
    });
  });

  it('propagates canonicalization errors (bigint) for the engine fallback to catch', async () => {
    const monitor = makeMonitor();
    await expect(
      monitor.recordToolCall(
        'search',
        {
          id: 10n,
        },
        1,
      ),
    ).rejects.toThrow(/bigint/i);
  });

  it('server-tool records use the non-blockable ladder path and the server detector label', async () => {
    const monitor = makeMonitor();
    let last: DoomLoopCallRecord | undefined;
    for (let round = 1; round <= 3; round++) {
      last = await monitor.recordToolCall(
        'server:web_search_call',
        {
          query: 'x',
        },
        round,
        {
          allowBlock: false,
          detector: 'server-tool-fingerprint',
        },
      );
    }
    // Streak 3 crosses the block rung, but allowBlock=false ⇒ observe.
    expect(last?.verdict).toMatchObject({
      detector: 'server-tool-fingerprint',
      action: 'observe',
      streak: 3,
    });
  });

  it('is deterministic: two monitors fed the same sequence agree exactly', async () => {
    const script: Array<
      [
        string,
        unknown,
        number,
      ]
    > = [
      [
        'a',
        {
          x: 1,
        },
        1,
      ],
      [
        'b',
        {},
        1,
      ],
      [
        'a',
        {
          x: 1,
        },
        2,
      ],
      [
        'a',
        {
          x: 2,
        },
        3,
      ],
      [
        'a',
        {
          x: 2,
        },
        4,
      ],
    ];
    const run = async () => {
      const monitor = makeMonitor();
      const results: Array<DoomLoopVerdict | null> = [];
      for (const [name, args, round] of script) {
        results.push((await monitor.recordToolCall(name, args, round)).verdict ?? null);
      }
      return results;
    };
    expect(await run()).toEqual(await run());
  });
});

describe('DoomLoopMonitor — text', () => {
  it('within-response repetition can stop immediately when repeats cross the stop rung', async () => {
    const monitor = makeMonitor();
    const verdict = await monitor.recordAssistantText(Array(20).fill('I am stuck.').join(' '));
    expect(verdict).toMatchObject({
      detector: 'text-repetition',
      action: 'stop',
      streak: 20,
    });
  });

  it('cross-step identical text builds a streak (block downgrades to observe for text)', async () => {
    const monitor = makeMonitor();
    expect(await monitor.recordAssistantText('Let me try that again.')).toBeUndefined();
    expect(await monitor.recordAssistantText('Let me try that again.')).toMatchObject({
      detector: 'text-streak',
      action: 'observe',
      streak: 2,
    });
    // Streak 3 crosses the block rung, but text cannot be blocked → observe.
    expect(await monitor.recordAssistantText('Let me try that again.')).toMatchObject({
      detector: 'text-streak',
      action: 'observe',
      streak: 3,
    });
    for (let i = 0; i < 2; i++) {
      await monitor.recordAssistantText('Let me try that again.');
    }
    expect(await monitor.recordAssistantText('Let me try that again.')).toMatchObject({
      action: 'stop',
      streak: 6,
    });
  });

  it('whitespace-only differences do not defeat the cross-step streak', async () => {
    const monitor = makeMonitor();
    await monitor.recordAssistantText('Retrying   the\nsame plan.');
    expect(await monitor.recordAssistantText('Retrying the same plan.')).toMatchObject({
      streak: 2,
    });
  });

  it('DOCUMENTED MISS: paraphrased cross-step text does not build a streak', async () => {
    const monitor = makeMonitor();
    const paraphrases = [
      'I am unable to find the file.',
      'I cannot locate the file.',
      'I am not able to find that file.',
      'The file cannot be found.',
      'Locating the file is not possible.',
      'I could not find that file.',
    ];
    for (const text of paraphrases) {
      expect(await monitor.recordAssistantText(text)).toBeUndefined();
    }
  });

  it('empty text (tool-only turns) neither counts nor resets', async () => {
    const monitor = makeMonitor();
    await monitor.recordAssistantText('same');
    await monitor.recordAssistantText('');
    await monitor.recordAssistantText('   ');
    expect(await monitor.recordAssistantText('same')).toMatchObject({
      streak: 2,
    });
  });

  it('text: false disables both text detectors', async () => {
    const monitor = makeMonitor({
      text: false,
    });
    expect(await monitor.recordAssistantText(Array(30).fill('loop').join(' '))).toBeUndefined();
  });
});

describe('DoomLoopMonitor — state round-trip', () => {
  it('serializes to plain JSON and resumes counting where it left off', async () => {
    const monitor = makeMonitor();
    await monitor.recordToolCall(
      'search',
      {
        q: 'x',
      },
      1,
    );
    await monitor.recordToolCall(
      'search',
      {
        q: 'x',
      },
      2,
    );

    // Simulate serialize → store → resume (JSON round-trip proves plainness).
    const blob = JSON.parse(JSON.stringify(monitor.getState()));
    const config = resolveDoomLoopOption(true);
    if (!config) {
      throw new Error('unreachable');
    }
    const resumed = new DoomLoopMonitor(config, blob);

    // The resumed run numbers its rounds from 1 again — round markers are
    // NOT serialized, so the first resumed record still increments.
    expect(
      (
        await resumed.recordToolCall(
          'search',
          {
            q: 'x',
          },
          1,
        )
      ).verdict,
    ).toMatchObject({
      action: 'block',
      streak: 3, // 2 before the round-trip + 1 after
    });
  });

  it('ignores corrupt persisted state instead of crashing the run', async () => {
    const config = resolveDoomLoopOption(true);
    if (!config) {
      throw new Error('unreachable');
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const monitor = new DoomLoopMonitor(config, 'not an object');
    expect(
      (
        await monitor.recordToolCall(
          'search',
          {
            q: 'x',
          },
          1,
        )
      ).verdict,
    ).toBeUndefined(); // fresh state, streak 1
    expect(warn).toHaveBeenCalled();
  });
  it('a persisted "__proto__" tool name cannot pollute streak bookkeeping', async () => {
    // Regression (PR #73 review): the streak map was a plain object; a
    // crafted persisted blob {"tools":{"__proto__":{...}}} reassigned its
    // prototype, making EVERY unseen tool inherit the seeded streak —
    // false stop verdicts from client-writable state storage.
    const config = resolveDoomLoopOption(true);
    if (!config) {
      throw new Error('unreachable');
    }
    const hostile = JSON.parse(
      '{"tools":{"__proto__":{"fingerprint":"x","streak":999}}}',
    ) as unknown;
    const monitor = new DoomLoopMonitor(config, hostile);

    // An unseen tool must start at streak 1 — not inherit streak 999 and
    // instantly cross the stop rung.
    const record = await monitor.recordToolCall(
      'unrelated_tool',
      {
        q: 'first call',
      },
      1,
    );
    expect(record.streak).toBe(1);
    expect(record.verdict).toBeUndefined();
    // And Object.prototype itself was not touched.
    expect(({} as Record<string, unknown>)['fingerprint']).toBeUndefined();
  });

  it('a tool legitimately named "__proto__" is tracked as ordinary data', async () => {
    const monitor = makeMonitor();
    await monitor.recordToolCall('__proto__', {}, 1);
    const record = await monitor.recordToolCall('__proto__', {}, 2);
    expect(record.streak).toBe(2);
    // Round-trips through getState (own property, not a prototype hit)…
    const snapshot = monitor.getState();
    expect(Object.hasOwn(snapshot.tools, '__proto__')).toBe(true);
    // …and JSON serialization keeps it as data.
    const revived = JSON.parse(JSON.stringify(snapshot)) as {
      tools: Record<string, unknown>;
    };
    expect(Object.hasOwn(revived.tools, '__proto__')).toBe(true);
  });

  it('getState returns a snapshot, not a live reference', async () => {
    const monitor = makeMonitor();
    await monitor.recordToolCall('a', {}, 1);
    const snapshot = monitor.getState();
    await monitor.recordToolCall('a', {}, 2);
    expect(snapshot.tools['a']?.streak).toBe(1);
    expect(monitor.getState().tools['a']?.streak).toBe(2);
  });
});
