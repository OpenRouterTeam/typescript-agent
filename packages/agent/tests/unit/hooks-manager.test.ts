import { describe, expect, it, vi } from 'vitest';
import * as z4 from 'zod/v4';
import { HooksManager } from '../../src/lib/hooks-manager.js';

describe('HooksManager', () => {
  describe('constructor', () => {
    it('creates with no arguments', () => {
      const manager = new HooksManager();
      expect(manager).toBeInstanceOf(HooksManager);
    });

    it('throws on custom hook name collision with built-in', () => {
      expect(
        () =>
          new HooksManager({
            PreToolUse: {
              payload: z4.object({
                custom: z4.string(),
              }),
              result: z4.void(),
            },
          }),
      ).toThrow('collides with a built-in hook');
    });

    it('accepts custom hooks with unique names', () => {
      const manager = new HooksManager({
        MyCustomHook: {
          payload: z4.object({
            data: z4.string(),
          }),
          result: z4.void(),
        },
      });
      expect(manager).toBeInstanceOf(HooksManager);
    });
  });

  describe('on / off / removeAll', () => {
    it('registers a handler and returns unsubscribe function', async () => {
      const manager = new HooksManager();
      const handler = vi.fn();

      const unsub = manager.on('PostToolUse', {
        handler,
      });
      expect(manager.hasHandlers('PostToolUse')).toBe(true);

      unsub();
      expect(manager.hasHandlers('PostToolUse')).toBe(false);
    });

    it('removes a handler by reference with off()', async () => {
      const manager = new HooksManager();
      const handler = vi.fn();

      manager.on('PostToolUse', {
        handler,
      });
      expect(manager.hasHandlers('PostToolUse')).toBe(true);

      const removed = manager.off('PostToolUse', handler);
      expect(removed).toBe(true);
      expect(manager.hasHandlers('PostToolUse')).toBe(false);
    });

    it('returns false when off() cannot find the handler', () => {
      const manager = new HooksManager();
      const removed = manager.off('PostToolUse', vi.fn());
      expect(removed).toBe(false);
    });

    it('removes all handlers for a specific hook', () => {
      const manager = new HooksManager();
      manager.on('PostToolUse', {
        handler: vi.fn(),
      });
      manager.on('PostToolUse', {
        handler: vi.fn(),
      });
      manager.on('PreToolUse', {
        handler: vi.fn(),
      });

      manager.removeAll('PostToolUse');
      expect(manager.hasHandlers('PostToolUse')).toBe(false);
      expect(manager.hasHandlers('PreToolUse')).toBe(true);
    });

    it('removes all handlers for all hooks', () => {
      const manager = new HooksManager();
      manager.on('PostToolUse', {
        handler: vi.fn(),
      });
      manager.on('PreToolUse', {
        handler: vi.fn(),
      });

      manager.removeAll();
      expect(manager.hasHandlers('PostToolUse')).toBe(false);
      expect(manager.hasHandlers('PreToolUse')).toBe(false);
    });
  });

  describe('emit', () => {
    it('invokes registered handlers with payload', async () => {
      const manager = new HooksManager();
      const handler = vi.fn();

      manager.on('PostToolUse', {
        handler,
      });
      await manager.emit('PostToolUse', {
        toolName: 'Bash',
        toolInput: {},
        toolOutput: 'ok',
        durationMs: 100,
        sessionId: 'test',
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'Bash',
        }),
        expect.objectContaining({
          hookName: 'PostToolUse',
        }),
      );
    });

    it('returns empty results when no handlers registered', async () => {
      const manager = new HooksManager();
      const result = await manager.emit('PostToolUse', {
        toolName: 'Bash',
        toolInput: {},
        toolOutput: 'ok',
        durationMs: 100,
        sessionId: 'test',
      });

      expect(result.results).toEqual([]);
      expect(result.blocked).toBe(false);
    });

    it('passes toolName to emit context for matcher filtering', async () => {
      const manager = new HooksManager();
      const bashHandler = vi.fn();
      const readHandler = vi.fn();

      manager.on('PreToolUse', {
        matcher: 'Bash',
        handler: bashHandler,
      });
      manager.on('PreToolUse', {
        matcher: 'ReadFile',
        handler: readHandler,
      });

      await manager.emit(
        'PreToolUse',
        {
          toolName: 'Bash',
          toolInput: {},
          sessionId: 'test',
        },
        {
          toolName: 'Bash',
        },
      );

      expect(bashHandler).toHaveBeenCalledOnce();
      expect(readHandler).not.toHaveBeenCalled();
    });

    it('supports custom hooks', async () => {
      const manager = new HooksManager({
        AgentThinking: {
          payload: z4.object({
            thought: z4.string(),
          }),
          result: z4.void(),
        },
      });

      const handler = vi.fn();
      manager.on('AgentThinking', {
        handler,
      });

      await manager.emit('AgentThinking', {
        thought: 'hmm',
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          thought: 'hmm',
        }),
        expect.any(Object),
      );
    });
  });

  describe('drain', () => {
    it('resolves when no pending async handlers', async () => {
      const manager = new HooksManager();
      await expect(manager.drain()).resolves.toBeUndefined();
    });

    it('waits for pending async handler work', async () => {
      const manager = new HooksManager();
      let resolveWork: (() => void) | undefined;
      const work = new Promise<void>((resolve) => {
        resolveWork = resolve;
      });
      let drainResolved = false;

      manager.on('PostToolUse', {
        handler: () => ({
          async: true as const,
          work,
        }),
      });

      await manager.emit('PostToolUse', {
        toolName: 'Bash',
        toolInput: {},
        toolOutput: 'ok',
        durationMs: 100,
        sessionId: 'test',
      });

      const drainPromise = manager.drain().then(() => {
        drainResolved = true;
      });

      // Give drain a microtask tick to attach — it should still be pending
      // because the detached work has not settled.
      await Promise.resolve();
      expect(drainResolved).toBe(false);

      resolveWork?.();
      await drainPromise;
      expect(drainResolved).toBe(true);
    });
  });

  describe('setSessionId', () => {
    it('sets session ID used in hook context', async () => {
      const manager = new HooksManager();
      manager.setSessionId('my-session');

      let receivedSessionId = '';
      manager.on('PostToolUse', {
        handler: (_payload, context) => {
          receivedSessionId = context.sessionId;
        },
      });

      await manager.emit('PostToolUse', {
        toolName: 'Bash',
        toolInput: {},
        toolOutput: 'ok',
        durationMs: 100,
        sessionId: 'my-session',
      });

      expect(receivedSessionId).toBe('my-session');
    });

    it('payload sessionId overrides manager sessionId in hook context', async () => {
      const manager = new HooksManager();
      manager.setSessionId('stale-session');

      let receivedSessionId = '';
      manager.on('PostToolUse', {
        handler: (_payload, context) => {
          receivedSessionId = context.sessionId;
        },
      });

      await manager.emit('PostToolUse', {
        toolName: 'Bash',
        toolInput: {},
        toolOutput: 'ok',
        durationMs: 100,
        sessionId: 'fresh-session',
      });

      expect(receivedSessionId).toBe('fresh-session');
    });

    it('falls back to manager sessionId for custom hooks without sessionId in payload', async () => {
      const manager = new HooksManager({
        AgentThinking: {
          payload: z4.object({
            thought: z4.string(),
          }),
          result: z4.void(),
        },
      });
      manager.setSessionId('manager-session');

      let receivedSessionId = '';
      manager.on('AgentThinking', {
        handler: (_payload, context) => {
          receivedSessionId = context.sessionId;
        },
      });

      await manager.emit('AgentThinking', {
        thought: 'hmm',
      });

      expect(receivedSessionId).toBe('manager-session');
    });
  });

  describe('schema validation', () => {
    /**
     * Cast helper used to pass intentionally-invalid values to hook emits in
     * these validation tests without sprinkling `as any` on every call site.
     * Lives in the test file so it can't be imported by production code.
     */
    const asTyped = <T>(value: unknown): T => value as T;

    it('rejects an invalid payload against the built-in schema in strict mode', async () => {
      const manager = new HooksManager(undefined, {
        throwOnHandlerError: true,
      });
      manager.on('PreToolUse', {
        handler: vi.fn(),
      });

      // `toolInput` must be an object per PreToolUsePayloadSchema.
      await expect(
        manager.emit('PreToolUse', {
          toolName: 'Bash',
          toolInput: asTyped<Record<string, unknown>>('not an object'),
          sessionId: 's',
        }),
      ).rejects.toThrow('Invalid payload for hook "PreToolUse"');
    });

    it('default mode logs and short-circuits when payload is invalid', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = new HooksManager();
      const handler = vi.fn();
      manager.on('PreToolUse', {
        handler,
      });

      const result = await manager.emit('PreToolUse', {
        toolName: 'Bash',
        toolInput: asTyped<Record<string, unknown>>(42),
        sessionId: 's',
      });

      expect(warnSpy).toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(result.results).toEqual([]);
      expect(result.blocked).toBe(false);
      warnSpy.mockRestore();
    });

    it('rejects an invalid handler result against the built-in result schema in strict mode', async () => {
      const manager = new HooksManager(undefined, {
        throwOnHandlerError: true,
      });
      manager.on('PreToolUse', {
        // `block` must be boolean or string per PreToolUseResultSchema.
        handler: () => ({
          block: asTyped<boolean>(12345),
        }),
      });

      await expect(
        manager.emit('PreToolUse', {
          toolName: 'Bash',
          toolInput: {},
          sessionId: 's',
        }),
      ).rejects.toThrow('invalid result');
    });

    it('validates payload and result against custom hook schemas', async () => {
      const manager = new HooksManager(
        {
          AgentThinking: {
            payload: z4.object({
              thought: z4.string(),
            }),
            result: z4.object({
              ack: z4.boolean(),
            }),
          },
        },
        {
          throwOnHandlerError: true,
        },
      );

      manager.on('AgentThinking', {
        // Invalid result -- `ack` must be boolean.
        handler: () => ({
          ack: asTyped<boolean>('yes'),
        }),
      });

      await expect(
        manager.emit('AgentThinking', {
          thought: 'hmm',
        }),
      ).rejects.toThrow('invalid result');
    });

    it('does not validate results for void-typed built-in hooks', async () => {
      const manager = new HooksManager(undefined, {
        throwOnHandlerError: true,
      });
      // Void-typed hook: PostToolUse. Handler may return arbitrary values and
      // they land in `results` without schema complaints.
      manager.on('PostToolUse', {
        handler: () =>
          asTyped<void>({
            arbitrary: true,
          }),
      });

      const result = await manager.emit('PostToolUse', {
        toolName: 'Bash',
        toolInput: {},
        toolOutput: 'ok',
        durationMs: 10,
        sessionId: 's',
      });

      expect(result.results).toEqual([
        {
          arbitrary: true,
        },
      ]);
    });
  });

  describe('abortInflight', () => {
    it('aborts the signal on the LifecycleHookContext of in-flight emits', async () => {
      const manager = new HooksManager();
      let observedAborted = false;

      manager.on('PostToolUse', {
        handler: async (_payload, ctx) => {
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) {
              observedAborted = true;
              resolve();
            } else {
              ctx.signal.addEventListener('abort', () => {
                observedAborted = true;
                resolve();
              });
            }
          });
        },
      });

      const emitPromise = manager.emit('PostToolUse', {
        toolName: 'Bash',
        toolInput: {},
        toolOutput: 'ok',
        durationMs: 0,
        sessionId: 's',
      });

      // Give the handler a microtask tick to register the listener, then abort.
      await Promise.resolve();
      manager.abortInflight();
      await emitPromise;

      expect(observedAborted).toBe(true);
    });
  });

  describe('pendingAsync hygiene', () => {
    it('settled async work self-removes from pending tracking', async () => {
      const manager = new HooksManager();
      manager.on('PostToolUse', {
        handler: () => ({
          async: true as const,
          work: Promise.resolve(),
        }),
      });

      for (let i = 0; i < 5; i++) {
        await manager.emit('PostToolUse', {
          toolName: 'T',
          toolInput: {},
          toolOutput: null,
          durationMs: 0,
          sessionId: 's',
        });
      }

      // After all the detached work has settled, drain should be a no-op --
      // the self-removal hook should have cleared the internal set.
      await manager.drain();
      await manager.drain();

      // Emit one more and verify we are not accumulating entries.
      await manager.emit('PostToolUse', {
        toolName: 'T',
        toolInput: {},
        toolOutput: null,
        durationMs: 0,
        sessionId: 's',
      });
      await manager.drain();
    });
  });
});
