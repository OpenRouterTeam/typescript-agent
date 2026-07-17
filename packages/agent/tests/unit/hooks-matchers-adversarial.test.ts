import { describe, expect, it } from 'vitest';
import { matchesTool } from '../../src/lib/hooks-matchers.js';

describe('matchesTool (adversarial)', () => {
  describe('empty string edge cases', () => {
    it('empty string matcher matches empty string toolName', () => {
      expect(matchesTool('', '')).toBe(true);
    });

    it('empty string matcher does NOT match non-empty toolName', () => {
      expect(matchesTool('', 'Bash')).toBe(false);
    });

    it('non-empty matcher does NOT match empty toolName', () => {
      expect(matchesTool('Bash', '')).toBe(false);
    });
  });

  describe('RegExp stateful behavior', () => {
    it('RegExp with global flag is made idempotent by resetting lastIndex', () => {
      const globalRegex = /Bash/g;

      // matchesTool resets lastIndex before each .test(), so /g and /y flags
      // no longer cause alternating true/false across successive emits.
      expect(matchesTool(globalRegex, 'Bash')).toBe(true);
      expect(matchesTool(globalRegex, 'Bash')).toBe(true);
      expect(matchesTool(globalRegex, 'Bash')).toBe(true);
    });

    it('RegExp with sticky flag is idempotent', () => {
      const stickyRegex = /Bash/y;
      expect(matchesTool(stickyRegex, 'Bash')).toBe(true);
      expect(matchesTool(stickyRegex, 'Bash')).toBe(true);
    });

    it('RegExp without global flag is idempotent', () => {
      const regex = /Bash/;
      expect(matchesTool(regex, 'Bash')).toBe(true);
      expect(matchesTool(regex, 'Bash')).toBe(true);
      expect(matchesTool(regex, 'Bash')).toBe(true);
    });

    it('RegExp with case-insensitive flag', () => {
      expect(matchesTool(/bash/i, 'Bash')).toBe(true);
      expect(matchesTool(/bash/i, 'BASH')).toBe(true);
    });

    it('RegExp matching partial tool name (no anchoring)', () => {
      // /Read/ matches "ReadFile" — this is regex default behavior, not bug
      expect(matchesTool(/Read/, 'ReadFile')).toBe(true);
      expect(matchesTool(/Read/, 'OnlyRead')).toBe(true);
    });
  });

  describe('function matcher edge cases', () => {
    it('function matcher throwing propagates the error', () => {
      const throwingMatcher = () => {
        throw new Error('matcher boom');
      };
      expect(() => matchesTool(throwingMatcher, 'Bash')).toThrow('matcher boom');
    });

    it('function matcher returning truthy non-boolean is coerced to true', () => {
      // Regression: matchesTool must coerce so its declared `boolean` return
      // type holds at runtime and strict === comparisons behave.
      const truthyMatcher = () => 1 as unknown as boolean;
      expect(matchesTool(truthyMatcher, 'Bash')).toBe(true);
    });

    it('function matcher returning 0 (falsy) is coerced to false', () => {
      const falsyMatcher = () => 0 as unknown as boolean;
      expect(matchesTool(falsyMatcher, 'Bash')).toBe(false);
    });

    it('function matcher returning null is coerced to false', () => {
      const nullMatcher = () => null as unknown as boolean;
      expect(matchesTool(nullMatcher, 'Bash')).toBe(false);
    });
  });

  describe('special characters in string matcher', () => {
    it('string matcher with regex-special chars does exact match only', () => {
      expect(matchesTool('Read.*File', 'Read.*File')).toBe(true);
      expect(matchesTool('Read.*File', 'ReadAnyFile')).toBe(false);
    });
  });
});
