import { resolveAuth } from './auth/auth-resolver.js';
import type { MCPAuth } from './auth/auth-types.js';
import { isOAuthAuth } from './auth/auth-types.js';
import type { MCPCacheStore } from './cache/cache-store.js';
import { defaultCacheKey } from './cache/cache-store.js';
import type { SerializedMCPServer } from './cache/cache-types.js';
import { isSerializedMCPServer } from './cache/cache-types.js';
import { closeQuietly } from './close-quietly.js';
import { MCPCacheError, MCPCacheWriteError, MCPStaleSnapshotError } from './errors.js';
import { freshConnect, makeHandle } from './handle.js';
import type { ConnectOptions, MCPConnection } from './mcp-connection.js';
import { connect, isAuthFailure } from './mcp-connection.js';
import { loadMcpSdk } from './mcp-sdk.js';
import type { UnconvertibleSchemaMode } from './schema/json-schema-to-zod.js';
import type { McpToolDef } from './tool-wrapper.js';
import type {
  CreateMCPToolsOptions,
  ElicitationHandler,
  MCPProtocolNegotiation,
  MCPToolsHandle,
  ResourcesOption,
} from './types.js';

/** Clock skew (ms) treated as "already expired" when checking cached tokens. */
const EXPIRY_SKEW_MS = 30_000;

export interface RehydrateMCPToolsOptions {
  snapshot: SerializedMCPServer;
  /** Required when the snapshot carries no cached credentials. */
  auth?: MCPAuth;
  fetch?: typeof fetch;
  onUnconvertibleSchema?: UnconvertibleSchemaMode;
  onElicitation?: ElicitationHandler;
  signal?: AbortSignal;
  /** Protocol-revision negotiation policy; defaults to `'auto'`. */
  protocolNegotiation?: MCPProtocolNegotiation;
  /** Ceiling on the `server/discover` probe, in ms; defaults to 30000. */
  probeTimeoutMs?: number;
  /** Re-list tools instead of replaying a snapshot older than this. */
  staleness?: {
    maxAgeMs?: number;
  };
  /**
   * Cache to refresh on reconnect/fallback.
   *
   * A successful replay does **not** write here — the snapshot it would write is
   * the one you passed in, so the write is skipped as a no-op. The store is
   * written when something genuinely new exists: a `refresh()`, a
   * `tools/list_changed` auto-refresh, or the fresh-connect fallback. To seed a
   * store from a snapshot obtained elsewhere, write it yourself
   * (`store.set(key, snapshot)`) or call `handle.refresh()` after rehydrating.
   */
  cache?: {
    store: MCPCacheStore;
    key?: string;
  };
  /**
   * On expired cached tokens, missing credentials, an over-age snapshot
   * (`staleness.maxAgeMs`), or a replay connection failure, transparently fall
   * back to a full fresh connect. Default true.
   *
   * The fallback is skipped when the replay's connect ended in a credential
   * rejection (the SDK's `UnauthorizedError`, or a 401 status when an OAuth
   * provider is configured): the fallback reuses the same auth, so retrying
   * cannot succeed and would re-drive an OAuth authorization flow. Those
   * failures reject with `MCPCacheError` instead. A 403 does not skip it — the
   * SDK's OAuth side effects only occur on 401, and gateways commonly answer
   * unknown methods with 403.
   */
  reconnectOnExpiry?: boolean;
  // Tool-shaping + caching options threaded through from `createMCPTools` so a
  // cache hit applies the same filters/prefix as the original cold call.
  toolNamePrefix?: string;
  includeTools?: readonly string[];
  excludeTools?: readonly string[];
  resources?: ResourcesOption;
  emitProgress?: boolean;
  /** Doom-loop identities for wrapped tools, keyed by unprefixed MCP name. */
  loopKeys?: CreateMCPToolsOptions['loopKeys'];
  autoRefreshOnListChanged?: boolean;
  cacheCredentials?: boolean;
  clientInfo?: {
    name: string;
    version: string;
  };
}

function snapshotToToolDefs(snapshot: SerializedMCPServer): McpToolDef[] {
  return snapshot.tools.map((t) => ({
    name: t.name,
    ...(t.description !== undefined && {
      description: t.description,
    }),
    inputSchema: {
      ...t.inputSchema,
    },
    ...(t.outputSchema !== undefined && {
      outputSchema: {
        ...t.outputSchema,
      },
    }),
    ...(t.loopKey !== undefined && {
      loopKey: t.loopKey,
    }),
  }));
}

