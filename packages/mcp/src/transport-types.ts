/**
 * Non-stdio MCP transports this package supports.
 *
 * `'sse'` (HTTP+SSE) is reclassified as Deprecated by MCP protocol revision
 * 2026-07-28 (SEP-2596) and remains only for legacy servers. Prefer
 * `'streamableHttp'`. See MIGRATION notes in the package README.
 */
export type MCPTransportKind = 'streamableHttp' | 'sse';
