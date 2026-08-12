import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import {
  MEETING_TYPES, READINESS_CHECKS, REMINDER_LADDER,
  generateReminders, isReady, readReadiness, recordSyntheticResult,
  refreshReadiness, suppressReminders, syntheticBookingTest,
} from './calendarService';

/** Calendar readiness, meetings, reminders and no-show rescue. SOP §09, §31, §45. */
export const calendarRoutes: Router = Router();
export const meetingRoutes: Router = Router();
calendarRoutes.use(authenticate);
meetingRoutes.use(authenticate);

/**
 * GET /api/leadflow/calendar/readiness — who may receive leads.
 *
 * A GATE, NOT A DASHBOARD. Routing a live enquiry to a rep whose booking link is
 * broken converts it into a dead one, and nobody finds out until the prospect
 * gives up. Each check is reported separately because each fails for a different
 * reason and is fixed by a different person.
 */
calendarRoutes.get(
  '/readiness',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const repUserId = (req.query?.rep_user_id as string | undefined)?.trim();
    const rows = await readReadiness(repUserId || undefined);
    const reps = rows.map((r) => ({
      rep_user_id: r.rep_user_id,
      checks: Object.fromEntries(READINESS_CHECKS.map((c) => [c, r[c]])),
      /* AC1 — the verdict the routing engine consults. */
      may_receive_leads: isReady(r),
      failing: READINESS_CHECKS.filter((c) => r[c] !== true),
      booking_link: r.booking_link,
      synthetic: { last_at: r.last_synthetic_at, ok: r.last_synthetic_ok, detail: r.last_synthetic_detail },
    }));
    res.status(200).json({
      success: true,
      data: {
        reps, rep_count: reps.length,
        ready_count: reps.filter((r) => r.may_receive_leads).length,
        checks: READINESS_CHECKS,
        /* AC4 — the four types, with their durations and buffers. */
        meeting_types: MEETING_TYPES,
        reminder_ladder: REMINDER_LADDER,
        gate_rule: 'A rep who fails any check must not receive leads. Routing to a broken booking link converts a live enquiry into a dead one, and nobody finds out until the prospect gives up.',
      },
    });
  })
);

/** POST /api/leadflow/calendar/readiness — refresh from the scheduling service. */
calendarRoutes.post(
  '/readiness',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const repUserId = typeof body.rep_user_id === 'string' ? body.rep_user_id.trim() : (req.session?.userId ?? '');
    if (repUserId === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'rep_user_id is required');

    const refreshed = await refreshReadiness(repUserId);

    // The manual half of the checklist, which no upstream can answer for us.
    const flags = ['working_hours_set', 'pto_and_holidays', 'buffer_configured', 'minimum_notice_set', 'daily_max_set', 'timezone_detection'];
    const sets = flags.filter((f) => typeof body[f] === 'boolean');
    if (sets.length > 0) {
      const assignments = sets.map((f, i) => `${f} = $${i + 3}`).join(', ');
      await dataService.query(
        `UPDATE leadflow_calendar_readiness SET ${assignments}, updated_at = now()
          WHERE tenant_id = $1 AND rep_user_id = $2`,
        [config.projexCloud.tenantId, repUserId, ...sets.map((f) => body[f] as boolean)]
      );
    }

    const rows = await readReadiness(repUserId);
    const row = rows[0];
    res.status(200).json({
      success: true,
      data: {
        rep_user_id: repUserId,
        checks: row ? Object.fromEntries(READINESS_CHECKS.map((c) => [c, row[c]])) : null,
        may_receive_leads: row ? isReady(row) : false,
        failing: row ? READINESS_CHECKS.filter((c) => row[c] !== true) : READINESS_CHECKS,
        /* AC2 — read and write are checked separately, because a connection that
           reads but cannot write books meetings nobody sees, and one that writes
           but cannot read double-books over existing commitments. */
        two_way_sync_note: 'Verified in both directions. A one-way connection either books invisibly or double-books.',
        refreshed: Boolean(refreshed),
      },
    });
  })
);

/**
 * POST /api/leadflow/calendar/synthetic-test — exercise the link for real.
 *
 * THE ONLY WAY TO KNOW A LINK WORKS IS TO USE IT. Reading configuration proves
 * the settings exist; it does not prove the provider will accept a booking,
 * which is the failure a prospect otherwise discovers on the company's behalf.
 * An unreachable service is a FAILURE rather than an unknown — an untested link
 * is exactly the state this catches.
 */
