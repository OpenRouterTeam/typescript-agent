import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_STATE_VERSION,
  createInitialState,
  deserializeConversationState,
  InvalidStateError,
  serializeConversationState,
  UnsupportedStateVersionError,
} from '../../src/lib/conversation-state.js';
import type { ConversationState } from '../../src/lib/tool-types.js';

describe('ConversationState serialization contract (PR-6)', () => {
  it('round-trips a fresh createInitialState with version 1', () => {
    const state = createInitialState('conv_fresh');
    expect(state.version).toBe(1);

    const json = serializeConversationState(state);
    const restored = deserializeConversationState(json);

    expect(restored).toEqual({
      ...state,
      version: CONVERSATION_STATE_VERSION,
    });
    expect(restored.version).toBe(1);
  });

  it('round-trips a rich awaiting_client_tools state with pendingToolCalls', () => {
    // Shape mirrors the frozen pending state produced after a manual-tool
    // pause (see manual-tool-pending-state.test.ts / PR-4).
    const rich: ConversationState = {
      version: 1,
      id: 'conv_manual_pause',
      status: 'awaiting_client_tools',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_500,
      previousResponseId: 'resp_manual',
      messages: [
        {
          type: 'message',
          role: 'user',
          content: 'run ls',
        },
        {
          type: 'function_call',
          id: 'fc_call_manual_1',
          callId: 'call_manual_1',
          name: 'exec_command',
          arguments: '{"command":"ls"}',
          status: 'completed',
        },
        {
          type: 'function_call',
          id: 'fc_call_auto_1',
          callId: 'call_auto_1',
          name: 'auto_search',
          arguments: '{"query":"docs"}',
          status: 'completed',
        },
        {
          type: 'function_call_output',
          id: 'output_call_auto_1',
          callId: 'call_auto_1',
          output: JSON.stringify({
            result: 'found it',
          }),
        },
      ],
      pendingToolCalls: [
        {
          id: 'call_manual_1',
          name: 'exec_command',
          arguments: {
            command: 'ls',
          },
        },
      ],
      unsentToolResults: [
        {
          callId: 'call_auto_1',
          name: 'auto_search',
          output: {
            result: 'found it',
          },
        },
      ],
    };

    const json = serializeConversationState(rich);
    const restored = deserializeConversationState(json);

    expect(restored).toEqual(rich);
    expect(restored.status).toBe('awaiting_client_tools');
    expect(restored.pendingToolCalls).toHaveLength(1);
    expect(restored.pendingToolCalls?.[0]?.id).toBe('call_manual_1');
    expect(restored.pendingToolCalls?.[0]?.name).toBe('exec_command');
    expect(restored.messages).toHaveLength(4);
    expect(restored.unsentToolResults?.[0]?.callId).toBe('call_auto_1');
  });

  it('deserializes version-less legacy JSON and normalizes to version 1', () => {
    // Hand-written pre-version fixture (what consumers stored with JSON.stringify).
    const legacyJson = JSON.stringify({
      id: 'conv_legacy',
      messages: [
        {
          type: 'message',
          role: 'user',
          content: 'hello from v0',
        },
      ],
      status: 'complete',
      createdAt: 1_600_000_000_000,
      updatedAt: 1_600_000_000_100,
      previousResponseId: 'resp_legacy',
    });

    const restored = deserializeConversationState(legacyJson);

    expect(restored.version).toBe(1);
    expect(restored.id).toBe('conv_legacy');
    expect(restored.status).toBe('complete');
    expect(restored.messages).toHaveLength(1);
    expect(restored.previousResponseId).toBe('resp_legacy');
  });

  it('throws UnsupportedStateVersionError for version 2', () => {
    const futureJson = JSON.stringify({
      version: 2,
      id: 'conv_future',
      messages: [],
      status: 'in_progress',
      createdAt: 1,
      updatedAt: 1,
    });

    expect(() => deserializeConversationState(futureJson)).toThrow(UnsupportedStateVersionError);

    try {
      deserializeConversationState(futureJson);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedStateVersionError);
      const typed = error as UnsupportedStateVersionError;
      expect(typed.found).toBe(2);
      expect(typed.supported).toEqual([
        1,
      ]);
      expect(typed.name).toBe('UnsupportedStateVersionError');
    }
  });

  it('throws UnsupportedStateVersionError for version 2 even when the shape changed', () => {
    // A version bump may rename/remove v1 fields; the version guard must run
    // before structural validation so consumers get the version signal, not a
    // misleading corruption error.
    const reshapedFutureJson = JSON.stringify({
      version: 2,
      conversationId: 'conv_future',
      history: [],
    });

    expect(() => deserializeConversationState(reshapedFutureJson)).toThrow(
      UnsupportedStateVersionError,
    );
  });

  it('throws InvalidStateError for malformed shapes', () => {
    expect(() =>
      deserializeConversationState(
        JSON.stringify({
          messages: [],
          status: 'in_progress',
        }),
      ),
    ).toThrow(InvalidStateError);

    try {
      deserializeConversationState(
        JSON.stringify({
          messages: [],
          status: 'in_progress',
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStateError);
      expect((error as InvalidStateError).message).toMatch(/"id"/);
    }

    try {
      deserializeConversationState(
        JSON.stringify({
          id: 'conv_x',
          messages: 'not-an-array',
          status: 'in_progress',
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStateError);
      expect((error as InvalidStateError).message).toMatch(/"messages"/);
    }

    try {
      deserializeConversationState(
        JSON.stringify({
          id: 'conv_x',
          messages: [],
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStateError);
      expect((error as InvalidStateError).message).toMatch(/"status"/);
    }

    try {
      deserializeConversationState(
        JSON.stringify({
          id: 'conv_x',
          messages: [],
          status: 'in_progress',
          updatedAt: 1,
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStateError);
      expect((error as InvalidStateError).message).toMatch(/"createdAt"/);
    }

    try {
      deserializeConversationState(
        JSON.stringify({
          id: 'conv_x',
          messages: [],
          status: 'in_progress',
          createdAt: 1,
          updatedAt: 'yesterday',
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStateError);
      expect((error as InvalidStateError).message).toMatch(/"updatedAt"/);
    }

    expect(() => deserializeConversationState('not-json{')).toThrow(InvalidStateError);
  });

  it('serialize injects version when input state lacks it', () => {
    const versionless = {
      id: 'conv_no_ver',
      messages: [],
      status: 'in_progress' as const,
      createdAt: 42,
      updatedAt: 43,
    } satisfies ConversationState;

    // Explicitly omit version at the type level and runtime.
    expect('version' in versionless ? versionless.version : undefined).toBeUndefined();

    const json = serializeConversationState(versionless);
    const parsed = JSON.parse(json) as {
      version: number;
    };
    expect(parsed.version).toBe(1);

    const restored = deserializeConversationState(json);
    expect(restored.version).toBe(1);
    expect(restored.id).toBe('conv_no_ver');
  });
});
