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
import { isOAuthAuth } from './auth/auth-types.js';
import { closeQuietly } from './close-quietly.js';
import { makeElicitationRequestHandler } from './elicitation.js';
import { MCPConnectionError } from './errors.js';
import type { MCPProtocolNegotiation, MCPTransportKind } from './transport-types.js';
import type { ElicitationHandler } from './types.js';
import { PACKAGE_VERSION } from './version.js';

/**
 * Ceiling on the `server/discover` probe, in ms.
 *
 * The SDK falls back to the full request timeout (60s) when this is unset, which
 * is a long time to spend on a liveness question: under the `'auto'` default the
 * probe is the first request of every connection, and a gateway that black-holes
 * it burns the whole budget per attempt — up to four attempts once the legacy
 * retry re-walks the transport ladder, so minutes before `createMCPTools()`
 * rejects on the no-configuration path.
 *
 * **But a probe timeout is not recoverable, so this cannot be tight.** On HTTP
 * the SDK classifies a timed-out probe as an outage and rejects (only stdio
 * treats it as a legacy verdict), and the legacy retry that follows sends
 * `initialize` — which revision 2026-07-28 removed (SEP-2575). So a
 * modern-only server slower than this ceiling fails *both* passes and does not
 * connect at all, where the SDK's own default would have waited and succeeded.
 * Serverless cold starts routinely exceed a few seconds, which makes an
 * aggressive value a correctness bug rather than a latency tradeoff.
 *
 * 30s splits the difference: comfortably past a cold start, while keeping the
 * probe from consuming the SDK's full 60s request budget per attempt. Note the
 * ceiling bounds only the `'auto'` probes — the implicit legacy retry's
 * `initialize` attempts still run under the SDK's own timeout, so the
 * black-holed-gateway worst case on the default path is roughly
 * 30s + 30s + 60s + 60s ≈ 3 minutes across the four attempts (vs ~2 minutes
 * for the two attempts before this package probed at all). A caller with a
 * harder deadline bounds the whole ladder with `signal`. Raise this with
 * `probeTimeoutMs` for a server known to be slower; lower it when you control
 * the server and want to fail fast.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

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
  /**
   * Aborts the connect — every transport attempt, the negotiation probe, and
   * the implicit legacy retry. Without this a caller with its own deadline has
   * no way to bound the ladder, whose worst case is minutes (see
   * {@link DEFAULT_PROBE_TIMEOUT_MS}).
   */
  signal?: AbortSignal;
  /**
   * Ceiling on the `server/discover` probe, in ms. Defaults to
   * `DEFAULT_PROBE_TIMEOUT_MS` (30000).
   *
   * Raise it for a server that is slow to answer its first request; the SDK's own
   * default is the full request timeout, which makes a hanging gateway far slower
   * to fail than it needs to be.
   */
  probeTimeoutMs?: number;
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

/** Per-call request options threaded into the SDK's `connect()`. */
function connectRequestOptions(options: ConnectOptions):
  | {
      signal: AbortSignal;
    }
  | undefined {
  return options.signal !== undefined
    ? {
        signal: options.signal,
      }
    : undefined;
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
      probe: {
        timeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      },
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
      await client.connect(buildSse(options), connectRequestOptions(options));
    } catch (sseErr) {
      // Same transport-release reason as the Streamable HTTP path below.
      await closeQuietly(client);
      // Wrapped like every other path. Rethrowing raw here made the error type a
      // caller sees depend on whether `protocolNegotiation` happened to be set —
      // unset, the outer retry aggregated it into an `MCPConnectionError`; set, the
      // transport error escaped. Same server, same failure, different `catch`.
      throw new MCPConnectionError('Failed to connect over SSE', {
        cause: sseErr,
      });
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
    await client.connect(http, connectRequestOptions(options));
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
    if (options.transport === 'streamableHttp' || isAuthFailure(httpErr, options.auth)) {
      // Auth failures stop here rather than falling through. The SSE attempt
      // would carry the same `authProvider` into the SDK's auth path — a second
      // `redirectToAuthorization`, a second `saveCodeVerifier` overwriting the
      // first — which is the duplicated side effect `connect()`'s retry guard
      // exists to prevent. Guarding one and not the other left the hazard inside
      // a single pass, where it is arguably worse: the caller did not even opt
      // into a second negotiation mode.
      throw new MCPConnectionError('Failed to connect over Streamable HTTP', {
        cause: httpErr,
      });
    }
    // An aborted caller gets no fallback: the same signal rides into the SSE
    // attempt, but whether it interrupts `transport.start()` promptly is the
    // SDK's business — checking here makes "abort means stop dialling"
    // deterministic instead of dependent on where the SDK polls the signal.
    if (options.signal?.aborted === true) {
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
      await sseClient.connect(buildSse(options), connectRequestOptions(options));
      return wrap({
        client: sseClient,
        transport: 'sse',
        listChanged,
      });
    } catch (sseErr) {
      await closeQuietly(sseClient);
      // Both failures are kept. `sseErr` is the `cause` because it is the last
      // thing tried, but discarding `httpErr` loses information the caller needs:
      // an `UnauthorizedError` from the HTTP attempt is what tells `connect()` not
      // to retry, and a 404/405 from an endpoint that simply isn't an SSE URL
      // would otherwise hide it. `errors` matches `AggregateError`'s shape so the
      // pair is discoverable without a bespoke field.
      throw new MCPConnectionError('Failed to connect over Streamable HTTP and SSE', {
        cause: sseErr,
        errors: [
          httpErr,
          sseErr,
        ],
      });
    }
  }
}

