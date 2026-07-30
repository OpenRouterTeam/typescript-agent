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
 * Raised when the tool list was read successfully but writing the snapshot back
 * to the caller's `MCPCacheStore` failed.
 *
 * Distinct from the read failing, because the consequences differ completely: the
 * connection is live and its tools are current, so the only thing lost is a cache
 * entry. Callers who treat a store outage as fatal can catch this; callers who
 * would rather keep working with a warm handle can ignore it.
 *
 * Subclasses {@link MCPCacheError}, so existing catch sites keep working.
 */
export class MCPCacheWriteError extends MCPCacheError {
  constructor(
    message: string,
    options?: {
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = 'MCPCacheWriteError';
  }
}

/**
 * Raised when a snapshot is older than `staleness.maxAgeMs` and the re-list that
 * would have refreshed it failed — so the only tools available are ones the
 * caller declared too old to use.
 *
 * Subclasses {@link MCPCacheError}, so existing `catch (e instanceof
 * MCPCacheError)` sites keep working. Catch this specifically to fall back to
 * stale-but-usable tools instead of failing.
 */
export class MCPStaleSnapshotError extends MCPCacheError {
  constructor(
    message: string,
    options?: {
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = 'MCPStaleSnapshotError';
  }
}

/**
 * Raised when connecting to the MCP server fails across all attempted transports.
 */
export class MCPConnectionError extends MCPError {
  /**
   * Every failure behind this one, in attempt order, when more than one transport
   * was tried.
   *
   * `cause` holds only the last attempt, which loses information: an
   * `UnauthorizedError` from the Streamable HTTP attempt matters even when the
   * SSE fallback then failed for an unrelated reason (a URL that simply isn't an
   * SSE endpoint answering 404). Named `errors` to match `AggregateError`, so it
   * reads the way callers expect rather than as a bespoke field.
   *
   * Empty when only one transport was attempted.
   */
  readonly errors: readonly unknown[];

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      errors?: readonly unknown[];
    },
  ) {
    super(message, options);
    this.name = 'MCPConnectionError';
    this.errors = options?.errors ?? [];
  }
}
