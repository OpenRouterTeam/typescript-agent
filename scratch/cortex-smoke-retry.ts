/**
 * TEMPORARY cortex live-review smoke file. This PR is closed immediately
 * after the review posts; do not merge.
 */
export async function fetchWithRetry(url: string, attempts = 10): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {}
    // fixed one-second wait between tries
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("exhausted retries");
}
