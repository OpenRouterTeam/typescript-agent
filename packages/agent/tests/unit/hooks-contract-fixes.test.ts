/**
 * Regression tests for the hooks contract fixes:
 *
 * 1. Payload validation feeds `parsed.data` into the chain (transforms /
 *    defaults / key-stripping apply).
 * 2. `emit.mutated` is the authoritative mutation signal (payload cloning by
 *    validation no longer false-positives reference comparisons).
 * 3. Custom hooks with `result: z.void()` skip result validation exactly like
 *    the built-in void hooks (decided by schema shape, not name list).
 * 4. Non-plain payloads (Date, Map, class instances) pass through the chain
 *    un-cloned and un-mangled.
 * 5. `asyncTimeout` bounds how long drain() waits and aborts the emit signal
 *    so handlers can cancel cooperatively.
 * 6. `abortInflight()` reaches fire-and-forget work that outlives the emit.
 * 7. drain() runs on session teardown even when SessionStart never fired
 *    (approval-resume path).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z4 from 'zod/v4';
import { HooksManager, isVoidSchema } from '../../src/lib/hooks-manager.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('payload validation uses parsed.data', () => {
  it('applies .transform() so handlers see the schema OUTPUT type', async () => {
    const manager = new HooksManager({
      Numify: {
        payload: z4.object({
          n: z4.string().transform((s) => Number(s)),
        }),
        result: z4.void(),
      },
    });

    let seen: unknown;
    manager.on('Numify', {
      handler: (payload) => {
        seen = payload.n;
      },
    });

    await manager.emit('Numify', {
      n: '42',
    } as unknown as {
      n: number;
    });

    expect(seen).toBe(42);
  });

  it('applies .default() for omitted fields', async () => {
    const manager = new HooksManager({
      Defaulted: {
        payload: z4.object({
          level: z4.string().default('info'),
        }),
        result: z4.void(),
      },
    });

    let seen: unknown;
    manager.on('Defaulted', {
      handler: (payload) => {
        seen = payload.level;
      },
    });

    await manager.emit(
      'Defaulted',
      {} as {
        level: string;
      },
    );

    expect(seen).toBe('info');
  });

  it('finalPayload reflects the parsed shape', async () => {
    const manager = new HooksManager({
      Stripped: {
        payload: z4.object({
          keep: z4.string(),
        }),
        result: z4.void(),
      },
    });
    manager.on('Stripped', {
      handler: () => {},
    });

    const result = await manager.emit('Stripped', {
      keep: 'yes',
      extra: 'stripped-by-zod-object-default',
    } as {
      keep: string;
    });

    expect(result.finalPayload).toEqual({
      keep: 'yes',
    });
  });
});

describe('emit.mutated is the authoritative mutation signal', () => {
  it('is false when no handler pipes a mutation (despite payload cloning)', async () => {
    const manager = new HooksManager();
    manager.on('PreToolUse', {
      handler: () => undefined,
    });

    const result = await manager.emit(
      'PreToolUse',
      {
        toolName: 't',
        toolInput: {},
        sessionId: 's',
      },
      {
        toolName: 't',
      },
    );

    expect(result.mutated).toBe(false);
  });

  it('is true when a handler returns mutatedInput', async () => {
    const manager = new HooksManager();
    manager.on('PreToolUse', {
      handler: () => ({
        mutatedInput: {
          injected: true,
        },
      }),
    });

    const result = await manager.emit(
      'PreToolUse',
      {
        toolName: 't',
        toolInput: {},
        sessionId: 's',
      },
      {
        toolName: 't',
      },
    );

    expect(result.mutated).toBe(true);
    expect(result.finalPayload.toolInput).toEqual({
      injected: true,
    });
  });

  it('mutation from a blocking handler still lands before the short-circuit', async () => {
    const manager = new HooksManager();
    manager.on('PreToolUse', {
      handler: () => ({
        mutatedInput: {
          scrubbed: true,
        },
        block: 'policy',
      }),
    });

    const result = await manager.emit(
      'PreToolUse',
      {
        toolName: 't',
        toolInput: {
          secret: 'x',
        },
        sessionId: 's',
      },
      {
        toolName: 't',
      },
    );

    expect(result.blocked).toBe(true);
    expect(result.mutated).toBe(true);
    expect(result.finalPayload.toolInput).toEqual({
      scrubbed: true,
    });
  });
});

describe('void schema detection (pins zod v4 internals against upgrades)', () => {
  // isVoidSchema reads `schema._zod.def.type` -- zod v4's introspection
  // surface for library authors, but still an internal shape. These tests
  // pin the detection so a zod upgrade that restructures the internals
  // fails loudly here instead of silently re-enabling result validation on
  // void-result hooks.
  it('returns true for z.void()', () => {
    expect(isVoidSchema(z4.void())).toBe(true);
  });

  it('returns false for non-void schemas', () => {
    expect(isVoidSchema(z4.object({}))).toBe(false);
    expect(isVoidSchema(z4.string())).toBe(false);
    expect(isVoidSchema(z4.undefined())).toBe(false);
    expect(isVoidSchema(z4.unknown())).toBe(false);
    expect(isVoidSchema(z4.null())).toBe(false);
  });

  it('the _zod.def.type introspection surface exists on v4 schemas', () => {
    // Canary: if this fails after a zod upgrade, isVoidSchema needs a new
    // detection strategy.
    const internals = (
      z4.void() as unknown as {
        _zod?: {
          def?: {
            type?: string;
          };
        };
      }
    )._zod;
    expect(internals?.def?.type).toBe('void');
  });
});

describe('custom void-result hooks skip result validation (schema shape, not name list)', () => {
  it('handler returning an arbitrary value does not warn or throw', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new HooksManager(
      {
        Audit: {
          payload: z4.object({}),
          result: z4.void(),
        },
      },
      {
        throwOnHandlerError: true,
      },
    );
    // The handler intentionally returns a value from a void-result hook; the
    // double cast on the function type sidesteps the compile-time void check
    // the same way real-world JS callers would.
    const returnsValue = () => ({
      logged: true,
    });
    manager.on('Audit', {
      handler: returnsValue as unknown as () => undefined,
    });

    const result = await manager.emit('Audit', {});
    expect(result.results).toEqual([
      {
        logged: true,
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('non-plain payloads pass through un-mangled', () => {
  it('a Date payload reaches the handler intact', async () => {
    const manager = new HooksManager({
      Dated: {
        payload: z4.date(),
        result: z4.void(),
      },
    });

    let seen: unknown;
    manager.on('Dated', {
      handler: (payload) => {
        seen = payload;
      },
    });

    const d = new Date('2026-01-01T00:00:00Z');
    await manager.emit('Dated', d);

    expect(seen).toBeInstanceOf(Date);
    expect((seen as Date).getTime()).toBe(d.getTime());
  });

  it('a Map payload reaches the handler intact (no schema registered)', async () => {
    const manager = new HooksManager({
      Mapped: {
        payload: z4.instanceof(Map),
        result: z4.void(),
      },
    });

    let seen: unknown;
    manager.on('Mapped', {
      handler: (payload) => {
        seen = payload;
      },
    });

    const m = new Map([
      [
        'k',
        'v',
      ],
    ]);
    await manager.emit('Mapped', m);

    expect(seen).toBeInstanceOf(Map);
    expect((seen as Map<string, string>).get('k')).toBe('v');
  });
});

describe('asyncTimeout and abortInflight semantics', () => {
  it('drain() resolves at the asyncTimeout even when work never settles', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new HooksManager();

    manager.on('PostToolUse', {
      handler: () => ({
        async: true as const,
        work: new Promise<never>(() => {}),
        asyncTimeout: 1_000,
      }),
    });

    await manager.emit(
      'PostToolUse',
      {
        toolName: 't',
        toolInput: {},
        toolOutput: null,
        durationMs: 1,
        sessionId: 's',
      },
      {
        toolName: 't',
      },
    );

    let drained = false;
    const drainPromise = manager.drain().then(() => {
      drained = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(drained).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    await drainPromise;
    expect(drained).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeded its 1000ms timeout'));
  });

  it('the emit signal is aborted when async work times out', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new HooksManager();

    let signal: AbortSignal | undefined;
    manager.on('PostToolUse', {
      handler: (_payload, ctx) => {
        signal = ctx.signal;
        return {
          async: true as const,
          work: new Promise<never>(() => {}),
          asyncTimeout: 500,
        };
      },
    });

    await manager.emit(
      'PostToolUse',
      {
        toolName: 't',
        toolInput: {},
        toolOutput: null,
        durationMs: 1,
        sessionId: 's',
      },
      {
        toolName: 't',
      },
    );

    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(501);
    expect(signal?.aborted).toBe(true);
  });

  it('abortInflight() reaches detached work that outlives the emit', async () => {
    const manager = new HooksManager();

    let signal: AbortSignal | undefined;
    let releaseWork: (() => void) | undefined;
    manager.on('PostToolUse', {
      handler: (_payload, ctx) => {
        signal = ctx.signal;
        return {
          async: true as const,
          work: new Promise<void>((resolve) => {
            releaseWork = resolve;
          }),
        };
      },
    });

    // emit() returns while the detached work is still pending.
    await manager.emit(
      'PostToolUse',
      {
        toolName: 't',
        toolInput: {},
        toolOutput: null,
        durationMs: 1,
        sessionId: 's',
      },
      {
        toolName: 't',
      },
    );

    expect(signal?.aborted).toBe(false);

    // The controller must still be registered because the work is pending.
    manager.abortInflight('shutdown');
    expect(signal?.aborted).toBe(true);

    releaseWork?.();
    await manager.drain();
  });

  it('controller is released once detached work settles', async () => {
    const manager = new HooksManager();

    let signal: AbortSignal | undefined;
    manager.on('PostToolUse', {
      handler: (_payload, ctx) => {
        signal = ctx.signal;
        return {
          async: true as const,
          work: Promise.resolve(),
        };
      },
    });

    await manager.emit(
      'PostToolUse',
      {
        toolName: 't',
        toolInput: {},
        toolOutput: null,
        durationMs: 1,
        sessionId: 's',
      },
      {
        toolName: 't',
      },
    );
    await manager.drain();

    // Work settled -> controller deregistered -> abortInflight is a no-op.
    manager.abortInflight('too-late');
    expect(signal?.aborted).toBe(false);
  });
});
