// SSEClientTransport is deprecated upstream (SEP-2596) but intentionally
// supported here for legacy MCP servers that haven't migrated to Streamable HTTP.
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { resolveAuth } from './auth/auth-resolver.js';
import type { MCPAuth } from './auth/auth-types.js';
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
 * Connect a `Client` to the MCP server. Defaults to Streamable HTTP and falls
 * back to SSE on connection failure (legacy servers), unless a transport is
 * pinned explicitly. Auth, the elicitation handler, and the list_changed
 * subscription are wired into the single connected client so they apply to
 * discovery and every tool call.
 */
export async function connect(options: ConnectOptions): Promise<MCPConnection> {
  const preferred = options.transport ?? 'streamableHttp';
  const listChanged: MutableListChanged = {
    handler: undefined,
  };

  if (preferred === 'sse') {
    const client = makeClient(options, listChanged);
    await client.connect(buildSse(options));
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
    if (options.transport === 'streamableHttp') {
      throw new MCPConnectionError('Failed to connect over Streamable HTTP', {
        cause: httpErr,
      });
    }
    // Fall back to SSE on a fresh client (the failed one may be half-initialized).
    // Note this also catches version-probe failures under `'auto'`: on HTTP a
    // probe timeout is an outage, so the SSE attempt below will usually fail too
    // and surface the combined error. Callers on flaky servers can skip the
    // probe entirely with `protocolNegotiation: 'legacy'`.
    const sseClient = makeClient(options, listChanged);
    try {
      await sseClient.connect(buildSse(options));
      return wrap({
        client: sseClient,
        transport: 'sse',
        listChanged,
      });
    } catch (sseErr) {
      throw new MCPConnectionError('Failed to connect over Streamable HTTP and SSE', {
        cause: sseErr,
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
