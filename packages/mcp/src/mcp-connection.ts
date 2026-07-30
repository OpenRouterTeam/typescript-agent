// SSEClientTransport is deprecated upstream (SEP-2596) but intentionally
// supported here for legacy MCP servers that haven't migrated to Streamable HTTP.
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { resolveAuth } from './auth/auth-resolver.js';
import type { MCPAuth } from './auth/auth-types.js';
import { closeQuietly } from './close-quietly.js';
import { makeElicitationRequestHandler } from './elicitation.js';
import { MCPConnectionError } from './errors.js';
import type { MCPProtocolNegotiation, MCPTransportKind } from './transport-types.js';
import type { ElicitationHandler } from './types.js';
import { PACKAGE_VERSION } from './version.js';

// Self-reported to every MCP server we connect to as `clientInfo`. The version
// is generated from package.json (scripts/gen-version.mjs) so it cannot drift.
const DEFAULT_CLIENT_INFO = {
  name: '@openrouter/mcp',
  version: PACKAGE_VERSION,
};

export interface ConnectOptions {
  url: URL;
  transport?: MCPTransportKind;
  auth?: MCPAuth;
  fetch?: typeof fetch;
  clientInfo?: {
    name: string;
    version: string;
  };
  /**
   * Streamable HTTP session id to resume.
   *
   * @deprecated Ignored by 2026-07-28 servers — protocol-level sessions are
   * removed (SEP-2567). Still honoured on 2025-era connections.
   */
  sessionId?: string;
  onElicitation?: ElicitationHandler;
  protocolNegotiation?: MCPProtocolNegotiation;
}

export interface MCPConnection {
  client: Client;
  transport: MCPTransportKind;
  /**
   * Session id reported by the transport, when there is one.
   *
   * @deprecated `undefined` on 2026-07-28 connections (SEP-2567) and on SSE,
   * which never had a protocol-level session.
   */
  sessionId?: string;
  /**
   * Register a callback for `tools/list_changed`. Settable after connect so the
   * handle can wire it to its own `refresh()`. Replaces any prior handler.
   */
  setToolListChangedHandler(handler: () => void): void;
  close(): Promise<void>;
}

function buildStreamableHttp(options: ConnectOptions): StreamableHTTPClientTransport {
  const { headers, authProvider } = resolveAuth(options.auth);
  return new StreamableHTTPClientTransport(options.url, {
    requestInit: {
      headers,
    },
    ...(authProvider !== undefined && {
      authProvider,
    }),
    ...(options.fetch !== undefined && {
      fetch: options.fetch,
    }),
    ...(options.sessionId !== undefined && {
      sessionId: options.sessionId,
    }),
  });
}

function buildSse(options: ConnectOptions): SSEClientTransport {
  const { headers, authProvider } = resolveAuth(options.auth);
  return new SSEClientTransport(options.url, {
    requestInit: {
      headers,
    },
    ...(authProvider !== undefined && {
      authProvider,
    }),
    ...(options.fetch !== undefined && {
      fetch: options.fetch,
    }),
  });
}

interface MutableListChanged {
  handler: (() => void) | undefined;
}

/**
 * Build the configured `Client` — negotiation mode, elicitation handler, and the
 * `tools/list_changed` subscription — without connecting it.
 *
 * Exported for tests only, and deliberately not re-exported from the package
 * entrypoint. It is the seam that lets a test drive the real handler wiring over
 * `InMemoryTransport`: the notification method name is compile-checked (it is a
 * `NotificationMethod` literal union, so a typo fails `tsc`), but the *dispatch*
 * — that an inbound notification actually reaches `setToolListChangedHandler`'s
 * callback — is only observable end to end. Without this seam, default-on
 * `autoRefreshOnListChanged` could be silently dead with every test green.
 *
 * @internal
 */
export function makeClientForTest(options: ConnectOptions, onListChanged: () => void): Client {
  return makeClient(options, {
    handler: onListChanged,
  });
}