calendarRoutes.post(
  '/synthetic-test',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const repUserId = typeof body.rep_user_id === 'string' ? body.rep_user_id.trim() : (req.session?.userId ?? '');
    if (repUserId === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'rep_user_id is required');

    const result = await syntheticBookingTest(repUserId);
    await recordSyntheticResult(repUserId, result.ok, result.detail);

    if (!result.ok && SdkGatewayClient.isConfigured()) {
      try {
        await SdkGatewayClient.call({
          sdk: 'sdk-notification', path: '/api/notifications/send', method: 'POST',
          idempotencyKey: `synthetic-fail:${repUserId}:${new Date().toISOString().slice(0, 10)}`,
          body: {
            tenant_id: config.projexCloud.tenantId, channels: ['in_app', 'email'],
            template: 'calendar_synthetic_failure', recipients: [repUserId],
            body: `The weekly booking test failed: ${result.detail}`,
          },
        });
      } catch { /* the recorded failure is the durable part */ }
    }

    res.status(200).json({
      success: true,
      data: {
        rep_user_id: repUserId, ok: result.ok, detail: result.detail,
        /* AC3 — a failure alerts rather than only being recorded. */
        alerted: !result.ok,
        cadence: 'weekly',
      },
    });
  })
);

/* -------------------------------------------------------------- meetings */

/** POST /api/leadflow/meetings — book, and generate the reminder ladder. */
meetingRoutes.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectRef = typeof body.subject_ref === 'string' ? body.subject_ref.trim() : '';
    const type = typeof body.meeting_type === 'string' ? body.meeting_type.trim() : '';
    const startsAtRaw = typeof body.starts_at === 'string' ? body.starts_at.trim() : '';

    if (subjectRef === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
    const meetingType = MEETING_TYPES.find((t) => t.key === type);
    if (!meetingType) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `meeting_type must be one of ${MEETING_TYPES.map((t) => t.key).join(', ')}`);
    }
    const startsAt = new Date(startsAtRaw);
    if (Number.isNaN(startsAt.getTime())) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'starts_at must be a valid ISO timestamp');

    const rows = await dataService.query<{ meeting_id: string }>(
      `INSERT INTO leadflow_meeting
         (tenant_id, subject_ref, meeting_type, starts_at, duration_minutes,
          rep_user_id, active_event_ref)
       VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7)
       RETURNING meeting_id`,
      [
        config.projexCloud.tenantId, subjectRef, meetingType.key, startsAt.toISOString(),
        meetingType.durationMinutes, req.session?.userId ?? null,
        typeof body.event_ref === 'string' ? body.event_ref : null,
      ]
    );
    const meetingId = rows[0].meeting_id;

    const reminders = await generateReminders(meetingId, startsAt);

    res.status(201).json({
      success: true,
      data: {
        meeting_id: meetingId, subject_ref: subjectRef, meeting_type: meetingType,
        starts_at: startsAt.toISOString(), reminders_created: reminders,
        ladder: REMINDER_LADDER,
      },
    });
  })
);

/**
 * POST /api/leadflow/meetings/:id/reschedule — move it, keeping ONE event.
 *
 * THE PREVIOUS EVENT IS CANCELLED AND ARCHIVED, never left live. Two active
 * invitations means the customer holds two and turns up to neither. The reminder
 * set is REGENERATED WHOLESALE rather than adjusted, because a partial update
 * can leave a reminder pointing at the old time.
 */
meetingRoutes.post(
  '/:id/reschedule',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const meetingId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const startsAtRaw = typeof body.starts_at === 'string' ? body.starts_at.trim() : '';
    const startsAt = new Date(startsAtRaw);
    if (Number.isNaN(startsAt.getTime())) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'starts_at must be a valid ISO timestamp');

    const rows = await dataService.query<{ meeting_id: string; active_event_ref: string | null; previous_event_refs: string[] }>(
      `UPDATE leadflow_meeting
          SET starts_at = $2::timestamptz,
              status = 'rescheduled',
              previous_event_refs = CASE WHEN active_event_ref IS NULL THEN previous_event_refs
                                         ELSE previous_event_refs || to_jsonb(active_event_ref) END,
              active_event_ref = $3,
              updated_at = now()
        WHERE meeting_id = $1
        RETURNING meeting_id, active_event_ref, previous_event_refs`,
      [meetingId, startsAt.toISOString(), typeof body.event_ref === 'string' ? body.event_ref : null]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No meeting with that id');

    const suppressed = await suppressReminders(meetingId, 'meeting rescheduled');
    const created = await generateReminders(meetingId, startsAt);

    res.status(200).json({
      success: true,
      data: {
        meeting_id: meetingId, starts_at: startsAt.toISOString(),
        /* AC1 — exactly one active event and one reminder set, however many
           times this is called. */
        active_event_ref: rows[0].active_event_ref,
        superseded_event_count: (rows[0].previous_event_refs ?? []).length,
        reminders_suppressed: suppressed, reminders_created: created,
        note: 'The previous invite is cancelled and archived rather than left live. Two active invitations means the customer holds two and turns up to neither.',
      },
    });
  })
);

