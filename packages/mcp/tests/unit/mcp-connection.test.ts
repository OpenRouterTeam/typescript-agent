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
  /** When true, every connect rejects with the SDK's `UnauthorizedError`. */
  authFailure: boolean;
  /** When set, only that transport rejects with `UnauthorizedError`. */
  authFailOn: 'streamableHttp' | 'sse' | undefined;
  /**
   * When set, every connect rejects with an error carrying this `status` — the
   * shape the SDK's probe uses for HTTP failures instead of `UnauthorizedError`.
   */
  httpErrorStatus: number | undefined;
  /** When set, every connect rejects with exactly this error. */
  connectError: unknown;
  /** sessionId the fake Streamable HTTP transport reports after connecting. */
  httpSessionId: string | undefined;
  clientsCreated: number;
  /** `versionNegotiation.mode` seen by each constructed Client, in order. */
  negotiationModes: unknown[];
  /** `versionNegotiation.probe.timeoutMs` seen by each Client, in order. */
  probeTimeouts: unknown[];
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
  authFailure: false,
  authFailOn: undefined,
  httpErrorStatus: undefined,
  connectError: undefined,
  httpSessionId: undefined,
  clientsCreated: 0,
  negotiationModes: [],
  probeTimeouts: [],
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
// The real one is brand-based rather than prototype-based; a plain Error
// subclass is enough for the `cause`-chain walk under test, and keeps the fake
// self-contained. Safe to declare after `vi.mock` despite vitest hoisting that
// call, because the factory body only runs on first import of the mocked module.
class FakeUnauthorizedError extends Error {}