function makeClient(options: ConnectOptions, listChanged: MutableListChanged): Client {
  const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO, {
    capabilities: {
      elicitation: {},
    },
    // The SDK defaults to 'legacy'; we default to 'auto' so callers reach both
    // 2025-era and 2026-07-28 servers without configuring anything.
    //
    // `inputRequired` is deliberately left unset: its defaults (auto-fulfil on,
    // 10 rounds) are what we want, and pinning them here would freeze values
    // the SDK may tune.
    versionNegotiation: {
      mode: options.protocolNegotiation ?? 'auto',
    },
  });

  // Method-name-first in SDK v2; spec methods supply their own schema. This one
  // handler serves both protocol eras: on 2025-era connections the server sends
  // `elicitation/create` directly, and on 2026-07-28 the multi-round-trip driver
  // dispatches `input_required` through this same handler, then retries the
  // original call with the collected `inputResponses`.
  client.setRequestHandler(
    'elicitation/create',
    makeElicitationRequestHandler(options.onElicitation),
  );

  // Kept as a notification handler rather than `ClientOptions.listChanged`: the
  // latter re-lists tools itself, duplicating the handle's own `refresh()` and
  // its cache write. Notification handlers are era-transparent.
  client.setNotificationHandler('notifications/tools/list_changed', () => {
    listChanged.handler?.();
  });

  return client;
}

/**
 * Connect a `Client` to the MCP server.
 *
 * Defaults to Streamable HTTP and falls back to SSE on connection failure
 * (legacy servers), unless a transport is pinned explicitly. Auth, the
 * elicitation handler, and the list_changed subscription are wired into the
 * single connected client so they apply to discovery and every tool call.
 *
 * When the caller does not set `protocolNegotiation`, a failed connect is
 * retried once with `'legacy'` — see {@link connect} below, which owns that
 * policy; this function performs exactly one negotiation mode.
 */
async function connectWithNegotiation(options: ConnectOptions): Promise<MCPConnection> {
  const preferred = options.transport ?? 'streamableHttp';
  const listChanged: MutableListChanged = {
    handler: undefined,
  };

  if (preferred === 'sse') {
    const client = makeClient(options, listChanged);
    try {
      await client.connect(buildSse(options));
    } catch (sseErr) {
      // Same transport-release reason as the Streamable HTTP path below.
      await closeQuietly(client);
      throw sseErr;
    }
    return wrap({
      client,
      transport: 'sse',
      listChanged,
    });
  }

  // Streamable HTTP, with SSE fallback when the transport wasn't pinned.
  const client = makeClient(options, listChanged);
  try {
    const http = buildStreamableHttp(options);
    await client.connect(http);
    return wrap({
      client,
      transport: 'streamableHttp',
      listChanged,
      ...(http.sessionId !== undefined && {
        sessionId: http.sessionId,
      }),
    });
  } catch (httpErr) {
    // Release the failed client's transport. The SDK cleans up after a failed
    // probe or `initialize` handshake, but not when `transport.start()` itself
    // throws: the base connect stores the transport before starting it and
    // propagates without teardown, leaving a keep-alive socket open. Releasing
    // unconditionally is safe on the paths the SDK already handles — see
    // `closeQuietly`, which tolerates any close outcome rather than depending on
    // what the SDK does internally.
    await closeQuietly(client);
    if (options.transport === 'streamableHttp') {
      throw new MCPConnectionError('Failed to connect over Streamable HTTP', {
        cause: httpErr,
      });
    }
    // Fall back to SSE on a fresh client (the failed one may be half-initialized).
    // Under `'auto'` this re-probes, so a probe-hostile server fails here too —
    // which is why `connect()` retries the whole thing under `'legacy'` when the
    // caller did not pin a negotiation mode.
    const sseClient = makeClient(options, listChanged);
    try {
      await sseClient.connect(buildSse(options));
      return wrap({
        client: sseClient,
        transport: 'sse',
        listChanged,
      });
    } catch (sseErr) {
      await closeQuietly(sseClient);
      throw new MCPConnectionError('Failed to connect over Streamable HTTP and SSE', {
        cause: sseErr,
      });
    }
  }
}

