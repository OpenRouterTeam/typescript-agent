import { SUBSCRIPTION_ID_META_KEY } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '../../../src/lib/tool-types.js';
import { isClientTool } from '../../../src/lib/tool-types.js';
import type { MCPOAuthClientProvider } from '../../../src/mcp/auth/auth-types.js';
import { createMCPTools } from '../../../src/mcp/create-mcp-tools.js';
import { rehydrateMCPTools } from '../../../src/mcp/rehydrate.js';

// `tools/list_changed` delivery, end to end over the real Streamable HTTP
// transport and the real SDK client — nothing in `src/mcp` is mocked.
//
// The distinction these tests exist for: registering a notification handler
// makes a client able to *dispatch* the notification, not able to *receive*
// it. A 2026-07-28 server has no session and no standalone GET stream, so it
// can only deliver on a `subscriptions/listen` stream the client opened. Tests
// over `InMemoryTransport` cannot see that, because a fake there can push
// unsolicited. The fake below answers `fetch` like an HTTP server, so a
// notification reaches the client only if the client asked for a stream.

const URL_ = 'https://mcp.example.com/mcp';

/** Passed on warm calls: a snapshot without credentials is never replayed. */
const AUTH = {
  kind: 'bearer',
  token: 't',
} as const;

/** One server-to-client SSE stream the fake is holding open. */
interface PushStream {
  /** JSON-RPC id of the `subscriptions/listen` request; undefined for a GET. */
  id: string | undefined;
  push(message: Record<string, unknown>): void;
  /** End the stream the way a proxy idle timeout or a redeploy does. */
  end(): void;
  /** Whether the client tore the stream down. */
  aborted(): boolean;
}

interface ServerBehavior {
  era: 'modern' | 'legacy';
  /** Advertise `tools.listChanged`. Default true. */
  advertise?: boolean;
  /**
   * How `subscriptions/listen` is answered: acknowledged (default), refused
   * with a JSON-RPC error, accepted and then never acknowledged, or left
   * hanging with no response at all (`hang`).
   */
  listen?: 'ack' | 'refuse' | 'silent' | 'hang';
}

/**
 * How long a hung request takes to reject after its caller gives up — a
 * `fetch` wrapper that backs off before rethrowing. The gap matters: it is
 * what leaves a rejection unobserved for a while.
 */
const LATE_REJECT_MS = 50;

interface FakeServer {
  fetch: typeof fetch;
  /** Every request, in order: `POST <method>` or the bare HTTP method. */
  seen: string[];
  /** `subscriptions/listen` streams, in the order they were opened. */
  listens: PushStream[];
  /** Standalone GET streams (2025-era only). */
  gets: PushStream[];
  /** Tool names `tools/list` currently answers with. */
  toolNames: string[];
  /** Answer every MCP request with 401, as for a revoked or expired token. */
  unauthorized: boolean;
  /** Change how later `subscriptions/listen` requests are answered. */
  setListen(mode: NonNullable<ServerBehavior['listen']>): void;
  count(entry: string): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function openStream(
  id: string | undefined,
  signal: AbortSignal | null | undefined,
): {
  stream: PushStream;
  response: Response;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let aborted = false;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  // A real fetch errors the body when its signal aborts; mirror that so the
  // transport sees the same thing it would against a live server.
  signal?.addEventListener('abort', () => {
    aborted = true;
    try {
      controller?.error(new DOMException('The operation was aborted.', 'AbortError'));
    } catch {
      // Already closed by `end()`.
    }
  });
  return {
    stream: {
      id,
      push: (message) => {
        controller?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
      },
      end: () => {
        controller?.close();
      },
      aborted: () => aborted,
    },
    response: new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
    }),
  };
}

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}

