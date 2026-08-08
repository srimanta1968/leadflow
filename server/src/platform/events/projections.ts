/**
 * The pipeline projection, expressed as a PURE FOLD.
 *
 * `apply(state, event)` takes the current row and one event and returns the next
 * row. No database, no clock, no randomness — which is exactly what makes the
 * acceptance criterion provable rather than hopeful: if the next state is a pure
 * function of (previous state, event), then replaying the same events in the
 * same order gives byte-identical output, and a consumer killed mid-stream and
 * restarted cannot land anywhere else.
 *
 * The I/O lives in consumer.ts. Keeping it out of here is the whole design: a
 * handler that reaches for `NOW()` or issues its own query is one that can no
 * longer be replayed, and it stops being replayable silently.
 *
 * EVENT TYPES ARE THE PRODUCER'S. They are transcribed from the SDKs named in
 * the task — sdk-crm, sdk-payment, sdk-scheduling, sdk-deliverability,
 * sdk-notification, sdk-sequence, sdk-sla, sdk-identity-resolver, sdk-handoff —
 * and an unrecognised type is IGNORED rather than treated as an error, because
 * ProjexCloud adding an event type must not dead-letter a stream LeadFlow is
 * otherwise handling correctly.
 */

export interface PipelineState {
  subjectId: string;
  subjectType: string;
  tenantId: string | null;
  stageKey: string | null;
  stageEnteredAt: string | null;
  ownerId: string | null;
  backupOwnerId: string | null;
  slaState: string | null;
  slaDueAt: string | null;
  nextAction: string | null;
  nextActionDueAt: string | null;
  bookingState: string | null;
  bookingAt: string | null;
  paymentState: string | null;
  lastReplyAt: string | null;
  lastReplyChannel: string | null;
  closeReasonKey: string | null;
  lastEventId: string | null;
  lastSequence: number;
}

export interface DomainEvent {
  eventId: string;
  eventType: string;
  sequence: number;
  occurredAt: string | null;
  subjectType: string | null;
  subjectId: string | null;
  tenantId: string | null;
  payload: Record<string, unknown>;
}