/**
 * Was this failure the server rejecting our credentials?
 *
 * Walks the `cause` chain because `connectWithNegotiation` wraps transport
 * errors in `MCPConnectionError`, so the SDK's `UnauthorizedError` is nested
 * rather than thrown directly. Depth-capped: a cyclic `cause` would otherwise
 * hang, and legitimate chains here are two or three links.
 */
function isAuthFailure(err: unknown): boolean {
  let current = err;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof UnauthorizedError) {
      return true;
    }
    if (!(current instanceof Error) || current.cause === undefined) {
      return false;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Connect a `Client` to the MCP server, degrading to the 2025-era handshake if
 * protocol negotiation gets in the way.
 *
 * We default `protocolNegotiation` to `'auto'` where the SDK defaults to
 * `'legacy'`, so every connection's first request is a `server/discover` probe.
 * On its own that would be a connectivity regression: a proxy, WAF, or strict
 * gateway that hangs or 5xx's on an unknown method takes a server from working
 * to failing, and the SSE fallback re-probes and fails identically — so the
 * two-transport fallback, which looks like defense in depth, collapses to a
 * single point of failure against exactly the infrastructure it should rescue.
 *
 * So when the caller left `protocolNegotiation` unset, a failed connect is
 * retried once with `'legacy'`. That makes `'auto'` strictly additive: modern
 * servers get the new revision, everything else lands exactly where it did
 * before this package started probing. The cost is one extra attempt on a path
 * that is already failing, which is where latency matters least.
 *
 * The retry fires on **any** failure rather than only on ones that look like
 * probe timeouts. Inspecting the cause would avoid a wasted attempt against a
 * genuinely dead server, but it would couple this to SDK error codes — and a
 * reshaped error would silently disable the degradation, which is the failure
 * mode this package keeps getting bitten by.
 *
 * Two bounds keep the retry from making a bad situation worse:
 *
 * 1. **It is skipped on an auth failure.** `UnauthorizedError` means the
 *    transport reached the server and the credentials were rejected — nothing a
 *    different protocol revision changes. Retrying would re-drive the OAuth
 *    provider's authorization flow: a second `redirectToAuthorization`, a second
 *    saved PKCE verifier overwriting the first. Replaying a failure that had
 *    side effects is worse than not retrying.
 * 2. **It reuses one transport, not another two-transport ladder.** Without
 *    this, an unreachable server is dialled four times where it used to be
 *    dialled twice, each dial carrying its own request timeout — enough to push
 *    a caller past its own deadline. Reusing the caller's transport preference
 *    keeps the worst case at three.
 *
 * An **explicit** `protocolNegotiation` is honoured exactly, including
 * `'auto'`: asking for a mode means asking for its failures too, and silently
 * ignoring a caller's `{ pin }` would defeat the point of pinning.
 */
export async function connect(options: ConnectOptions): Promise<MCPConnection> {
  if (options.protocolNegotiation !== undefined) {
    return connectWithNegotiation(options);
  }
  try {
    return await connectWithNegotiation(options);
  } catch (autoErr) {
    if (isAuthFailure(autoErr)) {
      throw autoErr;
    }
    // Pin the transport the caller asked for — `'streamableHttp'` by default —
    // so this is a single attempt rather than a second ladder. Not inspecting
    // the error for *whether* the probe was at fault: that would couple us to
    // SDK error codes, and a reshaped error would silently disable the whole
    // degradation. `UnauthorizedError` above is the one exception, because there
    // the cost of retrying is a duplicated side effect rather than a wasted dial.
    return await connectWithNegotiation({
      ...options,
      transport: options.transport ?? 'streamableHttp',
      protocolNegotiation: 'legacy',
    });
  }
}

interface WrapArgs {
  client: Client;
  transport: MCPTransportKind;
  listChanged: MutableListChanged;
  sessionId?: string;
}

function wrap(args: WrapArgs): MCPConnection {
  const { client, transport, listChanged, sessionId } = args;
  return {
    client,
    transport,
    ...(sessionId !== undefined && {
      sessionId,
    }),
    setToolListChangedHandler: (handler: () => void) => {
      listChanged.handler = handler;
    },
    close: () => client.close(),
  };
}
