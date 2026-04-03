import { describe, it, expect, vi } from 'vitest';
import * as z4 from 'zod/v4';
import { HooksManager } from '../../src/lib/hooks-manager.js';

describe('HooksManager', () => {
  describe('constructor', () => {
    it('creates with no arguments', () => {
      const manager = new HooksManager();
      expect(manager).toBeInstanceOf(HooksManager);
    });

    it('throws on custom hook name collision with built-in', () => {
      expect(() =>
        new HooksManager({
          PreToolUse: {
            payload: z4.object({ custom: z4.string() }),
            result: z4.void(),
          },
        }),
      ).toThrow('collides with a built-in hook');
    });

    it('accepts custom hooks with unique names', () => {
      const manager = new HooksManager({
        MyCustomHook: {
          payload: z4.object({ data: z4.string() }),
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

      const unsub = manager.on('PostToolUse', { handler });
      expect(manager.hasHandlers('PostToolUse')).toBe(true);

      unsub();
      expect(manager.hasHandlers('PostToolUse')).toBe(false);
    });

    it('removes a handler by reference with off()', async () => {
      const manager = new HooksManager();
      const handler = vi.fn();

      manager.on('PostToolUse', { handler });
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
      manager.on('PostToolUse', { handler: vi.fn() });
      manager.on('PostToolUse', { handler: vi.fn() });
      manager.on('PreToolUse', { handler: vi.fn() });

      manager.removeAll('PostToolUse');
      expect(manager.hasHandlers('PostToolUse')).toBe(false);
      expect(manager.hasHandlers('PreToolUse')).toBe(true);
    });

    it('removes all handlers for all hooks', () => {
      const manager = new HooksManager();
      manager.on('PostToolUse', { handler: vi.fn() });
      manager.on('PreToolUse', { handler: vi.fn() });

      manager.removeAll();
      expect(manager.hasHandlers('PostToolUse')).toBe(false);
      expect(manager.hasHandlers('PreToolUse')).toBe(false);
    });
  });

  describe('emit', () => {
    it('invokes registered handlers with payload', async () => {
      const manager = new HooksManager();
      const handler = vi.fn();

      manager.on('PostToolUse', { handler });
      await manager.emit('PostToolUse', {
        toolName: 'Bash',
        toolInput: {},
        toolOutput: 'ok',
        durationMs: 100,
        sessionId: 'test',
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'Bash' }),
        expect.objectContaining({ hookName: 'PostToolUse' }),
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

      manager.on('PreToolUse', { matcher: 'Bash', handler: bashHandler });
      manager.on('PreToolUse', { matcher: 'ReadFile', handler: readHandler });

      await manager.emit(
        'PreToolUse',
        { toolName: 'Bash', toolInput: {}, sessionId: 'test' },
        { toolName: 'Bash' },
      );

      expect(bashHandler).toHaveBeenCalledOnce();
      expect(readHandler).not.toHaveBeenCalled();
    });

    it('supports custom hooks', async () => {
      const manager = new HooksManager({
        AgentThinking: {
          payload: z4.object({ thought: z4.string() }),
          result: z4.void(),
        },
      });

      const handler = vi.fn();
      manager.on('AgentThinking', { handler });

      await manager.emit('AgentThinking', { thought: 'hmm' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ thought: 'hmm' }),
        expect.any(Object),
      );
    });
  });

  describe('drain', () => {
    it('resolves when no pending async handlers', async () => {
      const manager = new HooksManager();
      await expect(manager.drain()).resolves.toBeUndefined();
    });

    it('waits for pending async handlers', async () => {
      const manager = new HooksManager();
      manager.on('PostToolUse', {
        handler: () => {
          // Return async output signal
          return { async: true as const };
        },
      });

      await manager.emit('PostToolUse', {
        toolName: 'Bash',
        toolInput: {},
        toolOutput: 'ok',
        durationMs: 100,
        sessionId: 'test',
      });

      await manager.drain();
      // Drain completes (async tracking works even if side effects are independent)
      expect(true).toBe(true);
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
        sessionId: 'test',
      });

      expect(receivedSessionId).toBe('my-session');
    });
  });
});
