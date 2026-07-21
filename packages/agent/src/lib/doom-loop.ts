/**
 * Doom-loop detection for the tool-execution loop.
 *
 * A "doom loop" is a run that stops making progress while continuing to spend:
 * the model re-issues the same tool call with identical arguments (including
 * repeated *empty* calls and repeated unparseable calls), or emits the same
 * text tokens over and over. This module provides the deterministic detection
 * primitives; `ModelResult` wires them into the loop behind the `doomLoop`
 * option on `callModel`.
 *
 * Design principles:
 *
 * - **Deterministic.** Every verdict is a pure function of the recorded
 *   sequence of tool calls / assistant texts. The same scripted transcript
 *   produces the same verdicts at the same indices — no wall clocks, no
 *   randomness — so the feature is testable without a live model and
 *   portable across SDK ports via shared test vectors.
 * - **Tool-declared identity.** A tool opts into precise loop identity via
 *   `loopKey` (see {@link ToolLoopKeyFn} in tool-types): a web-search tool
 *   returns its normalized query, a bash tool returns
 *   `{ command, cwd, env }`, a status poller returns `null` to exempt
 *   itself. Tools return *key material*; this module owns canonicalization
 *   and hashing so fingerprints are uniform across tools and ports.
 * - **Graduated response.** Detection feeds a configurable action ladder
 *   (observe → steer → block → stop) rather than killing the run outright.
 */

//#region Public Types

/**
 * Escalation actions, weakest to strongest:
 *
 * - `observe` — emit the `DoomLoopDetected` hook only.
 * - `steer`   — inject a corrective user message before the next model turn
 *   (same mechanism as the Stop hook's `appendPrompt`); the call still runs.
 * - `block`   — refuse the tool call and synthesize an error
 *   `function_call_output` (same shape as a PreToolUse block); the error text
 *   is itself steering, delivered where the model looks.
 * - `stop`    — halt the run before the next model request
 *   (`SessionEnd.reason: 'doom_loop'`).
 */
export type DoomLoopAction = 'observe' | 'steer' | 'block' | 'stop';

/** Which detector produced a verdict. */
export type DoomLoopDetectorKind = 'tool-fingerprint' | 'text-repetition' | 'text-streak';

/**
 * A doom-loop detection event.
 *
 * `streak` is the repetition count that crossed a ladder threshold: for
 * `tool-fingerprint` the consecutive identical-fingerprint call count for
 * that tool; for `text-repetition` the number of consecutive repeats of a
 * token block within one response; for `text-streak` the number of
 * consecutive steps with identical assistant text.
 */
export interface DoomLoopVerdict {
  detector: DoomLoopDetectorKind;
  action: DoomLoopAction;
  streak: number;
  /** Deterministic fingerprint of the repeated unit (call identity or text). */
  fingerprint: string;
  /** Present for `tool-fingerprint` verdicts. */
  toolName?: string;
  /** Human/model-readable explanation; used verbatim for block outputs and steer messages. */
  message: string;
}

/**
 * Streak thresholds for each action. A threshold of `false` disables that
 * rung. When several rungs are crossed the strongest wins
 * (stop > block > steer > observe). Thresholds compare with `>=`, so a
 * verdict fires on *every* record at or past a rung — escalating as the
 * streak grows.
 */
export interface DoomLoopLadder {
  observe?: number | false;
  steer?: number | false;
  block?: number | false;
  stop?: number | false;
}

/** Options for within-response text-repetition detection. */
export interface DoomLoopTextOptions {
  /** Master switch for both text detectors. Default true. */
  enabled?: boolean;
  /** Longest repeating token block to search for. Default 16. */
  maxPeriodTokens?: number;
  /** Minimum consecutive repeats of a block to count as repetition. Default 4. */
  minRepeats?: number;
  /** Minimum total tokens covered by the repetition. Default 12. */
  minCoveredTokens?: number;
  /** Only the trailing N tokens of a response are scanned. Default 400. */
  maxWindowTokens?: number;
}

/** Configuration for doom-loop detection. `doomLoop: true` uses all defaults. */
export interface DoomLoopConfig {
  ladder?: DoomLoopLadder;
  /** Text-loop detection. `false` disables; an object tunes it. Default on. */
  text?: boolean | DoomLoopTextOptions;
}

