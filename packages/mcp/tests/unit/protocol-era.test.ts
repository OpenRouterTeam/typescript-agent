import type { Transport } from '@modelcontextprotocol/client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { MCPConnection } from '../../src/mcp-connection.js';

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
  /** `ttlMs` the fake reports on `tools/list`; defaults to 0 (uncacheable). */
  toolsListTtlMs?: number;
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
        // Non-zero for the cache-invalidation test below, which needs the SDK to
        // actually cache the response so we can prove the notification evicts it.
        ttlMs: behavior.toolsListTtlMs ?? 0,
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

/**
 * The `tools/list_changed` wiring, end to end over a real transport.
 *
 * `mcp-connection.ts` registers the subscription with a bare string method name
 * rather than an SDK schema value. The name itself is compile-checked — the
 * parameter is a `NotificationMethod` literal union, so a typo fails `tsc`
 * (verified: mutating it to `'notifications/tools/list_changedX'` produces
 * TS2345). What the type cannot check is *dispatch*: that an inbound
 * notification actually reaches the callback registered via
 * `setToolListChangedHandler`.
 *
 * That gap matters because `autoRefreshOnListChanged` defaults to on, so a
 * broken dispatch path means tool-list refreshes silently never happen — the
 * same failure shape as the `callTool` arity bug this PR fixes, which was also
 * invisible to a green test suite.
 *
 * These drive the real `makeClient` from `mcp-connection.ts` (via the
 * `makeClientForTest` seam), not a locally-built `Client`, so the assertion
 * covers our registration rather than a restatement of the SDK's.
 */
