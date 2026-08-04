import type { Tool, ToolLoopKey } from '@openrouter/agent/tool-types';
import type { MCPAuth } from './auth/auth-types.js';
import type { MCPCacheStore } from './cache/cache-store.js';
import type { UnconvertibleSchemaMode } from './schema/json-schema-to-zod.js';
import type {
  MCPProtocolNegotiation,
  MCPProtocolRevision,
  MCPTransportKind,
} from './transport-types.js';

export type { MCPProtocolNegotiation, MCPProtocolRevision, MCPTransportKind };

/**
 * Response to a server-initiated elicitation request. `accept` must carry
 * `content` matching the server's `requestedSchema`.
 */
export type ElicitationResponse =
  | {
      action: 'accept';
      content: Record<string, unknown>;
    }
  | {
      action: 'decline';
    }
  | {
      action: 'cancel';
    };

/**
 * Handler for server-initiated `elicitation/create` requests during a tool
 * call. If omitted from options, requests are auto-declined so a tool call
 * needing input fails gracefully rather than hanging.
 */
export type ElicitationHandler = (request: {
  message: string;
  requestedSchema: Record<string, unknown>;
}) => Promise<ElicitationResponse> | ElicitationResponse;

/** How MCP resources are exposed to the model. */
export type ResourcesOption =
  | boolean
  | {
      mode?: 'synthetic-tools';
    };

export interface CreateMCPToolsOptions {
  /** Remote MCP server endpoint. */
  url: string | URL;
  /** Transport to use; defaults to `streamableHttp` with SSE fallback. */
  transport?: MCPTransportKind;
  /**
   * Protocol-revision negotiation policy. Defaults to `'auto'`, which probes
   * the server and speaks either 2025-11-25 or 2026-07-28 as appropriate.
   */
  protocolNegotiation?: MCPProtocolNegotiation;
  /**
   * Ceiling on the `server/discover` probe, in ms. Defaults to 30000 —
   * `DEFAULT_PROBE_TIMEOUT_MS` in `mcp-connection.ts` is the source of truth.
   *
   * Raise it for a server slow to answer its first request. The SDK's own default
   * is the full request timeout, which makes a hanging gateway far slower to fail
   * than it needs to be.
   */
  probeTimeoutMs?: number;
  /** Authentication, supplied once and reused for discovery + every call. */
  auth?: MCPAuth;
  /** Custom fetch implementation for all network requests. */
  fetch?: typeof fetch;
  /** Client identity sent during `initialize`. */
  clientInfo?: {
    name: string;
    version: string;
  };
  /** Prefix applied to every wrapped tool name (e.g. `"github_"`). */
  toolNamePrefix?: string;
  /**
   * Allow-list of MCP tool names to expose. Applies to discovered MCP tools
   * only; synthetic `list_resources`/`read_resource` tools are controlled
   * exclusively by `resources`.
   */
  includeTools?: readonly string[];
  /**
   * Deny-list of MCP tool names to skip. Applies to discovered MCP tools only;
   * synthetic `list_resources`/`read_resource` tools are controlled
   * exclusively by `resources`.
   */
  excludeTools?: readonly string[];
  /** Behavior when a tool's JSON Schema can't be fully represented in Zod. */
  onUnconvertibleSchema?: UnconvertibleSchemaMode;
  /** Cache store + key for automatic rehydrate-on-hit / write-on-miss. */
  cache?: {
    store: MCPCacheStore;
    key?: string;
  };
  /** Persist resolved tokens/session into the snapshot. Off by default. */
  cacheCredentials?: boolean;
  /** Re-list tools when a cached snapshot is older than this. */
  staleness?: {
    maxAgeMs?: number;
  };
  /** Expose resources as synthetic `list_resources`/`read_resource` tools. */
  resources?: ResourcesOption;
  /** Map MCP progress notifications to generator-tool events. Default true. */
  emitProgress?: boolean;
  /**
   * Doom-loop identities for wrapped tools (see the `doomLoop` option on
   * `callModel`), keyed by the tool's UNPREFIXED MCP name. Any `ToolLoopKey`
   * form: a function computing key material, a declarative field-name array
   * (e.g. `{ run_command: ['command', 'cwd'] }`), or `false` to exempt a
   * tool. Takes precedence over a server-advertised
   * `_meta['openrouter/loopKey']` declaration. Function forms are
   * client-side only (they cannot be cached or transported); prefer field
   * lists where possible.
   */
  loopKeys?: Readonly<Record<string, ToolLoopKey<Record<string, unknown>>>>;
  /** Auto-refresh tools on `tools/list_changed`. Default true when connected. */
  autoRefreshOnListChanged?: boolean;
  /**
   * Handler for elicitation requests; auto-declines when omitted.
   *
   * Works against both protocol revisions. On 2025-11-25 the server sends
   * `elicitation/create` directly. On 2026-07-28 that request no longer
   * exists — the server answers with an `input_required` result instead
   * (SEP-2322) — but the SDK's multi-round-trip driver dispatches it through
   * this same handler and then retries the original call, so callers see
   * identical behavior either way.
   */
  onElicitation?: ElicitationHandler;
  /**
   * Abort signal threaded into every underlying `callTool` — and, new in this
   * release, into the connection itself: connecting, the negotiation probe, the
   * implicit legacy retry, and any reconnect all abort with it. An early
   * cancellation can therefore surface as a connection failure, not only as a
   * cancelled tool call.
   */
  signal?: AbortSignal;
}

/**
 * Handle returned by {@link createMCPTools}/`rehydrateMCPTools`. Holds a live
 * connection (unless rehydrated offline) and the wrapped tools.
 */
export interface MCPToolsHandle {
  /** Tools ready to pass into `callModel({ tools })`. */
  readonly tools: readonly Tool[];
  readonly serverInfo?: {
    name?: string;
    version?: string;
  };
  /** Snapshot for persistence; omits credentials unless `cacheCredentials`. */
  serialize(): Promise<import('./cache/cache-types.js').SerializedMCPServer>;
  /** Force a fresh `listTools()` and rebuild the tool set. */
  refresh(): Promise<readonly Tool[]>;
  /** Subscribe to auto-refreshes triggered by `tools/list_changed`. */
  onToolsChanged(listener: (tools: readonly Tool[]) => void): () => void;
  /** Close the transport and underlying client. */
  close(): Promise<void>;
}
