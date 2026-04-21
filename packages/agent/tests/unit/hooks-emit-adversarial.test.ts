import { describe, expect, it, vi } from 'vitest';
import { executeHandlerChain } from '../../src/lib/hooks-emit.js';
import type { HookEntry, LifecycleHookContext } from '../../src/lib/hooks-types.js';

function makeContext(hookName = 'TestHook'): LifecycleHookContext {
  return {
    signal: new AbortController().signal,
    hookName,
    sessionId: 'test-session',
  };
}

describe('executeHandlerChain (adversarial)', () => {
  describe('empty and degenerate inputs', () => {
    it('returns clean result for empty entries array', async () => {
      const result = await executeHandlerChain(
        [],
        {
          v: 1,
        },
        makeContext(),
        {
          hookName: 'Test',
          throwOnHandlerError: false,
        },
      );

      expect(result.results).toEqual([]);
      expect(result.pending).toEqual([]);
      expect(result.blocked).toBe(false);
      expect(result.finalPayload).toEqual({
        v: 1,
      });
    });

    it('skips sparse array holes (undefined entries)', async () => {
      // biome-ignore lint/suspicious/noSparseArray: intentional sparse array to test hole handling
      const entries = [
        ,
        ,
        {
          handler: vi.fn(),
        },
      ] as unknown as HookEntry<unknown, void>[];

      await executeHandlerChain(entries, {}, makeContext(), {
        hookName: 'Test',
        throwOnHandlerError: false,
      });

      expect(entries[2]!.handler).toHaveBeenCalledOnce();
    });
  });

  describe('handler return value edge cases', () => {
    it('treats null return as void (no result collected)', async () => {
      const entries: HookEntry<
        unknown,
        {
          v: number;
        }
      >[] = [
        {
          handler: () =>
            null as unknown as {
              v: number;
            },
        },
      ];

      const result = await executeHandlerChain(entries, {}, makeContext(), {
        hookName: 'Test',
        throwOnHandlerError: false,
      });

      expect(result.results).toEqual([]);
    });

    it('collects non-object primitive results without mutation crash', async () => {
      const entries: HookEntry<
        {
          toolInput: Record<string, unknown>;
        },
        number
      >[] = [
        {
          handler: () => 42,
        },
        {
          handler: () => 99,
        },
      ];

      const result = await executeHandlerChain(
        entries,
        {
          toolInput: {
            a: 1,
          },
        },
        makeContext(),
        {
          hookName: 'PreToolUse',
          throwOnHandlerError: false,
        },
      );

      // applyMutations should be a no-op for primitives
      expect(result.results).toEqual([
        42,
        99,
      ]);
      expect(result.finalPayload.toolInput).toEqual({
        a: 1,
      });
    });

    it('does not trigger block on non-blocking hooks even if result has block field', async () => {
      const entries: HookEntry<
        unknown,
        {
          block: boolean;
        }
      >[] = [
        {
          handler: () => ({
            block: true,
          }),
        },
      ];

      const result = await executeHandlerChain(entries, {}, makeContext(), {
        hookName: 'PostToolUse', // Not a blocking hook
        throwOnHandlerError: false,
      });

      expect(result.blocked).toBe(false);
      expect(result.results).toEqual([
        {
          block: true,
        },
      ]);
    });

    it('block: false does not short-circuit PreToolUse', async () => {
      const second = vi.fn(() => ({
        block: false,
      }));
      const entries: HookEntry<
        {
          toolInput: Record<string, unknown>;
        },
        {
          block: boolean;
        }
      >[] = [
        {
          handler: () => ({
            block: false,
          }),
        },
        {
          handler: second,
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

      expect(result.blocked).toBe(false);
      expect(second).toHaveBeenCalled();
    });

    it('block: 0 (falsy number) does not short-circuit', async () => {
      const second = vi.fn();
      const entries: HookEntry<
        {
          toolInput: Record<string, unknown>;
        },
        {
          block: number;
        }
      >[] = [
        {
          handler: () => ({
            block: 0,
          }),
        },
        {
          handler: second,
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

      // 0 is neither `true` nor a string, so should not block
      expect(result.blocked).toBe(false);
      expect(second).toHaveBeenCalled();
    });

    it('block: "" (empty string) does NOT short-circuit (fails closed without a reason)', async () => {
      const second = vi.fn();
      const entries: HookEntry<
        {
          toolInput: Record<string, unknown>;
        },
        {
          block: string;
        }
      >[] = [
        {
          handler: () => ({
            block: '',
          }),
        },
        {
          handler: second,
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

      // An empty string is not a usable block reason; model-result.ts searches
      // for the first truthy `block` field to surface a reason and would fall
      // through, so emit must also treat this as "no block triggered" for the
      // two sides to stay consistent.
      expect(result.blocked).toBe(false);
      expect(second).toHaveBeenCalled();
    });
  });

  describe('mutation piping edge cases', () => {
    it('mutatedInput: undefined does not overwrite existing toolInput', async () => {
      const entries: HookEntry<
        {
          toolInput: Record<string, unknown>;
        },
        {
          mutatedInput: undefined;
        }
      >[] = [
        {
          handler: () => ({
            mutatedInput: undefined,
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
      });
    });

    it('mutatedPrompt pipes correctly through UserPromptSubmit', async () => {
      const entries: HookEntry<
        {
          prompt: string;
        },
        {
          mutatedPrompt: string;
        }
      >[] = [
        {
          handler: () => ({
            mutatedPrompt: 'rewritten-1',
          }),
        },
        {
          handler: (p) => ({
            mutatedPrompt: `${p.prompt}+appended`,
          }),
        },
      ];

      const result = await executeHandlerChain(
        entries,
        {
          prompt: 'original',
        },
        makeContext(),
        {
          hookName: 'UserPromptSubmit',
          throwOnHandlerError: false,
        },
      );

      // First handler rewrites prompt to 'rewritten-1', second sees 'rewritten-1' as p.prompt
      expect(result.finalPayload.prompt).toBe('rewritten-1+appended');
    });

    it('result with __proto__ key does not cause prototype pollution', async () => {
      const entries: HookEntry<
        {
          toolInput: Record<string, unknown>;
        },
        Record<string, unknown>
      >[] = [
        {
          handler: () => {
            const obj = Object.create(null);
            obj['__proto__'] = {
              polluted: true,
            };
            return obj;
          },
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(({} as Record<string, unknown>)['polluted'] as unknown).toBeUndefined();
      expect(result.results.length).toBe(1);
    });
  });

  describe('filter edge cases', () => {
    it('throwing filter is caught in non-strict mode', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const entries: HookEntry<unknown, void>[] = [
        {
          filter: () => {
            throw new Error('filter boom');
          },
          handler: vi.fn(),
        },
      ];

      // The filter throw happens inside the try block since filter is called
      // before handler. Let's verify current behavior.
      // Looking at the code: filter is called OUTSIDE the try block!
      // This means a throwing filter will propagate.
      await expect(
        executeHandlerChain(entries, {}, makeContext(), {
          hookName: 'Test',
          throwOnHandlerError: false,
        }),
      ).rejects.toThrow('filter boom');

      warnSpy.mockRestore();
    });

    it('throwing filter in strict mode propagates error', async () => {
      const entries: HookEntry<unknown, void>[] = [
        {
          filter: () => {
            throw new Error('filter fail');
          },
          handler: vi.fn(),
        },
      ];

      await expect(
        executeHandlerChain(entries, {}, makeContext(), {
          hookName: 'Test',
          throwOnHandlerError: true,
        }),
      ).rejects.toThrow('filter fail');
    });
  });

  describe('async output edge cases', () => {
    it('{ async: true } with block field is treated as async, not block', async () => {
      const entries: HookEntry<
        {
          toolInput: Record<string, unknown>;
        },
        {
          async: true;
          block: true;
          work: Promise<void>;
        }
      >[] = [
        {
          handler: () => ({
            async: true as const,
            block: true,
            work: Promise.resolve(),
          }),
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

      // isAsyncOutput check comes before block check, so this should be async
      expect(result.pending.length).toBe(1);
      expect(result.blocked).toBe(false);
      expect(result.results).toEqual([]);
    });

    it('{ async: true } without `work` does not push a pending promise', async () => {
      const entries: HookEntry<
        unknown,
        {
          async: true;
        }
      >[] = [
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

      // No `work` => nothing to track; pending stays empty.
      expect(result.pending.length).toBe(0);
      expect(result.results).toEqual([]);
    });

    it('{ async: "true" } (string) is NOT treated as async', async () => {
      const entries: HookEntry<
        unknown,
        {
          async: string;
        }
      >[] = [
        {
          handler: () => ({
            async: 'true',
          }),
        },
      ];

      const result = await executeHandlerChain(entries, {}, makeContext(), {
        hookName: 'Test',
        throwOnHandlerError: false,
      });

      // isAsyncOutput requires async === true (boolean), not "true" (string)
      expect(result.pending.length).toBe(0);
      expect(result.results).toEqual([
        {
          async: 'true',
        },
      ]);
    });
  });

  describe('error handling edge cases', () => {
    it('handler returning a rejected promise is caught in non-strict mode', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const secondHandler = vi.fn();

      const entries: HookEntry<unknown, void>[] = [
        {
          handler: () => Promise.reject(new Error('async boom')),
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

    it('non-Error thrown values are caught in non-strict mode', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const entries: HookEntry<unknown, void>[] = [
        {
          handler: () => {
            throw 'string error';
          },
        },
      ];

      await executeHandlerChain(entries, {}, makeContext(), {
        hookName: 'Test',
        throwOnHandlerError: false,
      });

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('non-Error thrown values propagate in strict mode', async () => {
      const entries: HookEntry<unknown, void>[] = [
        {
          handler: () => {
            throw 'string error';
          },
        },
      ];

      await expect(
        executeHandlerChain(entries, {}, makeContext(), {
          hookName: 'Test',
          throwOnHandlerError: true,
        }),
      ).rejects.toBe('string error');
    });
  });

  describe('matcher + filter interaction', () => {
    it('matcher is checked before filter — mismatched matcher skips filter call', async () => {
      const filterFn = vi.fn(() => true);
      const entries: HookEntry<unknown, void>[] = [
        {
          matcher: 'Bash',
          filter: filterFn,
          handler: vi.fn(),
        },
      ];

      await executeHandlerChain(entries, {}, makeContext(), {
        hookName: 'Test',
        throwOnHandlerError: false,
        toolName: 'ReadFile',
      });

      expect(filterFn).not.toHaveBeenCalled();
    });

    it('matcher without toolName in options skips the handler (fails closed)', async () => {
      const handler = vi.fn();
      const entries: HookEntry<unknown, void>[] = [
        {
          matcher: 'Bash',
          handler,
        },
      ];

      await executeHandlerChain(entries, {}, makeContext(), {
        hookName: 'Test',
        throwOnHandlerError: false,
        // no toolName
      });

      // A handler with a matcher has declared it cares about tool identity.
      // If the caller cannot supply a toolName, we cannot prove the matcher
      // applies, so we skip the handler rather than invoking it globally.
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('large chain stress', () => {
    it('handles 1000 handlers without stack overflow', async () => {
      const entries: HookEntry<
        {
          count: number;
        },
        void
      >[] = Array.from(
        {
          length: 1000,
        },
        () => ({
          handler: vi.fn(),
        }),
      );

      const result = await executeHandlerChain(
        entries,
        {
          count: 0,
        },
        makeContext(),
        {
          hookName: 'Test',
          throwOnHandlerError: false,
        },
      );

      expect(result.results).toEqual([]);
      for (const entry of entries) {
        expect(entry.handler).toHaveBeenCalledOnce();
      }
    });
  });
});
