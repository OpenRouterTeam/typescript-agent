import type { Client, McpSubscription } from '@modelcontextprotocol/client';

/** Delay before the first re-listen after a stream ends; doubles per attempt. */
const RELISTEN_BASE_DELAY_MS = 1_000;

/**
 * Ceiling on the re-listen delay, and how long a stream has to survive before
 * the backoff starts over. One constant for both: a stream that outlives the
 * longest wait is, by the only yardstick available here, a healthy one.
 */
const RELISTEN_MAX_DELAY_MS = 60_000;

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
 * subscription, a lost stream is re-opened with capped exponential backoff for
 * as long as the connection lives. A first subscription that is never
 * acknowledged is not retried: the likeliest reason is a server that does not
 * serve this, and asking again on a timer would only add load.
 */
export function watchToolListChanged(args: WatchArgs): ToolListChangedWatch | undefined {
  const { client, signal, onResubscribed } = args;
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
    } catch {
      // Refused, unanswered, or the connection went away. Nothing to report:
      // the subscription is an optimisation over calling `refresh()`.
      return undefined;
    }
  };

  const scheduleRelisten = (): void => {
    // `transport` is cleared when the client closes, however that happened —
    // re-listening on a dead connection would fail on every tick, forever.
    if (stopped || signal?.aborted === true || client.transport === undefined) {
      return;
    }
    const delay = Math.min(RELISTEN_BASE_DELAY_MS * 2 ** attempt, RELISTEN_MAX_DELAY_MS);
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
