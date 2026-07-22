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
 * - **Cross-port fingerprints.** Key material is canonicalized per RFC 8785
 *   (JCS) and hashed with SHA-256 over the UTF-8 bytes. Ports (Python/Go)
 *   MUST use a JCS implementation (e.g. pip `jcs`,
 *   `cyberphone/json-canonicalization`), not their stdlib JSON serializer —
 *   the shared vector file `tests/vectors/doom-loop-fingerprints.json` is
 *   the conformance contract.
 * - **Tool-declared identity.** A tool opts into precise loop identity via
 *   `loopKey` on its definition: a function computing key material, a
 *   declarative field subset (`['command', 'cwd']`), or `false` to exempt
 *   the tool. Tools declare *what identifies a call*; this module owns
 *   canonicalization and hashing so fingerprints are uniform across tools
 *   and ports.
 * - **Round-scoped streaks.** A streak measures the model *re-issuing a call
 *   after seeing its result*, which requires a model round trip. N identical
 *   calls fanned out in ONE round count once; the duplicates share that
 *   round's decision.
 * - **Graduated response.** Detection feeds a configurable action ladder
 *   (observe → steer → block → stop) rather than killing the run outright.
 * - **Never the cause of failure.** Detection may only affect a run through
 *   its defined actions. Any internal error (unhashable key material,
 *   throwing `loopKey`, corrupt persisted state) degrades to a fallback
 *   identity or skips detection for that call — it never rejects the call
 *   or crashes the run.
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
export type DoomLoopDetectorKind =
  | 'tool-fingerprint'
  | 'server-tool-fingerprint'
  | 'text-repetition'
  | 'text-streak';

/**
 * A doom-loop detection event.
 *
 * `streak` is the repetition count that crossed a ladder threshold: for
 * fingerprint detectors the consecutive identical-fingerprint round count
 * for that tool; for `text-repetition` the number of consecutive repeats of
 * a token block within one response; for `text-streak` the number of
 * consecutive steps with identical assistant text.
 */
export interface DoomLoopVerdict {
  detector: DoomLoopDetectorKind;
  action: DoomLoopAction;
  streak: number;
  /** Deterministic fingerprint of the repeated unit (call identity or text). */
  fingerprint: string;
  /** Present for fingerprint verdicts. */
  toolName?: string;
  /** Human/model-readable explanation; used verbatim for block outputs and steer messages. */
  message: string;
}

/**
 * Result of recording one tool call with the monitor.
 *
 * `duplicateInRound` is true when the same `(toolName, fingerprint)` was
 * already recorded in this round — the streak did NOT increment and the
 * caller should reuse the decision it applied for the first occurrence
 * rather than re-emitting hooks.
 */