/** The `doomLoop` option on `callModel`: `true` for defaults, or a config object. */
export type DoomLoopOption = boolean | DoomLoopConfig;

/** Consecutive-repetition counter for one identity (a tool, or step text). */
export interface DoomLoopStreak {
  fingerprint: string;
  streak: number;
}

/**
 * Plain-JSON detector state, persisted inside `ConversationState.doomLoop`
 * so loop memory survives serialize → resume: a resumed doom loop is still
 * a doom loop.
 */
export interface DoomLoopSerializedState {
  /** Per-tool streaks keyed by tool name. Interleaved calls to other tools do not reset a tool's streak. */
  tools: Record<string, DoomLoopStreak>;
  /** Cross-step assistant-text streak. */
  text?: DoomLoopStreak;
}

//#endregion

//#region Defaults & Config Resolution

/**
 * Default ladder: observe at 2 consecutive identical calls, block at 3,
 * stop at 6. Steer is off by default (blocking already delivers feedback in
 * the tool output, where the model looks first).
 */
export const DEFAULT_DOOM_LOOP_LADDER: Readonly<Required<DoomLoopLadder>> = Object.freeze({
  observe: 2,
  steer: false as const,
  block: 3,
  stop: 6,
});

const DEFAULT_TEXT_OPTIONS: Readonly<Required<DoomLoopTextOptions>> = Object.freeze({
  enabled: true,
  maxPeriodTokens: 16,
  minRepeats: 4,
  minCoveredTokens: 12,
  maxWindowTokens: 400,
});

/** Fully-resolved config used by the monitor. */
export interface ResolvedDoomLoopConfig {
  ladder: Required<DoomLoopLadder>;
  text: Required<DoomLoopTextOptions>;
}

function sanitizeThreshold(
  value: number | false | undefined,
  fallback: number | false,
): number | false {
  if (value === false) {
    return false;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
    return Math.floor(value);
  }
  return fallback;
}

/**
 * Normalize the `doomLoop` option. `undefined` / `false` → null (detection
 * off — the SDK's default posture: explicit control over implicit magic).
 */
export function resolveDoomLoopOption(
  option: DoomLoopOption | undefined,
): ResolvedDoomLoopConfig | null {
  if (option === undefined || option === false) {
    return null;
  }
  const config = option === true ? {} : option;
  const ladderInput = config.ladder ?? {};
  const textInput = config.text === undefined || config.text === true ? {} : config.text;
  return {
    ladder: {
      observe: sanitizeThreshold(ladderInput.observe, DEFAULT_DOOM_LOOP_LADDER.observe),
      steer: sanitizeThreshold(ladderInput.steer, DEFAULT_DOOM_LOOP_LADDER.steer),
      block: sanitizeThreshold(ladderInput.block, DEFAULT_DOOM_LOOP_LADDER.block),
      stop: sanitizeThreshold(ladderInput.stop, DEFAULT_DOOM_LOOP_LADDER.stop),
    },
    text:
      textInput === false
        ? {
            ...DEFAULT_TEXT_OPTIONS,
            enabled: false,
          }
        : {
            enabled: textInput.enabled ?? DEFAULT_TEXT_OPTIONS.enabled,
            maxPeriodTokens: textInput.maxPeriodTokens ?? DEFAULT_TEXT_OPTIONS.maxPeriodTokens,
            minRepeats: textInput.minRepeats ?? DEFAULT_TEXT_OPTIONS.minRepeats,
            minCoveredTokens: textInput.minCoveredTokens ?? DEFAULT_TEXT_OPTIONS.minCoveredTokens,
            maxWindowTokens: textInput.maxWindowTokens ?? DEFAULT_TEXT_OPTIONS.maxWindowTokens,
          },
  };
}

//#endregion

//#region Canonicalization & Fingerprinting

/**
 * Deterministic canonical JSON for fingerprinting: object keys sorted
 * recursively, arrays in order, `undefined`/function/symbol values dropped
 * from objects (JSON semantics) and rendered as `null` elsewhere,
 * non-finite numbers as `null`. Insensitive to key insertion order, so
 * `{a:1,b:2}` and `{b:2,a:1}` fingerprint identically.
 *
 * This is the cross-port canonicalization contract: the Python and Go SDKs
 * must produce byte-identical canonical strings for the same key material.
 *
 * @throws Error on circular references (tool arguments come from JSON and
 * cannot be circular; a circular custom `loopKey` return is a caller bug —
 * the engine catches this and falls back to the raw arguments).
 */
