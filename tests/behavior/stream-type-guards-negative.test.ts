import { describe, expect, it } from 'vitest';
import {
  isFunctionCallArgumentsDeltaEvent,
  isFunctionCallArgumentsDoneEvent,
  isFunctionCallItem,
  isOutputItemAddedEvent,
  isOutputItemDoneEvent,
  isOutputMessage,
  isOutputTextDeltaEvent,
  isOutputTextPart,
  isReasoningDeltaEvent,
  isReasoningOutputItem,
  isRefusalPart,
  isResponseCompletedEvent,
  isResponseFailedEvent,
  isResponseIncompleteEvent,
} from '../../src/lib/stream-type-guards.js';

describe('stream event type guards - negative cases (reject wrong type)', () => {
  it('isOutputTextDeltaEvent rejects reasoning delta', () => {
    expect(
      isOutputTextDeltaEvent({
        type: 'response.reasoning_text.delta',
      } as any),
    ).toBe(false);
  });

  it('isReasoningDeltaEvent rejects text delta', () => {
    expect(
      isReasoningDeltaEvent({
        type: 'response.output_text.delta',
      } as any),
    ).toBe(false);
  });

  it('isFunctionCallArgumentsDeltaEvent rejects text delta', () => {
    expect(
      isFunctionCallArgumentsDeltaEvent({
        type: 'response.output_text.delta',
      } as any),
    ).toBe(false);
  });

  it('isOutputItemAddedEvent rejects output_item.done', () => {
    expect(
      isOutputItemAddedEvent({
        type: 'response.output_item.done',
      } as any),
    ).toBe(false);
  });

  it('isOutputItemDoneEvent rejects output_item.added', () => {
    expect(
      isOutputItemDoneEvent({
        type: 'response.output_item.added',
      } as any),
    ).toBe(false);
  });

  it('isResponseCompletedEvent rejects response.failed', () => {
    expect(
      isResponseCompletedEvent({
        type: 'response.failed',
      } as any),
    ).toBe(false);
  });

  it('isResponseFailedEvent rejects response.completed', () => {
    expect(
      isResponseFailedEvent({
        type: 'response.completed',
      } as any),
    ).toBe(false);
  });

  it('isResponseIncompleteEvent rejects response.completed', () => {
    expect(
      isResponseIncompleteEvent({
        type: 'response.completed',
      } as any),
    ).toBe(false);
  });

  it('isFunctionCallArgumentsDoneEvent rejects function_call_arguments.delta', () => {
    expect(
      isFunctionCallArgumentsDoneEvent({
        type: 'response.function_call_arguments.delta',
      } as any),
    ).toBe(false);
  });
});

describe('output item type guards - negative cases', () => {
  it('isOutputMessage rejects function_call', () => {
    expect(
      isOutputMessage({
        type: 'function_call',
      }),
    ).toBe(false);
  });

  it('isFunctionCallItem rejects message', () => {
    expect(
      isFunctionCallItem({
        type: 'message',
      }),
    ).toBe(false);
  });

  it('isReasoningOutputItem rejects message', () => {
    expect(
      isReasoningOutputItem({
        type: 'message',
      }),
    ).toBe(false);
  });

  it('isOutputTextPart rejects refusal', () => {
    expect(
      isOutputTextPart({
        type: 'refusal',
      }),
    ).toBe(false);
  });

  it('isRefusalPart rejects output_text', () => {
    expect(
      isRefusalPart({
        type: 'output_text',
      }),
    ).toBe(false);
  });
});
