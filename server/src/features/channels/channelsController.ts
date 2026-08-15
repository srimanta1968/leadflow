import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { verifyAddress, sendDecision, describeConfiguration } from '../../platform/email';
import { degradingRead } from '../../platform/sdkGateway/degradingRead';
import {
  DAILY_AUTOMATED_CAP, DEDUP_WINDOW_MINUTES, ELIGIBILITY_BASES,
  checkSmsEligibility, grantEligibility, logSmsSend, type EligibilityBasis,
} from './smsEligibility';
import { dialCall, recordCallDisposition, CALLING_HOURS } from './voiceService';
import { listTemplates, publishTemplateVersion, TEMPLATE_CATALOG } from './templateLibrary';

/** Email, SMS, voice and the template library. SOP §07, §16-18, §21, §29. */
export const channelRoutes: Router = Router();
export const callRoutes: Router = Router();
export const templateRoutes: Router = Router();

for (const r of [channelRoutes, callRoutes, templateRoutes]) r.use(authenticate);

/**
 * GET /api/leadflow/channels/email/health — can this tenant send at all?
 *
 * SPF, DKIM AND DMARC ARE REPORTED SEPARATELY (AC1 of #119), not as one
 * `verified` flag. They fail for different reasons and are fixed by different
 * DNS records, so a single boolean tells an operator to "fix DNS" — which is not
 * an instruction anybody can follow. `can_send` is the conjunction, computed
 * here so no caller has to remember that all three are required.
 */
channelRoutes.get(
  '/email/health',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const domains = await dataService.query<{
      domain: string; spf_verified: boolean; dkim_verified: boolean; dmarc_verified: boolean;
      last_checked_at: string | null; from_name: string; from_address: string;
      business_name: string; physical_address: string;
    }>(
      `SELECT domain, spf_verified, dkim_verified, dmarc_verified, last_checked_at,
              from_name, from_address, business_name, physical_address
         FROM leadflow_email_domain WHERE tenant_id = $1 ORDER BY domain`,
      [config.projexCloud.tenantId]
    );

    const reputation = await degradingRead<Record<string, unknown> | null>(
      'sdk-deliverability',
      `/api/deliverability/reputation?tenant_id=${encodeURIComponent(config.projexCloud.tenantId)}`,
      null,
      (body) => (body ?? null) as Record<string, unknown> | null
    );

    const rows = domains.map((d) => ({
      domain: d.domain,
      spf_verified: d.spf_verified,
      dkim_verified: d.dkim_verified,
      dmarc_verified: d.dmarc_verified,
      /* AC1 — all three, or the channel does not send. */
      can_send: d.spf_verified && d.dkim_verified && d.dmarc_verified,
      last_checked_at: d.last_checked_at,
      /* AC4 — the identity every commercial email must carry. */
      sender_identity: {
        from_name: d.from_name, from_address: d.from_address,
        business_name: d.business_name, physical_address: d.physical_address,
        unsubscribe: 'A working opt-out link is appended at render time by sdk-deliverability optout-tokens.',
      },
    }));

    res.status(200).json({
      success: true,
      data: {
        domains: rows,
        domain_count: rows.length,
        sendable_domains: rows.filter((r) => r.can_send).length,
        /* Said plainly: a tenant with no verified domain cannot send, and an
           empty list is that state rather than an unknown one. */
        channel_ready: rows.some((r) => r.can_send),
        reputation: reputation.value,
        reputation_available: reputation.available,
        reply_rule: 'An inbound reply pauses the sequence and creates an urgent owner task inside the 15-minute human-response expectation.',
        checks: ['spf', 'dkim', 'dmarc'],
      },
    });
  })
);

/**
 * POST /api/leadflow/channels/email/verify — does this address exist?
 *
 * ASKED BEFORE ANYTHING IS SENT, which is the entire point, and it is the same
 * code the send paths run: platform/email/transport.ts and platform/notify.ts
 * both call checkBeforeSending(), so a screen that shows "we can reach this
 * person" and a send that goes ahead cannot disagree.
 *
 * A POST THAT READS. It takes a body rather than a query string because the
 * bulk form takes a list, and because an address in a URL ends up in access
 * logs and browser history — an email address is personal data and does not
 * belong in either.
 *
 * IT DOES NOT REFUSE RISKY ADDRESSES, it reports them. `allowed` says what the
 * send gate WOULD do with this deployment's policy; `verdict` says what is
 * true about the address. A screen that wants to warn rather than block has
 * both, and neither has been decided on its behalf.
 */