/** A snapshot older than `maxAgeMs` should be re-listed rather than replayed. */
function snapshotIsStale(snapshot: SerializedMCPServer, maxAgeMs: number | undefined): boolean {
  if (maxAgeMs === undefined) {
    return false;
  }
  return Date.now() - snapshot.cachedAt > maxAgeMs;
}

/** Cached tokens are unusable if they have a known expiry within the skew window. */
function tokensExpired(snapshot: SerializedMCPServer): boolean {
  const expiresAt = snapshot.auth?.tokens?.expiresAt;
  if (expiresAt === undefined) {
    return false;
  }
  return expiresAt - Date.now() <= EXPIRY_SKEW_MS;
}

/**
 * Reconstruct an {@link MCPAuth} from credentials persisted in a snapshot (only
 * present when it was serialized with `cacheCredentials: true`). Prefer static
 * headers when present; otherwise fall back to the OAuth/bearer access token.
 * Returns undefined when the snapshot carries no usable credentials.
 */
function authFromSnapshot(snapshot: SerializedMCPServer): MCPAuth | undefined {
  const auth = snapshot.auth;
  if (auth === undefined) {
    return undefined;
  }
  if (auth.headers !== undefined && Object.keys(auth.headers).length > 0) {
    return {
      kind: 'headers',
      headers: auth.headers,
    };
  }
  if (auth.tokens?.accessToken !== undefined) {
    return {
      kind: 'bearer',
      token: auth.tokens.accessToken,
    };
  }
  return undefined;
}

/**
 * Options copied straight from a rehydrate call onto the `createMCPTools`
 * options used for the fresh-connect fallback. `satisfies` keeps this honest:
 * a key that isn't on both types fails to compile rather than silently
 * dropping.
 *
 * `staleness` is deliberately absent — it compares a snapshot's age, and the
 * fallback path has no snapshot to compare.
 */
const PASS_THROUGH_CREATE_KEYS = [
  'fetch',
  'onUnconvertibleSchema',
  'onElicitation',
  'protocolNegotiation',
  'probeTimeoutMs',
  'signal',
  'clientInfo',
  'toolNamePrefix',
  'includeTools',
  'excludeTools',
  'resources',
  'emitProgress',
  'loopKeys',
  'autoRefreshOnListChanged',
  'cacheCredentials',
  'cache',
] as const satisfies readonly (keyof RehydrateMCPToolsOptions & keyof CreateMCPToolsOptions)[];

function toCreateOptions(
  options: RehydrateMCPToolsOptions,
  snapshot: SerializedMCPServer,
  effectiveAuth: MCPAuth | undefined,
): CreateMCPToolsOptions {
  const out: CreateMCPToolsOptions = {
    url: snapshot.url,
    transport: snapshot.transport,
    ...(effectiveAuth !== undefined && {
      auth: effectiveAuth,
    }),
  };
  // Copy every defined pass-through key in one pass. Written as a loop rather
  // than a spread per key so adding an option doesn't push this function's
  // cyclomatic complexity past the structural gate's ceiling; it also mirrors
  // `forwardedRehydrateOptions` in create-mcp-tools.ts, which forwards the same
  // set in the opposite direction.
  for (const key of PASS_THROUGH_CREATE_KEYS) {
    const value = options[key];
    if (value !== undefined) {
      Object.assign(out, {
        [key]: value,
      });
    }
  }
  return out;
}

/**
 * Connect options for the snapshot-replay path.
 *
 * Distinct from {@link toCreateOptions}, which builds the *fallback*
 * `createMCPTools` options: this one carries the snapshot's own `transport` and
 * `sessionId` because the point is to re-establish the connection the snapshot
 * describes, and it deliberately omits the tool-shaping keys, which are applied
 * by `makeHandle` rather than at connect time.
 */
