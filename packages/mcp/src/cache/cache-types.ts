import { isJsonSchemaObject } from '../schema/json-schema-guards.js';
import type { MCPTransportKind } from '../transport-types.js';

/** A discovered tool definition as stored in a cache snapshot. */
export interface SerializedMCPToolDef {
  name: string;
  description?: string;
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema?: Readonly<Record<string, unknown>>;
}

/** OAuth/bearer token material, persisted only when `cacheCredentials` is on. */
export interface SerializedTokenSet {
  accessToken: string;
  tokenType?: string;
  refreshToken?: string;
  /** Epoch ms; absence means unknown/no declared expiry. */
  expiresAt?: number;
  scope?: string;
}

/**
 * Serializable snapshot of a connected MCP server: enough to rebuild the tool
 * set (and, opt-in, reconnect with cached credentials) without re-listing or
 * re-authenticating.
 */
export interface SerializedMCPServer {
  version: 1;
  url: string;
  transport: MCPTransportKind;
  serverInfo?: {
    name?: string;
    version?: string;
  };
  capabilities?: Readonly<Record<string, unknown>>;
  sessionId?: string;
  tools: SerializedMCPToolDef[];
  auth?: {
    headers?: Readonly<Record<string, string>>;
    tokens?: SerializedTokenSet;
  };
  cachedAt: number;
}

function isTransportKind(value: unknown): value is MCPTransportKind {
  return value === 'streamableHttp' || value === 'sse';
}

/**
 * The shared "valid `cachedAt`" rule: a finite, non-negative epoch (ms).
 * Consumed by both the read-side snapshot validator and the write-side
 * serializer so the two can't drift. Rejecting negatives keeps the invariant
 * honest at the boundary rather than relying on downstream maxAge arithmetic to
 * fail-safe on a clock-skewed or garbage value.
 */
export function isFiniteEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSerializedToolDef(value: unknown): value is SerializedMCPToolDef {
  return (
    isJsonSchemaObject(value) &&
    typeof value['name'] === 'string' &&
    isJsonSchemaObject(value['inputSchema'])
  );
}

/**
 * Validate an untrusted value as a {@link SerializedMCPServer}. Cache stores may
 * be backed by a DB or another org member's data, so snapshots are checked
 * structurally before use — never trusted by shape alone.
 */
export function isSerializedMCPServer(value: unknown): value is SerializedMCPServer {
  if (!isJsonSchemaObject(value)) {
    return false;
  }
  if (value['version'] !== 1) {
    return false;
  }
  if (typeof value['url'] !== 'string' || !isTransportKind(value['transport'])) {
    return false;
  }
  if (!isFiniteEpoch(value['cachedAt'])) {
    return false;
  }
  const { tools } = value;
  return Array.isArray(tools) && tools.every(isSerializedToolDef);
}