/**
 * Reduce one pass's failure to the list of attempts behind it.
 *
 * A pass that tried both transports is already an `MCPConnectionError` carrying
 * them in `errors`; unwrapping keeps `errors` a flat list of real attempts rather
 * than a tree of wrappers, so a caller can iterate it without recursing. A pass
 * that tried one transport contributes itself.
 */
function flattenAttempts(err: unknown): readonly unknown[] {
  if (err instanceof MCPConnectionError) {
    if (err.errors.length > 0) {
      return err.errors;
    }
    // A single-transport pass wraps its one failure with only `cause` set, so
    // returning it as-is would put an opaque wrapper in a list documented as
    // holding real attempts — and a caller scanning for a rejected token would
    // have to know to dig through `cause` on some entries but not others.
    if (err.cause !== undefined) {
      return [
        err.cause,
      ];
    }
  }
  return [
    err,
  ];
}

/**
 * Does this error carry an HTTP status that means "your credentials were the
 * problem"?
 *
 * 401 only, deliberately. The suppression this feeds exists to avoid re-driving
 * OAuth side effects, and in SDK v2 those side effects (`saveCodeVerifier`,
 * `redirectToAuthorization`) live exclusively behind the transport's
 * `status === 401 && this._authProvider` branch — a 403 never enters the OAuth
 * flow at all. Meanwhile proxies and WAFs commonly answer an unknown method
 * like `server/discover` with 403 without consulting credentials, so treating
 * 403 as a credential rejection made exactly the deployments the legacy retry
 * exists to rescue permanently unreachable, for OAuth users only. A 403 retry
 * re-drives nothing; a 401 retry re-drives the flow. Match the side effect,
 * not the status class.
 *
 * Read via a duck-typed `status` rather than `instanceof SdkHttpError` plus an
 * `SdkErrorCode` comparison: the numeric status is the stable half of that
 * contract, and it also catches a gateway surfacing 401 in some other error
 * shape.
 *
 * Only consulted when the caller configured OAuth — see {@link isAuthFailure}.
 */
function isAuthStatus(err: unknown): boolean {
  // Errors only. A plain object carrying a `status` is far more likely to be a
  // response, a log record, or some other payload that happens to travel in a
  // `cause` than an authoritative rejection — the SDK itself builds log entries
  // with `status: 0`, and treating one of those as a credential failure would
  // silently suppress the retry and make a probe-hostile server unreachable.
  if (!(err instanceof Error) || !('status' in err)) {
    return false;
  }
  const { status } = err as unknown as {
    status: unknown;
  };
  return status === 401;
}

