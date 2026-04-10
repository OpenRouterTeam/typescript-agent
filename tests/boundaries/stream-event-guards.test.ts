import { describe, expect, it } from 'vitest';

import {
  isFunctionCallArgumentsDeltaEvent,
  isFunctionCallArgumentsDoneEvent,
  isOutputItemAddedEvent,
  isOutputItemDoneEvent,
  isOutputTextDeltaEvent,
  isReasoningDeltaEvent,
  isResponseCompletedEvent,
  isResponseFailedEvent,
  isResponseIncompleteEvent,
} from '../../src/lib/stream-type-guards.js';

const guards = [
  {
    name: 'isOutputTextDeltaEvent',
    fn: isOutputTextDeltaEvent,
    type: 'response.output_text.delta',
  },
  {
    name: 'isReasoningDeltaEvent',
    fn: isReasoningDeltaEvent,
    type: 'response.reasoning_text.delta',
  },
  {
    name: 'isFunctionCallArgumentsDeltaEvent',
    fn: isFunctionCallArgumentsDeltaEvent,
    type: 'response.function_call_arguments.delta',
  },
  {
    name: 'isOutputItemAddedEvent',
    fn: isOutputItemAddedEvent,
    type: 'response.output_item.added',
  },
  {
    name: 'isOutputItemDoneEvent',
    fn: isOutputItemDoneEvent,
    type: 'response.output_item.done',
  },
  {
    name: 'isResponseCompletedEvent',
    fn: isResponseCompletedEvent,
    type: 'response.completed',
  },
  {
    name: 'isResponseFailedEvent',
    fn: isResponseFailedEvent,
    type: 'response.failed',
  },
  {
    name: 'isResponseIncompleteEvent',
    fn: isResponseIncompleteEvent,
    type: 'response.incomplete',
  },
  {
    name: 'isFunctionCallArgumentsDoneEvent',
    fn: isFunctionCallArgumentsDoneEvent,
    type: 'response.function_call_arguments.done',
  },
] as const;

describe('Stream event type guards - mutual exclusion', () => {
  for (const guard of guards) {
    describe(guard.name, () => {
      it(`returns true for its own event type: ${guard.type}`, () => {
        const event = {
          type: guard.type,
        } as any;
        expect(guard.fn(event)).toBe(true);
      });

      it('returns false for at least one other stream event type', () => {
        const other = guards.find((g) => g.type !== guard.type)!;
        const event = {
          type: other.type,
        } as any;
        expect(guard.fn(event)).toBe(false);
      });

      it('returns false for objects missing type or with wrong type', () => {
        expect(guard.fn({} as any)).toBe(false);
        expect(
          guard.fn({
            type: 'unrelated.event',
          } as any),
        ).toBe(false);
        expect(
          guard.fn({
            type: '',
          } as any),
        ).toBe(false);
      });
    });
  }
});
