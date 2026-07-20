import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// SSEClientTransport is deprecated upstream but intentionally supported here for
// legacy MCP servers that haven't migrated to Streamable HTTP.
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ElicitRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolveAuth } from './auth/auth-resolver.js';
import type { MCPAuth } from './auth/auth-types.js';
import { makeElicitationRequestHandler } from './elicitation.js';
import { MCPConnectionError } from './errors.js';
import type { ElicitationHandler, MCPTransportKind } from './types.js';

const DEFAULT_CLIENT_INFO = {
  name: '@openrouter/mcp',
  version: '0.1.0',
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
  sessionId?: string;
  onElicitation?: ElicitationHandler;
}

export interface MCPConnection {
  client: Client;
  transport: MCPTransportKind;
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

/**
 * Runtime narrowing to `Transport`. The SDK's transport classes implement the
 * interface, but their `.d.ts` types `sessionId` as `string | undefined` rather
 * than `sessionId?: string`, which `exactOptionalPropertyTypes` rejects at the
 * `connect()` call site. We confirm the structural contract at runtime instead
 * of asserting past the variance with `as`.
 */
function isTransport(value: { start: unknown; send: unknown; close: unknown }): value is Transport {
  return (
    typeof value.start === 'function' &&
    typeof value.send === 'function' &&
    typeof value.close === 'function'
  );
}

interface MutableListChanged {
  handler: (() => void) | undefined;
}

function makeClient(options: ConnectOptions, listChanged: MutableListChanged): Client {
  const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO, {
    capabilities: {
      elicitation: {},
    },
  });

  client.setRequestHandler(
    ElicitRequestSchema,
    makeElicitationRequestHandler(options.onElicitation),
  );

  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged.handler?.();
  });

  return client;
}

async function connectWith(
  client: Client,
  transport: StreamableHTTPClientTransport | SSEClientTransport,
): Promise<void> {
  if (!isTransport(transport)) {
    throw new MCPConnectionError('MCP transport does not implement the Transport contract');
  }
  await client.connect(transport);
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
    await connectWith(client, buildSse(options));
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
    await connectWith(client, http);
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
    const sseClient = makeClient(options, listChanged);
    try {
      await connectWith(sseClient, buildSse(options));
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
