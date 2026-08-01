import { getToken } from './api';

/** Change kinds the server pushes. */
export type LeadEventType =
  | 'lead.captured'
  | 'lead.routed'
  | 'lead.reassigned'
  | 'routing_rule.changed'
  /** A lead's response clock was stopped by a valid human first response. */
  | 'sla.response_recorded'
  /** The monitoring sweep discovered a breach. Emitted once per lead. */
  | 'sla.breached'
  /** An SLA target was created, adjusted or retired. */
  | 'sla_policy.changed';

export interface PushedEvent {
  type: LeadEventType;
  subject_id: string;
  at: string;
}

/** Reconnect backoff, in ms. Grows then plateaus rather than hammering. */
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

/**
 * Subscribe to the server's change stream.
 *
 * Implemented with `fetch` and a stream reader rather than the browser's
 * `EventSource`, for one reason: EventSource cannot send request headers, so an
 * EventSource client would have to put the session token in the query string,
 * where it lands in access logs, proxy logs and browser history. A fetch reader
 * keeps the token in the Authorization header like every other call.
 *
 * The trade-off is that automatic reconnection is EventSource's job and has to
 * be written by hand here — hence the backoff below.
 *
 * Events carry no state by design: each one means "something changed, re-read".
 * The caller re-fetches the projection, which stays the source of truth, so a
 * missed event costs a stale view until the next one rather than corrupting
 * anything.
 *
 * @param onEvent Called for each event received.
 * @returns An unsubscribe function that closes the connection.
 */
export function subscribeToEvents(onEvent: (event: PushedEvent) => void): () => void {
  const controller = new AbortController();
  let closed = false;
  let attempt = 0;

  async function connect(): Promise<void> {
    if (closed) {
      return;
    }

    const token = getToken();
    if (!token) {
      // Signed out: nothing to subscribe to, and retrying would 401 forever.
      return;
    }

    try {
      const response = await fetch('/api/events/stream', {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`stream refused with ${response.status}`);
      }

      // Connected: reset the backoff so a later blip starts fast again.
      attempt = 0;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line. Keep any partial trailing frame
        // in the buffer — a chunk boundary can fall mid-frame.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) {
            // A comment frame (': heartbeat') carries no data. Expected.
            continue;
          }
          try {
            onEvent(JSON.parse(dataLine.slice('data: '.length)) as PushedEvent);
          } catch {
            // A malformed frame must not kill the stream.
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted || closed) {
        return;
      }
      // Fall through to the retry below.
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[eventStream] disconnected:', message);
    }

    if (!closed) {
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt += 1;
      setTimeout(() => void connect(), delay);
    }
  }

  // Open the channel once the browser has gone idle, rather than during the
  // page's initial load.
  //
  // Two reasons. The product one: this stream is a background nicety — it says
  // "something changed, re-read" — while the projection fetch the view actually
  // renders from is on the critical path. Racing them makes first paint slower
  // for no gain, because there is nothing to push about until the first read has
  // landed anyway.
  //
  // The consequence that made it urgent: this is a `fetch` held open for the
  // lifetime of the page, so as long as it is opened during load the browser
  // never reports an idle network. Any tool that waits for network-idle before
  // considering a navigation finished — Playwright's `networkidle`, which the
  // BDD runner uses — therefore waits until it times out and reports the page
  // as unreachable. Every /app screen failed that way while /signin and the
  // marketing pages passed, because those do not subscribe. Deferring past the
  // idle point lets the navigation settle first; the stream then opens
  // normally.
  //
  // `requestIdleCallback` is not in Safari before 17, hence the timeout
  // fallback. Either way the delay is imperceptible and the channel behaves
  // identically once open.
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  const startTimer = idle
    ? idle(() => void connect(), { timeout: 2000 })
    : setTimeout(() => void connect(), 600);

  return () => {
    closed = true;
    const cancelIdle = (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback;
    if (idle && cancelIdle) {
      cancelIdle(startTimer as number);
    } else {
      clearTimeout(startTimer as ReturnType<typeof setTimeout>);
    }
    controller.abort();
  };
}