describe('tools/list_changed dispatch', () => {
  async function connectRealClient(
    modern: boolean,
    toolsListTtlMs?: number,
  ): Promise<{
    client: Client;
    serverSide: Transport;
    fired: () => number;
    seen: string[];
  }> {
    const { makeClientForTest } = await import('../../src/mcp-connection.js');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const seen: string[] = [];
    startFakeServer(serverSide, {
      modern,
      seen,
      ...(toolsListTtlMs !== undefined && {
        toolsListTtlMs,
      }),
    });

    let count = 0;
    const client = makeClientForTest(
      {
        url: new URL('https://example.invalid/mcp'),
      },
      () => {
        count += 1;
      },
    );
    await client.connect(clientSide);
    return {
      client,
      serverSide,
      fired: () => count,
      seen,
    };
  }

  async function emitListChanged(serverSide: Transport): Promise<void> {
    await serverSide.send({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    } as never);
    // Notifications are fire-and-forget in both directions; yield so the
    // client's handler runs before we assert.
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('routes the notification to the registered handler in the modern era', async () => {
    const { client, serverSide, fired } = await connectRealClient(true);

    expect(client.getProtocolEra()).toBe('modern');
    expect(fired()).toBe(0);

    await emitListChanged(serverSide);

    expect(fired()).toBe(1);
    await client.close();
  });

  it('routes the notification to the registered handler in the legacy era', async () => {
    const { client, serverSide, fired } = await connectRealClient(false);

    expect(client.getProtocolEra()).toBe('legacy');

    await emitListChanged(serverSide);

    // One handler serves both revisions — the same guarantee the elicitation
    // tests above establish for requests.
    expect(fired()).toBe(1);
    await client.close();
  });

  /**
   * The SDK keeps a per-client response cache (24h ceiling), and `makeClient`
   * deliberately opts out of `ClientOptions.listChanged` so the handle's own
   * `refresh()` owns the re-list. Devin raised the question that follows: if the
   * cache were invalidated by the SDK's `listChanged` machinery — the machinery
   * we opt out of — then `refresh()`'s `listTools()` would be served from cache
   * and `autoRefreshOnListChanged` would silently do nothing.
   *
   * It isn't. Eviction lives in the base `_onnotification` dispatcher, keyed off
   * the notification method (`notifications/tools/list_changed` → evict
   * `tools/list`), so it fires for any inbound notification regardless of how the
   * handler was registered. This test is the executable form of that claim,
   * because reading the SDK proves it today and a test proves it after the next
   * version bump.
   *
   * `ttlMs` must be non-zero here: with the default 0 the response is
   * uncacheable, so a cache bug would be invisible.
   */
  it('evicts the SDK response cache so a post-notification re-list hits the wire', async () => {
    const { client, serverSide, seen } = await connectRealClient(true, 60_000);

    await client.listTools();
    const afterFirst = seen.filter((m) => m === 'tools/list').length;
    expect(afterFirst).toBe(1);

    // Second call with no notification in between: served from the SDK cache.
    await client.listTools();
    expect(seen.filter((m) => m === 'tools/list')).toHaveLength(1);

    await emitListChanged(serverSide);

    // Now it must reach the server again — otherwise `refresh()` would return
    // the stale tool set and auto-refresh would be a silent no-op.
    await client.listTools();
    expect(seen.filter((m) => m === 'tools/list')).toHaveLength(2);

    await client.close();
  });

  it('fires once per notification', async () => {
    const { client, serverSide, fired } = await connectRealClient(true);

    await emitListChanged(serverSide);
    await emitListChanged(serverSide);

    expect(fired()).toBe(2);
    await client.close();
  });
});

/**
 * `listToolDefs` must reach the server every time, even inside the SDK's
 * response-cache TTL.
 *
 * SDK v2 caches `tools/list` per client, honouring the server's `ttlMs` up to a
 * 24h ceiling. Under the default `cacheMode: 'use'` that makes
 * `MCPToolsHandle.refresh()` a liar — it documents a forced re-read but would
 * return the cached list, so an app calling `refresh()` to pick up newly added
 * server tools could keep the old set for as long as the server allows reuse.
 * A behavior change introduced by the v1 → v2 migration, since v1 had no
 * response cache.
 *
 * The `tools/list_changed` path was already safe (the SDK evicts in its
 * notification dispatcher), so this covers the consumer-initiated path that has
 * no notification to trigger eviction.
 */
describe('listToolDefs bypasses the SDK response cache', () => {
  it('hits the wire on every call despite a live cache entry', async () => {
    const { makeClientForTest } = await import('../../src/mcp-connection.js');
    const { listToolDefs } = await import('../../src/handle.js');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const seen: string[] = [];
    startFakeServer(serverSide, {
      modern: true,
      seen,
      // Long enough that a cached read would definitely be served.
      toolsListTtlMs: 60_000,
    });

    const client = makeClientForTest(
      {
        url: new URL('https://example.invalid/mcp'),
      },
      () => {},
    );
    await client.connect(clientSide);
    const connection: MCPConnection = {
      client,
      transport: 'streamableHttp',
      setToolListChangedHandler: () => {},
      close: () => client.close(),
    };

    await listToolDefs(connection, undefined);
    expect(seen.filter((m) => m === 'tools/list')).toHaveLength(1);

    // The assertion that matters: a second read inside the TTL. A plain
    // `client.listTools()` here would still be 1 (proven by the eviction test
    // above), so this only passes because `listToolDefs` sends
    // `cacheMode: 'refresh'`.
    await listToolDefs(connection, undefined);
    expect(seen.filter((m) => m === 'tools/list')).toHaveLength(2);

    await listToolDefs(connection, undefined);
    expect(seen.filter((m) => m === 'tools/list')).toHaveLength(3);

    await client.close();
  });
});

/**
 * The probe timeout on the production client.
 *
 * `makeClient` sets only `versionNegotiation.mode`, so with `'auto'` now the
 * default every connection's first request is a `server/discover` probe governed
 * by the SDK's *default* timeout. Devin flagged that no test exercised that
 * default — the tests above build their own `Client` with an explicit
 * `probe: { timeoutMs: 2000 }`, and `mcp-connection.test.ts` fakes the `Client`
 * entirely — so a change to an unbounded default upstream would land silently on
 * the critical path of every `createMCPTools()` call.
 *
 * It is bounded: `negotiateEra` resolves `negotiation.probe.timeoutMs ??
 * deps.defaultTimeoutMs`, which `_connectNegotiated` fills from `options?.timeout
 * ?? DEFAULT_REQUEST_TIMEOUT_MSEC` (60s). So a gateway that black-holes
 * `server/discover` rejects rather than hanging forever. This pins that.
 */
/**
 * The probe block is passed unconditionally — including under `'legacy'`, where
 * no `server/discover` is sent and the field should be inert. This pins that the
 * real SDK constructor tolerates the combination rather than validating it away:
 * both the implicit legacy retry and an explicit `protocolNegotiation: 'legacy'`
 * construct exactly this shape.
 */
describe('probe options under legacy mode', () => {
  it('connects with a probe block alongside mode legacy', async () => {
    const { makeClientForTest } = await import('../../src/mcp-connection.js');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    startFakeServer(serverSide, {
      modern: false,
      seen: [],
    });

    const client = makeClientForTest(
      {
        url: new URL('https://example.invalid/mcp'),
        protocolNegotiation: 'legacy',
      },
      () => {},
    );
    await expect(client.connect(clientSide)).resolves.toBeUndefined();
    expect(client.getProtocolEra()).toBe('legacy');
    await client.close();
  });
});

describe('probe timeout default', () => {
  it('bounds the probe on a client built the way production builds it', async () => {
    const { makeClientForTest } = await import('../../src/mcp-connection.js');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

    // A server that accepts the probe and never answers it — the black-hole
    // gateway case. No fake server: nothing is wired to `serverSide.onmessage`.
    serverSide.onmessage = () => {};

    const client = makeClientForTest(
      {
        url: new URL('https://example.invalid/mcp'),
        probeTimeoutMs: 150,
      },
      () => {},
    );

    // The bound is asserted via `probeTimeoutMs` rather than `connect`'s
    // `timeout`: this package now sets `probe.timeoutMs` explicitly, which takes
    // precedence over the per-request timeout, so passing the latter would leave
    // the test waiting out the real 30s default. A short override keeps it fast
    // while still proving the probe honours the ceiling instead of hanging.
    await expect(client.connect(clientSide)).rejects.toThrow(/timed out|timeout/i);

    await client.close().catch(() => {});
  });
});