vi.mock('@modelcontextprotocol/client', () => ({
  UnauthorizedError: FakeUnauthorizedError,
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
          probe?: {
            timeoutMs?: unknown;
          };
        };
      },
    ) {
      state.clientsCreated += 1;
      state.negotiationModes.push(opts?.versionNegotiation?.mode);
      state.probeTimeouts.push(opts?.versionNegotiation?.probe?.timeoutMs);
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
      if (state.authFailure || state.authFailOn === kind) {
        return Promise.reject(new FakeUnauthorizedError('unauthorized'));
      }
      if (state.connectError !== undefined) {
        return Promise.reject(state.connectError);
      }
      if (state.httpErrorStatus !== undefined) {
        return Promise.reject(
          Object.assign(new Error(`http ${state.httpErrorStatus}`), {
            status: state.httpErrorStatus,
          }),
        );
      }
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
  state.authFailure = false;
  state.authFailOn = undefined;
  state.httpErrorStatus = undefined;
  state.connectError = undefined;
  state.httpSessionId = undefined;
  state.clientsCreated = 0;
  state.negotiationModes = [];
  state.probeTimeouts = [];
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

  /**
   * Pinned SSE wraps like every other path.
   *
   * It used to rethrow the raw transport error, which made the type a caller sees
   * depend on an unrelated option: with `protocolNegotiation` unset the outer
   * retry aggregated it into an `MCPConnectionError`, with it set the raw error
   * escaped. Same server, same failure, different `catch`.
   */
  it('wraps a pinned SSE failure in MCPConnectionError', async () => {
    state.failing.add('sse');

    const err = await connect({
      url: URL_UNDER_TEST,
      transport: 'sse',
      protocolNegotiation: 'auto',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MCPConnectionError);
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(((err as Error).cause as Error).message).toMatch(/sse refused/);
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

  /**
   * The case the whole mechanism exists for, and the one an earlier revision of
   * it broke: a legacy server reachable **only** over SSE, behind infrastructure
   * that chokes on the probe.
   *
   * Under `'auto'` both transports fail — HTTP because the server doesn't speak
   * it, SSE because the probe is refused. The retry therefore has to re-walk the
   * ladder; pinning it to Streamable HTTP (which I did briefly, to cap the
   * attempt count) means SSE is never offered again and a server that connected
   * before this PR stops connecting.
   */
  it('reaches an SSE-only server whose probe is refused', async () => {
    state.probeHostile = true;
    state.failing.add('streamableHttp');

    const conn = await connect({
      url: URL_UNDER_TEST,
    });

    expect(conn.transport).toBe('sse');
    expect(state.attempts.map((a) => a.kind)).toEqual([
      'streamableHttp',
      'sse',
      'streamableHttp',
      'sse',
    ]);
  });

  /**
   * The cost of that guarantee: a genuinely dead server is dialled four times,
   * two per negotiation mode. Asserted so the number is a decision rather than an
   * accident — the bound that matters is that it is a fixed multiple, not a retry
   * loop.
   */
  it('caps a dead server at four attempts — two per mode', async () => {
    // Not probe-hostile — the transport itself refuses, so the retry fails too.
    state.failing.add('streamableHttp');
    state.failing.add('sse');

    await expect(
      connect({
        url: URL_UNDER_TEST,
      }),
    ).rejects.toThrow(MCPConnectionError);

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

  /**
   * A hanging gateway must not cost four full request timeouts.
   *
   * The SDK falls back to the whole request timeout (60s) for the probe when
   * `probe.timeoutMs` is unset. Under `'auto'` the probe is the first request of
   * every connection, and with the legacy retry re-walking the ladder that is up
   * to four attempts — roughly four minutes before `createMCPTools()` rejects, on
   * the path a caller gets with no configuration at all.
   */
  it('bounds the probe below the SDK request timeout', async () => {
    const conn = await connect({
      url: URL_UNDER_TEST,
    });

    // Half the SDK's 60s default rather than a tight cap: a probe timeout is not
    // recoverable (HTTP treats it as an outage, and the legacy retry sends an
    // `initialize` that 2026-07-28 removed), so a value tight enough to trip a
    // cold start would make a modern-only server unreachable rather than slow.
    expect(state.probeTimeouts).toEqual([
      30_000,
    ]);
    await conn.close();
  });

  /**
   * The default is stated in four places — the constant, two JSDoc sites, the
   * README, and the changeset — and it has already drifted once: it moved 5s → 30s
   * while three JSDoc comments kept saying 5000. This pins the source files
   * against the constant so the next change to it fails here rather than shipping
   * hover text that is six times wrong.
   */
  it('documents the same probe default that the code applies', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

    const conn = await connect({
      url: URL_UNDER_TEST,
    });
    const applied = state.probeTimeouts[0];
    await conn.close();

    expect(typeof applied).toBe('number');
    for (const file of [
      'types.ts',
      'rehydrate.ts',
      'mcp-connection.ts',
    ]) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      // Every `Defaults to <n>` / `defaults to <n>` near the probe option must
      // name the value the code actually passes.
      for (const match of text.matchAll(/probe[^\n]*\n?[^\n]*?efaults to (\d+)/gi)) {
        expect(Number(match[1])).toBe(applied);
      }
    }
  });

  it('lets a caller raise the probe timeout for a slow server', async () => {
    const conn = await connect({
      url: URL_UNDER_TEST,
      probeTimeoutMs: 30_000,
    });

    expect(state.probeTimeouts).toEqual([
      30_000,
    ]);
    await conn.close();
  });

  /**
   * `errors` entries must be real failures, not wrappers.
   *
   * A single-transport pass wraps its one failure with only `cause` set, so
   * without unwrapping that case the aggregated list becomes two opaque
   * `MCPConnectionError`s — and a caller scanning for a rejected token would have
   * to dig through `cause` on some entries but not others.
   */
  it('unwraps single-transport passes so errors holds real failures', async () => {
    // Pinned Streamable HTTP: each pass wraps its single failure in an
    // `MCPConnectionError` whose own `errors` is empty, so this is the case where
    // the aggregated list would otherwise be two opaque wrappers. (Pinned SSE
    // rethrows the raw error, so it never had the problem.)
    state.failing.add('streamableHttp');

    const err = await connect({
      url: URL_UNDER_TEST,
      transport: 'streamableHttp',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MCPConnectionError);
    const { errors } = err as MCPConnectionError;
    // One attempt per pass, both unwrapped to the underlying transport error.
    expect(errors).toHaveLength(2);
    for (const nested of errors) {
      expect(nested).not.toBeInstanceOf(MCPConnectionError);
      expect((nested as Error).message).toMatch(/streamableHttp refused/);
    }
  });

  /**
   * Node's happy-eyeballs path and some fetch implementations report a 401 as an
   * `AggregateError` member rather than as a `cause`. A spine-only walk misses it
   * and re-drives the OAuth flow.
   */
  it('finds an auth failure inside an AggregateError', async () => {
    state.connectError = new AggregateError(
      [
        new Error('ipv6 refused'),
        Object.assign(new Error('http 401'), {
          status: 401,
        }),
      ],
      'all addresses failed',
    );

    await expect(
      connect({
        url: URL_UNDER_TEST,
      }),
    ).rejects.toThrow();

    expect(state.negotiationModes).not.toContain('legacy');
  });

  /**
   * `errors` has to span both negotiation passes, not just the last.
   *
   * `MCPConnectionError.errors` documents itself as every failure in attempt
   * order. If the retry's rejection propagated untouched, the `'auto'` pass's
   * failures would vanish — half the attempts, plus any auth-shaped rejection
   * `isAuthFailure` didn't match — and someone debugging an unreachable server
   * would be reading a partial record while the docs promised a complete one.
   */
  it('reports every attempt across both negotiation passes', async () => {
    state.failing.add('streamableHttp');
    state.failing.add('sse');

    const err = await connect({
      url: URL_UNDER_TEST,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MCPConnectionError);
    // Four attempts: two transports × two negotiation modes, flat rather than a
    // tree of wrappers so a caller can iterate without recursing.
    expect((err as MCPConnectionError).errors).toHaveLength(4);
    for (const nested of (err as MCPConnectionError).errors) {
      expect(nested).not.toBeInstanceOf(MCPConnectionError);
    }
    // `cause` still points at the last thing tried.
    expect((err as MCPConnectionError).cause).toBeInstanceOf(Error);
  });

  /**
   * An auth rejection does not always arrive as `UnauthorizedError`.
   *
   * The version-negotiation probe doesn't route 401/403 through the OAuth flow —
   * `classifyHttpError` turns them into an `SdkHttpError` with
   * `ClientHttpAuthentication` / `ClientHttpForbidden`. So a probe rejected for
   * auth reasons is a different type entirely, and a guard keyed only on
   * `UnauthorizedError` would retry it and re-drive the flow.
   */
  it('suppresses the retry for an auth-shaped HTTP status', async () => {
    state.httpErrorStatus = 403;

    await expect(
      connect({
        url: URL_UNDER_TEST,
      }),
    ).rejects.toThrow();

    expect(state.negotiationModes).not.toContain('legacy');
  });

  /**
   * A non-Error payload carrying `status: 401` must not suppress the retry.
   *
   * The guard is duck-typed on `status`, which is the stable half of the SDK's
   * contract — but a plain object with that field is far more likely to be a
   * response or a log record riding along in a `cause` than an authoritative
   * rejection (the SDK builds log entries with `status: 0`). Treating one as a
   * credential failure would silently suppress the retry and make a
   * probe-hostile-but-authenticated server unreachable — the regression the
   * retry exists to prevent.
   */
  it('ignores a status on a non-Error payload', async () => {
    state.connectError = Object.assign(new Error('gateway barfed'), {
      cause: {
        status: 401,
        note: 'upstream response, not our rejection',
      },
    });

    await expect(
      connect({
        url: URL_UNDER_TEST,
      }),
    ).rejects.toThrow();

    expect(state.negotiationModes).toContain('legacy');
  });

  it('still retries a non-auth HTTP status', async () => {
    // 404 is the SSE-endpoint-doesn't-exist case, not a credentials problem —
    // guards against the status check over-matching and disabling degradation.
    state.httpErrorStatus = 404;

    await expect(
      connect({
        url: URL_UNDER_TEST,
      }),
    ).rejects.toThrow();

    expect(state.negotiationModes).toContain('legacy');
  });

  /**
   * The auth guard has to see *both* transport attempts, not just the last.
   *
   * When Streamable HTTP 401s (OAuth flow driven once) and the SSE fallback then
   * fails for an unrelated reason — the same URL answering 404 to an SSE GET,
   * which never reaches the auth path — the `cause` spine holds only the SSE
   * error. A guard reading `cause` alone would miss the `UnauthorizedError` and
   * retry, re-driving `redirectToAuthorization` and overwriting the stored PKCE
   * verifier.
   */
  it('suppresses the retry when only the HTTP attempt was an auth failure', async () => {
    state.authFailOn = 'streamableHttp';
    state.failing.add('sse');

    await expect(
      connect({
        url: URL_UNDER_TEST,
      }),
    ).rejects.toThrow(MCPConnectionError);

    // Both transports tried once; no legacy retry behind them.
    expect(state.negotiationModes).toEqual([
      'auto',
      'auto',
    ]);
    expect(state.negotiationModes).not.toContain('legacy');
  });

  /**
   * An auth rejection means the transport reached the server and the credentials
   * were refused — nothing a different protocol revision changes. Retrying would
   * re-drive an OAuth provider's authorization flow: a second
   * `redirectToAuthorization`, a second saved PKCE verifier overwriting the
   * first. Replaying a failure that had side effects is worse than not retrying.
   */
  it('does not retry an auth failure', async () => {
    state.authFailure = true;

    await expect(
      connect({
        url: URL_UNDER_TEST,
      }),
    ).rejects.toThrow(MCPConnectionError);

    // The transport ladder still runs — that is about reachability, not
    // credentials — but no `'legacy'` retry follows it, so the OAuth flow is
    // driven once rather than twice.
    expect(state.negotiationModes).toEqual([
      'auto',
      'auto',
    ]);
    expect(state.negotiationModes).not.toContain('legacy');
  });

  it('detects an auth failure nested inside the wrapper error', async () => {
    // Guards the `cause`-chain walk specifically: `connectWithNegotiation` wraps
    // transport errors in `MCPConnectionError`, so a bare top-level `instanceof`
    // check would miss the nested `UnauthorizedError` and retry anyway —
    // re-driving the authorization flow these tests exist to prevent.
    state.authFailure = true;

    const err = await connect({
      url: URL_UNDER_TEST,
    }).catch((e: unknown) => e);

    // Wrapped, not bare — which is exactly why the walk is needed.
    expect(err).toBeInstanceOf(MCPConnectionError);
    expect((err as Error).cause).toBeInstanceOf(FakeUnauthorizedError);
  });
});
