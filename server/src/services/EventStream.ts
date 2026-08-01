import { EventEmitter } from 'events';

/** Kinds of change the UI can react to. */
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
  | 'sla_policy.changed'
  /** An escalation was raised. Emitted once per new alert row. */
  | 'sla_alert.raised';

export interface LeadEvent {
  type: LeadEventType;
  /** The subject the change happened to. */
  subject_id: string;
  /** Emitted at, so a client can discard an event older than its own state. */
  at: string;
  /** Minimal payload — the client re-reads the projection rather than trusting this. */
  detail?: Record<string, unknown>;
}

/**
 * In-process publish/subscribe for UI push notifications.
 *
 * Deliberately minimal, and deliberately NOT the durable event backbone. Two
 * limitations a reader must know about:
 *
 *  1. SINGLE INSTANCE ONLY. Subscribers are held in this process's memory, so
 *     behind more than one server replica a client connected to replica A never
 *     sees an event published on replica B. The durable, cross-instance path is
 *     the transactional outbox and event subscriber that the composition-layer
 *     epic owns; this is the interim mechanism so the Capture Inbox stops
 *     needing a manual refresh.
 *  2. AT-MOST-ONCE. Nothing is persisted or replayed. An event emitted while a
 *     client is disconnected is simply lost, which is safe here ONLY because the
 *     event carries no state — it is a hint to re-read, and the projection
 *     remains the source of truth. Never make a client's correctness depend on
 *     receiving one of these.
 */
class EventStream {
  private readonly emitter = new EventEmitter();

  constructor() {
    // A single SSE endpoint can accumulate many concurrent listeners; the
    // default cap of 10 would log spurious leak warnings.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Publish a change.
   *
   * Never throws: a failing subscriber must not break the request that caused
   * the event. Publishing is a side effect of doing the work, not part of it.
   */
  publish(event: Omit<LeadEvent, 'at'>): void {
    try {
      this.emitter.emit('event', { ...event, at: new Date().toISOString() } satisfies LeadEvent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[EventStream] publish failed:', message);
    }
  }

  /**
   * Subscribe to every change.
   * @returns An unsubscribe function the caller MUST invoke on disconnect.
   */
  subscribe(listener: (event: LeadEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }

  /** Current subscriber count, surfaced on /health for diagnosis. */
  subscriberCount(): number {
    return this.emitter.listenerCount('event');
  }
}

export const eventStream = new EventStream();