const MAX_BULK_VERIFY = 100;

channelRoutes.post(
  '/email/verify',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as { email?: unknown; emails?: unknown; recheck?: unknown };

    const single = typeof body.email === 'string' ? [body.email] : [];
    const many = Array.isArray(body.emails)
      ? body.emails.filter((e): e is string => typeof e === 'string')
      : [];
    const inputs = [...single, ...many];

    if (inputs.length === 0) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR,
        "Supply 'email' with one address, or 'emails' with a list of them");
    }
    if (inputs.length > MAX_BULK_VERIFY) {
      /* A cap, not a silent truncation: returning 100 verdicts for a list of
         500 would let a caller believe the other 400 were checked and passed. */
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR,
        `At most ${MAX_BULK_VERIFY} addresses can be checked in one call; ${inputs.length} were supplied`);
    }

    const recheck = body.recheck === true;
    const results = await Promise.all(
      inputs.map(async (address) => {
        const verification = await verifyAddress(address, { skipCache: recheck });
        const decision = sendDecision(verification);
        return {
          ...verification,
          allowed: decision.allowed,
          blocked_because: decision.reason,
        };
      })
    );

    res.status(200).json({
      success: true,
      data: {
        results,
        checked: results.length,
        deliverable: results.filter((r) => r.verdict === 'deliverable').length,
        undeliverable: results.filter((r) => r.verdict === 'undeliverable').length,
        risky: results.filter((r) => r.verdict === 'risky').length,
        unknown: results.filter((r) => r.verdict === 'unknown').length,
        would_block: results.filter((r) => !r.allowed).length,
        /* What this deployment is actually checking, returned with every answer
           so an operator reading a surprising verdict does not have to guess
           whether mailbox probing was even on. */
        policy: describeConfiguration(),
      },
    });
  })
);

/**
 * GET /api/leadflow/channels/sms/eligibility — may we text this person?
 *
 * ASKED BEFORE COMPOSING, which is the point. A rep who is told after writing a
 * message that it cannot be sent has wasted the effort and learned nothing; the
 * reason is returned here so the composer can show it up front.
 */
channelRoutes.get(
  '/sms/eligibility',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const subjectRef = (query.subject_ref ?? '').trim();
    const purpose = (query.purpose ?? '').trim();

    if (subjectRef === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
    if (purpose === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'purpose is required — an SMS with no stated purpose cannot be consent-checked');

    const verdict = await checkSmsEligibility({
      subjectRef, purposeKey: purpose,
      recipientTimezone: query.timezone ?? null,
      automated: query.automated !== 'false',
    });

    res.status(200).json({
      success: true,
      data: {
        subject_ref: subjectRef, purpose,
        ...verdict,
        /* AC1 — stated in the response so nobody infers otherwise from a phone
           number being present on the record. */
        number_alone_is_not_permission: true,
        accepted_bases: ELIGIBILITY_BASES,
        daily_cap: DAILY_AUTOMATED_CAP,
        dedup_window_minutes: DEDUP_WINDOW_MINUTES,
        /* AC4 — never silently mark a text as sent. */
        never_silently_sent: 'When SMS is ineligible the caller must send the email and create a call task. Recording an SMS as sent when none went is forbidden.',
      },
    });
  })
);