/** A minimal MCP server behind `fetch`, speaking either protocol revision. */
function fakeServer(behavior: ServerBehavior): FakeServer {
  let listenMode = behavior.listen ?? 'ack';
  const capabilities = {
    tools:
      (behavior.advertise ?? true)
        ? {
            listChanged: true,
          }
        : {},
  };
  const server: FakeServer = {
    seen: [],
    listens: [],
    gets: [],
    toolNames: [
      'a',
    ],
    unauthorized: false,
    setListen: (mode) => {
      listenMode = mode;
    },
    count: (entry) => server.seen.filter((s) => s === entry).length,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const httpMethod = init?.method ?? 'GET';
      const url = input instanceof Request ? input.url : String(input);
      // OAuth discovery, reached only once a request has been answered 401: no
      // protected-resource metadata, an authorization server that supports
      // PKCE, and a token endpoint that grants nothing.
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return Promise.resolve(
          new Response(null, {
            status: 404,
          }),
        );
      }
      if (url.includes('/.well-known/')) {
        return Promise.resolve(
          jsonResponse({
            issuer: 'https://mcp.example.com',
            authorization_endpoint: 'https://mcp.example.com/authorize',
            token_endpoint: 'https://mcp.example.com/token',
            response_types_supported: [
              'code',
            ],
            code_challenge_methods_supported: [
              'S256',
            ],
          }),
        );
      }
      if (url.endsWith('/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: 'invalid_grant',
            }),
            {
              status: 400,
              headers: {
                'content-type': 'application/json',
              },
            },
          ),
        );
      }
      if (httpMethod !== 'POST') {
        server.seen.push(httpMethod);
        // The standalone stream a 2025-era client opens after `initialized`.
        if (httpMethod === 'GET' && behavior.era === 'legacy') {
          const { stream, response } = openStream(undefined, init?.signal);
          server.gets.push(stream);
          return Promise.resolve(response);
        }
        return Promise.resolve(
          new Response(null, {
            status: 405,
          }),
        );
      }

      // A real `fetch` rejects at once when its signal has already aborted,
      // and the request never reaches the server.
      if (init?.signal?.aborted === true) {
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
      }
      const message: unknown = JSON.parse(String(init?.body));
      if (!isRecord(message) || typeof message['method'] !== 'string') {
        throw new Error('fake server: unexpected request body');
      }
      const method = message['method'];
      const id = message['id'];
      server.seen.push(`POST ${method}`);
      if (server.unauthorized) {
        return Promise.resolve(
          new Response('unauthorized', {
            status: 401,
            headers: {
              'www-authenticate': 'Bearer error="invalid_token"',
            },
          }),
        );
      }
      // Notifications carry no id and expect no reply.
      if (id === undefined) {
        return Promise.resolve(
          new Response(null, {
            status: 202,
          }),
        );
      }
      const reply = (result: Record<string, unknown>): Promise<Response> =>
        Promise.resolve(
          jsonResponse({
            jsonrpc: '2.0',
            id,
            result,
          }),
        );
      const methodNotFound = (): Promise<Response> =>
        Promise.resolve(
          jsonResponse({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: 'Method not found',
            },
          }),
        );

      if (method === 'server/discover') {
        if (behavior.era === 'legacy') {
          return methodNotFound();
        }
        return reply({
          resultType: 'complete',
          supportedVersions: [
            '2026-07-28',
          ],
          capabilities,
          _meta: {
            'io.modelcontextprotocol/serverInfo': {
              name: 'fake-modern',
              version: '9.9.9',
            },
          },
        });
      }

      if (method === 'initialize') {
        return reply({
          protocolVersion: '2025-11-25',
          serverInfo: {
            name: 'fake-legacy',
            version: '1.2.3',
          },
          capabilities,
        });
      }

      if (method === 'tools/list') {
        return reply({
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'public',
          tools: server.toolNames.map((name) => ({
            name,
            inputSchema: {
              type: 'object',
              properties: {},
            },
          })),
        });
      }

      if (method === 'subscriptions/listen') {
        if (listenMode === 'refuse' || typeof id !== 'string') {
          return methodNotFound();
        }
        if (listenMode === 'hang') {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              setTimeout(() => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
              }, LATE_REJECT_MS);
            });
          });
        }
        const { stream, response } = openStream(id, init?.signal);
        server.listens.push(stream);
        if (listenMode === 'ack') {
          const params = message['params'];
          stream.push({
            jsonrpc: '2.0',
            method: 'notifications/subscriptions/acknowledged',
            params: {
              _meta: {
                [SUBSCRIPTION_ID_META_KEY]: id,
              },
              notifications: isRecord(params) ? params['notifications'] : {},
            },
          });
        }
        return Promise.resolve(response);
      }

      return reply({
        resultType: 'complete',
      });
    },
  };
  return server;
}

