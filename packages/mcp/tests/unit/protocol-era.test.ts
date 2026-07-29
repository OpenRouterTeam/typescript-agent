import type { Transport } from '@modelcontextprotocol/client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

// Proves the SDK negotiates BOTH protocol revisions — 2025-11-25 ("legacy",
// `initialize` handshake) and 2026-07-28 ("modern", per-request `_meta`
// envelope with no handshake). Everything here runs over InMemoryTransport, so
// there is no network, no fixture process, and no MCP_TEST_URL gate.
//
// These tests are what protect the assumptions the rest of the package leans
// on: that `getServerVersion()` / `getServerCapabilities()` stay populated in
// the modern era (handle.ts reads both synchronously), that `sessionId` simply
// goes undefined rather than erroring, and that one elicitation handler serves
// both eras.

type JsonRpc = {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

interface ServerBehavior {
  /** Answer `server/discover` as a 2026-07-28 server. */
  modern: boolean;
  /** Methods the fake server saw, in order. */
  seen: string[];
  /** When set, `tools/call` demands input once via an input_required result. */
  demandInput?: boolean;
}

/**
 * Minimal hand-rolled MCP server over one end of a linked transport pair.
 * Responds only to what these tests exercise.
 */
function startFakeServer(serverSide: Transport, behavior: ServerBehavior): void {
  let callRound = 0;

  serverSide.onmessage = (raw: unknown) => {
    const msg = raw as JsonRpc;
    const method = msg.method;
    if (method === undefined) {
      return;
    }
    behavior.seen.push(method);

    // Notifications carry no id and expect no reply.
    if (msg.id === undefined) {
      return;
    }
    const id = msg.id;
    const reply = (result: unknown): void => {
      void serverSide.send({
        jsonrpc: '2.0',
        id,
        result,
      } as never);
    };
    const replyError = (code: number, message: string): void => {
      void serverSide.send({
        jsonrpc: '2.0',
        id,
        error: {
          code,
          message,
        },
      } as never);
    };

    if (method === 'server/discover') {
      if (!behavior.modern) {
        // A legacy server has never heard of this method.
        replyError(-32601, 'Method not found');
        return;
      }
      reply({
        resultType: 'complete',
        // NOTE: the field is `supportedVersions`, not `protocolVersions`.
        supportedVersions: [
          '2026-07-28',
        ],
        capabilities: {
          tools: {},
          resources: {},
        },
        _meta: {
          'io.modelcontextprotocol/serverInfo': {
            name: 'fake-modern',
            version: '9.9.9',
          },
        },
      });
      return;
    }

    if (method === 'initialize') {
      reply({
        protocolVersion: '2025-11-25',
        serverInfo: {
          name: 'fake-legacy',
          version: '1.2.3',
        },
        capabilities: {
          tools: {},
          resources: {},
        },
      });
      return;
    }

    if (method === 'tools/list') {
      reply({
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'public',
        tools: [
          {
            name: 'needs_input',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      });
      return;
    }

    if (method === 'tools/call') {
      callRound += 1;
      if (behavior.demandInput === true && callRound === 1) {
        reply({
          resultType: 'input_required',
          requestState: 'opaque-state-blob',
          // `inputRequests` is an object keyed by request id, not an array.
          inputRequests: {
            r1: {
              method: 'elicitation/create',
              params: {
                message: 'Your name?',
                requestedSchema: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                    },
                  },
                  required: [
                    'name',
                  ],
                },
              },
            },
          },
        });
        return;
      }
      reply({
        resultType: 'complete',
        content: [
          {
            type: 'text',
            text: 'done',
          },
        ],
      });
      return;
    }

    reply({
      resultType: 'complete',
    });
  };
  void serverSide.start();
}

interface Harness {
  client: Client;
  behavior: ServerBehavior;
  clientSide: Transport;
}

