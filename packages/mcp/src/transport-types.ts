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
 * - `'legacy'` — skip the probe and always use the `initialize` handshake. Saves
 *   that round trip when you already know the server is 2025-era.
 * - `{ pin }` — require exactly that revision; fail loudly rather than
 *   falling back.
 *
 * **Setting this at all opts out of the automatic legacy retry.** When you leave
 * it unset, a failed connect is retried once with `'legacy'`, so a server behind
 * a probe-hostile proxy or gateway still connects. Naming a mode — including
 * `'auto'` — means you want that mode's failures too, and silently overriding a
 * `{ pin }` would defeat the point of pinning. So `'legacy'` is a performance
 * choice here, not a compatibility one.
 *
 * This is a policy, not a version — `{ pin: '2026-07-28' }` is how you request
 * a specific revision. Declared here rather than re-exported from the SDK so
 * the public API does not depend on SDK types.
 */
export type MCPProtocolNegotiation =
  | 'legacy'
  | 'auto'
  | {
      /**
       * Exact revision to speak, skipping negotiation.
       *
       * The two known revisions autocomplete and typo-check; the `(string & {})`
       * arm keeps any other value assignable, so pinning a revision this package
       * predates still compiles rather than forcing a cast. A wrong string there
       * fails at connect time, as before.
       */
      pin: MCPProtocolRevision | (string & {});
    };

/** Protocol revisions this package knows by name. */
export type MCPProtocolRevision = '2025-11-25' | '2026-07-28';