function announceToolsChanged(stream: PushStream | undefined): void {
  if (stream === undefined) {
    throw new Error('expected an open stream to announce on');
  }
  stream.push({
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
    ...(stream.id !== undefined && {
      params: {
        _meta: {
          [SUBSCRIPTION_ID_META_KEY]: stream.id,
        },
      },
    }),
  });
}

function names(tools: readonly Tool[]): (string | undefined)[] {
  return tools.map((t) => (isClientTool(t) ? t.function.name : undefined));
}

/** Resolve once the client has opened `count` listen streams. */
async function listening(server: FakeServer, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(server.listens).toHaveLength(count);
  });
}

interface OAuthProbe {
  provider: MCPOAuthClientProvider;
  /** Every `redirectToAuthorization` call. */
  redirects: URL[];
  /** Every `saveCodeVerifier` call. */
  verifiers: string[];
}

/**
 * An OAuth provider holding a valid access token and no refresh token, so a
 * 401 leaves the SDK nothing to do but start a new authorization.
 * `tokensDelayMs` makes `tokens()` asynchronous, as a keychain or database
 * read is.
 */
function oauthProvider(tokensDelayMs?: number): OAuthProbe {
  const redirects: URL[] = [];
  const verifiers: string[] = [];
  return {
    redirects,
    verifiers,
    provider: {
      get redirectUrl() {
        return 'http://localhost:9999/callback';
      },
      get clientMetadata() {
        return {
          redirect_uris: [
            'http://localhost:9999/callback',
          ],
        };
      },
      clientInformation: () => ({
        client_id: 'test-client',
      }),
      tokens: async () => {
        if (tokensDelayMs !== undefined) {
          await sleep(tokensDelayMs);
        }
        return {
          access_token: 'tok',
          token_type: 'bearer',
        };
      },
      saveTokens: () => {},
      redirectToAuthorization: (authorizationUrl) => {
        redirects.push(authorizationUrl);
      },
      saveCodeVerifier: (codeVerifier) => {
        verifiers.push(codeVerifier);
      },
      codeVerifier: () => verifiers.at(-1) ?? '',
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Run `scenario` and return every `unhandledRejection` the process raised
 * meanwhile. Node raises one when a rejected promise still has no handler once
 * the microtask queue drains, and by default exits on it.
 */
async function unhandledRejectionsDuring(scenario: () => Promise<void>): Promise<unknown[]> {
  const raised: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    raised.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    await scenario();
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  return raised;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('tools/list_changed on a 2026-07-28 server over HTTP', () => {
  it('re-lists and notifies when the server announces a change', async () => {
    const server = fakeServer({
      era: 'modern',
    });
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
    });
    const changed = vi.fn();
    handle.onToolsChanged(changed);
    await listening(server, 1);
    expect(names(handle.tools)).toEqual([
      'a',
    ]);

    server.toolNames = [
      'a',
      'b',
    ];
    announceToolsChanged(server.listens[0]);

    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
    });
    expect(names(handle.tools)).toEqual([
      'a',
      'b',
    ]);
    expect(changed).toHaveBeenCalledWith(handle.tools);
    // The discovery read plus exactly one refresh: the subscription must not
    // bring a second, SDK-driven re-list along with it.
    expect(server.count('POST tools/list')).toBe(2);
    await handle.close();
  });

  it('subscribes on the snapshot-replay path too', async () => {
    const server = fakeServer({
      era: 'modern',
    });
    const cold = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
      auth: AUTH,
    });
    const snapshot = await cold.serialize();
    await cold.close();

    const warm = await rehydrateMCPTools({
      snapshot,
      auth: AUTH,
      fetch: server.fetch,
    });
    const changed = vi.fn();
    warm.onToolsChanged(changed);
    await listening(server, 2);
    // A replay: the tool set came from the snapshot, not a second read.
    expect(server.count('POST tools/list')).toBe(1);

    server.toolNames = [
      'b',
    ];
    announceToolsChanged(server.listens[1]);

    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
    });
    expect(names(warm.tools)).toEqual([
      'b',
    ]);
    await warm.close();
  });

  it('opens no subscription when autoRefreshOnListChanged is false', async () => {
    const server = fakeServer({
      era: 'modern',
    });
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
      autoRefreshOnListChanged: false,
    });
    await handle.refresh();

    expect(server.seen).toEqual([
      'POST server/discover',
      'POST tools/list',
      'POST tools/list',
    ]);
    await handle.close();
  });

  it('opens no subscription when the server does not advertise tools.listChanged', async () => {
    const server = fakeServer({
      era: 'modern',
      advertise: false,
    });
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
    });
    await handle.refresh();

    expect(server.count('POST subscriptions/listen')).toBe(0);
    await handle.close();
  });

  it('still returns a working handle when the server refuses the subscription', async () => {
    vi.useFakeTimers();
    const server = fakeServer({
      era: 'modern',
      listen: 'refuse',
    });
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
    });
    await vi.waitFor(() => {
      expect(server.count('POST subscriptions/listen')).toBe(1);
    });

    expect(names(handle.tools)).toEqual([
      'a',
    ]);
    server.toolNames = [
      'a',
      'b',
    ];
    expect(names(await handle.refresh())).toEqual([
      'a',
      'b',
    ]);
    // A server that never acknowledged a subscription is not asked again.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(server.count('POST subscriptions/listen')).toBe(1);
    await handle.close();
  });

  it('does not wait for a server that never acknowledges the subscription', async () => {
    const server = fakeServer({
      era: 'modern',
      listen: 'silent',
    });
    // Resolving at all is the assertion: the acknowledgement never comes, and
    // the SDK waits a full request timeout for one. Blocking on it would hang
    // this call for a minute.
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
    });
    await listening(server, 1);

    expect(names(handle.tools)).toEqual([
      'a',
    ]);
    await handle.close();
    expect(server.listens[0]?.aborted()).toBe(true);
  });

  it('tears the stream down on close and does not re-open it', async () => {
    vi.useFakeTimers();
    const server = fakeServer({
      era: 'modern',
    });
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
    });
    await listening(server, 1);
    expect(server.listens[0]?.aborted()).toBe(false);

    await handle.close();

    expect(server.listens[0]?.aborted()).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(server.count('POST subscriptions/listen')).toBe(1);
  });

  it('ends the subscription when the caller aborts the signal', async () => {
    vi.useFakeTimers();
    const server = fakeServer({
      era: 'modern',
    });
    const controller = new AbortController();
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
      signal: controller.signal,
    });
    const changed = vi.fn();
    handle.onToolsChanged(changed);
    await listening(server, 1);
    // A delivered notification proves the subscription is established, so the
    // abort below ends a live stream rather than one still being opened.
    announceToolsChanged(server.listens[0]);
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
    });

    controller.abort();

    await vi.waitFor(() => {
      expect(server.listens[0]?.aborted()).toBe(true);
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(server.count('POST subscriptions/listen')).toBe(1);
    await handle.close();
  });
});

