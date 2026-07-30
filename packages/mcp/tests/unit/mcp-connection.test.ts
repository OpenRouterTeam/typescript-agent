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
    }
    // v2 registration is method-name-first; the fakes accept and ignore both args.
    setRequestHandler(_method: string, _handler: unknown): void {}
    setNotificationHandler(_method: string, _handler: unknown): void {}
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
