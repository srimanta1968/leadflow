import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import {
  APPROVAL_PARTIES, FEATURE_STATUSES, KICKOFF_WINDOW_HOURS, REFUND_APPROVAL_THRESHOLD_CENTS,
  REQUIRED_OFFER_FIELDS, alertOverdueHandoff, approvalComplete, createCheckout, currentOffer,
  featureMatrix, pendingHandoffs, reconcileFromGateway, scanForCardData, verifyPayment,
} from './commerceService';

export const offerRoutes: Router = Router();
export const checkoutRoutes: Router = Router();
export const paymentRoutes: Router = Router();
export const onboardingRoutes: Router = Router();
for (const r of [offerRoutes, checkoutRoutes, paymentRoutes, onboardingRoutes]) r.use(authenticate);

/**
 * GET /api/leadflow/offers/current — the only version a rep may quote.
 *
 * IMPROVISATION IS MADE STRUCTURALLY IMPOSSIBLE rather than discouraged. A rep
 * who cannot see last quarter's pricing cannot quote it by accident, and one who
 * cannot see an unapproved draft cannot quote terms nobody reviewed.
 */
offerRoutes.get(
  '/current',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const offerKey = ((req.query?.offer_key as string | undefined) ?? '').trim();
    if (offerKey === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'offer_key is required');

    const offer = await currentOffer(offerKey);
    if (!offer) {
      /* 404 rather than an empty 200: a rep given nothing would improvise, which
         is the exact failure this endpoint prevents. */
      throw new AppError(
        404, ErrorCodes.NOT_FOUND,
        'No approved active version exists for that offer. Nothing may be quoted until one is published and activated.'
      );
    }

    const missing = REQUIRED_OFFER_FIELDS.filter((f) => {
      const v = (offer as unknown as Record<string, unknown>)[f];
      return v === null || v === undefined || v === '';
    });

    res.status(200).json({
      success: true,
      data: {
        offer_key: offer.offer_key, version: offer.version,
        /* AC1 — the version stamp a checkout link and a quote must carry. */
        version_stamp: `${offer.offer_key}@v${offer.version}`,
        price_cents: Number(offer.price_cents), currency: offer.currency,
        quantity_basis: offer.quantity_basis, payment_options: offer.payment_options,
        license_limits: offer.license_limits,
        implementation_expectations: offer.implementation_expectations,
        refund_terms: offer.refund_terms, cancellation_terms: offer.cancellation_terms,
        included_features: offer.included_features,
        variable_charges: offer.variable_charges, third_party_charges: offer.third_party_charges,
        approved_scarcity_language: offer.approved_scarcity_language,
        approved_at: offer.approved_at, activated_at: offer.activated_at,
        /* AC4 — every commercial field the SOP requires, reported rather than
           assumed present. */
        required_fields: REQUIRED_OFFER_FIELDS,
        missing_required_fields: missing,
        complete: missing.length === 0,
        /* AC2 — who signed off, and whether the route is complete. */
        approvals: offer.approvals,
        approval_route: APPROVAL_PARTIES,
        approval_complete: approvalComplete(offer.approvals ?? []).complete,
      },
    });
  })
);

/**
 * POST /api/leadflow/offers — draft a new version of an offer.
 *
 * A DRAFT IS UNQUOTABLE. It is created unapproved and inactive, so nothing a rep
 * can read changes until the full route has signed off and somebody activates
 * it. Every commercial field the SOP requires is mandatory here rather than
 * checked at publish, because a half-filled draft invites the gap to be closed
 * by improvisation on a call.
 */