export function canonicalizeKeyMaterial(value: unknown): string {
  const seen = new Set<object>();
  const canon = (v: unknown): string => {
    if (v === null || v === undefined) {
      return 'null';
    }
    switch (typeof v) {
      case 'number':
        return Number.isFinite(v) ? JSON.stringify(v) : 'null';
      case 'string':
      case 'boolean':
        return JSON.stringify(v);
      case 'bigint':
        return JSON.stringify(v.toString());
      case 'object':
        break;
      default:
        // function / symbol — not representable; JSON semantics say null here.
        return 'null';
    }
    const obj = v as object;
    if (seen.has(obj)) {
      throw new Error('Cannot canonicalize circular key material for doom-loop fingerprinting');
    }
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        return `[${obj.map((item) => canon(item)).join(',')}]`;
      }
      const record = obj as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => {
          const entry = record[key];
          return entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol';
        })
        .sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canon(record[key])}`).join(',')}}`;
    } finally {
      seen.delete(obj);
    }
  };
  return canon(value);
}

/**
 * cyrb53 — a fast, deterministic, dependency-free 53-bit string hash
 * (public-domain construction). Chosen over `node:crypto` so the SDK stays
 * runtime-agnostic (browser/edge/node). 53 bits is ample: a false positive
 * requires a collision between *consecutive same-tool* calls, and the
 * consequence is a graduated ladder action, not data corruption.
 */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Fingerprint arbitrary key material (canonicalize + hash). 14 hex chars. */
export function fingerprintKeyMaterial(keyMaterial: unknown): string {
  return cyrb53(canonicalizeKeyMaterial(keyMaterial)).toString(16).padStart(14, '0');
}

/**
 * Fingerprint a tool call: `hash(toolName + '\n' + canonical(keyMaterial))`.
 * The tool name participates so `search({q})` and `fetch({q})` with equal
 * arguments never share a fingerprint.
 */
export function fingerprintToolCall(toolName: string, keyMaterial: unknown): string {
  return cyrb53(`${toolName}\n${canonicalizeKeyMaterial(keyMaterial)}`)
    .toString(16)
    .padStart(14, '0');
}

//#endregion

//#region Text Repetition Detection

/** A detected repeating token block at the tail of a response. */
export interface TextRepetitionResult {
  /** Consecutive repeats of the block (feeds the ladder as the streak). */
  repeats: number;
  /** Block length in whitespace-delimited tokens. */
  periodTokens: number;
  /** repeats × periodTokens. */
  coveredTokens: number;
  /** The repeating block itself. */
  sample: string;
}

/**
 * Detect a period-p token block repeating at the *tail* of `text` — the
 * canonical shape of an in-response token doom loop ("I am stuck. I am
 * stuck. I am stuck. …"). Pure and deterministic: whitespace tokenization,
 * suffix comparison, no heuristics beyond the thresholds.
 *
 * Ties on covered tokens prefer the smallest period (the most repeats), so
 * "no no no no no no" reports p=1 × 6, not p=2 × 3 — the repeat count is
 * what feeds the ladder.
 *
 * Returns null when no block meets `minRepeats` and `minCoveredTokens`
 * within `maxPeriodTokens` / `maxWindowTokens` — thresholds tuned so
 * legitimately repetitive prose (short lists, emphasis) stays below the
 * line while degenerate token loops trip it.
 */