function toReplayConnectOptions(args: {
  options: RehydrateMCPToolsOptions;
  snapshot: SerializedMCPServer;
  url: URL;
  effectiveAuth: MCPAuth | undefined;
}): ConnectOptions {
  const { options, snapshot, url, effectiveAuth } = args;
  return {
    url,
    transport: snapshot.transport,
    ...(effectiveAuth !== undefined && {
      auth: effectiveAuth,
    }),
    ...(options.fetch !== undefined && {
      fetch: options.fetch,
    }),
    ...(options.clientInfo !== undefined && {
      clientInfo: options.clientInfo,
    }),
    // `sessionId` is deliberately NOT forwarded. When a transport reports one,
    // SDK v2 skips negotiation entirely — no `server/discover` probe and no
    // `initialize` — and returns with `getProtocolEra()`,
    // `getServerCapabilities()` and `getServerVersion()` all left undefined. It
    // does not error, which is what makes it dangerous: `serverHasResources()`
    // reads those capabilities, so a snapshot carrying a `sessionId` would
    // silently replay with resource tools missing and no server info. Sessions
    // are also removed outright in 2026-07-28 (SEP-2567), so a fresh handshake
    // is both correct and cheap — one round trip on a path that already opens a
    // connection.
    ...(options.onElicitation !== undefined && {
      onElicitation: options.onElicitation,
    }),
    ...(options.protocolNegotiation !== undefined && {
      protocolNegotiation: options.protocolNegotiation,
    }),
    ...(options.probeTimeoutMs !== undefined && {
      probeTimeoutMs: options.probeTimeoutMs,
    }),
    ...(options.signal !== undefined && {
      signal: options.signal,
    }),
  };
}

/**
 * Re-list tools on a handle built from a snapshot older than the caller's
 * `staleness.maxAgeMs`.
 *
 * Reached only when `reconnectOnExpiry` is false — otherwise a stale snapshot
 * has already gone to `freshConnect`. Re-listing over the connection just opened
 * honours `maxAgeMs` without the reconnect the caller declined: "stale" means the
 * tool set needs re-reading, not that the transport needs rebuilding.
 * `refresh()` also clears the carried `cachedAt`, so the write-back records the
 * new age rather than carrying the snapshot's forward.
 */
async function refreshStaleReplay(handle: MCPToolsHandle): Promise<void> {
  // `refresh()` swaps `handle.tools` to a fresh array exactly when the re-list
  // succeeded, before it persists — so the reference tells re-list failure
  // apart from persistence failure. Keying on that rather than on
  // `MCPCacheWriteError` matters because persistence can fail OUTSIDE the
  // store op too (the caller's OAuth provider rejecting inside `snapshot()`),
  // and that failure must not masquerade as "re-listing tools failed".
  const before = handle.tools;
  try {
    await handle.refresh();
  } catch (refreshErr) {
    // Tools adopted: the re-list succeeded and only the persistence after it
    // broke. Survivable, and must not fail the call — the tools ARE current;
    // only the cache entry is stale, and the next rehydrate re-reads it.
    // (A transient store outage here used to discard a connection whose tools
    // had just been read successfully.)
    if (handle.tools !== before || refreshErr instanceof MCPCacheWriteError) {
      return;
    }
    // A failed re-list is not. The connection is live and the snapshot's tools
    // would work, but they are older than the caller's own `maxAgeMs` — serving
    // them anyway is exactly the unbounded-age bug that check exists to prevent.
    await closeQuietly(handle);
    throw new MCPStaleSnapshotError(
      'Snapshot is older than staleness.maxAgeMs and re-listing tools failed',
      {
        cause: refreshErr,
      },
    );
  }
}