/** POST /api/leadflow/channels/sms/eligibility — record a basis, with evidence. */
channelRoutes.post(
  '/sms/eligibility',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectRef = typeof body.subject_ref === 'string' ? body.subject_ref.trim() : '';
    const basis = typeof body.basis === 'string' ? body.basis.trim() : '';
    const evidenceRef = typeof body.evidence_ref === 'string' ? body.evidence_ref.trim() : '';
    const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : '';

    if (subjectRef === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
    if (!(ELIGIBILITY_BASES as readonly string[]).includes(basis)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `basis must be one of ${ELIGIBILITY_BASES.join(', ')} — holding a phone number is not one of them`);
    }
    /* Evidence is required, and the CHECK constraint refuses it too: a basis with
       nothing behind it reads as documented while resting on somebody's memory. */
    if (evidenceRef === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'evidence_ref is required — an eligibility basis must point at the evidence for it');
    }
    if (purpose === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'purpose is required');

    const id = await grantEligibility({
      subjectRef, basis: basis as EligibilityBasis, evidenceRef, purposeKey: purpose,
      expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null,
    });
    res.status(201).json({ success: true, data: { eligibility_id: id, subject_ref: subjectRef, basis, purpose } });
  })
);

/**
 * POST /api/leadflow/calls/dial — place a call from the tracking number.
 *
 * TWO GATES BEFORE THE DIAL (AC2 of #121): permitted calling hours and DNC. Both
 * are checked here rather than in the UI, because a disabled button is a
 * courtesy and this is the control.
 *
 * RECORDING IS BLOCKED WITHOUT A VERIFIED CONSENT BASIS (AC1), and the reason is
 * returned rather than the call silently going out unrecorded — a rep who
 * believes a call was recorded and finds later that it was not has lost the
 * evidence they were relying on.
 */
callRoutes.post(
  '/dial',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectRef = typeof body.subject_ref === 'string' ? body.subject_ref.trim() : '';
    const toNumber = typeof body.to_number === 'string' ? body.to_number.trim() : '';

    if (subjectRef === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
    if (toNumber === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'to_number is required');

    const result = await dialCall({
      subjectRef, toNumber,
      repUserId: req.session?.userId ?? null,
      recordingRequested: body.record !== false,
      recipientTimezone: typeof body.timezone === 'string' ? body.timezone : null,
    });

    if (!result.allowed) {
      /* 409 rather than 403: the rep is permitted to call, the RECORD or the
         CLOCK is not in a state that allows it, and the remedy is to wait or to
         fix the number rather than to obtain a permission. */
      throw new AppError(409, ErrorCodes.CONFLICT, result.refusal ?? 'This call cannot be placed');
    }

    res.status(201).json({
      success: true,
      data: {
        call_id: result.callId, subject_ref: subjectRef,
        tracking_number: result.trackingNumber,
        /* AC1 — stated either way, so the rep knows before speaking. */
        recording_permitted: result.recordingPermitted,
        recording_basis: result.recordingBasis,
        recording_refusal: result.recordingRefusal,
        placed: result.placed,
        calling_hours: CALLING_HOURS,
        note: result.recordingPermitted
          ? 'Recording is permitted for this contact and begins with the call.'
          : 'This call is NOT being recorded. The reason is above; do not tell the contact the call is recorded.',
      },
    });
  })
);

/**
 * POST /api/leadflow/calls/:id/disposition — close the loop on a call.
 *
 * EVERY CALL PRODUCES A CRM ACTIVITY WITH A DISPOSITION AND A NEXT (AC3). The
 * NEXT is required here rather than left to the save gate, because a call with
 * no next action is precisely the record that goes quiet.
 */
callRoutes.post(
  '/:id/disposition',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const callId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const disposition = typeof body.disposition === 'string' ? body.disposition.trim() : '';
    const nextAction = typeof body.next_action === 'string' ? body.next_action.trim() : '';

    if (disposition === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'disposition is required');
    if (nextAction === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'next_action is required — a call with no next action is the record that goes quiet');
    }

    const result = await recordCallDisposition({
      callId, disposition, nextAction,
      voicemailTranscript: typeof body.voicemail_transcript === 'string' ? body.voicemail_transcript : null,
      actorUserId: req.session?.userId ?? null,
    });

    if (!result.found) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No call with that id');

    res.status(200).json({
      success: true,
      data: {
        call_id: callId, disposition, next_action: nextAction,
        /* AC4 — the voicemail and the attempt are one event in the timeline. */
        voicemail_logged: result.voicemailLogged,
        attempt_id: result.attemptId,
        crm_activity_recorded: result.crmRecorded,
      },
    });
  })
);

