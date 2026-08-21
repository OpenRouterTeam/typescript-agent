/**
 * Void-result schema handling:
 *
 * 1. `isVoidSchema` detection is pinned against zod v4 internals so a zod
 *    upgrade that restructures `_zod.def.type` fails loudly here instead of
 *    silently re-enabling result validation on void-result hooks.
 * 2. Custom hooks with `result: z.void()` skip result validation exactly like
 *    the built-in void hooks (decided by schema shape, not a name list).
 */
import { describe, expect, it, vi } from 'vitest';
import * as z4 from 'zod/v4';
import { HooksManager, isVoidSchema } from '../../src/lib/hooks-manager.js';

describe('void schema detection (pins zod v4 internals against upgrades)', () => {
  // isVoidSchema reads `schema._zod.def.type` -- zod v4's introspection
  // surface for library authors, but still an internal shape.
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
    // detection strategy. Parse the schema object itself so the shape is
    // runtime-verified instead of asserted.
    const IntrospectionShape = z4.object({
      _zod: z4.object({
        def: z4.object({
          type: z4.string(),
        }),
      }),
    });
    const internals = IntrospectionShape.parse(z4.void());
    expect(internals._zod.def.type).toBe('void');
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
    manager.on('Audit', {
      // @ts-expect-error -- intentionally returns a value from a void-result
      // hook, the way an untyped JS caller would; the runtime must collect it
      // as an opaque result without complaint.
      handler: () => ({
        logged: true,
      }),
    });

    const result = await manager.emit('Audit', {});
    expect(result.results).toEqual([
      {
        logged: true,
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
