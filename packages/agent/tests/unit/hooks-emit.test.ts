import { describe, expect, it, vi } from 'vitest';
import { executeHandlerChain } from '../../src/lib/hooks-emit.js';
import type { HookContext, HookEntry } from '../../src/lib/hooks-types.js';

function makeContext(hookName = 'TestHook'): HookContext {
  return {
    signal: new AbortController().signal,
    hookName,
    sessionId: 'test-session',
  };
}

describe('executeHandlerChain', () => {
  it('executes handlers in registration order', async () => {
    const order: number[] = [];
    const entries: HookEntry<
      {
        value: number;
      },
      void
    >[] = [
      {
        handler: () => {
          order.push(1);
        },
      },
      {
        handler: () => {
          order.push(2);
        },
      },
      {
        handler: () => {
          order.push(3);
        },
      },
    ];

    await executeHandlerChain(
      entries,
      {
        value: 0,
      },
      makeContext(),
      {
        hookName: 'Test',
        throwOnHandlerError: false,
      },
    );

    expect(order).toEqual([
      1,
      2,
      3,
    ]);
  });

  it('skips handlers when matcher does not match', async () => {
    const called = vi.fn();
    const entries: HookEntry<
      {
        toolName: string;
      },
      void
    >[] = [
      {
        matcher: 'Bash',
        handler: called,
      },
    ];

    await executeHandlerChain(
      entries,
      {
        toolName: 'ReadFile',
      },
      makeContext(),
      {
        hookName: 'Test',
        throwOnHandlerError: false,
        toolName: 'ReadFile',
      },
    );

    expect(called).not.toHaveBeenCalled();
  });

  it('invokes handler when matcher matches', async () => {
    const called = vi.fn();
    const entries: HookEntry<
      {
        toolName: string;
      },
      void
    >[] = [
      {
        matcher: 'Bash',
        handler: called,
      },
    ];

    await executeHandlerChain(
      entries,
      {
        toolName: 'Bash',
      },
      makeContext(),
      {
        hookName: 'Test',
        throwOnHandlerError: false,
        toolName: 'Bash',
      },
    );

    expect(called).toHaveBeenCalledOnce();
  });

  it('skips handlers when filter returns false', async () => {
    const called = vi.fn();
    const entries: HookEntry<
      {
        value: number;
      },
      void
    >[] = [
      {
        filter: (p) => p.value > 5,
        handler: called,
      },
    ];

    await executeHandlerChain(
      entries,
      {
        value: 3,
      },
      makeContext(),
      {
        hookName: 'Test',
        throwOnHandlerError: false,
      },
    );

    expect(called).not.toHaveBeenCalled();
  });

  it('collects sync results', async () => {
    const entries: HookEntry<
      {
        v: number;
      },
      {
        doubled: number;
      }
    >[] = [
      {
        handler: (p) => ({
          doubled: p.v * 2,
        }),
      },
      {
        handler: (p) => ({
          doubled: p.v * 3,
        }),
      },
    ];

    const result = await executeHandlerChain(
      entries,
      {
        v: 5,
      },
      makeContext(),
      {
        hookName: 'Test',
        throwOnHandlerError: false,
      },
    );

    expect(result.results).toEqual([
      {
        doubled: 10,
      },
      {
        doubled: 15,
      },
    ]);
  });

  it('applies mutation piping for mutatedInput', async () => {
    const entries: HookEntry<
      {
        toolInput: Record<string, unknown>;
      },
      {
        mutatedInput: Record<string, unknown>;
      }
    >[] = [
      {
        handler: ({ toolInput }) => ({
          mutatedInput: {
            ...toolInput,
            added: true,
          },
        }),
      },
      {
        handler: ({ toolInput }) => ({
          mutatedInput: {
            ...toolInput,
            second: true,
          },
        }),
      },
    ];

    const result = await executeHandlerChain(
      entries,
      {
        toolInput: {
          original: true,
        },
      },
      makeContext(),
      {
        hookName: 'PreToolUse',
        throwOnHandlerError: false,
      },
    );

    expect(result.finalPayload.toolInput).toEqual({
      original: true,
      added: true,
      second: true,
    });
  });

  it('short-circuits on block for PreToolUse', async () => {
    const secondHandler = vi.fn();
    const entries: HookEntry<
      {
        toolInput: Record<string, unknown>;
      },
      {
        block?: boolean | string;
      }
    >[] = [
      {
        handler: () => ({
          block: 'dangerous',
        }),
      },
      {
        handler: secondHandler,
      },
    ];

    const result = await executeHandlerChain(
      entries,
      {
        toolInput: {},
      },
      makeContext(),
      {
        hookName: 'PreToolUse',
        throwOnHandlerError: false,
      },
    );

    expect(result.blocked).toBe(true);
    expect(secondHandler).not.toHaveBeenCalled();
  });

  it('short-circuits on reject for UserPromptSubmit', async () => {
    const secondHandler = vi.fn();
    const entries: HookEntry<
      {
        prompt: string;
      },
      {
        reject?: boolean | string;
      }
    >[] = [
      {
        handler: () => ({
          reject: 'not allowed',
        }),
      },
      {
        handler: secondHandler,
      },
    ];

    const result = await executeHandlerChain(
      entries,
      {
        prompt: 'test',
      },
      makeContext(),
      {
        hookName: 'UserPromptSubmit',
        throwOnHandlerError: false,
      },
    );

    expect(result.blocked).toBe(true);
    expect(secondHandler).not.toHaveBeenCalled();
  });

  it('handles async output by tracking pending promises', async () => {
    const entries: HookEntry<unknown, void>[] = [
      {
        handler: () => ({
          async: true as const,
        }),
      },
    ];

    const result = await executeHandlerChain(entries, {}, makeContext(), {
      hookName: 'Test',
      throwOnHandlerError: false,
    });

    expect(result.pending.length).toBe(1);
    expect(result.results.length).toBe(0);
  });

  it('logs and continues on handler error in default mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secondHandler = vi.fn();

    const entries: HookEntry<unknown, void>[] = [
      {
        handler: () => {
          throw new Error('boom');
        },
      },
      {
        handler: secondHandler,
      },
    ];

    await executeHandlerChain(entries, {}, makeContext(), {
      hookName: 'Test',
      throwOnHandlerError: false,
    });

    expect(warnSpy).toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('throws in strict mode on handler error', async () => {
    const entries: HookEntry<unknown, void>[] = [
      {
        handler: () => {
          throw new Error('boom');
        },
      },
    ];

    await expect(
      executeHandlerChain(entries, {}, makeContext(), {
        hookName: 'Test',
        throwOnHandlerError: true,
      }),
    ).rejects.toThrow('boom');
  });
});
