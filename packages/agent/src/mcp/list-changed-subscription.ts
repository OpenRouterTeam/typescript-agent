import type { Client, McpSubscription } from '@modelcontextprotocol/client';

/** Nominal delay before the first re-listen after a stream ends; doubles per attempt. */
const RELISTEN_BASE_DELAY_MS = 1_000;

/**
 * Ceiling on the re-listen delay, and how long a stream has to survive before
 * the backoff starts over. One constant for both: a stream that outlives the
 * longest wait is, by the only yardstick available here, a healthy one.
 */
const RELISTEN_MAX_DELAY_MS = 60_000;

/**
 * Each delay is spread over this fraction either side of its nominal value.
 * Streams are usually lost in bulk — one redeploy drops every client's at the
 * same instant — and without a spread they would all come back, and re-list,
 * on the same tick, then again in step at every later attempt.
 */
const RELISTEN_JITTER = 0.5;

export interface ToolListChangedWatch {
  /**
   * Stop re-listening. Does not close the open stream — `client.close()` does
   * that — so call this *before* closing the client: the SDK reports a stream
   * ended by its own close as a remote drop, which would otherwise look like
   * something to recover from.
   */
  stop(): void;
}

interface WatchArgs {
  client: Client;
  /** Ends the subscription for good when aborted. */
  signal: AbortSignal | undefined;
  /** Whether a failed open was the server rejecting the connection's credentials. */
  isAuthFailure: (err: unknown) => boolean;
  /**
   * The stream was lost and has been re-established. Whatever changed in
   * between was never delivered, so the caller should re-list.
   */
  onResubscribed: () => void;
}

/**
 * Keep a `subscriptions/listen` stream open so a 2026-07-28 server can deliver
 * `notifications/tools/list_changed`.
 *
 * That revision has no unsolicited server-to-client channel: no session, and no
 * standalone GET stream (the transport only opens one after the 2025-era
 * `notifications/initialized`). A notification handler alone is therefore never
 * called. Notifications arriving on this stream dispatch to the handler already
 * registered with `setNotificationHandler`, so nothing else changes.
 *
 * Returns `undefined` — nothing opened — on a 2025-era connection, where the
 * notification arrives unsolicited as before, and when the server does not
 * advertise `tools.listChanged`.
 *
 * Runs entirely in the background and never rejects: the handle is fully usable
 * without it, so neither a refused subscription nor an unanswered one may delay
 * or fail the connect that asked for it.
 *
 * The SDK does not re-listen when a stream ends, and streams do end — a proxy's
 * idle timeout, a redeploy. Left there, auto-refresh would work until the first
 * drop and then be silently dead again. So once the server has acknowledged a
 * subscription, a lost stream is re-opened with capped, jittered exponential
 * backoff for as long as the connection lives. A first subscription that is never
 * acknowledged is not retried: the likeliest reason is a server that does not
 * serve this, and asking again on a timer would only add load.
 *
 * One failure ends the watch outright: rejected credentials. See `open` below.
 */
export function watchToolListChanged(args: WatchArgs): ToolListChangedWatch | undefined {
  const { client, signal, isAuthFailure, onResubscribed } = args;
  if (
    client.getProtocolEra() !== 'modern' ||
    client.getServerCapabilities()?.tools?.listChanged !== true
  ) {
    return undefined;
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  const open = async (): Promise<McpSubscription | undefined> => {
    try {
      return await client.listen(
        {
          toolsListChanged: true,
        },
        signal !== undefined
          ? {
              signal,
            }
          : undefined,
      );
    } catch (err) {
      // Refused, unanswered, or the connection went away. Nothing to report:
      // the subscription is an optimisation over calling `refresh()`.
      //
      // That every such failure arrives *here* depends on the SDK: before
      // 2.2.0, `listen()` awaited the transport's send before anything observed
      // its internal ack promise, so a close, an abort or the ack timeout
      // during that send rejected a promise no caller could reach — an
      // unhandled rejection, which ends a Node process. Hence the `^2.2.0`
      // peer floor; there is nothing this `catch` could do about it.
      if (isAuthFailure(err)) {
        // Rejected credentials are final for this watch. Under OAuth the SDK
        // has, by the time this throws, already run its authorization flow
        // once — a saved PKCE verifier and a `redirectToAuthorization` — and
        // every further attempt would run it again, from a timer, with nobody
        // asking. `connect()` and `rehydrateMCPTools` refuse to retry for the
        // same reason. That first run happens inside the SDK's send and cannot
        // be prevented, so the bound is one.
        stopped = true;
      }
      return undefined;
    }
  };

  const scheduleRelisten = (): void => {
    // `transport` is cleared when the client closes, however that happened —
    // re-listening on a dead connection would fail on every tick, forever.
    if (stopped || signal?.aborted === true || client.transport === undefined) {
      return;
    }
    const nominal = Math.min(RELISTEN_BASE_DELAY_MS * 2 ** attempt, RELISTEN_MAX_DELAY_MS);
    const delay = nominal * (1 - RELISTEN_JITTER + Math.random() * 2 * RELISTEN_JITTER);
    attempt += 1;
    timer = setTimeout(() => {
      timer = undefined;
      void run(true);
    }, delay);
  };

  const run = async (isRelisten: boolean): Promise<void> => {
    const subscription = await open();
    if (subscription === undefined) {
      if (isRelisten) {
        scheduleRelisten();
      }
      return;
    }
    const openedAt = Date.now();
    if (isRelisten) {
      try {
        onResubscribed();
      } catch {
        // The callback's failure is its own; it must not end the watch.
      }
    }
    // `closed` never rejects. `'local'` means the caller's signal aborted.
    const cause = await subscription.closed;
    if (cause === 'local') {
      return;
    }
    if (Date.now() - openedAt >= RELISTEN_MAX_DELAY_MS) {
      attempt = 0;
    }
    scheduleRelisten();
  };

  void run(false);

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
