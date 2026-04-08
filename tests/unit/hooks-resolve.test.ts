import { describe, it, expect, vi } from 'vitest';
import { resolveHooks } from '../../src/lib/hooks-resolve.js';
import { HooksManager } from '../../src/lib/hooks-manager.js';
import type { InlineHookConfig } from '../../src/lib/hooks-types.js';

describe('resolveHooks', () => {
  it('returns undefined for undefined input', () => {
    expect(resolveHooks(undefined)).toBeUndefined();
  });

  it('passes through HooksManager instances', () => {
    const manager = new HooksManager();
    expect(resolveHooks(manager)).toBe(manager);
  });

  it('converts inline config to HooksManager', () => {
    const config: InlineHookConfig = {
      PreToolUse: [
        {
          matcher: 'Bash',
          handler: vi.fn(),
        },
      ],
    };

    const result = resolveHooks(config);
    expect(result).toBeInstanceOf(HooksManager);
    expect(result!.hasHandlers('PreToolUse')).toBe(true);
  });

  it('registers multiple entries for a single hook', () => {
    const config: InlineHookConfig = {
      PostToolUse: [
        { handler: vi.fn() },
        { handler: vi.fn() },
      ],
    };

    const result = resolveHooks(config);
    expect(result).toBeInstanceOf(HooksManager);
    expect(result!.hasHandlers('PostToolUse')).toBe(true);
  });

  it('registers entries for multiple hooks', () => {
    const config: InlineHookConfig = {
      PreToolUse: [{ handler: vi.fn() }],
      PostToolUse: [{ handler: vi.fn() }],
      Stop: [{ handler: vi.fn() }],
    };

    const result = resolveHooks(config);
    expect(result!.hasHandlers('PreToolUse')).toBe(true);
    expect(result!.hasHandlers('PostToolUse')).toBe(true);
    expect(result!.hasHandlers('Stop')).toBe(true);
  });
});