async function connectTo(options: {
  modern: boolean;
  mode:
    | 'legacy'
    | 'auto'
    | {
        pin: string;
      };
  demandInput?: boolean;
  onElicit?: () => {
    action: 'accept';
    content: Record<string, unknown>;
  };
}): Promise<Harness> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const behavior: ServerBehavior = {
    modern: options.modern,
    seen: [],
    ...(options.demandInput !== undefined && {
      demandInput: options.demandInput,
    }),
  };
  startFakeServer(serverSide, behavior);

  const client = new Client(
    {
      name: 'era-test',
      version: '0.0.0',
    },
    {
      capabilities: {
        elicitation: {},
      },
      versionNegotiation: {
        mode: options.mode,
        probe: {
          timeoutMs: 2000,
        },
      },
    },
  );
  if (options.onElicit !== undefined) {
    const handler = options.onElicit;
    client.setRequestHandler('elicitation/create', () => handler());
  }
  await client.connect(clientSide);
  return {
    client,
    behavior,
    clientSide,
  };
}

describe("mode: 'auto' against a legacy (2025-11-25) server", () => {
  it('probes server/discover, then falls back to the initialize handshake', async () => {
    const { client, behavior } = await connectTo({
      modern: false,
      mode: 'auto',
    });

    expect(behavior.seen[0]).toBe('server/discover');
    expect(behavior.seen).toContain('initialize');
    expect(client.getProtocolEra()).toBe('legacy');
    await client.close();
  });

  it('still reports server identity and capabilities', async () => {
    const { client } = await connectTo({
      modern: false,
      mode: 'auto',
    });

    expect(client.getServerVersion()?.name).toBe('fake-legacy');
    expect(client.getServerCapabilities()?.resources).toBeDefined();
    await client.close();
  });
});

describe("mode: 'auto' against a modern (2026-07-28) server", () => {
  it('never sends initialize — the handshake is removed in this revision', async () => {
    const { client, behavior } = await connectTo({
      modern: true,
      mode: 'auto',
    });

    expect(behavior.seen[0]).toBe('server/discover');
    expect(behavior.seen).not.toContain('initialize');
    expect(client.getProtocolEra()).toBe('modern');
    await client.close();
  });

  it('populates serverInfo and capabilities from server/discover', async () => {
    // handle.ts reads both of these synchronously; if the modern era left them
    // empty, resource tools would silently disappear and snapshots would lose
    // their serverInfo.
    const { client } = await connectTo({
      modern: true,
      mode: 'auto',
    });

    expect(client.getServerVersion()).toEqual({
      name: 'fake-modern',
      version: '9.9.9',
    });
    expect(client.getServerCapabilities()?.resources).toBeDefined();
    await client.close();
  });

  it('leaves sessionId undefined — protocol sessions are removed (SEP-2567)', async () => {
    const { client, clientSide } = await connectTo({
      modern: true,
      mode: 'auto',
    });

    expect(clientSide.sessionId).toBeUndefined();
    await client.close();
  });

  it('still lists tools', async () => {
    const { client } = await connectTo({
      modern: true,
      mode: 'auto',
    });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'needs_input',
    ]);
    await client.close();
  });
});

describe('multi-round-trip input (SEP-2322)', () => {
  it('fulfils input_required through the same elicitation handler and retries', async () => {
    // This is what justifies keeping `onElicitation` rather than deprecating
    // it: the 2026-07-28 era has no server-initiated elicitation/create, but
    // the MRTR driver dispatches through the very same registered handler.
    let calls = 0;
    const { client, behavior } = await connectTo({
      modern: true,
      mode: 'auto',
      demandInput: true,
      onElicit: () => {
        calls += 1;
        return {
          action: 'accept',
          content: {
            name: 'Luke',
          },
        };
      },
    });

    const result = await client.callTool({
      name: 'needs_input',
      arguments: {},
    });

    expect(calls).toBe(1);
    // Two tools/call round trips: the input_required answer, then the retry.
    expect(behavior.seen.filter((m) => m === 'tools/call')).toHaveLength(2);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'done',
      },
    ]);
    await client.close();
  });
});

describe('pinning', () => {
  it('fails loudly when a pinned revision is not offered', async () => {
    await expect(
      connectTo({
        modern: false,
        mode: {
          pin: '2026-07-28',
        },
      }),
    ).rejects.toThrow();
  });

  it('connects in the modern era when the pin is offered', async () => {
    const { client } = await connectTo({
      modern: true,
      mode: {
        pin: '2026-07-28',
      },
    });

    expect(client.getProtocolEra()).toBe('modern');
    await client.close();
  });
});