/**
 * The cases where a successful replay still writes to the cache store.
 *
 * The replay write-back is normally skipped as a no-op — the snapshot it would
 * persist is the one just read. Three exceptions where the write genuinely does
 * something, all best-effort:
 *
 * 1. **OAuth token rotation.** With `cacheCredentials: true` and an OAuth
 *    provider, the old per-hit write re-serialized the provider's *current*
 *    tokens; without it the stored entry keeps cold-connect-time tokens, and
 *    once those pass `expiresAt` every rehydrate takes the fresh-connect
 *    detour even though the provider holds a valid refreshed token.
 * 2. **Static credential rotation.** Same story for `bearer`/`headers` auth:
 *    the old per-hit write kept the stored `auth.headers` in sync with the
 *    caller's live `auth`, so a rotated API key propagated on the next warm
 *    hit. When the caller passes static auth under `cacheCredentials: true`
 *    and the resolved headers differ from the stored ones, the stored entry's
 *    header block is updated — otherwise a later credential-bearing rehydrate
 *    (`authFromSnapshot`) would dial with the superseded secret.
 * 3. **Legacy `sessionId` scrub.** Entries written by earlier versions can
 *    carry a bearer-equivalent `Mcp-Session-Id` under `cacheCredentials`; with
 *    the warm path never rewriting, that credential-grade value would sit in
 *    the external store indefinitely. One write — the entry copied without the
 *    field — removes it.
 *
 * All three share one invariant: they only ever REWRITE an entry the store
 * already holds, read back first. The credential grafts move only their block
 * onto the stored entry rather than re-serializing this call's live state — a
 * direct `rehydrateMCPTools` may have loaded its snapshot from a file or
 * another key, and writing that snapshot's (older) tool set and `cachedAt`
 * over the store's entry would roll back a newer entry written by a concurrent
 * `refresh()`. Copying the stored entry also cannot strip or introduce
 * credentials the way a re-serialize under this call's options could (the
 * DEV-766 hazard): each block is only updated where the stored entry already
 * carries that block.
 */

/**
 * Graft the provider's current tokens onto the STORED entry — never the other
 * way round.
 *
 * Only the token block moves; the stored entry's tool set and `cachedAt` stay
 * untouched, so a direct rehydrate whose input snapshot is older than the
 * store's entry (a concurrent `refresh()` having written since) cannot roll the
 * entry back. Returns undefined — no write — when the stored entry carries no
 * tokens (grafting would introduce credentials into an entry that never held
 * them) or the fresh serialize produced none.
 *
 * An UNROTATED token — same access token as stored — grafts nothing at all,
 * for three reasons that all point the same way. No per-replay write (the
 * documented warm-path economy, and no re-touching TTL-extending stores). No
 * expiry ratchet: `serializeServer` stamps `expiresAt` as `Date.now() +
 * expires_in * 1000`, but `expires_in` is relative to *issuance* (RFC 6749
 * §5.1), so re-persisting the same token would push the recorded expiry
 * forward each replay and `tokensExpired()` would never trip. And no field
 * loss: a wholesale replace would drop stored fields the provider's `tokens()`
 * no longer reports (a `refreshToken` held elsewhere, say) without any actual
 * rotation. A rotated token replaces the block, fresh restamp included — the
 * SDK just obtained it, so its relative `expires_in` genuinely is from ~now.
 */
function graftRotatedTokens(
  stored: SerializedMCPServer,
  serialized: SerializedMCPServer,
): SerializedMCPServer | undefined {
  const prev = stored.auth?.tokens;
  const next = serialized.auth?.tokens;
  if (prev === undefined || next === undefined) {
    return undefined;
  }
  if (next.accessToken === prev.accessToken) {
    return undefined;
  }
  return {
    ...stored,
    auth: {
      ...stored.auth,
      tokens: {
        ...next,
      },
    },
  };
}

function headersEqual(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const aKeys = Object.keys(a);
  return aKeys.length === Object.keys(b).length && aKeys.every((k) => a[k] === b[k]);
}

/**
 * Graft the caller's current static headers onto the STORED entry — the
 * `bearer`/`headers` counterpart of {@link graftRotatedTokens}, under the same
 * invariants: only the header block moves, and only where the stored entry
 * already carries headers (never introducing credentials into an entry that
 * had none). Returns undefined — no write — when there is nothing to update.
 */
function graftStaticHeaders(
  stored: SerializedMCPServer,
  headers: Readonly<Record<string, string>>,
): SerializedMCPServer | undefined {
  const prev = stored.auth?.headers;
  if (prev === undefined || Object.keys(prev).length === 0 || Object.keys(headers).length === 0) {
    return undefined;
  }
  if (headersEqual(prev, headers)) {
    return undefined;
  }
  return {
    ...stored,
    auth: {
      ...stored.auth,
      headers,
    },
  };
}

/**
 * Compute the maintenance rewrite for a stored entry, if any: an OAuth token
 * graft, a static-header graft, or nothing. Split from
 * {@link maintainReplayedEntry} to keep each piece readable.
 */