export function detectTextRepetition(
  text: string,
  options?: Partial<DoomLoopTextOptions>,
): TextRepetitionResult | null {
  const maxPeriodTokens = options?.maxPeriodTokens ?? DEFAULT_TEXT_OPTIONS.maxPeriodTokens;
  const minRepeats = options?.minRepeats ?? DEFAULT_TEXT_OPTIONS.minRepeats;
  const minCoveredTokens = options?.minCoveredTokens ?? DEFAULT_TEXT_OPTIONS.minCoveredTokens;
  const maxWindowTokens = options?.maxWindowTokens ?? DEFAULT_TEXT_OPTIONS.maxWindowTokens;

  const allTokens = text.trim().split(/\s+/).filter(Boolean);
  const tokens = allTokens.slice(-maxWindowTokens);
  if (tokens.length < Math.max(minCoveredTokens, 2)) {
    return null;
  }

  let best: TextRepetitionResult | null = null;
  const maxPeriod = Math.min(maxPeriodTokens, Math.floor(tokens.length / 2));
  for (let period = 1; period <= maxPeriod; period++) {
    let repeats = 1;
    outer: for (let start = tokens.length - 2 * period; start >= 0; start -= period) {
      for (let i = 0; i < period; i++) {
        if (tokens[start + i] !== tokens[tokens.length - period + i]) {
          break outer;
        }
      }
      repeats++;
    }
    const coveredTokens = repeats * period;
    if (repeats >= minRepeats && coveredTokens >= minCoveredTokens) {
      if (!best || coveredTokens > best.coveredTokens) {
        best = {
          repeats,
          periodTokens: period,
          coveredTokens,
          sample: tokens.slice(-period).join(' '),
        };
      }
    }
  }
  return best;
}

//#endregion

//#region Ladder Resolution

/**
 * Map a streak onto the strongest crossed ladder rung.
 *
 * `allowBlock: false` is used for text verdicts: the tokens are already
 * emitted, so there is nothing to block — a block-level streak falls
 * through to steer (when enabled) or observe, while stop still stops.
 */
export function resolveLadderAction(
  ladder: Required<DoomLoopLadder>,
  streak: number,
  options: {
    allowBlock: boolean;
  },
): DoomLoopAction | undefined {
  const meets = (threshold: number | false): boolean => threshold !== false && streak >= threshold;
  if (meets(ladder.stop)) {
    return 'stop';
  }
  if (options.allowBlock && meets(ladder.block)) {
    return 'block';
  }
  if (meets(ladder.steer)) {
    return 'steer';
  }
  if (meets(ladder.observe)) {
    return 'observe';
  }
  return undefined;
}

//#endregion

//#region Monitor

function isValidStreak(value: unknown): value is DoomLoopStreak {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DoomLoopStreak).fingerprint === 'string' &&
    typeof (value as DoomLoopStreak).streak === 'number' &&
    Number.isFinite((value as DoomLoopStreak).streak)
  );
}

/**
 * Pure state machine over the recorded transcript: feed it tool calls and
 * assistant texts, get verdicts back. Holds no engine concerns (hook
 * emission, blocking, steering, stopping live in `ModelResult`), so its
 * behavior is fully exercisable in unit tests and portable as a spec.
 *
 * State is bounded, plain JSON (one streak entry per distinct tool name +
 * one text streak) and round-trips through `ConversationState`.
 */
export class DoomLoopMonitor {
  private readonly config: ResolvedDoomLoopConfig;
  private state: DoomLoopSerializedState = {
    tools: {},
  };

  constructor(config: ResolvedDoomLoopConfig, initialState?: unknown) {
    this.config = config;
    if (initialState !== undefined) {
      this.restore(initialState);
    }
  }

  /** Snapshot the serializable detector state (deep copy). */
  getState(): DoomLoopSerializedState {
    return {
      tools: Object.fromEntries(
        Object.entries(this.state.tools).map(([name, entry]) => [
          name,
          {
            ...entry,
          },
        ]),
      ),
      ...(this.state.text && {
        text: {
          ...this.state.text,
        },
      }),
    };
  }

  /**
   * Restore persisted state (from `ConversationState.doomLoop`). Invalid
   * blobs are ignored with a warning — a corrupt detector state must never
   * take down a resumed run.
   */
  restore(state: unknown): void {
    if (typeof state !== 'object' || state === null || Array.isArray(state)) {
      console.warn('[DoomLoop] Ignoring invalid persisted doom-loop state');
      return;
    }
    const candidate = state as Partial<DoomLoopSerializedState>;
    const tools: Record<string, DoomLoopStreak> = {};
    if (typeof candidate.tools === 'object' && candidate.tools !== null) {
      for (const [name, entry] of Object.entries(candidate.tools)) {
        if (isValidStreak(entry)) {
          tools[name] = {
            fingerprint: entry.fingerprint,
            streak: entry.streak,
          };
        }
      }
    }
    this.state = {
      tools,
      ...(isValidStreak(candidate.text) && {
        text: {
          fingerprint: candidate.text.fingerprint,
          streak: candidate.text.streak,
        },
      }),
    };
  }

