import { describe, expect, it } from 'vitest';
import { isAsyncOutput } from '../../src/lib/hooks-types.js';

describe('isAsyncOutput (adversarial)', () => {
  describe('truthy values that should NOT match', () => {
    it('{ async: "true" } (string) is not AsyncOutput', () => {
      expect(
        isAsyncOutput({
          async: 'true',
        }),
      ).toBe(false);
    });

    it('{ async: 1 } (number) is not AsyncOutput', () => {
      expect(
        isAsyncOutput({
          async: 1,
        }),
      ).toBe(false);
    });

    it('{ async: {} } (object) is not AsyncOutput', () => {
      expect(
        isAsyncOutput({
          async: {},
        }),
      ).toBe(false);
    });

    it('{ async: [] } (array) is not AsyncOutput', () => {
      expect(
        isAsyncOutput({
          async: [],
        }),
      ).toBe(false);
    });
  });

  describe('non-object inputs', () => {
    it('null is not AsyncOutput', () => {
      expect(isAsyncOutput(null)).toBe(false);
    });

    it('undefined is not AsyncOutput', () => {
      expect(isAsyncOutput(undefined)).toBe(false);
    });

    it('number is not AsyncOutput', () => {
      expect(isAsyncOutput(42)).toBe(false);
    });

    it('string is not AsyncOutput', () => {
      expect(isAsyncOutput('async')).toBe(false);
    });

    it('boolean true is not AsyncOutput', () => {
      expect(isAsyncOutput(true)).toBe(false);
    });

    it('symbol is not AsyncOutput', () => {
      expect(isAsyncOutput(Symbol('async'))).toBe(false);
    });
  });

  describe('valid AsyncOutput variations', () => {
    it('{ async: true } is AsyncOutput', () => {
      expect(
        isAsyncOutput({
          async: true,
        }),
      ).toBe(true);
    });

    it('{ async: true, asyncTimeout: 5000 } is AsyncOutput', () => {
      expect(
        isAsyncOutput({
          async: true,
          asyncTimeout: 5000,
        }),
      ).toBe(true);
    });

    it('{ async: true, extraField: "ignored" } is still AsyncOutput', () => {
      expect(
        isAsyncOutput({
          async: true,
          extraField: 'ignored',
        }),
      ).toBe(true);
    });

    it('frozen object { async: true } is AsyncOutput', () => {
      expect(
        isAsyncOutput(
          Object.freeze({
            async: true,
          }),
        ),
      ).toBe(true);
    });
  });

  describe('array with async property', () => {
    it('array with async property set is treated as AsyncOutput', () => {
      const arr: unknown[] = [];
      (arr as unknown as Record<string, unknown>)['async'] = true;
      // Arrays are objects and have 'async' in arr, so this should match
      expect(isAsyncOutput(arr)).toBe(true);
    });
  });

  describe('Proxy objects', () => {
    it('Proxy that returns true for async property is AsyncOutput', () => {
      const proxy = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'async') {
              return true;
            }
            return undefined;
          },
          has(_target, prop) {
            return prop === 'async';
          },
        },
      );
      expect(isAsyncOutput(proxy)).toBe(true);
    });

    it('Proxy that throws on property access causes isAsyncOutput to throw', () => {
      const proxy = new Proxy(
        {},
        {
          has() {
            throw new Error('proxy trap');
          },
        },
      );
      expect(() => isAsyncOutput(proxy)).toThrow('proxy trap');
    });
  });

  describe('Object.create(null)', () => {
    it('bare object with async: true is AsyncOutput', () => {
      const obj = Object.create(null);
      obj.async = true;
      expect(isAsyncOutput(obj)).toBe(true);
    });
  });
});
