import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPConnectionError } from '../../src/errors.js';

// These tests exercise the real `connect()` — the transport selection and the
// Streamable HTTP -> SSE fallback — by faking the SDK's transports and client
// rather than mocking `mcp-connection.js` itself (which every other unit test
// does, leaving this path uncovered).

interface Attempt {
  kind: 'streamableHttp' | 'sse';
  sessionId?: string;
}

interface SdkState {
  attempts: Attempt[];
  /** Transport kinds whose `start()` should reject. */
  failing: Set<'streamableHttp' | 'sse'>;
  /**
   * When true, a connect rejects only while `versionNegotiation.mode` is
   * `'auto'` — the probe-hostile gateway the legacy degradation exists for.
   * Under `'legacy'` the same server connects fine.
   */
  probeHostile: boolean;
  /** When true, the fake Client's `close()` throws synchronously. */
  closeThrows: boolean;
  /** sessionId the fake Streamable HTTP transport reports after connecting. */
  httpSessionId: string | undefined;
  clientsCreated: number;
  /** `versionNegotiation.mode` seen by each constructed Client, in order. */
  negotiationModes: unknown[];
  /** `clientInfo` seen by each constructed Client, in order. */
  clientInfos: unknown[];
  /**
   * Transport kinds whose Client had `close()` called on it. Guards the
   * release of a client whose `connect()` rejected — the SDK does not close a
   * transport whose `start()` threw, so `connect()` has to.
   */
  closedClients: ('streamableHttp' | 'sse' | 'unattached')[];
}

const state: SdkState = {
  attempts: [],
  failing: new Set(),
  probeHostile: false,
  closeThrows: false,
  httpSessionId: undefined,
  clientsCreated: 0,
  negotiationModes: [],
  clientInfos: [],
  closedClients: [],
};

/** Explicit marker so the fake client can tell the two transports apart. */
const KIND = Symbol('transport-kind');

interface Marked {
  [KIND]: 'streamableHttp' | 'sse';
  sessionId: string | undefined;
}

