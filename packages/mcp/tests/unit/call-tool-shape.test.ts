import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { wrapMcpTool } from '../../src/tool-wrapper.js';

// Regression guard for the SDK v2 `callTool` signature change.
//
// v1 was `callTool(params, resultSchema, options)`; v2 is
// `callTool(params, options)`. The failure mode is silent rather than loud: if
// the old three-argument form survives, `signal` and `onprogress` land in a
// third parameter the SDK does not read, so cancellation and progress
// streaming stop working while every other test still passes. These tests
// assert the options object arrives in the SECOND argument.

interface RecordedCall {
  args: unknown[];
}

function fakeClient(recorded: RecordedCall[]): Client {
  return {
    callTool: (...args: unknown[]) => {
      recorded.push({
        args,
      });
      return Promise.resolve({
        content: [
          {
            type: 'text',
            text: 'ok',
          },
        ],
      });
    },
  } as never;
}

/**
 * The wrapped tool is an OpenRouter tool envelope — the callable lives at
 * `.function.execute`, not on the object itself.
 */
function asExecute(t: unknown): (args: Record<string, unknown>) => never {
  return (
    t as {
      function: {
        execute: (args: Record<string, unknown>) => never;
      };
    }
  ).function.execute;
}

const DEF = {
  name: 'do_thing',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

describe('callTool argument shape', () => {
  it('passes exactly two arguments — params then options', async () => {
    const recorded: RecordedCall[] = [];
    const t = wrapMcpTool(DEF, {
      client: fakeClient(recorded),
      emitProgress: false,
    });

    await asExecute(t)({});

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.args).toHaveLength(2);
    expect(recorded[0]?.args[0]).toEqual({
      name: 'do_thing',
      arguments: {},
    });
  });

  it('threads the abort signal into the second argument', async () => {
    const recorded: RecordedCall[] = [];
    const controller = new AbortController();
    const t = wrapMcpTool(DEF, {
      client: fakeClient(recorded),
      emitProgress: false,
      signal: controller.signal,
    });

    await asExecute(t)({});

    const options = recorded[0]?.args[1] as
      | {
          signal?: AbortSignal;
        }
      | undefined;
    expect(options?.signal).toBe(controller.signal);
  });

  it('threads onprogress into the second argument for generator tools', async () => {
    const recorded: RecordedCall[] = [];
    const t = wrapMcpTool(DEF, {
      client: fakeClient(recorded),
      emitProgress: true,
    });

    // Drain the generator so the underlying callTool actually runs.
    const gen = asExecute(t)({}) as AsyncGenerator<unknown, unknown, unknown>;
    while (!(await gen.next()).done) {
      // discard progress events
    }

    const options = recorded[0]?.args[1] as
      | {
          onprogress?: unknown;
        }
      | undefined;
    expect(typeof options?.onprogress).toBe('function');
  });
});
