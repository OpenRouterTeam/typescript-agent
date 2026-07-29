import type { OAuthClientProvider } from '@modelcontextprotocol/client';

/**
 * The OAuth provider contract expected by {@link MCPAuth}'s `oauth` variant.
 *
 * Re-exported under our own name so consumers can type their provider without
 * importing from `@modelcontextprotocol/client` directly — that import path is
 * an implementation detail of this package and has changed once already.
 */
export type MCPOAuthClientProvider = OAuthClientProvider;

/**
 * Authentication for a remote MCP server. Supplied once and reused by the
 * connected client for tool discovery and every subsequent tool call.
 *
 * - `bearer`: a static bearer token sent as `Authorization: Bearer <token>`.
 * - `headers`: arbitrary static headers (e.g. API keys, custom auth schemes).
 * - `oauth`: a user-supplied {@link OAuthClientProvider} that owns token
 *   acquisition/refresh. Preferred over caching static tokens.
 */
export type MCPAuth =
  | {
      kind: 'bearer';
      token: string;
    }
  | {
      kind: 'headers';
      headers: Readonly<Record<string, string>>;
    }
  | {
      kind: 'oauth';
      provider: OAuthClientProvider;
    };

export function isOAuthAuth(auth: MCPAuth | undefined): auth is {
  kind: 'oauth';
  provider: OAuthClientProvider;
} {
  return auth?.kind === 'oauth';
}
