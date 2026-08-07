import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  ElicitRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MCPMissingPeerDependencyError } from './errors.js';

export interface MCPSdk {
  Client: typeof Client;
  SSEClientTransport: typeof SSEClientTransport;
  StreamableHTTPClientTransport: typeof StreamableHTTPClientTransport;
  ElicitRequestSchema: typeof ElicitRequestSchema;
  ToolListChangedNotificationSchema: typeof ToolListChangedNotificationSchema;
}

let sdkPromise: Promise<MCPSdk> | undefined;

function isMissingSdk(error: unknown): boolean {
  let current = error;
  while (current instanceof Error) {
    const code = 'code' in current ? current.code : undefined;
    if (code === 'ERR_MODULE_NOT_FOUND' && current.message.includes('@modelcontextprotocol/sdk')) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** Load the optional MCP SDK only when a connection is actually requested. */
export function loadMcpSdk(): Promise<MCPSdk> {
  sdkPromise ??= Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ])
    .then(([client, sse, streamableHttp, types]) => ({
      Client: client.Client,
      SSEClientTransport: sse.SSEClientTransport,
      StreamableHTTPClientTransport: streamableHttp.StreamableHTTPClientTransport,
      ElicitRequestSchema: types.ElicitRequestSchema,
      ToolListChangedNotificationSchema: types.ToolListChangedNotificationSchema,
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