// The SDK does not re-listen when a stream ends. Without this, auto-refresh
// would work until the first proxy idle timeout and then be silently dead.
describe('re-listening after the stream ends', () => {
  it('re-opens the stream and re-lists to cover what it missed', async () => {
    vi.useFakeTimers();
    const server = fakeServer({
      era: 'modern',
    });
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
    });
    const changed = vi.fn();
    handle.onToolsChanged(changed);
    await listening(server, 1);

    // The tool set changes while no stream is open, so no notification can
    // announce it.
    server.listens[0]?.end();
    server.toolNames = [
      'a',
      'b',
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    await listening(server, 2);

    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
    });
    expect(names(handle.tools)).toEqual([
      'a',
      'b',
    ]);

    // And the new stream delivers like the first one did.
    server.toolNames = [
      'c',
    ];
    announceToolsChanged(server.listens[1]);
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(2);
    });
    expect(names(handle.tools)).toEqual([
      'c',
    ]);
    await handle.close();
  });

  it('backs off while the server keeps refusing, then recovers', async () => {
    vi.useFakeTimers();
    const server = fakeServer({
      era: 'modern',
    });
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
    });
    await listening(server, 1);
    const listenRequests = (): number => server.count('POST subscriptions/listen');

    server.setListen('refuse');
    server.listens[0]?.end();

    // 1s, then 2s, then 4s between attempts.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listenRequests()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(listenRequests()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(listenRequests()).toBe(3);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(listenRequests()).toBe(3);

    server.setListen('ack');
    await vi.advanceTimersByTimeAsync(1);
    expect(listenRequests()).toBe(4);
    await listening(server, 2);
    await handle.close();
  });

  it('starts the backoff over once a stream has stayed up', async () => {
    vi.useFakeTimers();
    const server = fakeServer({
      era: 'modern',
    });
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
    });
    const changed = vi.fn();
    handle.onToolsChanged(changed);
    await listening(server, 1);

    server.listens[0]?.end();
    await vi.advanceTimersByTimeAsync(1_000);
    // The re-list that follows a re-established stream marks it as open.
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
    });

    // The second stream outlives the longest backoff, so its loss is a fresh
    // incident: the next attempt comes after 1s again, not 2s.
    await vi.advanceTimersByTimeAsync(60_000);
    server.listens[1]?.end();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(server.count('POST subscriptions/listen')).toBe(3);
    await handle.close();
  });

  it('stops for good when the server rejects the credentials on a re-open', async () => {
    vi.useFakeTimers();
    const server = fakeServer({
      era: 'modern',
    });
    const oauth = oauthProvider();
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
      auth: {
        kind: 'oauth',
        provider: oauth.provider,
      },
    });
    await listening(server, 1);
    expect(oauth.redirects).toHaveLength(0);

    // The token is revoked and the stream drops with it.
    server.unauthorized = true;
    server.listens[0]?.end();

    // The first re-open is answered 401, and the SDK runs its authorization
    // flow inside that request: one redirect that cannot be prevented.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(oauth.redirects).toHaveLength(1);
    });

    // Eleven more minutes of what would have been backoff periods. Each further
    // attempt would save another PKCE verifier and redirect again.
    for (const step of [
      2_000,
      4_000,
      8_000,
      16_000,
      32_000,
      60_000,
      60_000,
      60_000,
      60_000,
      60_000,
      300_000,
    ]) {
      await vi.advanceTimersByTimeAsync(step);
    }

    expect(server.count('POST subscriptions/listen')).toBe(2);
    expect(oauth.redirects).toHaveLength(1);
    expect(oauth.verifiers).toHaveLength(1);
    await handle.close();
  });

  it('stops re-listening once the handle is closed', async () => {
    vi.useFakeTimers();
    const server = fakeServer({
      era: 'modern',
    });
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
    });
    await listening(server, 1);

    // Closed during the backoff window, with a re-listen already scheduled.
    server.listens[0]?.end();
    await vi.advanceTimersByTimeAsync(500);
    await handle.close();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(server.count('POST subscriptions/listen')).toBe(1);
  });
});

