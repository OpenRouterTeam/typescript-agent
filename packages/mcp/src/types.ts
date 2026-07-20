import type { Tool } from '@openrouter/agent/tool-types';
import type { MCPAuth } from './auth/auth-types.js';
import type { MCPCacheStore } from './cache/cache-store.js';
import type { UnconvertibleSchemaMode } from './schema/json-schema-to-zod.js';
import type { MCPTransportKind } from './transport-types.js';

export type { MCPTransportKind };

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
  /** Auto-refresh tools on `tools/list_changed`. Default true when connected. */
  autoRefreshOnListChanged?: boolean;
  /** Handler for server-initiated elicitation; auto-declines when omitted. */
  onElicitation?: ElicitationHandler;
  /** Abort signal threaded into every underlying `callTool`. */
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
