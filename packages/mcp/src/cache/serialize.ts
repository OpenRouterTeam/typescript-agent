import type { OAuthClientProvider, StoredOAuthTokens } from '@modelcontextprotocol/client';
import { resolveAuth } from '../auth/auth-resolver.js';
import type { MCPAuth } from '../auth/auth-types.js';
import type { McpToolDef } from '../tool-wrapper.js';
import type { MCPTransportKind } from '../types.js';
import type { SerializedMCPServer, SerializedTokenSet } from './cache-types.js';
import { isFiniteEpoch } from './cache-types.js';

export interface SerializeInput {
  url: string;
  transport: MCPTransportKind;
  toolDefs: readonly McpToolDef[];
  serverInfo?: {
    name?: string;
    version?: string;
  };
  capabilities?: Readonly<Record<string, unknown>>;
  auth?: MCPAuth;
  cacheCredentials: boolean;
  cachedAt: number;
}

/**
 * Compile-time guard that the SDK still has a numeric `expires_in` field.
 *
 * `tokensFromProvider` narrows `expires_in` with a runtime `typeof` check, which
 * degrades silently: if a future SDK renamed the field or retyped it, the check
 * would simply never match, snapshots would carry no `expiresAt`, and
 * `tokensExpired()` would treat expired credentials as usable forever — a
 * security-relevant failure with no error anywhere. This assignment fails
 * `tsc` instead, at the version bump that causes it.
 *
 * What it cannot catch: a semantics change that keeps the name and the numeric
 * type — say `expires_in` becoming an absolute epoch. No static assert can see
 * that; the backstop is that `expires_in` is RFC 6749 §5.1 wire vocabulary
 * ("lifetime in seconds"), which an OAuth type is very unlikely to repurpose
 * without also renaming. Treat a major SDK bump as a prompt to re-read its
 * token type either way.
 */
type _AssertExpiresInIsSeconds = StoredOAuthTokens['expires_in'] extends number | undefined
  ? true
  : never;
const _expiresInStillRelative: _AssertExpiresInIsSeconds = true;
void _expiresInStillRelative;

/** Pull a serializable token set from an OAuth provider, if it has tokens. */
async function tokensFromProvider(
  provider: OAuthClientProvider,
): Promise<SerializedTokenSet | undefined> {
  const tokens = await provider.tokens();
  if (tokens === undefined) {
    return undefined;
  }
  const expiresInMs = typeof tokens.expires_in === 'number' ? tokens.expires_in * 1000 : undefined;
  return {
    accessToken: tokens.access_token,
    ...(typeof tokens.token_type === 'string' && {
      tokenType: tokens.token_type,
    }),
    ...(typeof tokens.refresh_token === 'string' && {
      refreshToken: tokens.refresh_token,
    }),
    ...(typeof tokens.scope === 'string' && {
      scope: tokens.scope,
    }),
    ...(expiresInMs !== undefined && {
      expiresAt: Date.now() + expiresInMs,
    }),
  };
}

async function buildAuthBlock(auth: MCPAuth | undefined): Promise<SerializedMCPServer['auth']> {
  if (auth === undefined) {
    return undefined;
  }
  if (auth.kind === 'oauth') {
    const tokens = await tokensFromProvider(auth.provider);
    return tokens !== undefined
      ? {
          tokens,
        }
      : undefined;
  }
  const { headers } = resolveAuth(auth);
  return Object.keys(headers).length > 0
    ? {
        headers,
      }
    : undefined;
}

/**
 * Build a serializable snapshot. Credentials (tokens/headers) are included only
 * when `cacheCredentials` is true; otherwise the snapshot holds just the
 * structural data needed to rebuild the tool set after a fresh auth. Session ids
 * are never included — see the note in the `cacheCredentials` branch.
 */
export async function serializeServer(input: SerializeInput): Promise<SerializedMCPServer> {
  const tools = input.toolDefs.map((def) => ({
    name: def.name,
    ...(def.description !== undefined && {
      description: def.description,
    }),
    inputSchema: def.inputSchema,
    ...(def.outputSchema !== undefined && {
      outputSchema: def.outputSchema,
    }),
    ...(def.loopKey !== undefined && {
      loopKey: def.loopKey,
    }),
  }));

  const snapshot: SerializedMCPServer = {
    version: 1,
    url: input.url,
    transport: input.transport,
    ...(input.serverInfo !== undefined && {
      serverInfo: input.serverInfo,
    }),
    ...(input.capabilities !== undefined && {
      capabilities: input.capabilities,
    }),
    tools,
    cachedAt: isFiniteEpoch(input.cachedAt) ? input.cachedAt : Date.now(),
  };

  if (input.cacheCredentials) {
    const auth = await buildAuthBlock(input.auth);
    if (auth !== undefined) {
      snapshot.auth = auth;
    }
    // `sessionId` is deliberately NOT persisted. A Streamable HTTP
    // `Mcp-Session-Id` is a bearer-equivalent handle to an authenticated server
    // session, and nothing reads it back: the replay path stopped forwarding it
    // once we found that a transport reporting a sessionId makes SDK v2 skip
    // negotiation entirely, silently losing server capabilities. Writing it to an
    // external store (Redis, a database, a file) would be attack surface for no
    // functionality. That it was gated behind `cacheCredentials` at all reflects
    // that it was always credential-grade.
  }

  return snapshot;
}