export interface DoomLoopCallRecord {
  fingerprint: string;
  streak: number;
  duplicateInRound: boolean;
  verdict?: DoomLoopVerdict;
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
 * a doom loop (provided the resuming call passes `doomLoop` again).
 */
export interface DoomLoopSerializedState {
  /** Per-tool streaks keyed by tool name. Interleaved calls to other tools do not reset a tool's streak. */
  tools: Record<string, DoomLoopStreak>;
  /** Cross-step assistant-text streak. */
  text?: DoomLoopStreak;
  /**
   * The verdict that condemned this run, when a `stop` action armed. Kept
   * across decision-only resumes (`approveToolCalls`/`rejectToolCalls`) so a
   * condemned run stays halted; cleared by a fresh conversational turn
   * (operator intervention = new information). Streaks are kept either way.
   */
  stopVerdict?: DoomLoopVerdict;
  /**
   * Steer guidance queued but not yet injected when the run paused. Flushed
   * into the conversation on resume.
   */
  pendingSteer?: string[];
}

/**
 * The result of resolving a tool's `loopKey` declaration against one call's
 * validated arguments. See {@link resolveLoopKeyMaterial}.
 */
export type LoopKeyResolution =
  | {
      kind: 'exempt';
    }
  | {
      kind: 'key';
      keyMaterial: unknown;
    }
  | {
      kind: 'fallback';
      keyMaterial: unknown;
      warning: string;
    };

//#endregion

//#region Defaults & Config Resolution

/**
 * Default ladder: observe at 2 consecutive identical rounds, block at 3,
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

/** Ladder rungs ordered weakest → strongest, for dead-rung analysis. */
const LADDER_ORDER: ReadonlyArray<keyof DoomLoopLadder> = [
  'observe',
  'steer',
  'block',
  'stop',
];

/**
 * Warn about configurations that are accepted but probably not what the
 * caller meant:
 *
 * - `block` enabled with `stop: false` — blocked calls still increment the
 *   streak, so a model that keeps re-issuing the call produces an unbounded
 *   block/re-issue ping-pong bounded only by `stopWhen` (which defaults to
 *   unbounded). Explicitly allowed, loudly flagged.
 * - Dead rungs — with strongest-wins resolution, a weaker rung whose
 *   threshold is >= an enabled stronger rung's threshold can never fire
 *   (e.g. `{ observe: 5, block: 2 }`: block wins from streak 2 on).
 */
function warnOnLadderHazards(ladder: Required<DoomLoopLadder>): void {
  if (ladder.block !== false && ladder.stop === false) {
    console.warn(
      '[DoomLoop] ladder has block enabled with stop disabled: a model that keeps ' +
        're-issuing a blocked call loops indefinitely (each blocked round still costs a ' +
        'model request). Bound the run with stopWhen, or enable the stop rung.',
    );
  }
  for (let weak = 0; weak < LADDER_ORDER.length; weak++) {
    const weakName = LADDER_ORDER[weak] as keyof DoomLoopLadder;
    const weakThreshold = ladder[weakName];
    if (weakThreshold === false) {
      continue;
    }
    for (let strong = weak + 1; strong < LADDER_ORDER.length; strong++) {
      const strongName = LADDER_ORDER[strong] as keyof DoomLoopLadder;
      const strongThreshold = ladder[strongName];
      if (strongThreshold !== false && weakThreshold >= strongThreshold) {
        console.warn(
          `[DoomLoop] ladder rung "${weakName}" (${weakThreshold}) can never fire: ` +
            `stronger rung "${strongName}" (${strongThreshold}) already wins at that streak ` +
            '(strongest crossed rung is applied).',
        );
        break; // one warning per dead rung is enough
      }
    }
  }
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
  const ladder: Required<DoomLoopLadder> = {
    observe: sanitizeThreshold(ladderInput.observe, DEFAULT_DOOM_LOOP_LADDER.observe),
    steer: sanitizeThreshold(ladderInput.steer, DEFAULT_DOOM_LOOP_LADDER.steer),
    block: sanitizeThreshold(ladderInput.block, DEFAULT_DOOM_LOOP_LADDER.block),
    stop: sanitizeThreshold(ladderInput.stop, DEFAULT_DOOM_LOOP_LADDER.stop),
  };
  warnOnLadderHazards(ladder);
  return {
    ladder,
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

//#region loopKey Resolution

/**
 * Resolve a tool's `loopKey` declaration (function, field list, `false`, or
 * absent) against one call's validated arguments.
 *
 * - absent (`undefined` declaration) → the full arguments object.
 * - `false` → the tool is statically exempt.
 * - `readonly string[]` → declarative field subset of the arguments
 *   (missing fields are simply absent — canonicalization drops them).
 *   Data, not code: serializable, so it survives tool caches and can be
 *   advertised over the MCP wire.
 * - function → called with the arguments. `null` exempts THIS call;
 *   `undefined` falls back to the full arguments (with a warning — a bare
 *   `return;` is almost always a bug, and treating it as key material would
 *   collide every call of the tool onto one fingerprint); a throw falls
 *   back to the full arguments (detection must never take down a run).
 */
export function resolveLoopKeyMaterial(
  loopKey: unknown,
  args: Record<string, unknown>,
): LoopKeyResolution {
  if (loopKey === undefined) {
    return {
      kind: 'key',
      keyMaterial: args,
    };
  }
  if (loopKey === false) {
    return {
      kind: 'exempt',
    };
  }
  if (Array.isArray(loopKey)) {
    const subset: Record<string, unknown> = {};
    for (const field of loopKey) {
      if (typeof field === 'string' && field in args) {
        subset[field] = args[field];
      }
    }
    return {
      kind: 'key',
      keyMaterial: subset,
    };
  }
  if (typeof loopKey === 'function') {
    let result: unknown;
    try {
      result = loopKey(args);
    } catch (error) {
      return {
        kind: 'fallback',
        keyMaterial: args,
        warning: `loopKey threw (${error instanceof Error ? error.message : String(error)}); falling back to full arguments`,
      };
    }
    if (result === null) {
      return {
        kind: 'exempt',
      };
    }
    if (result === undefined) {
      return {
        kind: 'fallback',
        keyMaterial: args,
        warning:
          'loopKey returned undefined; falling back to full arguments. Return null to exempt a call, or a value to use as identity.',
      };
    }
    return {
      kind: 'key',
      keyMaterial: result,
    };
  }
  return {
    kind: 'fallback',
    keyMaterial: args,
    warning: `loopKey has unsupported shape (${typeof loopKey}); falling back to full arguments`,
  };
}

//#endregion

//#region Canonicalization & Fingerprinting

/**
 * Maximum nesting depth accepted by {@link canonicalizeKeyMaterial}. Real
 * tool arguments come from parsed JSON and stay shallow; anything deeper is
 * hostile or buggy key material and must fail fast (with a catchable error)
 * instead of overflowing the stack.
 */
export const MAX_CANONICALIZE_DEPTH = 64;

/**
 * RFC 8785 (JCS) canonical JSON: object keys sorted by UTF-16 code units
 * (recursively), arrays in order, strings and finite numbers serialized per
 * ECMAScript `JSON.stringify` (which IS the JCS serialization — e.g. `-0`
 * canonicalizes to `0`, `1e21` to `1e+21`, lone surrogates to `\udXXX`
 * escapes). Insensitive to key insertion order, so `{a:1,b:2}` and
 * `{b:2,a:1}` canonicalize identically.
 *
 * This is the cross-port contract: Python and Go ports must produce
 * byte-identical canonical strings for the same key material, which means
 * they MUST use an RFC 8785 implementation (pip `jcs`,
 * `cyberphone/json-canonicalization`), not their stdlib JSON serializer
 * (Python's `json.dumps(-0.0)` is `-0.0`, which is NOT JCS).
 *
 * JSON-data-model semantics for JS-only values:
 * - `undefined` / function / symbol object entries are dropped (as
 *   `JSON.stringify` does); in arrays they serialize as `null`.
 *
 * @throws Error on values RFC 8785 cannot represent — non-finite numbers,
 * bigint — plus circular references and nesting deeper than
 * {@link MAX_CANONICALIZE_DEPTH}. Real tool arguments (parsed JSON) can
 * never trigger these; only computed `loopKey` material can, and the engine
 * catches the error and falls back to the full-arguments identity.
 */
export function canonicalizeKeyMaterial(value: unknown): string {
  const seen = new Set<object>();
  const canon = (v: unknown, depth: number): string => {
    if (depth > MAX_CANONICALIZE_DEPTH) {
      throw new Error(
        `Cannot canonicalize key material nested deeper than ${MAX_CANONICALIZE_DEPTH} levels for doom-loop fingerprinting`,
      );
    }
    if (v === null || v === undefined) {
      return 'null';
    }
    switch (typeof v) {
      case 'number':
        if (!Number.isFinite(v)) {
          throw new Error(
            'Cannot canonicalize non-finite number (NaN/Infinity) for doom-loop fingerprinting: RFC 8785 has no representation',
          );
        }
        return JSON.stringify(v);
      case 'string':
      case 'boolean':
        return JSON.stringify(v);
      case 'bigint':
        throw new Error(
          'Cannot canonicalize bigint for doom-loop fingerprinting: RFC 8785 has no representation (convert to string or number in loopKey)',
        );
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
        return `[${obj.map((item) => canon(item, depth + 1)).join(',')}]`;
      }
      const record = obj as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => {
          const entry = record[key];
          return entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol';
        })
        .sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canon(record[key], depth + 1)}`).join(',')}}`;
    } finally {
      seen.delete(obj);
    }
  };
  return canon(value, 0);
}

