import { describe, expect, it } from 'vitest';

import {
  isToolCallOutputEvent,
  isToolPreliminaryResultEvent,
  isToolResultEvent,
  isTurnEndEvent,
  isTurnStartEvent,
} from '../../src/lib/tool-types.js';

describe('ResponseStreamEvent guards - mutual exclusion', () => {
  it('isToolPreliminaryResultEvent rejects { type: "tool.result" }', () => {
    const event = {
      type: 'tool.result',
      toolCallId: 'c1',
      result: 42,
      timestamp: 1,
    };
    expect(isToolPreliminaryResultEvent(event)).toBe(false);
  });

  it('isToolResultEvent rejects { type: "tool.preliminary_result" }', () => {
    const event = {
      type: 'tool.preliminary_result',
      toolCallId: 'c1',
      result: 42,
      timestamp: 1,
    };
    expect(isToolResultEvent(event)).toBe(false);
  });

  it('isTurnStartEvent rejects { type: "turn.end" }', () => {
    const event = {
      type: 'turn.end',
      turnNumber: 1,
      timestamp: 1,
    };
    expect(isTurnStartEvent(event)).toBe(false);
  });

  it('isTurnEndEvent rejects { type: "turn.start" }', () => {
    const event = {
      type: 'turn.start',
      turnNumber: 1,
      timestamp: 1,
    };
    expect(isTurnEndEvent(event)).toBe(false);
  });

  it('isToolCallOutputEvent rejects { type: "tool.result" }', () => {
    const event = {
      type: 'tool.result',
      toolCallId: 'c1',
      result: 42,
      timestamp: 1,
    };
    expect(isToolCallOutputEvent(event)).toBe(false);
  });
});