// The subscription is opened in the background, so a caller can close or abort
// while the request for it is still in flight. Before SDK 2.2.0 `listen()`
// awaited its send before anything observed the promise it rejects on, so
// these raised an unhandled rejection — which, by default, exits Node. This is
// why the peer floor is `^2.2.0`; nothing in this package can catch it.
describe('ending the handle while the subscription is still opening', () => {
  // An asynchronous `tokens()` is what holds the send open: the transport
  // awaits it for the Authorization header before it issues the request.
  const TOKENS_DELAY_MS = 5;

  it('raises no unhandled rejection when closed straight after connecting', async () => {
    const server = fakeServer({
      era: 'modern',
    });
    let issuedBeforeClose: number | undefined;

    const raised = await unhandledRejectionsDuring(async () => {
      const handle = await createMCPTools({
        url: URL_,
        fetch: server.fetch,
        auth: {
          kind: 'oauth',
          provider: oauthProvider(TOKENS_DELAY_MS).provider,
        },
      });
      issuedBeforeClose = server.count('POST subscriptions/listen');
      await handle.close();
      await sleep(10 * TOKENS_DELAY_MS);
    });

    expect(raised).toEqual([]);
    // The premise: the close landed while the request was still being prepared.
    expect(issuedBeforeClose).toBe(0);
    expect(server.count('POST subscriptions/listen')).toBe(0);
  });

  it('raises no unhandled rejection when the signal aborts straight after connecting', async () => {
    const server = fakeServer({
      era: 'modern',
    });
    const controller = new AbortController();
    let issuedBeforeAbort: number | undefined;

    const raised = await unhandledRejectionsDuring(async () => {
      const handle = await createMCPTools({
        url: URL_,
        fetch: server.fetch,
        signal: controller.signal,
        auth: {
          kind: 'oauth',
          provider: oauthProvider(TOKENS_DELAY_MS).provider,
        },
      });
      issuedBeforeAbort = server.count('POST subscriptions/listen');
      controller.abort();
      await sleep(10 * TOKENS_DELAY_MS);
      await handle.close();
    });

    expect(raised).toEqual([]);
    expect(issuedBeforeAbort).toBe(0);
  });

  it('raises no unhandled rejection when the acknowledgement times out on a hung request', async () => {
    vi.useFakeTimers();
    const server = fakeServer({
      era: 'modern',
      listen: 'hang',
    });

    const raised = await unhandledRejectionsDuring(async () => {
      const handle = await createMCPTools({
        url: URL_,
        fetch: server.fetch,
      });
      await vi.waitFor(() => {
        expect(server.count('POST subscriptions/listen')).toBe(1);
      });
      // The SDK gives up on the acknowledgement after its request timeout and
      // aborts the request, which only rejects some time later.
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(2 * LATE_REJECT_MS);
      await handle.close();
    });

    expect(raised).toEqual([]);
  });
});

describe('tools/list_changed on a 2025-era server over HTTP', () => {
  it('never sends subscriptions/listen', async () => {
    const server = fakeServer({
      era: 'legacy',
    });
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
    });
    await vi.waitFor(() => {
      expect(server.gets).toHaveLength(1);
    });

    expect(server.count('POST initialize')).toBe(1);
    expect(server.count('POST subscriptions/listen')).toBe(0);
    await handle.close();
  });

  it('still refreshes on an unsolicited notification, advertised or not', async () => {
    // The capability is not advertised here on purpose: 2025-era servers that
    // notify without declaring `tools.listChanged` have always been served.
    const server = fakeServer({
      era: 'legacy',
      advertise: false,
    });
    const handle = await createMCPTools({
      url: URL_,
      fetch: server.fetch,
    });
    const changed = vi.fn();
    handle.onToolsChanged(changed);
    await vi.waitFor(() => {
      expect(server.gets).toHaveLength(1);
    });

    server.toolNames = [
      'a',
      'b',
    ];
    announceToolsChanged(server.gets[0]);

    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
    });
    expect(names(handle.tools)).toEqual([
      'a',
      'b',
    ]);
    await handle.close();
  });
});