export function emptyState(subjectId: string, subjectType: string, tenantId: string | null): PipelineState {
  return {
    subjectId,
    subjectType,
    tenantId,
    stageKey: null,
    stageEnteredAt: null,
    ownerId: null,
    backupOwnerId: null,
    slaState: null,
    slaDueAt: null,
    nextAction: null,
    nextActionDueAt: null,
    bookingState: null,
    bookingAt: null,
    paymentState: null,
    lastReplyAt: null,
    lastReplyChannel: null,
    closeReasonKey: null,
    lastEventId: null,
    lastSequence: 0,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Every event type this projection reacts to, and which SDK produces it. */
export const HANDLED_EVENT_TYPES: Record<string, string> = {
  'crm.deal.stage_changed.v1': 'sdk-crm',
  'crm.deal.closed_won.v1': 'sdk-crm',
  'crm.deal.closed_lost.v1': 'sdk-crm',
  'assignment.owner_assigned.v1': 'sdk-assignment',
  'sla.rung_fired.v1': 'sdk-sla',
  'sla.breached.v1': 'sdk-sla',
  'scheduling.booking_created.v1': 'sdk-scheduling',
  'scheduling.booking_rescheduled.v1': 'sdk-scheduling',
  'scheduling.booking_no_show.v1': 'sdk-scheduling',
  'payment.succeeded.v1': 'sdk-payment',
  'payment.failed.v1': 'sdk-payment',
  'deliverability.reply_received.v1': 'sdk-deliverability',
  'deliverability.bounced.v1': 'sdk-deliverability',
  'deliverability.complaint.v1': 'sdk-deliverability',
  'notification.inbound_sms.v1': 'sdk-notification',
  'sequence.enrollment_paused.v1': 'sdk-sequence',
  'identity.records_merged.v1': 'sdk-identity-resolver',
  'handoff.accepted.v1': 'sdk-handoff',
  'handoff.rejected.v1': 'sdk-handoff',
};

/**
 * Fold one event into the state.
 *
 * OUT-OF-ORDER EVENTS ARE DROPPED, not applied. A delivery that arrives after a
 * later one has already been folded would otherwise move the row BACKWARDS — a
 * lead that reached Closed Won reverting to Contacted because a delayed
 * stage_changed finally landed. The sequence guard is what makes at-least-once
 * delivery safe in an order the producer never promised.
 */
export function apply(state: PipelineState, event: DomainEvent): PipelineState {
  if (event.sequence <= state.lastSequence) return state;

  const p = event.payload;
  const at = event.occurredAt;
  const next: PipelineState = {
    ...state,
    lastEventId: event.eventId,
    lastSequence: event.sequence,
    tenantId: state.tenantId ?? event.tenantId,
  };

  switch (event.eventType) {
    case 'crm.deal.stage_changed.v1':
      next.stageKey = str(p.to_stage) ?? str(p.stage) ?? state.stageKey;
      next.stageEnteredAt = at;
      // A stage move clears the close reason: a record that has moved on is no
      // longer closed, and leaving the reason makes a reopened deal read as lost.
      next.closeReasonKey = null;
      return next;

    case 'crm.deal.closed_won.v1':
      next.stageKey = 'CLOSED_WON_ONBOARDING_PENDING';
      next.stageEnteredAt = at;
      next.closeReasonKey = str(p.reason_key) ?? 'WON_STANDARD';
      return next;

    case 'crm.deal.closed_lost.v1':
      next.stageKey = 'CLOSED_LOST';
      next.stageEnteredAt = at;
      next.closeReasonKey = str(p.reason_key) ?? 'LOST_NO_CONTACT';
      return next;

    case 'assignment.owner_assigned.v1':
      next.ownerId = str(p.owner_id) ?? state.ownerId;
      next.backupOwnerId = str(p.backup_owner_id) ?? state.backupOwnerId;
      return next;

    case 'sla.rung_fired.v1':
      next.slaState = str(p.rung) ?? 'at_risk';
      next.slaDueAt = str(p.due_at) ?? state.slaDueAt;
      return next;

    case 'sla.breached.v1':
      next.slaState = 'breached';
      next.slaDueAt = str(p.due_at) ?? state.slaDueAt;
      return next;

    case 'scheduling.booking_created.v1':
    case 'scheduling.booking_rescheduled.v1':
      next.bookingState = 'booked';
      next.bookingAt = str(p.starts_at) ?? state.bookingAt;
      return next;

    case 'scheduling.booking_no_show.v1':
      // The TIME is kept. "They did not attend the 3pm on Tuesday" is the useful
      // statement; blanking it leaves only "no show", which nobody can act on.
      next.bookingState = 'no_show';
      return next;

    case 'payment.succeeded.v1':
      next.paymentState = 'paid';
      return next;

    case 'payment.failed.v1':
      next.paymentState = 'failed';
      return next;

    case 'deliverability.reply_received.v1':
    case 'notification.inbound_sms.v1':
      next.lastReplyAt = at;
      next.lastReplyChannel =
        event.eventType === 'notification.inbound_sms.v1' ? 'sms' : (str(p.channel) ?? 'email');
      // A reply is the signal a sequence must stop on. Recorded here so the
      // queue can show it even if the pause event has not arrived yet.
      next.slaState = state.slaState === 'breached' ? 'breached' : 'responded';
      return next;

    case 'deliverability.bounced.v1':
      next.lastReplyChannel = 'bounced';
      return next;

    case 'deliverability.complaint.v1':
      // A complaint is not a reply and must never look like engagement.
      next.lastReplyChannel = 'complaint';
      return next;

    case 'sequence.enrollment_paused.v1':
      next.nextAction = str(p.reason) ?? 'Sequence paused';
      next.nextActionDueAt = str(p.resume_at) ?? null;
      return next;

    case 'identity.records_merged.v1':
      // The LOSING record points at the winner. The projection row for the
      // loser is kept rather than deleted, because a screen holding the old id
      // must still resolve to something rather than 404.
      next.subjectType = 'merged';
      next.nextAction = `Merged into ${str(p.winner_id) ?? 'another record'}`;
      return next;

    case 'handoff.accepted.v1':
      next.ownerId = str(p.to_owner_id) ?? state.ownerId;
      next.nextAction = null;
      return next;

    case 'handoff.rejected.v1':
      // Ownership does NOT move. The rejection is recorded as the next action so
      // the queue shows it needs re-routing rather than silently sitting with
      // somebody who declined it.
      next.nextAction = `Handoff rejected: ${str(p.reason) ?? 'no reason given'}`;
      return next;

    default:
      // Unrecognised. The sequence still advances so the checkpoint moves past
      // it — an event we do not care about must not stall the stream, and it is
      // not an error worth dead-lettering.
      return next;
  }
}

/** Fold a whole stream. The replay tool and the tests both use this. */
export function fold(events: DomainEvent[], initial?: PipelineState): PipelineState | null {
  let state = initial ?? null;
  for (const event of events) {
    if (!event.subjectId) continue;
    if (!state) state = emptyState(event.subjectId, event.subjectType ?? 'lead', event.tenantId);
    state = apply(state, event);
  }
  return state;
}
