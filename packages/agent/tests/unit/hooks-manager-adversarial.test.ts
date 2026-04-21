import { describe, expect, it, vi } from 'vitest';
import * as z4 from 'zod/v4';
import { HooksManager } from '../../src/lib/hooks-manager.js';

describe('HooksManager (adversarial)', () => {
  describe('unsubscribe edge cases', () => {
    it('calling unsubscribe twice does not throw or corrupt state', () => {
      const manager = new HooksManager();
      const unsub = manager.on('PostToolUse', {
        handler: vi.fn(),
      });

      unsub();
      unsub(); // second call should be harmless

      expect(manager.hasHandlers('PostToolUse')).toBe(false);
    });

    it('unsubscribe from one handler does not affect others', () => {
      const manager = new HooksManager();
      const h1 = vi.fn();
      const h2 = vi.fn();

      const unsub1 = manager.on('PostToolUse', {
        handler: h1,
      });
      manager.on('PostToolUse', {
        handler: h2,
      });

      unsub1();
      expect(manager.hasHandlers('PostToolUse')).toBe(true);
    });
  });

  describe('off() edge cases', () => {
    it('off with identical-looking but different function reference returns false', () => {
      const manager = new HooksManager();
      const h1 = () => {};
      const h2 = () => {};

      manager.on('PostToolUse', {
        handler: h1,
      });
      const removed = manager.off('PostToolUse', h2);

      expect(removed).toBe(false);
      expect(manager.hasHandlers('PostToolUse')).toBe(true);
    });

    it('off for a hook name that was never registered returns false', () => {
      const manager = new HooksManager();
      expect(manager.off('SessionEnd', vi.fn())).toBe(false);
    });
  });

  describe('re-entrant emit', () => {
    it('handler that registers a new handler during emit does not affect current chain', async () => {
      const manager = new HooksManager();
      const lateHandler = vi.fn();

      manager.on('PostToolUse', {
        handler: () => {
          // Register a new handler mid-emit
          manager.on('PostToolUse', {
            handler: lateHandler,
          });
        },
      });

      await manager.emit('PostToolUse', {
        toolName: 'Bash',
        toolInput: {},
        toolOutput: 'ok',
        durationMs: 100,
        sessionId: 'test',
      });

      // emit() snapshots the entries list before iterating the chain, so
      // handlers registered mid-emit are invisible to the in-flight chain and
      // will only fire on subsequent emits. This protects against the
      // symmetric removal case as well (off()/unsubscribe mid-chain can no
      // longer shift indices and skip the next handler).
      expect(lateHandler).not.toHaveBeenCalled();
    });

    it('handler that calls emit recursively does not deadlock', async () => {
      const manager = new HooksManager();
      let depth = 0;

      manager.on('SessionStart', {
        handler: async () => {
          depth++;
          if (depth < 3) {
            await manager.emit('SessionStart', {
              sessionId: `depth-${depth}`,
              config: undefined,
            });
          }
        },
      });

      await manager.emit('SessionStart', {
        sessionId: 'root',
        config: undefined,
      });

      expect(depth).toBe(3);
    });
  });

  describe('custom hook validation', () => {
    it('throws for each built-in hook name used as custom', () => {
      const builtInNames = [
        'PreToolUse',
        'PostToolUse',
        'PostToolUseFailure',
        'UserPromptSubmit',
        'Stop',
        'PermissionRequest',
        'SessionStart',
        'SessionEnd',
      ];

      for (const name of builtInNames) {
        expect(
          () =>
            new HooksManager({
              [name]: {
                payload: z4.object({}),
                result: z4.void(),
              },
            }),
        ).toThrow('collides with a built-in hook');
      }
    });

    it('allows custom hook with empty string name', () => {
      const manager = new HooksManager({
        '': {
          payload: z4.object({}),
          result: z4.void(),
        },
      });
      expect(manager).toBeInstanceOf(HooksManager);
    });
  });

  describe('emit edge cases', () => {
    it('emit for a hook with no registered handlers returns clean result', async () => {
      const manager = new HooksManager();
      const result = await manager.emit('PreToolUse', {
        toolName: 'Test',
        toolInput: {},
        sessionId: 's1',
      });

      expect(result.results).toEqual([]);
      expect(result.blocked).toBe(false);
      expect(result.pending).toEqual([]);
    });

    it('emit for an unregistered custom hook name returns clean result', async () => {
      const manager = new HooksManager();
      // Emitting a never-registered hook name
      const result = await manager.emit('NonExistentHook' as 'PostToolUse', {
        toolName: 'X',
        toolInput: {},
        toolOutput: null,
        durationMs: 0,
        sessionId: 's',
      });

      expect(result.results).toEqual([]);
    });

    it('handler that throws in strict mode propagates through emit', async () => {
      const manager = new HooksManager(undefined, {
        throwOnHandlerError: true,
      });

      manager.on('PostToolUse', {
        handler: () => {
          throw new Error('handler explosion');
        },
      });

      await expect(
        manager.emit('PostToolUse', {
          toolName: 'T',
          toolInput: {},
          toolOutput: null,
          durationMs: 0,
          sessionId: 's',
        }),
      ).rejects.toThrow('handler explosion');
    });

    it('handler that throws in default mode does not fail emit', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = new HooksManager();

      manager.on('PostToolUse', {
        handler: () => {
          throw new Error('soft failure');
        },
      });

      const result = await manager.emit('PostToolUse', {
        toolName: 'T',
        toolInput: {},
        toolOutput: null,
        durationMs: 0,
        sessionId: 's',
      });

      expect(result.results).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('PreToolUse block through manager', () => {
    it('block with string reason short-circuits and reports blocked', async () => {
      const manager = new HooksManager();
      const second = vi.fn();

      manager.on('PreToolUse', {
        handler: () => ({
          block: 'dangerous tool',
        }),
      });
      manager.on('PreToolUse', {
        handler: second,
      });

      const result = await manager.emit(
        'PreToolUse',
        {
          toolName: 'rm',
          toolInput: {
            path: '/',
          },
          sessionId: 's',
        },
        {
          toolName: 'rm',
        },
      );

      expect(result.blocked).toBe(true);
      expect(second).not.toHaveBeenCalled();
      expect(result.results).toEqual([
        {
          block: 'dangerous tool',
        },
      ]);
    });
  });

  describe('drain edge cases', () => {
    it('drain can be called multiple times safely', async () => {
      const manager = new HooksManager();
      await manager.drain();
      await manager.drain();
      // No error
    });

    it('drain after handlers have been cleared still resolves', async () => {
      const manager = new HooksManager();
      manager.on('PostToolUse', {
        handler: () => ({
          async: true as const,
          work: Promise.resolve(),
        }),
      });

      await manager.emit('PostToolUse', {
        toolName: 'T',
        toolInput: {},
        toolOutput: null,
        durationMs: 0,
        sessionId: 's',
      });

      manager.removeAll();
      await manager.drain(); // pending async should still drain
    });
  });

  describe('removeAll during usage', () => {
    it('removeAll clears all hooks even if called from within a handler', async () => {
      const manager = new HooksManager();

      manager.on('SessionStart', {
        handler: () => {
          manager.removeAll();
        },
      });

      await manager.emit('SessionStart', {
        sessionId: 's',
        config: undefined,
      });

      expect(manager.hasHandlers('SessionStart')).toBe(false);
    });
  });

  describe('internal registrar is not publicly reachable', () => {
    it('HooksManager has no public registerEntry method', () => {
      const manager = new HooksManager();
      // `registerEntry` used to be a public method on the class. It has been
      // removed in favour of a module-private registrar reached only via
      // `getInternalRegistrar`. Neither the instance nor its prototype chain
      // should expose a `registerEntry` symbol.
      expect('registerEntry' in manager).toBe(false);
    });
  });

  describe('setSessionId', () => {
    it('changing sessionId mid-session is reflected in subsequent emits', async () => {
      const manager = new HooksManager();
      const sessionIds: string[] = [];

      manager.on('PostToolUse', {
        handler: (_p, ctx) => {
          sessionIds.push(ctx.sessionId);
        },
      });

      manager.setSessionId('session-1');
      await manager.emit('PostToolUse', {
        toolName: 'T',
        toolInput: {},
        toolOutput: null,
        durationMs: 0,
        sessionId: 'session-1',
      });

      manager.setSessionId('session-2');
      await manager.emit('PostToolUse', {
        toolName: 'T',
        toolInput: {},
        toolOutput: null,
        durationMs: 0,
        sessionId: 'session-2',
      });

      expect(sessionIds).toEqual([
        'session-1',
        'session-2',
      ]);
    });

    it('payload sessionId overrides the manager sessionId when they disagree', async () => {
      const manager = new HooksManager();
      const sessionIds: string[] = [];

      manager.on('PostToolUse', {
        handler: (_p, ctx) => {
          sessionIds.push(ctx.sessionId);
        },
      });

      manager.setSessionId('stale-manager-id');
      await manager.emit('PostToolUse', {
        toolName: 'T',
        toolInput: {},
        toolOutput: null,
        durationMs: 0,
        sessionId: 'fresh-payload-id',
      });

      expect(sessionIds).toEqual([
        'fresh-payload-id',
      ]);
    });
  });
});
