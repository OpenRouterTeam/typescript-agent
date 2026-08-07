import type {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { MCPMissingPeerDependencyError } from './errors.js';

export interface MCPSdk {
  Client: typeof Client;
  SSEClientTransport: typeof SSEClientTransport;
  StreamableHTTPClientTransport: typeof StreamableHTTPClientTransport;
  UnauthorizedError: typeof UnauthorizedError;
}

let sdkPromise: Promise<MCPSdk> | undefined;

function isMissingSdk(error: unknown): boolean {
  let current = error;
  while (current instanceof Error) {
    const code = 'code' in current ? current.code : undefined;
    if (
      code === 'ERR_MODULE_NOT_FOUND' &&
      current.message.includes('@modelcontextprotocol/client')
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** Load the optional MCP client only when a connection is actually requested. */
export function loadMcpSdk(): Promise<MCPSdk> {
  sdkPromise ??= import('@modelcontextprotocol/client')
    .then((client) => ({
      Client: client.Client,
      SSEClientTransport: client.SSEClientTransport,
      StreamableHTTPClientTransport: client.StreamableHTTPClientTransport,
      UnauthorizedError: client.UnauthorizedError,
    }))
    .catch((cause: unknown) => {
      sdkPromise = undefined;
      if (isMissingSdk(cause)) {
        throw new MCPMissingPeerDependencyError({
          cause,
        });
      }
      throw cause;
    });
  return sdkPromise;
}
