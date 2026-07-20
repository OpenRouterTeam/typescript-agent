import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
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
  sessionId?: string;
  auth?: MCPAuth;
  cacheCredentials: boolean;
  cachedAt: number;
}

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
 * Build a serializable snapshot. Credentials (tokens/headers, session id) are
 * included only when `cacheCredentials` is true; otherwise the snapshot holds
 * just the structural data needed to rebuild the tool set after a fresh auth.
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
    if (input.sessionId !== undefined) {
      snapshot.sessionId = input.sessionId;
    }
  }

  return snapshot;
}
