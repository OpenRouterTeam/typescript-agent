/**
 * Release something closeable on a path that is already failing, swallowing
 * whatever `close()` does on the way out.
 *
 * The `try` matters as much as the `catch`: `close()` is not guaranteed to
 * return a rejected promise on failure, and a *synchronous* throw never
 * produces one — so `x.close().catch(() => {})` throws before `.catch()` is
 * ever attached. On an unwinding path that is actively harmful in two ways: it
 * replaces the real error (a useful "couldn't reach the server" becomes an
 * opaque teardown failure), and it skips whatever recovery followed the close —
 * a fallback that used to self-heal starts rejecting instead.
 *
 * Every teardown-on-failure site in this package goes through here, so the
 * guarantee holds uniformly rather than depending on each caller remembering
 * the distinction.
 *
 * Deliberately not exported from the package entrypoint: callers close through
 * `MCPToolsHandle.close()` / `MCPConnection.close()`, which report failures
 * rather than swallowing them. This is only for teardown during error unwinding.
 */
export async function closeQuietly(closeable: { close(): Promise<void> }): Promise<void> {
  try {
    await closeable.close();
  } catch {
    // Nothing actionable: we are already unwinding a failure, and the close
    // outcome is never the error the caller needs to see.
  }
}
