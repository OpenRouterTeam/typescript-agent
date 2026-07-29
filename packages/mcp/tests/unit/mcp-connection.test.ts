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
  /** sessionId the fake Streamable HTTP transport reports after connecting. */
  httpSessionId: string | undefined;
  clientsCreated: number;
  /** `versionNegotiation.mode` seen by each constructed Client, in order. */
  negotiationModes: unknown[];
}

const state: SdkState = {
  attempts: [],
  failing: new Set(),
  httpSessionId: undefined,
  clientsCreated: 0,
  negotiationModes: [],
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
      _info: unknown,
      opts?: {
        versionNegotiation?: {
          mode?: unknown;
        };
      },
    ) {
      state.clientsCreated += 1;
      state.negotiationModes.push(opts?.versionNegotiation?.mode);
    }
    // v2 registration is method-name-first; the fakes accept and ignore both args.
    setRequestHandler(_method: string, _handler: unknown): void {}
    setNotificationHandler(_method: string, _handler: unknown): void {}
    connect(transport: Marked): Promise<void> {
      const kind = transport[KIND];
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
      return Promise.resolve();
    }
  },
}));

const { connect } = await import('../../src/mcp-connection.js');

const URL_UNDER_TEST = new URL('https://example.invalid/mcp');

beforeEach(() => {
  state.attempts = [];
  state.failing = new Set();
  state.httpSessionId = undefined;
  state.clientsCreated = 0;
  state.negotiationModes = [];
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
