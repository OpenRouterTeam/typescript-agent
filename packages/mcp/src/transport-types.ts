/**
 * Non-stdio MCP transports this package supports.
 *
 * `'sse'` (HTTP+SSE) is reclassified as Deprecated by MCP protocol revision
 * 2026-07-28 (SEP-2596) and remains only for legacy servers. Prefer
 * `'streamableHttp'`. See MIGRATION notes in the package README.
 */
export type MCPTransportKind = 'streamableHttp' | 'sse';

/**
 * How to negotiate the MCP protocol revision.
 *
 * - `'auto'` (our default) — probe the server with `server/discover`, then speak
 *   whichever revision it offers. Definitive modern evidence selects
 *   2026-07-28; anything else falls back to the 2025-era `initialize`
 *   handshake. Costs one extra round trip against legacy servers.
 * - `'legacy'` — skip the probe and always use the `initialize` handshake.
 *   Useful when a server is flaky: on HTTP a probe timeout is treated as an
 *   outage and rejects, where `'legacy'` may still connect.
 * - `{ pin }` — require exactly that revision; fail loudly rather than
 *   falling back.
 *
 * This is a policy, not a version — `{ pin: '2026-07-28' }` is how you request
 * a specific revision. Declared here rather than re-exported from the SDK so
 * the public API does not depend on SDK types.
 */
export type MCPProtocolNegotiation =
  | 'legacy'
  | 'auto'
  | {
      pin: string;
    };
