import { Response } from 'express';
import { eventStream } from '../services/EventStream';
import { AuthenticatedRequest } from '../middleware/auth';

/** How often to emit a comment frame to hold the connection open, in ms. */
const HEARTBEAT_MS = 25000;

/**
 * Server-Sent Events endpoint for UI push.
 *
 * SSE rather than WebSocket because the traffic is strictly one-way — the server
 * tells the client "something changed, re-read" — and SSE needs no protocol
 * upgrade, reconnects automatically in the browser, and runs over ordinary HTTP
 * so the existing bearer-token guard applies unchanged.
 *
 * This is NOT a request-response endpoint. It holds the connection open and
 * writes an event stream, so it must never be tested as a plain JSON call
 * (MUST-63) — its api_definition documents the streaming contract instead of
 * asserting a body.
 */
export class EventController {
  /** GET /api/events/stream — open an event stream for the signed-in operator. */
  static async stream(req: AuthenticatedRequest, res: Response): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Defeats proxy buffering, which otherwise holds frames until the
      // response closes and makes the stream look dead.
      'X-Accel-Buffering': 'no',
    });

    /** Write one frame. Named events let the client filter without parsing. */
    const send = (event: { type: string; subject_id: string; at: string }): void => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Tell the client the stream is live, so it can distinguish "connected and
    // quiet" from "never connected".
    res.write(': connected\n\n');

    const unsubscribe = eventStream.subscribe((event) => {
      send({ type: event.type, subject_id: event.subject_id, at: event.at });
    });

    // Idle connections are dropped by proxies and load balancers. A comment
    // frame is the cheapest possible keep-alive and is ignored by EventSource.
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);

    // Both handlers are required: 'close' covers the client navigating away,
    // 'error' covers a broken pipe. Leaking either the listener or the interval
    // would accumulate one of each per page load until the process ran out.
    const teardown = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', teardown);
    req.on('error', teardown);
  }
}
