import { describe, expect, it, vi } from 'vitest';
import { HooksManager } from '../../src/lib/hooks-manager.js';
import { resolveHooks } from '../../src/lib/hooks-resolve.js';
import type { InlineHookConfig } from '../../src/lib/hooks-types.js';

describe('resolveHooks (adversarial)', () => {
  describe('falsy inputs', () => {
    it('returns undefined for null', () => {
      // @ts-expect-error deliberate misuse: null is not a valid hooks option
      expect(resolveHooks(null)).toBeUndefined();
    });

    it('returns undefined for false', () => {
      // @ts-expect-error deliberate misuse: false is not a valid hooks option
      expect(resolveHooks(false)).toBeUndefined();
    });

    it('returns undefined for 0', () => {
      // @ts-expect-error deliberate misuse: 0 is not a valid hooks option
      expect(resolveHooks(0)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      // @ts-expect-error deliberate misuse: '' is not a valid hooks option
      expect(resolveHooks('')).toBeUndefined();
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
      const result = resolveHooks({
        // @ts-expect-error deliberate misuse: hook entries must be an array
        PreToolUse: 'not-an-array',
      });
      expect(result).toBeInstanceOf(HooksManager);
      expect(result!.hasHandlers('PreToolUse')).toBe(false);
    });

    it('null value for a hook key is skipped', () => {
      const result = resolveHooks({
        // @ts-expect-error deliberate misuse: hook entries must be an array
        PreToolUse: null,
      });
      expect(result).toBeInstanceOf(HooksManager);
      expect(result!.hasHandlers('PreToolUse')).toBe(false);
    });

    it('number value for a hook key is skipped', () => {
      const result = resolveHooks({
        // @ts-expect-error deliberate misuse: hook entries must be an array
        PreToolUse: 42,
      });
      expect(result).toBeInstanceOf(HooksManager);
      expect(result!.hasHandlers('PreToolUse')).toBe(false);
    });
  });

  describe('prototype pollution resistance', () => {
    it('__proto__ key in config does not pollute Object prototype', () => {
      const config = JSON.parse('{"__proto__": [{"handler": null}], "PreToolUse": []}');

      // This should not crash and should not pollute Object.prototype
      const result = resolveHooks(config);
      expect(result).toBeInstanceOf(HooksManager);
      expect(({} as Record<string, unknown>)['handler']).toBeUndefined();
    });

    it('constructor key in config does not crash', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = resolveHooks({
        // @ts-expect-error deliberate misuse: 'constructor' is not a built-in hook name
        constructor: [
          {
            handler: vi.fn(),
          },
        ],
      });
      expect(result).toBeInstanceOf(HooksManager);
      // 'constructor' is not a built-in hook name — it is warned and skipped.
      expect(result!.hasHandlers('constructor')).toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('HooksManager passthrough', () => {
    it('returns the exact same instance, not a copy', () => {
      const manager = new HooksManager();
      manager.on('PreToolUse', {
        handler: vi.fn(),
      });

      const result = resolveHooks(manager);
      expect(result).toBe(manager);
    });
  });

  describe('non-standard hook names in inline config', () => {
    it('warns and skips non-built-in hook names (custom hooks require HooksManager)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = resolveHooks({
        // @ts-expect-error deliberate misuse: inline config only accepts built-in hook names
        CustomHook: [
          {
            handler: vi.fn(),
          },
        ],
      });
      expect(result).toBeInstanceOf(HooksManager);
      expect(result!.hasHandlers('CustomHook')).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('CustomHook'));
      warn.mockRestore();
    });
  });
});