  /**
   * Record one tool call (identified by its key material — the tool's
   * `loopKey` return, or the full arguments by default) and return a verdict
   * when the consecutive-identical streak crosses a ladder rung.
   *
   * Streaks are per tool: interleaved calls to *other* tools do not reset a
   * tool's streak (so `search X, read file, search X, read file` still
   * trips), while a different fingerprint for the *same* tool resets it to 1.
   * Blocked calls are recorded like any other — a model re-issuing a blocked
   * call is stronger loop evidence, not progress.
   */
  recordToolCall(toolName: string, keyMaterial: unknown): DoomLoopVerdict | undefined {
    const fingerprint = fingerprintToolCall(toolName, keyMaterial);
    const previous = this.state.tools[toolName];
    const streak = previous && previous.fingerprint === fingerprint ? previous.streak + 1 : 1;
    this.state.tools[toolName] = {
      fingerprint,
      streak,
    };
    const action = resolveLadderAction(this.config.ladder, streak, {
      allowBlock: true,
    });
    if (!action) {
      return undefined;
    }
    return {
      detector: 'tool-fingerprint',
      action,
      streak,
      fingerprint,
      toolName,
      message:
        `Doom loop suspected: tool "${toolName}" was invoked ${streak} consecutive times ` +
        `with identical arguments (fingerprint ${fingerprint}). Repeating the call will not ` +
        'change the result. Take a different approach, or explain why repetition is required.',
    };
  }

  /**
   * Record one step's assistant text and return the strongest verdict from
   * the two text detectors:
   *
   * - `text-repetition`: a token block repeating within THIS response; the
   *   repeat count feeds the ladder directly, so a single response spinning
   *   "I am stuck." dozens of times can stop the run immediately.
   * - `text-streak`: byte-identical (whitespace-normalized) text across
   *   consecutive steps.
   *
   * Empty/whitespace-only text (typical for tool-only turns) is a no-op:
   * it neither counts nor resets the cross-step streak, mirroring how
   * interleaved other-tool calls don't reset a tool streak.
   */
  recordAssistantText(text: string): DoomLoopVerdict | undefined {
    if (!this.config.text.enabled) {
      return undefined;
    }
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length === 0) {
      return undefined;
    }

    let withinResponse: DoomLoopVerdict | undefined;
    const repetition = detectTextRepetition(normalized, this.config.text);
    if (repetition) {
      const action = resolveLadderAction(this.config.ladder, repetition.repeats, {
        allowBlock: false,
      });
      if (action) {
        withinResponse = {
          detector: 'text-repetition',
          action,
          streak: repetition.repeats,
          fingerprint: fingerprintKeyMaterial(repetition.sample),
          message:
            `Doom loop suspected: the response repeats "${repetition.sample}" ` +
            `${repetition.repeats} times in a row. Stop repeating and take a different approach.`,
        };
      }
    }

    const fingerprint = fingerprintKeyMaterial(normalized);
    const previous = this.state.text;
    const streak = previous && previous.fingerprint === fingerprint ? previous.streak + 1 : 1;
    this.state.text = {
      fingerprint,
      streak,
    };
    let crossStep: DoomLoopVerdict | undefined;
    const crossAction = resolveLadderAction(this.config.ladder, streak, {
      allowBlock: false,
    });
    if (crossAction) {
      crossStep = {
        detector: 'text-streak',
        action: crossAction,
        streak,
        fingerprint,
        message:
          `Doom loop suspected: the assistant produced identical text for ${streak} ` +
          'consecutive turns. Stop repeating and take a different approach.',
      };
    }

    return strongerVerdict(withinResponse, crossStep);
  }
}

const ACTION_STRENGTH: Readonly<Record<DoomLoopAction, number>> = Object.freeze({
  observe: 0,
  steer: 1,
  block: 2,
  stop: 3,
});

function strongerVerdict(
  a: DoomLoopVerdict | undefined,
  b: DoomLoopVerdict | undefined,
): DoomLoopVerdict | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  // Within-response wins ties: its message names the repeated block.
  return ACTION_STRENGTH[b.action] > ACTION_STRENGTH[a.action] ? b : a;
}

//#endregion