/**
 * SHA-256 over UTF-8 bytes via WebCrypto — available in Node ≥18, Bun,
 * Deno, workers, and browsers, so no dependency and no `node:` builtin.
 * Lone surrogates never reach the encoder: `JSON.stringify` escapes them as
 * `\udXXX` (ASCII) inside the canonical string.
 */
async function sha256Hex(canonical: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += (view[i] as number).toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Fingerprint arbitrary key material: `sha256(utf8(jcs(keyMaterial)))`,
 * lowercase hex (64 chars).
 */
export function fingerprintKeyMaterial(keyMaterial: unknown): Promise<string> {
  return sha256Hex(canonicalizeKeyMaterial(keyMaterial));
}

/**
 * Fingerprint a tool call: `sha256(utf8(toolName + '\n' + jcs(keyMaterial)))`,
 * lowercase hex. The tool name participates so `search({q})` and
 * `fetch({q})` with equal arguments never share a fingerprint. This exact
 * construction is the cross-port contract — see
 * `tests/vectors/doom-loop-fingerprints.json`.
 */
export function fingerprintToolCall(toolName: string, keyMaterial: unknown): Promise<string> {
  return sha256Hex(`${toolName}\n${canonicalizeKeyMaterial(keyMaterial)}`);
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
 * Only the trailing region of the text is examined: a fixed character
 * budget (64 chars per window token) is sliced off the tail before
 * tokenization, so multi-megabyte responses do not pay a full-text token
 * split. The budget is part of the deterministic contract (same text ⇒
 * same slice ⇒ same result).
 *
 * Ties on covered tokens prefer the smallest period (the most repeats), so
 * "no no no no no no" reports p=1 × 6, not p=2 × 3 — the repeat count is
 * what feeds the ladder.
 *
 * Returns null when no block meets `minRepeats` and `minCoveredTokens`
 * within `maxPeriodTokens` / `maxWindowTokens`.
 *
 * KNOWN LIMIT: token blocks must repeat *exactly*. Paraphrased loops ("I am
 * stuck" / "I appear to be stuck" / …) do not trip this detector.
 */
export function detectTextRepetition(
  text: string,
  options?: Partial<DoomLoopTextOptions>,
): TextRepetitionResult | null {
  const maxPeriodTokens = options?.maxPeriodTokens ?? DEFAULT_TEXT_OPTIONS.maxPeriodTokens;
  const minRepeats = options?.minRepeats ?? DEFAULT_TEXT_OPTIONS.minRepeats;
  const minCoveredTokens = options?.minCoveredTokens ?? DEFAULT_TEXT_OPTIONS.minCoveredTokens;
  const maxWindowTokens = options?.maxWindowTokens ?? DEFAULT_TEXT_OPTIONS.maxWindowTokens;

  // Bound the tokenization cost: 64 chars/token is a generous upper bound
  // for whitespace-delimited tokens in practice; the window slice below
  // still enforces the exact token count.
  const charBudget = maxWindowTokens * 64;
  const tail = text.length > charBudget ? text.slice(-charBudget) : text;
  const allTokens = tail.trim().split(/\s+/).filter(Boolean);
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
 * `allowBlock: false` is used for text and server-tool verdicts: the tokens
 * are already emitted / the tool already ran server-side, so there is
 * nothing to block — a block-level streak falls through to steer (when
 * enabled) or observe, while stop still stops.
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

/** In-memory streak entry: serialized shape + the round of the last record. */
interface StreakEntry extends DoomLoopStreak {
  /**
   * Round of the most recent record. Same-round re-records are duplicates
   * (streak does not increment). Never serialized: a resumed run must
   * always increment on its first record, whatever its round numbering.
   */
  round?: number;
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
  private tools: Record<string, StreakEntry> = {};
  private text: StreakEntry | undefined;

  constructor(config: ResolvedDoomLoopConfig, initialState?: unknown) {
    this.config = config;
    if (initialState !== undefined) {
      this.restore(initialState);
    }
  }

  /**
   * Snapshot the serializable detector state (deep copy). Round markers are
   * deliberately dropped: rounds are meaningful only within one run.
   * `stopVerdict`/`pendingSteer` are owned by the engine, which merges them
   * into the persisted blob alongside this snapshot.
   */
  getState(): DoomLoopSerializedState {
    return {
      tools: Object.fromEntries(
        Object.entries(this.tools).map(([name, entry]) => [
          name,
          {
            fingerprint: entry.fingerprint,
            streak: entry.streak,
          },
        ]),
      ),
      ...(this.text && {
        text: {
          fingerprint: this.text.fingerprint,
          streak: this.text.streak,
        },
      }),
    };
  }

  /**
   * Restore persisted state (from `ConversationState.doomLoop`). Invalid
   * blobs are ignored with a warning — a corrupt detector state must never
   * take down a resumed run. Engine-owned fields (`stopVerdict`,
   * `pendingSteer`) are ignored here; the engine restores them itself.
   */
  restore(state: unknown): void {
    if (typeof state !== 'object' || state === null || Array.isArray(state)) {
      console.warn('[DoomLoop] Ignoring invalid persisted doom-loop state');
      return;
    }
    const candidate = state as Partial<DoomLoopSerializedState>;
    const tools: Record<string, StreakEntry> = {};
    if (typeof candidate.tools === 'object' && candidate.tools !== null) {
      for (const [name, entry] of Object.entries(candidate.tools)) {
        if (isValidStreak(entry)) {
          tools[name] = {
            fingerprint: entry.fingerprint,
            streak: entry.streak,
            // round intentionally absent: first resumed record increments.
          };
        }
      }
    }
    this.tools = tools;
    this.text = isValidStreak(candidate.text)
      ? {
          fingerprint: candidate.text.fingerprint,
          streak: candidate.text.streak,
        }
      : undefined;
  }

  /**
   * Record one tool call and return the streak record plus any verdict.
   *
   * Streak semantics:
   * - Per tool: interleaved calls to *other* tools do not reset a tool's
   *   streak (so `search X, read file, search X, read file` still trips).
   * - Per round: the same `(tool, fingerprint)` recorded again in the SAME
   *   `round` is a duplicate — the streak does not increment
   *   (`duplicateInRound: true`) and the caller should reuse the decision it
   *   applied for the first occurrence. A streak measures the model
   *   re-issuing a call *after seeing its result*, which requires a round
   *   trip; N parallel identical calls in one turn are one piece of
   *   evidence, not N.
   * - A different fingerprint for the same tool resets the streak to 1.
   *
   * Blocked calls are recorded like any other — a model re-issuing a
   * blocked call in a later round is stronger loop evidence, not progress.
   *
   * @throws Whatever {@link canonicalizeKeyMaterial} throws for unhashable
   * key material. Callers (the engine) must catch and fall back — see
   * `resolveLoopKeyMaterial` and the engine's fallback chain.
   */
  async recordToolCall(
    toolName: string,
    keyMaterial: unknown,
    round: number,
    options?: {
      /** False for post-execution records (server tools): block is meaningless. */
      allowBlock?: boolean;
      /** Verdict detector label; default 'tool-fingerprint'. */
      detector?: Extract<DoomLoopDetectorKind, 'tool-fingerprint' | 'server-tool-fingerprint'>;
    },
  ): Promise<DoomLoopCallRecord> {
    const fingerprint = await fingerprintToolCall(toolName, keyMaterial);
    const previous = this.tools[toolName];
    let streak: number;
    let duplicateInRound = false;
    if (previous && previous.fingerprint === fingerprint) {
      if (previous.round !== undefined && previous.round === round) {
        streak = previous.streak;
        duplicateInRound = true;
      } else {
        streak = previous.streak + 1;
      }
    } else {
      streak = 1;
    }
    this.tools[toolName] = {
      fingerprint,
      streak,
      round,
    };

    const allowBlock = options?.allowBlock ?? true;
    const action = resolveLadderAction(this.config.ladder, streak, {
      allowBlock,
    });
    if (!action) {
      return {
        fingerprint,
        streak,
        duplicateInRound,
      };
    }
    return {
      fingerprint,
      streak,
      duplicateInRound,
      verdict: {
        detector: options?.detector ?? 'tool-fingerprint',
        action,
        streak,
        fingerprint,
        toolName,
        message:
          `Doom loop suspected: tool "${toolName}" was invoked in ${streak} consecutive rounds ` +
          `with identical arguments (fingerprint ${fingerprint.slice(0, 16)}…). Repeating the call ` +
          'will not change the result. Take a different approach, or explain why repetition is required.',
      },
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
   *   consecutive steps. KNOWN LIMIT: paraphrased repetition does not trip.
   *
   * Empty/whitespace-only text (typical for tool-only turns) is a no-op:
   * it neither counts nor resets the cross-step streak, mirroring how
   * interleaved other-tool calls don't reset a tool streak.
   */
  async recordAssistantText(text: string): Promise<DoomLoopVerdict | undefined> {
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
          fingerprint: await fingerprintKeyMaterial(repetition.sample),
          message:
            `Doom loop suspected: the response repeats "${repetition.sample}" ` +
            `${repetition.repeats} times in a row. Stop repeating and take a different approach.`,
        };
      }
    }

    const fingerprint = await fingerprintKeyMaterial(normalized);
    const previous = this.text;
    const streak = previous && previous.fingerprint === fingerprint ? previous.streak + 1 : 1;
    this.text = {
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