async function graftForReplay(args: {
  options: RehydrateMCPToolsOptions;
  handle: MCPToolsHandle;
  stored: SerializedMCPServer;
  effectiveAuth: MCPAuth | undefined;
}): Promise<SerializedMCPServer | undefined> {
  const { options, handle, stored, effectiveAuth } = args;
  if (options.cacheCredentials !== true) {
    return undefined;
  }
  if (isOAuthAuth(effectiveAuth)) {
    return graftRotatedTokens(stored, await handle.serialize());
  }
  // Static graft keys on the CALLER's auth, not `effectiveAuth`: auth derived
  // from the input snapshot is by definition not a rotation.
  if (options.auth !== undefined) {
    return graftStaticHeaders(stored, resolveAuth(options.auth).headers);
  }
  return undefined;
}

async function maintainReplayedEntry(args: {
  options: RehydrateMCPToolsOptions;
  snapshot: SerializedMCPServer;
  handle: MCPToolsHandle;
  cacheKey: string;
  effectiveAuth: MCPAuth | undefined;
}): Promise<void> {
  const { options, handle, cacheKey, effectiveAuth } = args;
  const store = options.cache?.store;
  if (store === undefined) {
    return;
  }
  try {
    // Cheap gates first, so a warm hit with nothing to maintain performs ZERO
    // store operations. Credential grafts can only apply under
    // `cacheCredentials: true`; the scrub can only be needed when the *input*
    // snapshot carries a legacy `sessionId` (on the warm `createMCPTools` path
    // the input IS the store's entry, so a sessionId-free input — every entry
    // this version writes — means a sessionId-free store).
    const mayGraft =
      options.cacheCredentials === true &&
      (isOAuthAuth(effectiveAuth) || options.auth !== undefined);
    if (!mayGraft && args.snapshot.sessionId === undefined) {
      return;
    }
    // Read back before writing: every maintenance write is a rewrite of what
    // THIS store currently holds, never a serialize of this call's state — a
    // direct rehydrate's input snapshot may be older than the store's entry (a
    // concurrent refresh() having written since), and its auth may belong to a
    // store that never held credentials. One read per maintained replay is the
    // price.
    const stored = await store.get(cacheKey);
    if (stored === null || stored === undefined || !isSerializedMCPServer(stored)) {
      return;
    }
    const grafted = mayGraft
      ? await graftForReplay({
          options,
          handle,
          stored,
          effectiveAuth,
        })
      : undefined;
    // Nothing to graft and nothing to scrub — no write. A legacy sessionId in
    // the stored entry composes with either graft into one write.
    if (grafted === undefined && stored.sessionId === undefined) {
      return;
    }
    const next = {
      ...(grafted ?? stored),
    };
    delete next.sessionId;
    await store.set(cacheKey, next);
  } catch {
    // Best-effort, like every other store write: a cache outage never fails a
    // working replay.
  }
}

/**
 * Rebuild an {@link MCPToolsHandle} from a cached snapshot. On the happy path we
 * reconnect the transport and rebuild tools directly from the snapshot —
 * skipping `listTools()`. If cached tokens are expired, credentials are missing,
 * the snapshot is older than `staleness.maxAgeMs`, or the replay connection
 * fails, we transparently fall back to a fresh connect (unless
 * `reconnectOnExpiry` is false) — with one exception: a credential rejection is
 * not retried, because the fallback reuses the same auth and re-attempting
 * would re-drive an OAuth authorization flow. See {@link
 * RehydrateMCPToolsOptions.reconnectOnExpiry}.
 */