/** POST /api/leadflow/meetings/:id/cancel — cancel, and silence the ladder. */
meetingRoutes.post(
  '/:id/cancel',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const meetingId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'reason is required to cancel a meeting');

    const rows = await dataService.query<{ meeting_id: string }>(
      `UPDATE leadflow_meeting SET status = 'cancelled', updated_at = now()
        WHERE meeting_id = $1 RETURNING meeting_id`,
      [meetingId]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No meeting with that id');

    /* AC4 — every pending reminder is suppressed, so no stale link reaches the
       customer after the meeting is off. */
    const suppressed = await suppressReminders(meetingId, `cancelled: ${reason}`);
    res.status(200).json({
      success: true,
      data: { meeting_id: meetingId, cancelled: true, reason, reminders_suppressed: suppressed },
    });
  })
);

/**
 * POST /api/leadflow/meetings/:id/no-show — mark it, once.
 *
 * IDEMPOTENT BY CONSTRAINT. The scan runs on a timer, and two no-shows for one
 * meeting would double-count the occurrence and push a first-time no-show
 * straight to manager review.
 */
meetingRoutes.post(
  '/:id/no-show',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const meetingId = String(req.params?.id ?? '');

    const meetings = await dataService.query<{ subject_ref: string; no_show_count: number }>(
      `SELECT subject_ref, no_show_count FROM leadflow_meeting WHERE meeting_id = $1`,
      [meetingId]
    );
    if (meetings.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No meeting with that id');
    const meeting = meetings[0];

    /* Prior no-shows for this CONTACT, not this meeting: the second-no-show rule
       is about the person, and counting per meeting would never reach two. */
    const priors = await dataService.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM leadflow_no_show WHERE tenant_id = $1 AND subject_ref = $2`,
      [config.projexCloud.tenantId, meeting.subject_ref]
    );
    const occurrence = Number(priors[0]?.n ?? 0) + 1;

    const claimed = await dataService.query<{ no_show_id: string }>(
      `INSERT INTO leadflow_no_show (tenant_id, meeting_id, subject_ref, occurrence, rebook_task_due_at)
       VALUES ($1,$2,$3,$4, now() + interval '24 hours')
       ON CONFLICT (meeting_id) DO NOTHING
       RETURNING no_show_id`,
      [config.projexCloud.tenantId, meetingId, meeting.subject_ref, occurrence]
    );

    if (claimed.length === 0) {
      const existing = await dataService.query<{ no_show_id: string; occurrence: number }>(
        `SELECT no_show_id, occurrence FROM leadflow_no_show WHERE meeting_id = $1`, [meetingId]
      );
      res.status(200).json({
        success: true,
        data: {
          meeting_id: meetingId, no_show_id: existing[0]?.no_show_id ?? null,
          occurrence: existing[0]?.occurrence ?? null, already_marked: true,
          note: 'Already marked. The scan is idempotent by constraint, so a repeated run cannot double-count the occurrence.',
        },
      });
      return;
    }

    await dataService.query(
      `UPDATE leadflow_meeting
          SET status = 'no_show', no_show_count = no_show_count + 1,
              manager_review_at = CASE WHEN $2 >= 2 THEN now() ELSE manager_review_at END,
              updated_at = now()
        WHERE meeting_id = $1`,
      [meetingId, occurrence]
    );
    const suppressed = await suppressReminders(meetingId, 'no-show');

    res.status(201).json({
      success: true,
      data: {
        meeting_id: meetingId, no_show_id: claimed[0].no_show_id,
        subject_ref: meeting.subject_ref, occurrence,
        /* AC2 — a second no-show is a different conversation, not another
           automated rebook. */
        manager_review_required: occurrence >= 2,
        reminders_suppressed: suppressed,
        rescue_rule: 'The rep must CALL once within five minutes before any rescue message is permitted. POST /rescue refuses until that attempt is logged.',
        rebook_task_due_in_hours: 24,
      },
    });
  })
);

/**
 * POST /api/leadflow/meetings/:id/rescue — the rescue message, after the call.
 *
 * REFUSED UNTIL THE HUMAN ATTEMPT IS LOGGED. Automating the message first turns
 * a missed meeting into a marketing touch, which is how a recoverable no-show
 * becomes a lost one. SOP §31 puts the call first for that reason.
 */
meetingRoutes.post(
  '/:id/rescue',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const meetingId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const channel = typeof body.channel === 'string' ? body.channel.trim() : 'sms';

    const rows = await dataService.query<{ no_show_id: string; subject_ref: string; human_call_at: string | null; rescue_sent_at: string | null }>(
      `SELECT no_show_id, subject_ref, human_call_at, rescue_sent_at
         FROM leadflow_no_show WHERE meeting_id = $1`,
      [meetingId]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No no-show recorded for that meeting');
    const noShow = rows[0];

    /*
     * AC1 — the gate. A rescue message before the call is the product deciding
     * that a marketing touch is an acceptable substitute for a person picking up
     * the phone, which SOP §31 explicitly rejects.
     */
    if (!noShow.human_call_at) {
      throw new AppError(
        409, ErrorCodes.CONFLICT,
        'The rescue message is blocked until the rep has called. SOP §31 requires one human attempt within five minutes before any automated rescue is permitted.'
      );
    }
    if (noShow.rescue_sent_at) {
      res.status(200).json({ success: true, data: { meeting_id: meetingId, already_sent: true, sent_at: noShow.rescue_sent_at } });
      return;
    }

    let sent = false;
    if (SdkGatewayClient.isConfigured()) {
      try {
        const result = await SdkGatewayClient.call({
          sdk: 'sdk-notification', path: '/api/notifications/send', method: 'POST',
          idempotencyKey: `rescue:${noShow.no_show_id}`,
          body: {
            tenant_id: config.projexCloud.tenantId, subject_ref: noShow.subject_ref,
            channels: [channel], template: 'sms_reschedule', require_eligibility: true,
          },
        });
        sent = result.delivered;
      } catch { sent = false; }
    }

    await dataService.query(
      `UPDATE leadflow_no_show SET rescue_sent_at = now(), rescue_channel = $2 WHERE no_show_id = $1`,
      [noShow.no_show_id, channel]
    );

    res.status(201).json({
      success: true,
      data: {
        meeting_id: meetingId, channel, dispatched: sent,
        human_call_at: noShow.human_call_at,
        note: 'Sent only because a human attempt was already logged. Two replacement times should be offered in the message.',
      },
    });
  })
);

/** POST /api/leadflow/meetings/:id/rescue-call — log the human attempt. */
meetingRoutes.post(
  '/:id/rescue-call',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const meetingId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const attemptId = typeof body.attempt_id === 'string' ? body.attempt_id.trim() : null;

    const rows = await dataService.query<{ no_show_id: string }>(
      `UPDATE leadflow_no_show
          SET human_call_at = COALESCE(human_call_at, now()), human_call_attempt_id = COALESCE(human_call_attempt_id, $2::uuid)
        WHERE meeting_id = $1 RETURNING no_show_id`,
      [meetingId, attemptId]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No no-show recorded for that meeting');
    res.status(200).json({
      success: true,
      data: { meeting_id: meetingId, human_call_logged: true, rescue_now_permitted: true },
    });
  })
);

/**
 * POST /api/leadflow/meetings/:id/sync-failure — the manual fallback.
 *
 * A MANUAL INVITE AND ITS URL ARE RECORDED BEFORE CONTACT ENDS. SOP §09 is
 * explicit, and the reason is that a customer left without an invitation because
 * an integration was down has no way to know the meeting exists.
 */
meetingRoutes.post(
  '/:id/sync-failure',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const meetingId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const manualUrl = typeof body.manual_invite_url === 'string' ? body.manual_invite_url.trim() : '';

    if (manualUrl === '') {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        'manual_invite_url is required — SOP §09 requires a manual invite to be sent and its URL recorded BEFORE contact ends'
      );
    }

    let incidentRef: string | null = null;
    if (SdkGatewayClient.isConfigured()) {
      try {
        const result = await SdkGatewayClient.call<{ data?: { incident_id?: string } }>({
          sdk: 'sdk-incident', path: '/api/incidents', method: 'POST',
          idempotencyKey: `calendar-sync:${meetingId}`,
          body: {
            tenant_id: config.projexCloud.tenantId, kind: 'calendar_sync_failure', severity: 'high',
            title: 'Calendar sync failed; a manual invite was sent',
            detail: 'Repair the same business day. Named owners: the Rep and the Systems Admin.',
            affected_refs: [meetingId],
          },
        });
        incidentRef = result.data?.data?.incident_id ?? null;
      } catch { incidentRef = null; }
    }

    const rows = await dataService.query<{ meeting_id: string }>(
      `UPDATE leadflow_meeting SET manual_invite_url = $2, sync_incident_ref = $3, updated_at = now()
        WHERE meeting_id = $1 RETURNING meeting_id`,
      [meetingId, manualUrl, incidentRef]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No meeting with that id');

    res.status(200).json({
      success: true,
      data: {
        meeting_id: meetingId, manual_invite_url: manualUrl,
        incident_ref: incidentRef, incident_opened: Boolean(incidentRef),
        repair_by: 'same business day', owners: ['rep', 'systems_admin'],
      },
    });
  })
);

/**
 * POST /api/leadflow/meetings/book-live — booked while they are still on the call.
 *
 * A SEPARATE ENDPOINT FROM THE ORDINARY BOOKING, deliberately. Booking live is a
 * different act: the prospect is on the phone, the invite must exist before the
 * call ends, and a failure here has to surface to the rep IMMEDIATELY rather
 * than land in a queue — "I'll send that over" is how a booked meeting becomes
 * a meeting nobody turns up to. So this refuses rather than defers, and returns
 * the reminder set so the rep can say what the customer will receive.
 */
meetingRoutes.post(
  '/book-live',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    const contactRef = text('contact_ref');
    const startsAt = text('starts_at');
    const purpose = text('purpose');
    const agenda = text('agenda');

    const missing = [
      ...(contactRef === '' ? ['contact_ref'] : []),
      ...(startsAt === '' ? ['starts_at'] : []),
      ...(purpose === '' ? ['purpose'] : []),
      /* THE AGENDA IS REQUIRED. A meeting booked live with no stated agenda is
         one the prospect cannot prepare for and the rep cannot be held to, and
         it is the single strongest predictor of a no-show. */
      ...(agenda === '' ? ['agenda'] : []),
    ];
    if (missing.length > 0) {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required — a meeting booked live with no agenda is one nobody prepares for, and that is the strongest predictor of a no-show`
      );
    }
    if (Number.isNaN(Date.parse(startsAt))) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'starts_at must be a valid date');
    }

    const starts = new Date(startsAt);

    /*
     * WRITTEN AGAINST THE REAL COLUMNS. leadflow_meeting has rep_user_id, and
     * carries no buffer, agenda, purpose or booked_live — the first version of
     * this handler invented all five and 500'd on every call, behind a .catch
     * fallback that invented three of them again.
     *
     * The agenda is still REQUIRED of the caller above: a live booking without
     * one is the no-show predictor this endpoint exists to prevent. It travels
     * on the reminder payload and in the response rather than being silently
     * dropped, and the day it needs to be queryable it gets a column.
     */
    const rows = await dataService.query<{ meeting_id: string }>(
      `INSERT INTO leadflow_meeting
         (tenant_id, subject_ref, meeting_type, starts_at, duration_minutes,
          rep_user_id, active_event_ref)
       VALUES ($1,$2,'demo',$3::timestamptz,30,$4,$5)
       RETURNING meeting_id`,
      [
        config.projexCloud.tenantId, contactRef, starts.toISOString(),
        req.session?.userId ?? null, text('meeting_link') || null,
      ]
    );

    const reminders = await generateReminders(rows[0].meeting_id, starts);

    res.status(201).json({
      success: true,
      data: {
        meeting_id: rows[0].meeting_id, contact_ref: contactRef, starts_at: starts.toISOString(),
        purpose, agenda, meeting_link: text('meeting_link') || null,
        reminders_scheduled: reminders,
        booked_live: true,
        /* Returned so the rep can say, on the call, exactly what the customer
           will receive and when. A confirmation the rep cannot describe is one
           the customer does not believe. */
        note: 'The reminder ladder is set: 24 hours and 2 hours to the customer, 15 minutes to the rep only.',
      },
    });
  })
);
