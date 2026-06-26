/**
 * Base error for all @openrouter/mcp failures.
 */
export class MCPError extends Error {
  constructor(
    message: string,
    options?: {
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = 'MCPError';
  }
}

/**
 * Raised when an MCP tool call returns `isError: true` or when the result
 * cannot be mapped to a usable model output.
 */
export class MCPToolCallError extends MCPError {
  readonly toolName: string;

  constructor(
    toolName: string,
    message: string,
    options?: {
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = 'MCPToolCallError';
    this.toolName = toolName;
  }
}

/**
 * Raised when a cached snapshot cannot be validated or rehydrated.
 */
export class MCPCacheError extends MCPError {
  constructor(
    message: string,
    options?: {
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = 'MCPCacheError';
  }
}

/**
 * Raised when connecting to the MCP server fails across all attempted transports.
 */
export class MCPConnectionError extends MCPError {
  constructor(
    message: string,
    options?: {
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = 'MCPConnectionError';
  }
}