// SDK v2 ships Client and both transports from one package, so the three
// separate v1 module mocks collapse into this single factory.
vi.mock('@modelcontextprotocol/client', () => ({
  StreamableHTTPClientTransport: class {
    [KIND] = 'streamableHttp' as const;
    sessionId: string | undefined;
    constructor(
      _url: URL,
      opts?: {
        sessionId?: string;
      },
    ) {
      this.sessionId = opts?.sessionId;
    }
    start(): Promise<void> {
      return Promise.resolve();
    }
    send(): Promise<void> {
      return Promise.resolve();
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  },
  SSEClientTransport: class {
    [KIND] = 'sse' as const;
    sessionId: string | undefined = undefined;
    start(): Promise<void> {
      return Promise.resolve();
    }
    send(): Promise<void> {
      return Promise.resolve();
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  },
  Client: class {
    constructor(
      info: unknown,
      opts?: {
        versionNegotiation?: {
          mode?: unknown;
        };
      },
    ) {
      state.clientsCreated += 1;
      state.negotiationModes.push(opts?.versionNegotiation?.mode);
      state.clientInfos.push(info);
      this.mode = opts?.versionNegotiation?.mode;
    }
    // v2 registration is method-name-first; the fakes accept and ignore both args.
    setRequestHandler(_method: string, _handler: unknown): void {}
    setNotificationHandler(_method: string, _handler: unknown): void {}
    /** This client's `versionNegotiation.mode`, for probe-hostile simulation. */
    mode: unknown;
    /** Set by `connect()` so `close()` can report which transport it released. */
    attached: 'streamableHttp' | 'sse' | undefined;
    connect(transport: Marked): Promise<void> {
      const kind = transport[KIND];
      this.attached = kind;
      const attempt: Attempt = {
        kind,
      };
      if (transport.sessionId !== undefined) {
        attempt.sessionId = transport.sessionId;
      }
      state.attempts.push(attempt);
      if (state.failing.has(kind)) {
        return Promise.reject(new Error(`${kind} refused`));
      }
      // A probe-hostile server breaks any mode that probes. `'auto'` probes, and
      // so does `{ pin }` (it demands a specific revision via `server/discover`);
      // only `'legacy'` skips it and uses the classic `initialize` handshake.
      if (state.probeHostile && this.mode !== 'legacy') {
        return Promise.reject(new Error('server/discover probe timed out'));
      }
      if (kind === 'streamableHttp' && state.httpSessionId !== undefined) {
        transport.sessionId = state.httpSessionId;
      }
      return Promise.resolve();
    }
    close(): Promise<void> {
      state.closedClients.push(this.attached ?? 'unattached');
      if (state.closeThrows) {
        // Synchronous throw, not a rejected promise — the case a bare
        // `.catch()` on the call would fail to intercept.
        throw new Error('close exploded');
      }
      return Promise.resolve();
    }
  },
}));

const { connect } = await import('../../src/mcp-connection.js');

const URL_UNDER_TEST = new URL('https://example.invalid/mcp');

beforeEach(() => {
  state.attempts = [];
  state.failing = new Set();
  state.probeHostile = false;
  state.closeThrows = false;
  state.httpSessionId = undefined;
  state.clientsCreated = 0;
  state.negotiationModes = [];
  state.clientInfos = [];
  state.closedClients = [];
});

describe('connect transport selection', () => {
  it('defaults to Streamable HTTP and does not touch SSE when it succeeds', async () => {
    const conn = await connect({
      url: URL_UNDER_TEST,
    });

    expect(conn.transport).toBe('streamableHttp');
    expect(state.attempts.map((a) => a.kind)).toEqual([
      'streamableHttp',
    ]);
    await conn.close();
  });

  it('uses SSE directly when pinned, without trying Streamable HTTP first', async () => {
    const conn = await connect({
      url: URL_UNDER_TEST,
      transport: 'sse',
    });

    expect(conn.transport).toBe('sse');
    expect(state.attempts.map((a) => a.kind)).toEqual([
      'sse',
    ]);
    await conn.close();
  });

  it('falls back to SSE on a fresh client when Streamable HTTP fails and no transport is pinned', async () => {
    state.failing.add('streamableHttp');

    const conn = await connect({
      url: URL_UNDER_TEST,
    });

    expect(conn.transport).toBe('sse');
    expect(state.attempts.map((a) => a.kind)).toEqual([
      'streamableHttp',
      'sse',
    ]);
    // A fresh Client is built for the fallback: the failed one may be
    // half-initialized, so reusing it would be unsound.
    expect(state.clientsCreated).toBe(2);
    await conn.close();
  });

  it('does not fall back when Streamable HTTP was pinned explicitly', async () => {
    state.failing.add('streamableHttp');

    await expect(
      connect({
        url: URL_UNDER_TEST,
        transport: 'streamableHttp',
        // Explicit, so the legacy-degradation retry stays out of the way: this
        // test is about transport selection, not negotiation.
        protocolNegotiation: 'auto',
      }),
    ).rejects.toThrow(MCPConnectionError);

    expect(state.attempts.map((a) => a.kind)).toEqual([
      'streamableHttp',
    ]);
  });

  it('throws MCPConnectionError naming both transports when both fail', async () => {
    state.failing.add('streamableHttp');
    state.failing.add('sse');

    await expect(
      connect({
        url: URL_UNDER_TEST,
        protocolNegotiation: 'auto',
      }),
    ).rejects.toThrow(/Streamable HTTP and SSE/);

    expect(state.attempts.map((a) => a.kind)).toEqual([
      'streamableHttp',
      'sse',
    ]);
  });

  it('propagates the SSE failure when SSE is pinned and fails', async () => {
    state.failing.add('sse');

    await expect(
      connect({
        url: URL_UNDER_TEST,
        transport: 'sse',
        protocolNegotiation: 'auto',
      }),
    ).rejects.toThrow();

    expect(state.attempts.map((a) => a.kind)).toEqual([
      'sse',
    ]);
  });
});

/**
 * A client whose `connect()` rejected still holds its transport: the SDK stores
 * the transport before calling `start()`, and when `start()` itself throws it
 * returns without teardown — so nothing closes the socket. `connect()` releases
 * it explicitly on every failure path. Without that, a probe timeout against a
 * strict gateway leaks a keep-alive connection, and the `'auto'` default makes
 * that the expected failure mode rather than a rare one.
 */
describe('connect releases failed clients', () => {
  it('closes the failed Streamable HTTP client before falling back to SSE', async () => {
    state.failing.add('streamableHttp');

    const conn = await connect({
      url: URL_UNDER_TEST,
    });

    expect(conn.transport).toBe('sse');
    // The failed HTTP client is released; the successful SSE one is left open
    // for the caller, who closes it through the returned connection.
    expect(state.closedClients).toEqual([
      'streamableHttp',
    ]);
    await conn.close();
  });

  it('closes the failed client when Streamable HTTP was pinned', async () => {
    state.failing.add('streamableHttp');

    await expect(
      connect({
        url: URL_UNDER_TEST,
        transport: 'streamableHttp',
        protocolNegotiation: 'auto',
      }),
    ).rejects.toThrow(MCPConnectionError);

    expect(state.closedClients).toEqual([
      'streamableHttp',
    ]);
  });

  it('closes both clients when Streamable HTTP and SSE fall through', async () => {
    state.failing.add('streamableHttp');
    state.failing.add('sse');

    await expect(
      connect({
        url: URL_UNDER_TEST,
        protocolNegotiation: 'auto',
      }),
    ).rejects.toThrow(/Streamable HTTP and SSE/);

    expect(state.closedClients).toEqual([
      'streamableHttp',
      'sse',
    ]);
  });

  it('closes the failed client when SSE was pinned', async () => {
    state.failing.add('sse');

    await expect(
      connect({
        url: URL_UNDER_TEST,
        transport: 'sse',
        protocolNegotiation: 'auto',
      }),
    ).rejects.toThrow();

    expect(state.closedClients).toEqual([
      'sse',
    ]);
  });

  /**
   * The release must never become the error the caller sees. A `close()` that
   * throws synchronously produces no rejected promise, so a bare
   * `.catch(() => {})` on the call would not intercept it — the teardown failure
   * would escape and replace the useful "couldn't reach the server" diagnosis
   * with a misleading one, on the path where the diagnosis matters most.
   */
  it('surfaces the connect error even when close() throws synchronously', async () => {
    state.failing.add('streamableHttp');
    state.closeThrows = true;

    await expect(
      connect({
        url: URL_UNDER_TEST,
        transport: 'streamableHttp',
        protocolNegotiation: 'auto',
      }),
    ).rejects.toThrow(MCPConnectionError);

    // The close was attempted; its explosion was swallowed.
    expect(state.closedClients).toEqual([
      'streamableHttp',
    ]);
  });

  it('still falls back to SSE when the failed client close() throws', async () => {
    state.failing.add('streamableHttp');
    state.closeThrows = true;

    const conn = await connect({
      url: URL_UNDER_TEST,
    });

    // A teardown failure on the HTTP client must not prevent the fallback.
    expect(conn.transport).toBe('sse');
    expect(state.closedClients).toEqual([
      'streamableHttp',
    ]);
    // Not closing `conn` here: the flag would make the caller-facing close throw
    // too, which is that method's contract (it does not swallow) and not what
    // this test is about.
  });

  it('does not close the client on a successful connect', async () => {
    const conn = await connect({
      url: URL_UNDER_TEST,
    });

    expect(state.closedClients).toEqual([]);
    await conn.close();
  });
});

describe('connect session handling', () => {
  it('surfaces the session id reported by the Streamable HTTP transport', async () => {
    state.httpSessionId = 'session-from-server';

    const conn = await connect({
      url: URL_UNDER_TEST,
    });

    expect(conn.sessionId).toBe('session-from-server');
    await conn.close();
  });

  it('replays a caller-supplied session id onto the transport', async () => {
    const conn = await connect({
      url: URL_UNDER_TEST,
      sessionId: 'resumed-session',
    });

    expect(state.attempts[0]?.sessionId).toBe('resumed-session');
    await conn.close();
  });

  it('leaves sessionId absent for SSE, which has no protocol-level session', async () => {
    const conn = await connect({
      url: URL_UNDER_TEST,
      transport: 'sse',
    });

    expect(conn.sessionId).toBeUndefined();
    await conn.close();
  });
});

describe('protocol negotiation', () => {
  it("defaults to 'auto' so both protocol revisions work without configuration", async () => {
    const conn = await connect({
      url: URL_UNDER_TEST,
    });

    expect(state.negotiationModes).toEqual([
      'auto',
    ]);
    await conn.close();
  });

  it("honours an explicit 'legacy' policy", async () => {
    const conn = await connect({
      url: URL_UNDER_TEST,
      protocolNegotiation: 'legacy',
    });

    expect(state.negotiationModes).toEqual([
      'legacy',
    ]);
    await conn.close();
  });

  it('passes a pinned revision through untouched', async () => {
    const conn = await connect({
      url: URL_UNDER_TEST,
      protocolNegotiation: {
        pin: '2026-07-28',
      },
    });

    expect(state.negotiationModes).toEqual([
      {
        pin: '2026-07-28',
      },
    ]);
    await conn.close();
  });

  it('applies the policy to the SSE fallback client too', async () => {
    state.failing.add('streamableHttp');

    const conn = await connect({
      url: URL_UNDER_TEST,
      protocolNegotiation: 'legacy',
    });

    // Both the failed Streamable HTTP client and the fresh SSE one.
    expect(state.negotiationModes).toEqual([
      'legacy',
      'legacy',
    ]);
    await conn.close();
  });
});

/**
 * `clientInfo` is what every MCP server sees us as. The version half is
 * generated from package.json and guarded by version.test.ts, but nothing
 * asserted that the constant actually reaches the SDK constructor — so a
 * refactor could drop it, or send a hardcoded value, with that guard still
 * green. These close the loop between the generated constant and the wire.
 */
describe('connect clientInfo', () => {
  it('self-reports the package name and generated version by default', async () => {
    const { PACKAGE_VERSION } = await import('../../src/version.js');

    const conn = await connect({
      url: URL_UNDER_TEST,
    });

    expect(state.clientInfos).toEqual([
      {
        name: '@openrouter/mcp',
        version: PACKAGE_VERSION,
      },
    ]);
    await conn.close();
  });

  it('lets an explicit clientInfo override the default', async () => {
    const conn = await connect({
      url: URL_UNDER_TEST,
      clientInfo: {
        name: 'my-app',
        version: '9.9.9',
      },
    });

    expect(state.clientInfos).toEqual([
      {
        name: 'my-app',
        version: '9.9.9',
      },
    ]);
    await conn.close();
  });

  it('carries the same clientInfo onto the SSE fallback client', async () => {
    state.failing.add('streamableHttp');
    const { PACKAGE_VERSION } = await import('../../src/version.js');

    const conn = await connect({
      url: URL_UNDER_TEST,
    });

    // Both clients identify identically: a server that sees the fallback must
    // not see a different client than the one that just probed it.
    expect(state.clientInfos).toEqual([
      {
        name: '@openrouter/mcp',
        version: PACKAGE_VERSION,
      },
      {
        name: '@openrouter/mcp',
        version: PACKAGE_VERSION,
      },
    ]);
    await conn.close();
  });
});

/**
 * `'auto'` degrades to the 2025-era handshake rather than failing.
 *
 * We default `protocolNegotiation` to `'auto'` where the SDK defaults to
 * `'legacy'`, so every connection's first request is a `server/discover` probe.
 * Alone that is a connectivity regression: a proxy, WAF, or strict gateway that
 * hangs or 5xx's on an unknown method takes a working server to failing, and the
 * SSE fallback re-probes and fails identically — so the two-transport fallback
 * collapses to a single point of failure against exactly the infrastructure it
 * should rescue.
 *
 * Retrying once with `'legacy'` makes `'auto'` strictly additive: modern servers
 * get the new revision, everything else lands where it did before this package
 * probed at all.
 *
 * The `probeHostile` fake models the real case precisely — it rejects only while
 * `mode === 'auto'`, so a test that passes here would fail if the retry did not
 * actually switch modes.
 */
describe('legacy degradation under an implicit auto default', () => {
  it('retries with legacy and connects against a probe-hostile server', async () => {
    state.probeHostile = true;

    // No `protocolNegotiation` — the implicit default, which is what a consumer
    // who never configured negotiation gets.
    const conn = await connect({
      url: URL_UNDER_TEST,
    });

    expect(conn.transport).toBe('streamableHttp');
    // Modes in order: the 'auto' attempt, its SSE re-probe, then the legacy retry.
    expect(state.negotiationModes).toEqual([
      'auto',
      'auto',
      'legacy',
    ]);
  });

  it('does not retry when the first attempt succeeds', async () => {
    const conn = await connect({
      url: URL_UNDER_TEST,
    });

    expect(state.negotiationModes).toEqual([
      'auto',
    ]);
    await conn.close();
  });

  it('honours an explicit auto without degrading', async () => {
    state.probeHostile = true;

    await expect(
      connect({
        url: URL_UNDER_TEST,
        protocolNegotiation: 'auto',
      }),
      // Asking for a mode means asking for its failures too.
    ).rejects.toThrow(MCPConnectionError);

    expect(state.negotiationModes).not.toContain('legacy');
  });

  it('honours an explicit pin without degrading', async () => {
    state.probeHostile = true;

    await expect(
      connect({
        url: URL_UNDER_TEST,
        protocolNegotiation: {
          pin: '2026-07-28',
        },
      }),
      // Silently falling back would defeat the entire point of pinning.
    ).rejects.toThrow(MCPConnectionError);

    expect(state.negotiationModes).not.toContain('legacy');
  });

  it('degrades on a pinned SSE transport too', async () => {
    state.probeHostile = true;

    // Someone who pinned SSE did so because they have a legacy server — the most
    // likely person to sit behind probe-hostile infrastructure, and the least
    // likely to expect a probe.
    const conn = await connect({
      url: URL_UNDER_TEST,
      transport: 'sse',
    });

    expect(conn.transport).toBe('sse');
    expect(state.negotiationModes).toEqual([
      'auto',
      'legacy',
    ]);
    await conn.close();
  });

  it('surfaces the legacy failure when the server is genuinely unreachable', async () => {
    // Not probe-hostile — the transport itself refuses, so the retry fails too.
    state.failing.add('streamableHttp');
    state.failing.add('sse');

    await expect(
      connect({
        url: URL_UNDER_TEST,
      }),
      // The legacy attempt is the more informative failure: the server refused a
      // plain `initialize`, so this is reachability rather than negotiation.
    ).rejects.toThrow(/Streamable HTTP and SSE/);

    // Both modes were tried before giving up.
    expect(state.negotiationModes).toEqual([
      'auto',
      'auto',
      'legacy',
      'legacy',
    ]);
  });

  it('releases every failed client across both attempts', async () => {
    state.failing.add('streamableHttp');
    state.failing.add('sse');

    await expect(
      connect({
        url: URL_UNDER_TEST,
      }),
    ).rejects.toThrow(MCPConnectionError);

    // Four clients built, four released — the retry must not leak the transports
    // of the attempt that preceded it.
    expect(state.clientsCreated).toBe(4);
    expect(state.closedClients).toHaveLength(4);
  });
});
