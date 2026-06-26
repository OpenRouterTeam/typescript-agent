import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

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