export async function rehydrateMCPTools(
  options: RehydrateMCPToolsOptions,
): Promise<MCPToolsHandle> {
  const { snapshot } = options;
  if (!isSerializedMCPServer(snapshot)) {
    throw new MCPCacheError('Invalid MCP snapshot: failed structural validation');
  }

  const reconnectOnExpiry = options.reconnectOnExpiry ?? true;
  const url = new URL(snapshot.url);
  const cacheKey = options.cache?.key ?? defaultCacheKey(url.href);
  // Fall back to credentials cached in the snapshot when the caller didn't pass
  // any — otherwise a credential-bearing snapshot would reconnect unauthenticated.
  const effectiveAuth = options.auth ?? authFromSnapshot(snapshot);
  const hasCredentials = effectiveAuth !== undefined;
  // Route the fallback through `freshConnect`, NOT `createMCPTools`: the latter
  // would re-read this same snapshot and re-enter rehydrate, recursing without
  // bound on any no-credential / expired-token snapshot. `freshConnect` still
  // writes the refreshed result back to the cache via `makeHandle`.
  const createOptions = toCreateOptions(options, snapshot, effectiveAuth);

  // Staleness is checked here as well as in `createMCPTools`'s cache-hit path,
  // so a direct `rehydrateMCPTools()` call honours `staleness.maxAgeMs` too.
  // Previously only the `createMCPTools` route checked it, meaning callers who
  // held their own snapshot silently got unbounded-age tools.
  const staleSnapshot = snapshotIsStale(snapshot, options.staleness?.maxAgeMs);

  if ((tokensExpired(snapshot) || !hasCredentials || staleSnapshot) && reconnectOnExpiry) {
    return freshConnect(createOptions, url, cacheKey);
  }

  // Held outside the `try` so the `catch` can tear it down. `connect()` releases
  // its own client when it fails, so this stays undefined on that path and only
  // a post-connect failure has something to close.
  let connection: MCPConnection | undefined;
  try {
    connection = await connect(
      toReplayConnectOptions({
        options,
        snapshot,
        url,
        effectiveAuth,
      }),
    );

    // Rebuild tools from the snapshot — no listTools() round-trip.
    const handle = await makeHandle({
      connection,
      options: createOptions,
      context: {
        url,
        transport: connection.transport,
        cacheKey,
      },
      initialToolDefs: snapshotToToolDefs(snapshot),
      // Replay, not a listTools() — keep the snapshot's original age so
      // staleness.maxAgeMs stays measurable across repeated rehydrates.
      replayedCachedAt: snapshot.cachedAt,
    });

    if (staleSnapshot) {
      // `refresh()` re-listed and wrote the entry through `serialize` — which
      // carries the provider's current tokens and omits `sessionId` — so every
      // maintenance concern below is already satisfied. Running the scrub here
      // would clobber the just-refreshed entry with the caller's older input
      // snapshot.
      await refreshStaleReplay(handle);
    } else {
      await maintainReplayedEntry({
        options,
        snapshot,
        handle,
        cacheKey,
        effectiveAuth,
      });
    }

    return handle;
  } catch (err) {
    // The stale re-list above already closed and reported; let its verdict stand
    // rather than re-wrapping it as a generic rehydrate failure (and
    // double-closing). It is a deliberate refusal, not a rehydrate that broke.
    if (err instanceof MCPStaleSnapshotError) {
      throw err;
    }
    // Tear down the replay connection before leaving this path, mirroring
    // `freshConnect`'s guarantee in handle.ts. Whether we fall back (which opens
    // its own connection) or rethrow, nothing else holds a reference to this
    // one, so without the close its transport leaks. Reachable via `buildTools`
    // rejecting on a duplicate tool name, or a caller's `cache.store.set`
    // throwing during the initial write.
    if (connection !== undefined) {
      await closeQuietly(connection);
    }
    // The fallback is a third reconnect layer, and it reuses the same auth. If
    // the replay's connect ended in a credential rejection, `freshConnect` would
    // re-drive the OAuth flow — a third `redirectToAuthorization` behind the two
    // layers below that already guard against exactly this. Rejected credentials
    // are not something a fresh connection fixes.
    // An aborted caller gets no fallback either — the third reconnect layer,
    // matching the guards on the SSE fallback and the legacy retry. Dialling a
    // fresh connection after the caller cancelled would both waste the dial and
    // bury the cancellation under a "failed to connect" it didn't cause.
    const { UnauthorizedError } = await loadMcpSdk();
    if (
      reconnectOnExpiry &&
      options.signal?.aborted !== true &&
      !isAuthFailure({
        err,
        auth: effectiveAuth,
        UnauthorizedErrorType: UnauthorizedError,
      })
    ) {
      return freshConnect(createOptions, url, cacheKey);
    }
    throw new MCPCacheError('Failed to rehydrate MCP connection from snapshot', {
      cause: err,
    });
  }
}