/**
 * GET /api/leadflow/templates — the versioned library.
 *
 * PUBLISHED AND DRAFT ARE DISTINGUISHED. An unpublished version is unusable
 * rather than merely unmarked, so a rep cannot accidentally send copy that
 * nobody approved.
 */
templateRoutes.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const channel = (req.query?.channel as string | undefined)?.trim();
    if (channel && !['email', 'sms', 'voice', 'call_script'].includes(channel)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'channel must be one of email, sms, voice, call_script');
    }
    const templates = await listTemplates(channel ?? null);
    res.status(200).json({
      success: true,
      data: {
        templates,
        template_count: templates.length,
        /* AC1 — the SOP's required set, so a missing one is visible as a gap
           rather than as an absence nobody notices. */
        required_catalog: TEMPLATE_CATALOG,
        expected_email: TEMPLATE_CATALOG.filter((t) => t.channel === 'email').length,
        expected_sms: TEMPLATE_CATALOG.filter((t) => t.channel === 'sms').length,
        /* AC4 — the two rules every template is held to. */
        rules: {
          cta: 'Exactly one call to action. A message asking for two things reliably gets neither, and a CHECK constraint refuses any other count.',
          feature_honesty: 'Copy may not describe a capability as available unless it is. A publish naming an unavailable capability is refused.',
        },
      },
    });
  })
);

/**
 * POST /api/leadflow/templates/:id/publish — the approval gate.
 *
 * ONLY REVOPS MAY PUBLISH (AC2). A Rep may USE approved copy and may not alter
 * it: the refusal is a 403 naming the role, because a rep who edits a template
 * changes what every other rep sends without anybody reviewing it.
 */
templateRoutes.post(
  '/:id/publish',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const templateId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const version = Number(body.version);

    if (!Number.isInteger(version) || version < 1) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'version must be a positive integer');
    }

    const result = await publishTemplateVersion({
      templateId, version,
      publishedBy: req.session?.userId ?? 'unknown',
      role: req.session?.role ?? null,
      approvalRef: typeof body.approval_ref === 'string' ? body.approval_ref : null,
    });

    if (result.refusal) {
      throw new AppError(
        result.refusal.status,
        result.refusal.status === 403 ? ErrorCodes.FORBIDDEN : ErrorCodes.VALIDATION_ERROR,
        result.refusal.message
      );
    }
    if (!result.found) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No template version with that id and version');

    res.status(200).json({
      success: true,
      data: {
        template_id: templateId, version, published: true,
        published_by: req.session?.userId ?? 'unknown',
        approval_ref: result.approvalRef,
        note: 'The previous published version is retained. What was sent last month stays readable.',
      },
    });
  })
);

/** Log an SMS send against the cap. Called by the sequence executor. */
channelRoutes.post(
  '/sms/sent',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectRef = typeof body.subject_ref === 'string' ? body.subject_ref.trim() : '';
    if (subjectRef === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
    await logSmsSend({
      subjectRef,
      templateKey: typeof body.template_key === 'string' ? body.template_key : null,
      automated: body.automated !== false,
    });
    res.status(201).json({ success: true, data: { subject_ref: subjectRef, logged: true } });
  })
);

/** Health of the voice channel: which tracking numbers exist. */
channelRoutes.get(
  '/voice/tracking-numbers',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const rows = await dataService.query<{ phone_number: string; source_key: string | null; campaign_ref: string | null; released_at: string | null }>(
      `SELECT phone_number, source_key, campaign_ref, released_at
         FROM leadflow_tracking_number WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [config.projexCloud.tenantId]
    );
    const upstream = await degradingRead<unknown[]>(
      'connector-twilio-voice', '/api/voice/tracking-numbers', [],
      (body) => { const bag = (body ?? {}) as Record<string, unknown>; return Array.isArray(bag.numbers) ? bag.numbers : []; }
    );
    res.status(200).json({
      success: true,
      data: {
        numbers: rows, number_count: rows.length,
        active: rows.filter((r) => !r.released_at).length,
        upstream_available: { voice: upstream.available },
        note: 'A tracking number per source or campaign means an inbound call carries its own attribution rather than needing the caller to be asked.',
      },
    });
  })
);

void SdkGatewayClient;
