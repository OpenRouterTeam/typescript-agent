import { describe, expect, it } from 'vitest';

import {
  isFileSearchCallOutputItem,
  isFunctionCallItem,
  isImageGenerationCallOutputItem,
  isOutputMessage,
  isReasoningOutputItem,
  isWebSearchCallOutputItem,
} from '../../src/lib/stream-type-guards.js';

const guards = [
  {
    name: 'isOutputMessage',
    fn: isOutputMessage,
    type: 'message',
  },
  {
    name: 'isFunctionCallItem',
    fn: isFunctionCallItem,
    type: 'function_call',
  },
  {
    name: 'isReasoningOutputItem',
    fn: isReasoningOutputItem,
    type: 'reasoning',
  },
  {
    name: 'isWebSearchCallOutputItem',
    fn: isWebSearchCallOutputItem,
    type: 'web_search_call',
  },
  {
    name: 'isFileSearchCallOutputItem',
    fn: isFileSearchCallOutputItem,
    type: 'file_search_call',
  },
  {
    name: 'isImageGenerationCallOutputItem',
    fn: isImageGenerationCallOutputItem,
    type: 'image_generation_call',
  },
] as const;

describe('Output item type guards - mutual exclusion', () => {
  for (const guard of guards) {
    describe(guard.name, () => {
      it(`returns true for its own item type: ${guard.type}`, () => {
        const item = {
          type: guard.type,
        };
        expect(guard.fn(item)).toBe(true);
      });

      it('returns false for at least one other output item type', () => {
        const other = guards.find((g) => g.type !== guard.type)!;
        const item = {
          type: other.type,
        };
        expect(guard.fn(item)).toBe(false);
      });

      it('returns false for null, undefined, and primitive', () => {
        expect(guard.fn(null)).toBe(false);
        expect(guard.fn(undefined)).toBe(false);
        expect(guard.fn(42)).toBe(false);
      });
    });
  }
});
