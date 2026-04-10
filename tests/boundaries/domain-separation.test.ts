import { describe, expect, it } from 'vitest';

import {
  isFunctionCallArgumentsDeltaEvent,
  isFunctionCallItem,
  isOutputMessage,
  isOutputTextDeltaEvent,
} from '../../src/lib/stream-type-guards.js';

describe('Stream guards vs output item guards - domain separation', () => {
  it('isOutputTextDeltaEvent rejects an OutputMessage (item, not stream event)', () => {
    const item = {
      type: 'message',
      role: 'assistant',
      content: [],
    };
    expect(isOutputTextDeltaEvent(item as any)).toBe(false);
  });

  it('isOutputMessage rejects a TextDeltaEvent (stream event, not item)', () => {
    const event = {
      type: 'response.output_text.delta',
      delta: 'hello',
    };
    expect(isOutputMessage(event)).toBe(false);
  });

  it('isFunctionCallArgumentsDeltaEvent rejects a FunctionCallItem (completed item, not delta)', () => {
    const item = {
      type: 'function_call',
      callId: 'c1',
      name: 'test',
      arguments: '{}',
    };
    expect(isFunctionCallArgumentsDeltaEvent(item as any)).toBe(false);
  });

  it('isFunctionCallItem rejects a FunctionCallArgsDeltaEvent (delta, not item)', () => {
    const event = {
      type: 'response.function_call_arguments.delta',
      delta: '{"a":',
    };
    expect(isFunctionCallItem(event)).toBe(false);
  });
});
