import { describe, it, expect, vi } from 'vitest';
import { resolveHooks } from '../../src/lib/hooks-resolve.js';
import { HooksManager } from '../../src/lib/hooks-manager.js';
import type { InlineHookConfig } from '../../src/lib/hooks-types.js';

describe('resolveHooks (adversarial)', () => {
  describe('falsy inputs', () => {
    it('returns undefined for null', () => {
      expect(resolveHooks(null as unknown as undefined)).toBeUndefined();
    });

    it('returns undefined for false', () => {
      expect(resolveHooks(false as unknown as undefined)).toBeUndefined();
    });

    it('returns undefined for 0', () => {
      expect(resolveHooks(0 as unknown as undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(resolveHooks('' as unknown as undefined)).toBeUndefined();
    });
  });

  describe('empty config', () => {
    it('empty object returns a HooksManager with no handlers', () => {
      const result = resolveHooks({});
      expect(result).toBeInstanceOf(HooksManager);
      expect(result!.hasHandlers('PreToolUse')).toBe(false);
    });

    it('config with empty arrays returns HooksManager with no handlers', () => {
      const config: InlineHookConfig = {
        PreToolUse: [],
        PostToolUse: [],
      };

      const result = resolveHooks(config);
      expect(result).toBeInstanceOf(HooksManager);
      expect(result!.hasHandlers('PreToolUse')).toBe(false);
      expect(result!.hasHandlers('PostToolUse')).toBe(false);
    });
  });

  describe('malformed config values', () => {
    it('non-array value for a hook key is skipped', () => {
      const config = {
        PreToolUse: 'not-an-array',
      } as unknown as InlineHookConfig;

      const result = resolveHooks(config);
      expect(result).toBeInstanceOf(HooksManager);
      expect(result!.hasHandlers('PreToolUse')).toBe(false);
    });

    it('null value for a hook key is skipped', () => {
      const config = {
        PreToolUse: null,
      } as unknown as InlineHookConfig;

      const result = resolveHooks(config);
      expect(result).toBeInstanceOf(HooksManager);
      expect(result!.hasHandlers('PreToolUse')).toBe(false);
    });

    it('number value for a hook key is skipped', () => {
      const config = {
        PreToolUse: 42,
      } as unknown as InlineHookConfig;

      const result = resolveHooks(config);
      expect(result).toBeInstanceOf(HooksManager);
      expect(result!.hasHandlers('PreToolUse')).toBe(false);
    });
  });

  describe('prototype pollution resistance', () => {
    it('__proto__ key in config does not pollute Object prototype', () => {
      const config = JSON.parse(
        '{"__proto__": [{"handler": null}], "PreToolUse": []}',
      );

      // This should not crash and should not pollute Object.prototype
      const result = resolveHooks(config);
      expect(result).toBeInstanceOf(HooksManager);
      expect(({} as Record<string, unknown>)['handler']).toBeUndefined();
    });

    it('constructor key in config does not crash', () => {
      const config = {
        constructor: [{ handler: vi.fn() }],
      } as unknown as InlineHookConfig;

      const result = resolveHooks(config);
      expect(result).toBeInstanceOf(HooksManager);
      // 'constructor' is treated as a hook name — it gets registered
      expect(result!.hasHandlers('constructor')).toBe(true);
    });
  });

  describe('HooksManager passthrough', () => {
    it('returns the exact same instance, not a copy', () => {
      const manager = new HooksManager();
      manager.on('PreToolUse', { handler: vi.fn() });

      const result = resolveHooks(manager);
      expect(result).toBe(manager);
    });
  });

  describe('non-standard hook names in inline config', () => {
    it('registers handlers for arbitrary hook names (not just built-in)', () => {
      const config = {
        CustomHook: [{ handler: vi.fn() }],
      } as unknown as InlineHookConfig;

      const result = resolveHooks(config);
      expect(result).toBeInstanceOf(HooksManager);
      expect(result!.hasHandlers('CustomHook')).toBe(true);
    });
  });
});