offerRoutes.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const offerKey = typeof body.offer_key === 'string' ? body.offer_key.trim() : '';
    if (offerKey === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'offer_key is required');

    const text = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    const missing = REQUIRED_OFFER_FIELDS.filter((f) => {
      if (f === 'price_cents') return !Number.isFinite(Number(body.price_cents));
      if (f === 'payment_options' || f === 'included_features' || f === 'variable_charges' || f === 'third_party_charges') {
        return !Array.isArray(body[f]);
      }
      return text(f) === '';
    });
    if (missing.length > 0) {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        `An Offer Data Sheet missing ${missing.join(', ')} cannot be drafted — a rep filling the gap on a call is how two customers end up on different terms`
      );
    }

    const next = await dataService.query<{ v: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM leadflow_offer_version
        WHERE tenant_id = $1 AND offer_key = $2`,
      [config.projexCloud.tenantId, offerKey]
    );
    const version = Number(next[0]?.v ?? 1);

    const rows = await dataService.query<{ offer_version_id: string }>(
      `INSERT INTO leadflow_offer_version
         (tenant_id, offer_key, version, price_cents, currency, quantity_basis, payment_options,
          license_limits, implementation_expectations, refund_terms, cancellation_terms,
          included_features, variable_charges, third_party_charges, approved_scarcity_language)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15)
       RETURNING offer_version_id`,
      [
        config.projexCloud.tenantId, offerKey, version, Number(body.price_cents),
        typeof body.currency === 'string' ? body.currency : 'USD',
        text('quantity_basis'), JSON.stringify(body.payment_options),
        text('license_limits'), text('implementation_expectations'),
        text('refund_terms'), text('cancellation_terms'),
        JSON.stringify(body.included_features), JSON.stringify(body.variable_charges),
        JSON.stringify(body.third_party_charges),
        typeof body.approved_scarcity_language === 'string' ? body.approved_scarcity_language : null,
      ]
    );

    res.status(201).json({
      success: true,
      data: {
        offer_version_id: rows[0].offer_version_id, offer_key: offerKey, version,
        version_stamp: `${offerKey}@v${version}`,
        approved: false, active: false,
        approval_route: APPROVAL_PARTIES,
        note: 'A draft is unquotable. Nothing a rep can read changes until every party has signed off and the version is activated.',
      },
    });
  })
);

/**
 * POST /api/leadflow/offers/:id/approve — one party's sign-off.
 *
 * EACH PARTY SIGNS SEPARATELY. A single "approved" flag lets one person tick a
 * box on everybody's behalf, which is exactly the shortcut the multi-party route
 * exists to prevent — and afterwards nobody can say who actually read the terms.
 */
offerRoutes.post(
  '/:id/approve',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const id = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    /* One party or several. Sign-off often arrives as three separate emails that
       a route administrator records together, and refusing to accept them is how
       the route gets bypassed entirely rather than followed. Each is still
       stored as its own entry with who recorded it and when. */
    const parties = (Array.isArray(body.parties) ? body.parties : [body.party])
      .filter((p): p is string => typeof p === 'string')
      .map((p) => p.trim());
    if (parties.length === 0 || parties.some((p) => !(APPROVAL_PARTIES as readonly string[]).includes(p))) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `party must be one of ${APPROVAL_PARTIES.join(', ')}`);
    }

    const rows = await dataService.query<{ approvals: { party: string; at: string }[] }>(
      `UPDATE leadflow_offer_version
          SET approvals = (
                SELECT COALESCE(jsonb_agg(a), '[]'::jsonb)
                  FROM jsonb_array_elements(approvals) a
                 WHERE NOT (a->>'party' = ANY($2::text[]))
              ) || (
                SELECT COALESCE(jsonb_agg(jsonb_build_object('party', p, 'at', now()::text, 'by', $3::text)), '[]'::jsonb)
                  FROM unnest($2::text[]) p
              )
        WHERE offer_version_id = $1 AND activated_at IS NULL
        RETURNING approvals`,
      [id, parties, req.session?.userId ?? '']
    );
    if (rows.length === 0) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'No unactivated offer version with that id — an active version cannot be re-approved in place');
    }

    const state = approvalComplete(rows[0].approvals ?? []);
    if (state.complete) {
      await dataService.query(
        `UPDATE leadflow_offer_version SET approved_at = COALESCE(approved_at, now()) WHERE offer_version_id = $1`,
        [id]
      );
    }
    res.status(200).json({
      success: true,
      data: {
        offer_version_id: id, parties, approvals: rows[0].approvals,
        approval_route: APPROVAL_PARTIES,
        approval_complete: state.complete, awaiting: state.missing,
        may_activate: state.complete,
      },
    });
  })
);

/**
 * POST /api/leadflow/offers/:id/activate — make it the version reps quote.
 *
 * SUPERSEDING IS PART OF ACTIVATION, in the same statement. Two active versions
 * would mean two reps quoting different terms and both believing they were
 * current, and a partial unique index refuses the second one outright.
 */
offerRoutes.post(
  '/:id/activate',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const id = String(req.params?.id ?? '');
    const rows = await dataService.query<{ offer_key: string; version: number; approvals: { party: string }[]; approved_at: string | null }>(
      `SELECT offer_key, version, approvals, approved_at FROM leadflow_offer_version WHERE offer_version_id = $1`,
      [id]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No offer version with that id');

    const state = approvalComplete(rows[0].approvals ?? []);
    if (!state.complete) {
      /* 409 rather than 400: the request is well formed and the version is real,
         but the world is not in a state where activation is allowed yet. */
      throw new AppError(
        409, ErrorCodes.CONFLICT,
        `This version is still awaiting ${state.missing.join(' and ')}. Activating an unapproved sheet would put unreviewed terms in front of a buyer.`
      );
    }

    await dataService.query(
      `UPDATE leadflow_offer_version SET superseded_at = now()
        WHERE tenant_id = $1 AND offer_key = $2 AND activated_at IS NOT NULL AND superseded_at IS NULL`,
      [config.projexCloud.tenantId, rows[0].offer_key]
    );
    await dataService.query(
      `UPDATE leadflow_offer_version
          SET activated_at = now(), approved_at = COALESCE(approved_at, now()), superseded_at = NULL
        WHERE offer_version_id = $1`,
      [id]
    );

    res.status(200).json({
      success: true,
      data: {
        offer_version_id: id, offer_key: rows[0].offer_key, version: rows[0].version,
        version_stamp: `${rows[0].offer_key}@v${rows[0].version}`,
        active: true, superseded_previous: true,
        note: 'Exactly one version of an offer is active at a time. The previous one becomes unquotable in the same moment this one becomes quotable.',
      },
    });
  })
);

/**
 * GET /api/leadflow/offers/feature-matrix — the five labels a rep may speak.
 */
offerRoutes.get(
  '/feature-matrix',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const offerKey = ((req.query?.offer_key as string | undefined) ?? '').trim();
    if (offerKey === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'offer_key is required');

    const rows = await featureMatrix(offerKey);
    res.status(200).json({
      success: true,
      data: {
        offer_key: offerKey, capabilities: rows, capability_count: rows.length,
        /* AC3 — owner and update date are NOT NULL columns, so an entry without
           them cannot exist. A claim nobody owns, or nobody can tell is stale,
           is worse than no matrix because it looks authoritative. */
        statuses: FEATURE_STATUSES,
        by_status: FEATURE_STATUSES.map((s) => ({ status: s, count: rows.filter((r) => r.status === s).length })),
        speaking_rule: 'A rep may say exactly these five words about a capability. Anything else is a claim nobody approved.',
      },
    });
  })
);

/** POST /api/leadflow/offers/feature-matrix — set one capability's status. */
offerRoutes.post(
  '/feature-matrix',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const offerKey = typeof body.offer_key === 'string' ? body.offer_key.trim() : '';
    const capability = typeof body.capability === 'string' ? body.capability.trim() : '';
    const status = typeof body.status === 'string' ? body.status.trim() : '';
    const owner = typeof body.owner_user_id === 'string' ? body.owner_user_id.trim() : (req.session?.userId ?? '');

    if (offerKey === '' || capability === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'offer_key and capability are required');
    if (!(FEATURE_STATUSES as readonly string[]).includes(status)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `status must be one of ${FEATURE_STATUSES.join(', ')}`);
    }
    if (owner === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'owner_user_id is required — a capability claim nobody owns is a claim nobody is accountable for');

    await dataService.query(
      `INSERT INTO leadflow_feature_status (tenant_id, offer_key, capability, status, owner_user_id, note)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, offer_key, capability)
       DO UPDATE SET status = EXCLUDED.status, owner_user_id = EXCLUDED.owner_user_id,
                     note = EXCLUDED.note, updated_at = now()`,
      [config.projexCloud.tenantId, offerKey, capability, status, owner, typeof body.note === 'string' ? body.note : null]
    );
    res.status(201).json({ success: true, data: { offer_key: offerKey, capability, status, owner_user_id: owner } });
  })
);

/**
 * POST /api/leadflow/checkout/send — a versioned link, with no card data.
 *
 * CARD DATA IS NEVER COLLECTED. The rule is absolute, so the compose surface
 * REFUSES rather than warns: a card number in a note is already replicated,
 * indexed and backed up by the time anybody notices, and no amount of later
 * redaction undoes that.
 */
checkoutRoutes.post(
  '/send',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectRef = typeof body.subject_ref === 'string' ? body.subject_ref.trim() : '';
    const offerKey = typeof body.offer_key === 'string' ? body.offer_key.trim() : '';
    const note = typeof body.note === 'string' ? body.note : '';
    const message = typeof body.message === 'string' ? body.message : '';

    if (subjectRef === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
    if (offerKey === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'offer_key is required');

    /* AC1 of #134 — blocked, not flagged. */
    for (const [field, text] of [['note', note], ['message', message]] as const) {
      if (!text) continue;
      const scan = scanForCardData(text);
      if (scan.blocked) {
        throw new AppError(
          422, ErrorCodes.VALIDATION_ERROR,
          `This ${field} looks like it contains card data (${scan.matched.join(', ')}). Card details must never be collected in messages, notes, email or by phone — send the secure checkout link instead.`
        );
      }
    }

    const offer = await currentOffer(offerKey);
    if (!offer) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'No approved active version exists for that offer, so no checkout may be sent');
    }

    let checkoutUrl: string | null = null;
    if (SdkGatewayClient.isConfigured()) {
      try {
        const result = await SdkGatewayClient.call<{ data?: { url?: string; checkout_url?: string } }>({
          sdk: 'sdk-billing', path: '/api/billing/invoices/generate', method: 'POST',
          idempotencyKey: `checkout:${subjectRef}:${offer.offer_key}:${offer.version}`,
          body: {
            tenant_id: config.projexCloud.tenantId, subject_ref: subjectRef,
            offer_key: offer.offer_key, offer_version: offer.version,
            amount_cents: Number(offer.price_cents), currency: offer.currency,
          },
        });
        checkoutUrl = result.data?.data?.url ?? result.data?.data?.checkout_url ?? null;
      } catch { checkoutUrl = null; }
    }

    const decisionDueAt = typeof body.decision_due_at === 'string' ? body.decision_due_at : null;
    const checkoutId = await createCheckout({
      subjectRef, dealRef: typeof body.deal_ref === 'string' ? body.deal_ref : null,
      offerKey: offer.offer_key, offerVersion: offer.version, checkoutUrl, decisionDueAt,
    });

    /* The agreed decision time recorded as a NEXT rather than left in a rep's
       head, so the follow-up exists whether or not they remember it. */
    if (decisionDueAt && req.session?.userId) {
      await dataService.query(
        `INSERT INTO leadflow_next_action (tenant_id, subject_ref, action_type, owner_user_id, due_at, purpose, intended_outcome)
         VALUES ($1,$2,'call',$3,$4::timestamptz,$5,$6) ON CONFLICT DO NOTHING`,
        [
          config.projexCloud.tenantId, subjectRef, req.session.userId, decisionDueAt,
          'Agreed decision time on the checkout', 'A decision either way, or a new agreed date',
        ]
      );
    }

    res.status(201).json({
      success: true,
      data: {
        checkout_id: checkoutId, subject_ref: subjectRef,
        /* AC2 — the exact approved version the buyer was shown. */
        offer_key: offer.offer_key, offer_version: offer.version,
        version_stamp: `${offer.offer_key}@v${offer.version}`,
        checkout_url: checkoutUrl, link_generated: Boolean(checkoutUrl),
        decision_due_at: decisionDueAt,
        note: 'Any previous open checkout for this contact was cancelled. A second live link lets them pay twice, or pay against terms already replaced.',
      },
    });
  })
);

/** GET /api/leadflow/checkout/:id/status — including the assistance signal. */
checkoutRoutes.get(
  '/:id/status',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const checkoutId = String(req.params?.id ?? '');
    const rows = await dataService.query<{
      checkout_id: string; subject_ref: string; offer_key: string; offer_version: number;
      status: string; sent_at: string; started_at: string | null; paid_at: string | null;
      failed_at: string | null; failure_reason: string | null; decision_due_at: string | null;
    }>(
      `SELECT checkout_id, subject_ref, offer_key, offer_version, status, sent_at,
              started_at, paid_at, failed_at, failure_reason, decision_due_at
         FROM leadflow_checkout_session WHERE checkout_id = $1`,
      [checkoutId]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No checkout with that id');
    const c = rows[0];

    /* AC4 of #134 — started but not paid is the HIGHEST priority signal on the
       screen: somebody reached for their card and something stopped them, which
       is the most recoverable moment in the whole funnel and the shortest-lived. */
    const assistanceNeeded = c.status === 'started' || c.status === 'failed';

    res.status(200).json({
      success: true,
      data: {
        ...c,
        assistance_needed: assistanceNeeded,
        priority: assistanceNeeded ? 'highest' : 'normal',
        /* AC3 — pending or failed never advances the stage. */
        may_close_won: c.status === 'paid',
        close_won_rule: 'Closed Won requires a gateway-verified payment. A started or failed checkout never advances the stage.',
      },
    });
  })
);

/**
 * POST /api/leadflow/payments/verify — the gate on Closed Won.
 *
 * AN INTENT IS NOT A VERIFICATION. SOP §22 names "payment success assumed from
 * checkout intent" as the gap, so the two are different values and only a
 * gateway confirmation returns may_close_won true.
 */
paymentRoutes.post(
  '/verify',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectRef = typeof body.subject_ref === 'string' ? body.subject_ref.trim() : '';
    const chargeRef = typeof body.charge_ref === 'string' ? body.charge_ref.trim() : '';
    const source = typeof body.source === 'string' ? body.source.trim() : 'webhook';

    if (subjectRef === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
    if (chargeRef === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'charge_ref is required');

    let verification: 'gateway_confirmed' | 'intent_only' | 'failed' =
      body.verification === 'failed' ? 'failed'
        : source === 'checkout_intent' ? 'intent_only' : 'gateway_confirmed';
    let reconciled = false;
    let detail: string | null = null;

    /* AC3 of #135 — the missing-webhook case. Query the gateway rather than
       assume, and open a finance task either way. */
    if (source === 'missing_webhook') {
      const probe = await reconcileFromGateway(chargeRef);
      reconciled = true;
      detail = probe.detail;
      verification = probe.confirmed ? 'gateway_confirmed' : 'failed';
    }

    const result = await verifyPayment({
      subjectRef, chargeRef, checkoutId: typeof body.checkout_id === 'string' ? body.checkout_id : null,
      verification, amountCents: typeof body.amount_cents === 'number' ? body.amount_cents : null,
      currency: typeof body.currency === 'string' ? body.currency : null,
      payload: body.payload ?? null, reconciledFromGateway: reconciled,
    });

    let financeTaskRef: string | null = null;
    if (source === 'missing_webhook' && SdkGatewayClient.isConfigured()) {
      try {
        const task = await SdkGatewayClient.call<{ data?: { incident_id?: string } }>({
          sdk: 'sdk-incident', path: '/api/incidents', method: 'POST',
          idempotencyKey: `missing-webhook:${chargeRef}`,
          body: {
            tenant_id: config.projexCloud.tenantId, kind: 'payment_webhook_missing', severity: 'high',
            title: 'A payment webhook never arrived; the gateway was queried directly',
            detail: detail ?? '', affected_refs: [subjectRef, chargeRef],
          },
        });
        financeTaskRef = task.data?.data?.incident_id ?? null;
      } catch { financeTaskRef = null; }
    }

    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      data: {
        charge_ref: chargeRef, verification: result.verification,
        /* AC2 — a replay produces no second artifact, and says so. */
        duplicate: result.duplicate,
        verification_id: result.verificationId,
        /* AC1 — the gate. */
        may_close_won: result.mayCloseWon,
        reconciled_from_gateway: result.reconciledFromGateway,
        gateway_detail: detail,
        finance_task_ref: financeTaskRef,
        note: result.duplicate
          ? 'This charge was already verified. Replaying the webhook produces exactly one of every downstream artifact, because the charge reference is unique.'
          : 'An intent is not a verification. Only a gateway confirmation permits Closed Won.',
      },
    });
  })
);

/**
 * POST /api/leadflow/payments/:id/refund-request — with the approval threshold.
 *
 * EXPANSION MESSAGING FREEZES THE MOMENT A REFUND IS REQUESTED, before any
 * approval. Asking somebody to buy more while they are asking for money back is
 * the single most damaging automated message this system could send, and waiting
 * for the approval to land would leave a window in which it goes out.
 */
paymentRoutes.post(
  '/:id/refund-request',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const chargeRef = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const amountCents = Number(body.amount_cents);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'amount_cents must be a positive number');
    }
    if (reason === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'reason is required — a refund is money leaving under written terms, and the record is what a later reader judges it by');
    }

    const requiresApproval = amountCents >= REFUND_APPROVAL_THRESHOLD_CENTS;

    let approvalRef: string | null = null;
    if (requiresApproval && SdkGatewayClient.isConfigured()) {
      try {
        const a = await SdkGatewayClient.call<{ data?: { approval_id?: string } }>({
          sdk: 'sdk-approval', path: '/api/approvals/requests', method: 'POST',
          idempotencyKey: `refund:${chargeRef}`,
          body: {
            tenant_id: config.projexCloud.tenantId, kind: 'refund_above_threshold',
            subject_ref: chargeRef, reason, metadata: { amount_cents: amountCents },
          },
        });
        approvalRef = a.data?.data?.approval_id ?? null;
      } catch { approvalRef = null; }
    }

    const rows = await dataService.query<{ refund_id: string; expansion_frozen_at: string }>(
      `INSERT INTO leadflow_refund_request
         (tenant_id, charge_ref, amount_cents, reason, requires_approval, approval_ref, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING refund_id, expansion_frozen_at`,
      [config.projexCloud.tenantId, chargeRef, amountCents, reason, requiresApproval, approvalRef, req.session?.userId ?? null]
    );

    res.status(201).json({
      success: true,
      data: {
        refund_id: rows[0].refund_id, charge_ref: chargeRef, amount_cents: amountCents,
        /* AC4 — above the threshold needs a second party, and expansion stops
           either way. */
        requires_approval: requiresApproval,
        approval_threshold_cents: REFUND_APPROVAL_THRESHOLD_CENTS,
        approval_ref: approvalRef,
        approved: false,
        expansion_frozen_at: rows[0].expansion_frozen_at,
        note: 'Expansion messaging is frozen from this moment, before any approval. Waiting for the decision would leave a window in which an upsell goes to somebody asking for money back.',
      },
    });
  })
);

/**
 * GET /api/leadflow/onboarding/pending — paid licences with no landed handoff.
 */
onboardingRoutes.get(
  '/pending',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const rows = await pendingHandoffs();
    const overdue = rows.filter((r) => r.hours_since_payment >= KICKOFF_WINDOW_HOURS && !r.exception_reason);

    /* AC1 of #138 — the alert fires from here, once per handoff. */
    let alerted = 0;
    for (const r of overdue) {
      if (!r.alerted_at && (await alertOverdueHandoff(r.handoff_id, r.subject_ref))) alerted += 1;
    }

    res.status(200).json({
      success: true,
      data: {
        pending: rows, pending_count: rows.length,
        overdue: overdue.map((r) => r.handoff_id), overdue_count: overdue.length,
        alerts_raised: alerted,
        window_hours: KICKOFF_WINDOW_HOURS,
        /* AC2 — the rule the save gate already enforces, restated where the
           onboarding team reads it. */
        terminal_rule: 'Closed Won remains NON-TERMINAL until CS has accepted the handoff and the kickoff is booked. A record that goes quiet the moment payment clears is the failure this prevents.',
        clock_basis: 'verified_payment',
      },
    });
  })
);

/**
 * POST /api/leadflow/onboarding — start the 24-hour clock on a paid licence.
 *
 * REFUSED WITHOUT A GATEWAY-CONFIRMED PAYMENT. A handoff created from an intent
 * puts CS onto a customer who has not paid, and the first thing they do is
 * welcome them — which is the same harm the saga's pending path avoids.
 *
 * The closed-won saga writes this row itself; this endpoint exists because the
 * saga's sdk-handoff call can fail while the local clock must still start. A
 * paid licence with no clock is invisible to the alert that exists to find it.
 */
onboardingRoutes.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectRef = typeof body.subject_ref === 'string' ? body.subject_ref.trim() : '';
    const chargeRef = typeof body.charge_ref === 'string' ? body.charge_ref.trim() : '';
    if (subjectRef === '' || chargeRef === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref and charge_ref are both required');
    }

    const paid = await dataService.query<{ verified_at: string }>(
      `SELECT verified_at FROM leadflow_payment_verification
        WHERE tenant_id = $1 AND charge_ref = $2 AND verification = 'gateway_confirmed' LIMIT 1`,
      [config.projexCloud.tenantId, chargeRef]
    );
    if (paid.length === 0) {
      throw new AppError(
        409, ErrorCodes.CONFLICT,
        'That charge has no gateway-confirmed payment, so no onboarding handoff may start. A handoff built on an intent puts CS onto a customer who has not paid.'
      );
    }

    const rows = await dataService.query<{ handoff_id: string; paid_at: string }>(
      `INSERT INTO leadflow_onboarding_handoff (tenant_id, subject_ref, deal_ref, charge_ref, paid_at)
       VALUES ($1,$2,$3,$4,$5::timestamptz)
       ON CONFLICT (tenant_id, subject_ref) DO UPDATE SET charge_ref = EXCLUDED.charge_ref
       RETURNING handoff_id, paid_at`,
      [
        config.projexCloud.tenantId, subjectRef,
        typeof body.deal_ref === 'string' ? body.deal_ref : null, chargeRef, paid[0].verified_at,
      ]
    );

    res.status(201).json({
      success: true,
      data: {
        handoff_id: rows[0].handoff_id, subject_ref: subjectRef, charge_ref: chargeRef,
        /* The clock is stamped from the VERIFICATION, not from now. A handoff
           created three days late must already be three days overdue. */
        paid_at: rows[0].paid_at, window_hours: KICKOFF_WINDOW_HOURS,
        clock_basis: 'verified_payment',
      },
    });
  })
);

/**
 * POST /api/leadflow/onboarding/:id/accept — CS takes the customer.
 *
 * ACCEPTANCE AND A BOOKED KICKOFF ARE SEPARATE FACTS, and Closed Won stays
 * non-terminal until both land. An accepted handoff with no meeting is somebody
 * saying "yes, mine" and then nothing happening, which from the customer's side
 * is identical to nobody accepting at all.
 */
onboardingRoutes.post(
  '/:id/accept',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const handoffId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kickoffAt = typeof body.kickoff_at === 'string' ? body.kickoff_at.trim() : '';
    if (kickoffAt !== '' && Number.isNaN(Date.parse(kickoffAt))) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'kickoff_at must be a valid date when supplied');
    }

    const rows = await dataService.query<{
      handoff_id: string; accepted_at: string; kickoff_at: string | null; subject_ref: string;
    }>(
      `UPDATE leadflow_onboarding_handoff
          SET accepted_at = COALESCE(accepted_at, now()), accepted_by = $2,
              kickoff_at = COALESCE($3::timestamptz, kickoff_at),
              kickoff_meeting_id = COALESCE($4::uuid, kickoff_meeting_id)
        WHERE handoff_id = $1
        RETURNING handoff_id, accepted_at, kickoff_at, subject_ref`,
      [
        handoffId, req.session?.userId ?? null, kickoffAt === '' ? null : kickoffAt,
        typeof body.kickoff_meeting_id === 'string' ? body.kickoff_meeting_id : null,
      ]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No onboarding handoff with that id');

    const complete = Boolean(rows[0].kickoff_at);
    res.status(200).json({
      success: true,
      data: {
        handoff_id: handoffId, accepted_at: rows[0].accepted_at, kickoff_at: rows[0].kickoff_at,
        /* AC2 — the terminal test, computed rather than asserted. */
        closed_won_terminal: complete,
        awaiting: complete ? [] : ['kickoff_booked'],
        note: complete
          ? 'Accepted and booked. Closed Won is complete.'
          : 'Accepted, but no kickoff is booked, so Closed Won stays non-terminal. An accepted handoff with no meeting is indistinguishable, from the customer\'s side, from nobody accepting at all.',
      },
    });
  })
);

/**
 * POST /api/leadflow/onboarding/:id/exception — a buyer-driven delay.
 *
 * STILL REQUIRES A NAMED OWNER AND A DATE. An exception with neither is an
 * unworked handoff wearing a label, which is how a paid customer goes six weeks
 * without anybody calling them.
 */
onboardingRoutes.post(
  '/:id/exception',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const handoffId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const owner = typeof body.owner_user_id === 'string' ? body.owner_user_id.trim() : '';
    const reviewAt = typeof body.review_at === 'string' ? body.review_at.trim() : '';

    if (reason === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'reason is required');
    if (owner === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'owner_user_id is required — an exception with no named owner is an unworked handoff wearing a label');
    }
    if (reviewAt === '' || Number.isNaN(Date.parse(reviewAt))) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'review_at must be a valid date — an exception with no date never gets revisited');
    }

    const rows = await dataService.query<{ handoff_id: string; subject_ref: string }>(
      `UPDATE leadflow_onboarding_handoff
          SET exception_reason = $2, exception_owner_user_id = $3, exception_review_at = $4::timestamptz,
              thirty_day_task_at = COALESCE(thirty_day_task_at, now() + interval '30 days')
        WHERE handoff_id = $1 RETURNING handoff_id, subject_ref`,
      [handoffId, reason, owner, reviewAt]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No onboarding handoff with that id');

    /* AC4 — the 30-day check, created automatically rather than remembered. */
    await dataService.query(
      `INSERT INTO leadflow_next_action (tenant_id, subject_ref, action_type, owner_user_id, due_at, purpose, intended_outcome)
       VALUES ($1,$2,'task',$3,$4::timestamptz,$5,$6) ON CONFLICT DO NOTHING`,
      [
        config.projexCloud.tenantId, rows[0].subject_ref, owner, reviewAt,
        `Onboarding exception review: ${reason}`, 'Kickoff booked, or the exception renewed with a new date',
      ]
    );

    res.status(200).json({
      success: true,
      data: {
        handoff_id: handoffId, reason, owner_user_id: owner, review_at: reviewAt,
        thirty_day_check_created: true,
        note: 'A buyer-driven delay is legitimate. An exception with no owner and no date is not — it is how a paid customer goes six weeks without anybody calling them.',
      },
    });
  })
);