/**
 * Did any attempt behind this failure end in the server rejecting our
 * credentials?
 *
 * Searches the whole tree rather than the `cause` spine, because a single
 * `connect()` can fail more than once: `connectWithNegotiation` wraps transport
 * errors in `MCPConnectionError`, and on the two-transport path it records both
 * attempts in `errors`. Checking only `cause` would miss an `UnauthorizedError`
 * from the Streamable HTTP attempt whenever the SSE fallback then failed for an
 * unrelated reason — a URL that isn't an SSE endpoint answering 404 never
 * reaches the auth path — and the retry would re-drive the OAuth flow anyway.
 *
 * Depth-capped: a cyclic `cause` would otherwise hang, and real chains here are
 * two or three links.
 *
 * Exported for `rehydrateMCPTools`, whose fallback-to-`freshConnect` is a third
 * reconnect layer with the same duplicated-OAuth hazard; deliberately not
 * re-exported from the package entrypoint.
 */
export function isAuthFailure(err: unknown, auth: MCPAuth | undefined, depth = 0): boolean {
  if (depth >= 8) {
    return false;
  }
  // `UnauthorizedError` is unconditional: the SDK only throws it from the
  // provider-wrapped fetch and the authorization flow itself, so it inherently
  // means an OAuth provider is in play and its flow would be re-driven.
  if (err instanceof UnauthorizedError) {
    return true;
  }
  // A bare 401 status counts only when the caller configured OAuth — the one
  // auth kind where a 401 retry has side effects (a second
  // `redirectToAuthorization`, an overwritten PKCE verifier). 403 never
  // suppresses, even under OAuth: the SDK's PKCE writes live exclusively behind
  // its 401 branch, so a 403 retry re-drives nothing — while proxies and WAFs
  // commonly answer an unknown method like `server/discover` with 403, exactly
  // the probe-hostile infrastructure the retry exists to rescue. With bearer,
  // headers, or no auth, no status suppresses.
  if (isOAuthAuth(auth) && isAuthStatus(err)) {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  // Covers our own `errors` and `AggregateError`'s alike — Node's
  // happy-eyeballs path and some fetch implementations report a 401 as an
  // `AggregateError` member rather than as a `cause`, which a spine-only walk
  // would miss.
  const { errors } = err as {
    errors?: unknown;
  };
  if (Array.isArray(errors)) {
    for (const nested of errors) {
      if (isAuthFailure(nested, auth, depth + 1)) {
        return true;
      }
    }
  }
  return err.cause !== undefined && isAuthFailure(err.cause, auth, depth + 1);
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
 * 2. **It re-walks the same transport ladder the first pass did.** An earlier
 *    revision pinned Streamable HTTP to cap the attempt count, which broke the
 *    case this whole mechanism exists for: a legacy server reachable *only* over
 *    SSE, behind infrastructure that chokes on the probe, would fail under
 *    `'auto'` and then never be offered SSE again. Correctness wins over the
 *    attempt count here — a server that used to connect must still connect.
 *
 * So the worst case for a genuinely unreachable server is four `connect()`
 * calls, two per negotiation mode. That is the honest cost of guaranteeing no
 * working setup regresses, and it is paid only on a path that was already going
 * to fail. The bound that matters is that it is a fixed multiple rather than a
 * retry loop.
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
    // A caller-initiated abort is not a server problem: retrying under
    // `'legacy'` would immediately re-abort (or worse, outlive the caller's
    // deadline). Surface the abort as-is.
    if (options.signal?.aborted === true) {
      throw autoErr;
    }
    if (isAuthFailure(autoErr, options.auth)) {
      throw autoErr;
    }
    // Not inspecting the error for *whether* the probe was at fault: that would
    // couple us to SDK error codes, and a reshaped error would silently disable
    // the whole degradation. `UnauthorizedError` above is the one exception,
    // because there the cost of retrying is a duplicated side effect rather than
    // a wasted dial — and if that check ever stops matching we merely retry,
    // which is the pre-existing behavior rather than a silent loss of function.
    try {
      return await connectWithNegotiation({
        ...options,
        protocolNegotiation: 'legacy',
      });
    } catch (legacyErr) {
      // Carry both passes. Letting `legacyErr` propagate untouched would drop
      // everything the `'auto'` pass learned — up to half the attempts, and any
      // auth-shaped rejection that `isAuthFailure` did not match — which would
      // also make `MCPConnectionError.errors` a lie about being every failure in
      // attempt order.
      throw new MCPConnectionError('Failed to connect over any transport or protocol revision', {
        cause: legacyErr,
        errors: [
          ...flattenAttempts(autoErr),
          ...flattenAttempts(legacyErr),
        ],
      });
    }
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
