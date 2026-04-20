import { describe, expect, it } from 'vitest';
import {
  isToolCallOutputEvent,
  isToolPreliminaryResultEvent,
  isToolResultEvent,
  isTurnEndEvent,
  isTurnStartEvent,
} from '../../src/lib/tool-types.js';

describe('tool-types event type guards', () => {
  it('isToolPreliminaryResultEvent matches tool.preliminary_result', () => {
    expect(
      isToolPreliminaryResultEvent({
        type: 'tool.preliminary_result',
        toolCallId: 'c1',
        result: {},
        timestamp: 0,
      }),
    ).toBe(true);
  });

  it('isToolPreliminaryResultEvent rejects tool.result', () => {
    expect(
      isToolPreliminaryResultEvent({
        type: 'tool.result',
        toolCallId: 'c1',
        result: {},
        timestamp: 0,
      }),
    ).toBe(false);
  });

  it('isToolResultEvent matches tool.result', () => {
    expect(
      isToolResultEvent({
        type: 'tool.result',
        toolCallId: 'c1',
        result: {},
        timestamp: 0,
      }),
    ).toBe(true);
  });

  it('isToolResultEvent rejects tool.preliminary_result', () => {
    expect(
      isToolResultEvent({
        type: 'tool.preliminary_result',
        toolCallId: 'c1',
        result: {},
        timestamp: 0,
      }),
    ).toBe(false);
  });

  it('isToolCallOutputEvent matches tool.call_output', () => {
    expect(
      isToolCallOutputEvent({
        type: 'tool.call_output',
        output: {},
        timestamp: 0,
      }),
    ).toBe(true);
  });

  it('isTurnStartEvent matches turn.start', () => {
    expect(
      isTurnStartEvent({
        type: 'turn.start',
        turnNumber: 1,
        timestamp: 0,
      }),
    ).toBe(true);
  });

  it('isTurnEndEvent matches turn.end', () => {
    expect(
      isTurnEndEvent({
        type: 'turn.end',
        turnNumber: 1,
        timestamp: 0,
      }),
    ).toBe(true);
  });

  it('isTurnStartEvent rejects turn.end', () => {
    expect(
      isTurnStartEvent({
        type: 'turn.end',
        turnNumber: 1,
        timestamp: 0,
      }),
    ).toBe(false);
  });
});
