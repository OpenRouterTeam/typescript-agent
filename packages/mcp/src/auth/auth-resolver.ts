import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { MCPAuth } from './auth-types.js';

/**
 * The transport-level pieces derived from an {@link MCPAuth}: static headers to
 * merge into `requestInit`, and/or an OAuth provider to hand to the transport.
 * Both flow into the same connected client, so discovery and tool calls share
 * one authenticated session.
 */
export interface ResolvedAuth {
  headers: Record<string, string>;
  authProvider?: OAuthClientProvider;
}

export function resolveAuth(auth: MCPAuth | undefined): ResolvedAuth {
  if (auth === undefined) {
    return {
      headers: {},
    };
  }
  switch (auth.kind) {
    case 'bearer':
      return {
        headers: {
          Authorization: `Bearer ${auth.token}`,
        },
      };
    case 'headers':
      return {
        headers: {
          ...auth.headers,
        },
      };
    case 'oauth':
      return {
        headers: {},
        authProvider: auth.provider,
      };
  }
}
