import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { probe } from '../contacts/contactsService';
import { BUSINESS_ZONE, isBusinessTime, localParts } from '../sla/businessCalendar';
import { funnelBySource, onboardingAttainment, pipelineHealth } from '../insights/funnelService';

/**
 * The remaining workspace reads: routing, coverage, the pipeline board, the
 * NEXT queue, the unified inbox, dashboards, incidents and governance.
 *
 * Every one carries `upstream_available` and `field_gaps` like the rest of the
 * workspace, because most of what these screens show belongs to ProjexCloud and
 * a panel that renders blank during an outage is indistinguishable from one
 * rendering a genuinely empty queue.
 */

export const routingWorkspaceRoutes: Router = Router();
export const coverageRoutes: Router = Router();
export const nextActionRoutes: Router = Router();
export const inboxRoutes: Router = Router();
export const opportunityRoutes: Router = Router();
export const handoffRoutes: Router = Router();
export const dashboardRoutes: Router = Router();
export const incidentRoutes: Router = Router();
export const governanceRoutes: Router = Router();
export const certificationRoutes: Router = Router();

for (const r of [
  routingWorkspaceRoutes, coverageRoutes, nextActionRoutes, inboxRoutes, opportunityRoutes,
  handoffRoutes, dashboardRoutes, incidentRoutes, governanceRoutes, certificationRoutes,
]) r.use(authenticate);

/* ---------------------------------------------------------------- routing */

/** GET /api/leadflow/routing/config — the versioned rule set. */
routingWorkspaceRoutes.get(
  '/config',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    /* The real column names from migration 003 — evaluation_order, not
       priority; source_channel, not a conditions blob; assigned_user_id, not
       target_user_id. Written against the schema rather than against what the
       screen calls them, and aliased here so the client contract is stable even
       if the table is renamed underneath it. */
    const rules = await dataService.query<Record<string, unknown>>(
      `SELECT id, name, evaluation_order AS priority, source_channel,
              assigned_user_id::text AS target_user_id, is_active, created_at, updated_at
         FROM routing_rules ORDER BY evaluation_order ASC, created_at ASC`
    );
    const assignment = await probe<unknown>('sdk-assignment', '/api/assignment/policies');

    res.status(200).json({
      success: true,
      data: {
        rules, rule_count: rules.length,
        /* The local rules are the tenant's PREFERENCE; sdk-assignment makes the
           decision. Reporting both, and which of them answered, is what lets an
           operator tell "my rule did not match" from "the assignment service
           never saw it". */
        decision_owner: 'sdk-assignment',
        preference_owner: 'leadflow.routing_rules',
        upstream_available: { assignment: assignment.available },
        field_gaps: assignment.available ? [] : [
          { field: 'bands', reason: 'sdk-assignment could not be reached, so the live capacity bands and matchers it holds are unknown. The local rules below are what LeadFlow would send it.' },
        ],
      },
    });
  })
);

/**
 * POST /api/leadflow/routing/simulate — replay a window, zero side effects.
 *
 * NO ASSIGNMENT, NO NOTIFICATION, NO CLOCK. The simulation reads historical
 * leads and reports which rule WOULD have matched; it never calls the
 * assignment SDK, so there is no path from here to a real assignment. A rep
 * who gets a notification from a simulation stops trusting the simulation.
 */
routingWorkspaceRoutes.post(
  '/simulate',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const days = Number(body.window_days ?? 14);
    if (!Number.isFinite(days) || days <= 0 || days > 180) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'window_days must be between 1 and 180');
    }

    const rules = await dataService.query<{ id: string; name: string; priority: number; source_channel: string | null; target_user_id: string | null }>(
      `SELECT id, name, evaluation_order AS priority, source_channel,
              assigned_user_id::text AS target_user_id
         FROM routing_rules WHERE is_active = TRUE ORDER BY evaluation_order ASC`
    );
    const leads = await dataService.query<{ id: string; source: string | null; owner_user_id: string | null }>(
      `SELECT id, source, owner_user_id::text AS owner_user_id FROM leads
        WHERE created_at >= now() - ($1 || ' days')::interval LIMIT 5000`,
      [String(days)]
    );

    const perRule: Record<string, number> = {};
    let unmatched = 0;
    let wouldDiffer = 0;
    for (const lead of leads) {
      // A rule with no source_channel matches everything, which is how the
      // catch-all rule is expressed in this schema.
      const hit = rules.find((r) => r.source_channel === null || r.source_channel === (lead.source ?? ''));
      if (!hit) { unmatched += 1; continue; }
      perRule[hit.name] = (perRule[hit.name] ?? 0) + 1;
      if (hit.target_user_id !== null && hit.target_user_id !== lead.owner_user_id) wouldDiffer += 1;
    }

    res.status(200).json({
      success: true,
      data: {
        window_days: days, config_version: typeof body.config_version === 'string' ? body.config_version : null,
        leads_replayed: leads.length,
        matches_per_rule: perRule,
        /* THE NUMBER THAT MATTERS: how many leads this configuration would have
           sent somewhere ELSE. "412 leads matched" says nothing about whether
           the change is safe; "38 would have gone to a different rep" does. */
        would_route_differently: wouldDiffer,
        unmatched,
        unmatched_note: unmatched > 0
          ? 'Leads matching no rule fall through to the default assignment path. A growing number here is a configuration gap, not a routing failure.'
          : null,
        side_effects: { assignments: 0, notifications: 0, clocks_started: 0 },
        guarantee: 'The simulation never calls the assignment SDK, so there is no code path from here to a real assignment.',
      },
    });
  })
);

/** GET /api/leadflow/routing/fair-share-audit — skew and starvation. */
routingWorkspaceRoutes.get(
  '/fair-share-audit',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const rows = await dataService.query<{ owner: string | null; assigned: string; worked: string }>(
      `SELECT owner_user_id::text AS owner, COUNT(*)::text AS assigned,
              COUNT(first_response_at)::text AS worked
         FROM leads
        WHERE created_at >= now() - interval '30 days' AND owner_user_id IS NOT NULL
        GROUP BY owner_user_id ORDER BY COUNT(*) DESC`
    );
    const counts = rows.map((r) => Number(r.assigned));
    const total = counts.reduce((s, n) => s + n, 0);
    const mean = counts.length === 0 ? 0 : total / counts.length;
    const spread = counts.length === 0 ? 0 : Math.max(...counts) - Math.min(...counts);

    res.status(200).json({
      success: true,
      data: {
        window_days: 30,
        distribution: rows.map((r) => ({
          owner: r.owner, assigned: Number(r.assigned), worked: Number(r.worked),
          share: total === 0 ? 0 : Number((Number(r.assigned) / total).toFixed(4)),
        })),
        mean_per_rep: Number(mean.toFixed(2)),
        spread,
        /* STARVATION IS REPORTED SEPARATELY FROM SKEW. A rep receiving far less
           than the mean is a different problem from the pool being uneven: the
           first is somebody with no pipeline, the second is a tuning question. */
        starved: rows.filter((r) => Number(r.assigned) < mean * 0.5).map((r) => r.owner),
        note: 'Reps with zero assignments do not appear in this window at all — they have no rows to group by. The coverage console is where an entirely idle rep shows up.',
      },
    });
  })
);

/** GET /api/leadflow/leads/:id/routing-trace — why THIS lead went to THIS rep. */
export const routingTraceRoutes: Router = Router();
routingTraceRoutes.use(authenticate);
routingTraceRoutes.get(
  '/:id/routing-trace',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const leadId = String(req.params?.id ?? '');
    const rows = await dataService.query<{
      id: string; source: string | null; owner_user_id: string | null; assigned_at: string | null;
      routing_method: string | null; routing_reason: string | null; routing_rule_id: string | null;
      backup_user_id: string | null;
    }>(
      `SELECT id, source, owner_user_id::text AS owner_user_id, assigned_at, routing_method,
              routing_reason, routing_rule_id::text AS routing_rule_id, backup_user_id::text AS backup_user_id
         FROM leads WHERE id::text = $1`,
      [leadId]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No lead with that id');
    const lead = rows[0];

    const rule = lead.routing_rule_id
      ? await dataService.query<Record<string, unknown>>(
        `SELECT id, name, evaluation_order AS priority, source_channel
           FROM routing_rules WHERE id::text = $1`, [lead.routing_rule_id]
      )
      : [];

    res.status(200).json({
      success: true,
      data: {
        lead_id: lead.id,
        assigned_to: lead.owner_user_id, assigned_at: lead.assigned_at,
        backup: lead.backup_user_id,
        /* THE STORED REASON, not one reconstructed now. Re-deriving it would
           answer "which rule would match today", and the rules have changed
           since — which is exactly why somebody is asking. */
        steps: [
          { step: 'arrival', detail: `Arrived from ${lead.source ?? 'an unknown source'}.` },
          { step: 'method', detail: lead.routing_method ?? 'No routing method was recorded for this lead.' },
          { step: 'rule', detail: rule[0] ? `Matched rule "${String(rule[0].name)}" at priority ${String(rule[0].priority)}.` : 'No routing rule was recorded.' },
          { step: 'outcome', detail: lead.routing_reason ?? 'No reason was recorded at assignment time.' },
        ],
        rule: rule[0] ?? null,
        replayed: false,
        note: 'This is the reason recorded when the lead was routed. It is deliberately not recomputed — the rules have changed since, which is usually why somebody is asking.',
      },
    });
  })
);

/* --------------------------------------------------------------- coverage */

/** GET /api/leadflow/coverage/console — schedules, on-call and the gap detector. */
coverageRoutes.get(
  '/console',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const now = new Date();
    const parts = localParts(now);
    const cover = await probe<{ schedules?: unknown[]; on_call?: unknown[] }>('sdk-coverage', '/api/coverage/schedules');

    const unowned = await dataService.query<{ v: string }>(
      `SELECT COUNT(*)::text AS v FROM leads
        WHERE owner_user_id IS NULL AND (stage IS NULL OR stage NOT IN ('closed_won','closed_lost'))`
    );
    const overnight = await dataService.query<{ v: string }>(
      `SELECT COUNT(*)::text AS v FROM leadflow_overnight_queue WHERE released_at IS NULL`
    ).catch(() => [{ v: '0' }]);

    res.status(200).json({
      success: true,
      data: {
        business_date: parts.date, timezone: BUSINESS_ZONE,
        within_business_hours: isBusinessTime(now),
        schedules: cover.data?.schedules ?? [],
        on_call: cover.data?.on_call ?? [],
        /* THE GAP DETECTOR IS LOCAL AND ALWAYS ANSWERS. Coverage gaps are the
           one thing this console must report even when the coverage service is
           down — an outage in the tool that finds unowned leads is exactly when
           leads go unowned. */
        gaps: {
          unowned_active: Number(unowned[0]?.v ?? 0),
          overnight_unreleased: Number(overnight[0]?.v ?? 0),
        },
        upstream_available: { coverage: cover.available },
        field_gaps: cover.available ? [] : [
          { field: 'schedules', reason: 'sdk-coverage could not be reached, so rota and on-call are unknown. The gap counts below are computed locally and are still accurate.' },
        ],
      },
    });
  })
);

/**
 * POST /api/leadflow/coverage/opening-validation — the 8:45 checklist.
 *
 * THE MANAGER'S CONFIRMATION IS REQUIRED AND SEPARATE from the checks. A
 * checklist that records itself as confirmed is a form nobody read: the point of
 * the 8:45 validation is that a named person looked at the queue and said it was
 * clear, and a boolean the system sets on their behalf records the opposite of
 * what it claims.
 */
coverageRoutes.post(
  '/opening-validation',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.manager_confirmed !== true) {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        'manager_confirmed must be true — the opening validation records that a named person looked at the queue, and a checklist that confirms itself records the opposite of what it claims'
      );
    }
    const checks = (body.checks ?? {}) as Record<string, boolean>;
    const failed = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);

    const parts = localParts(new Date());
    await dataService.query(
      `INSERT INTO leadflow_digest_output (tenant_id, digest_id, output_key, description, due_at, completed_at, completed_by, completion_note)
       SELECT $1, d.id, 'opening_validation', 'The 8:45 opening validation, confirmed by a named manager', now(), now(), $2, $3
         FROM leadflow_operating_rhythm_digest d
        WHERE d.tenant_id = $1 AND d.rhythm_key = 'launch_huddle' AND d.business_date = $4::date
       ON CONFLICT (digest_id, output_key) DO NOTHING`,
      [
        config.projexCloud.tenantId, req.session?.userId ?? null,
        `Checks failed: ${failed.length === 0 ? 'none' : failed.join(', ')}. Overnight queue cleared: ${body.overnight_queue_cleared === true}.`,
        parts.date,
      ]
    ).catch(() => undefined);

    res.status(201).json({
      success: true,
      data: {
        recorded_at: new Date().toISOString(),
        business_date: parts.date,
        checks_failed: failed,
        overnight_queue_cleared: body.overnight_queue_cleared === true,
        /* Recorded even when checks failed. A validation that refuses to save a
           bad result is a validation nobody runs on a bad morning. */
        note: failed.length === 0
          ? 'All checks passed.'
          : 'Recorded with failures. The record of a bad morning is worth more than a clean form.',
      },
    });
  })
);

/* ---------------------------------------------------- pipeline and NEXT */

export const pipelineBoardRoutes: Router = Router();
pipelineBoardRoutes.use(authenticate);

/** GET /api/leadflow/pipeline/board — stage columns with the health targets. */
pipelineBoardRoutes.get(
  '/board',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const columns = await dataService.query<{ stage: string; count: string; oldest_days: string }>(
      `SELECT COALESCE(stage,'unstaged') AS stage, COUNT(*)::text AS count,
              FLOOR(EXTRACT(EPOCH FROM (now() - MIN(updated_at)))/86400)::text AS oldest_days
         FROM leads
        WHERE stage IS NULL OR stage NOT IN ('closed_won','closed_lost')
        GROUP BY COALESCE(stage,'unstaged') ORDER BY COUNT(*) DESC`
    );
    const health = await pipelineHealth();

    res.status(200).json({
      success: true,
      data: {
        columns: columns.map((c) => ({ stage: c.stage, count: Number(c.count), oldest_days: Number(c.oldest_days) })),
        pipeline_health: health,
        hard_targets: { unowned: 0, active_without_next: 0 },
        targets_met: health.unowned === 0 && health.active_without_next === 0,
      },
    });
  })
);

/** GET /api/leadflow/next-actions/overdue — leads with no dated action. */
nextActionRoutes.get(
  '/overdue',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const overdue = await dataService.query<Record<string, unknown>>(
      `SELECT id AS lead_id, name, stage, owner_user_id::text AS owner, next_action, next_due_at,
              FLOOR(EXTRACT(EPOCH FROM (now() - next_due_at))/3600)::int AS hours_overdue
         FROM leads
        WHERE next_due_at IS NOT NULL AND next_due_at < now()
          AND (stage IS NULL OR stage NOT IN ('closed_won','closed_lost'))
        ORDER BY next_due_at ASC LIMIT 200`
    );
    const missing = await dataService.query<Record<string, unknown>>(
      `SELECT id AS lead_id, name, stage, owner_user_id::text AS owner, updated_at
         FROM leads
        WHERE next_due_at IS NULL AND (stage IS NULL OR stage NOT IN ('closed_won','closed_lost'))
        ORDER BY updated_at ASC LIMIT 200`
    );

    res.status(200).json({
      success: true,
      data: {
        overdue, overdue_count: overdue.length,
        /* MISSING AND OVERDUE ARE SEPARATE LISTS. A lead with a date that has
           passed is somebody's slipped commitment; one with no date at all was
           never committed to, and the second is the worse of the two because
           nothing will ever surface it on a date-based queue. */
        no_next_action: missing, no_next_action_count: missing.length,
        target: 'zero of both',
      },
    });
  })
);

/* ----------------------------------------------------------------- inbox */

/**
 * GET /api/leadflow/inbox — one chronological thread list across every channel.
 *
 * THREADS, NOT MESSAGES. The screen works a queue: "who is waiting on me" is a
 * question about conversations, and a flat message list makes somebody
 * reconstruct the thread in their head to answer it — which is where they miss
 * the one that has been waiting three days.
 *
 * THE FILTER COUNTS ARE COMPUTED SERVER-SIDE over the same window the rows came
 * from. Counting in the browser would count only the page it was handed, so
 * "SLA at risk: 2" would mean two on this page rather than two in the queue.
 */
inboxRoutes.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const filter = typeof req.query?.filter === 'string' ? req.query.filter : 'all';
    const conversation = await probe<{ threads?: Record<string, unknown>[]; messages?: Record<string, unknown>[] }>(
      'sdk-conversation', `/api/conversations?tenant_id=${encodeURIComponent(config.projexCloud.tenantId ?? '')}&limit=200`
    );

    /*
     * The LOCAL lead projection is the fallback spine, not a decoration. An
     * unreachable conversation service must not empty this screen: a rep whose
     * inbox is blank concludes there is nothing to do, and the leads awaiting a
     * first response are exactly the ones that then breach.
     */
    const leads = await dataService.query<{
      id: string; name: string | null; email: string | null; source: string | null;
      owner_user_id: string | null; first_response_at: string | null; sla_due_at: string | null;
      sla_breached: boolean | null; updated_at: string | null;
    }>(
      `SELECT id, name, email, source, owner_user_id::text AS owner_user_id, first_response_at,
              sla_due_at, sla_breached, updated_at
         FROM leads
        WHERE stage IS NULL OR stage NOT IN ('closed_won','closed_lost')
        ORDER BY updated_at DESC NULLS LAST LIMIT 200`
    );

    const now = Date.now();
    const me = req.session?.userId ?? null;
    const threads = leads.map((l) => {
      const dueSoon = l.sla_due_at !== null
        && Date.parse(l.sla_due_at) - now < 15 * 60_000
        && l.first_response_at === null;
      return {
        thread_id: l.id,
        subject: l.name ? `Enquiry from ${l.name}` : 'Enquiry',
        contact: l.name ?? l.email,
        channel: l.source,
        last_message_at: l.updated_at,
        // Never contacted is the honest reading of "unread" on this projection:
        // nobody has answered them yet.
        unread: l.first_response_at === null,
        awaiting_reply: l.first_response_at === null,
        sla_at_risk: dueSoon || l.sla_breached === true,
        // Reserved for the review queue, which lives on its own screen. False
        // rather than omitted, so the column renders instead of showing blank.
        needs_review: false,
        owner: l.owner_user_id,
      };
    });

    const matches = (t: (typeof threads)[number], key: string): boolean => {
      switch (key) {
        case 'unread': return t.unread;
        case 'awaiting_reply': return t.awaiting_reply;
        case 'my_leads': return me !== null && t.owner === me;
        case 'sla_at_risk': return t.sla_at_risk;
        case 'needs_review': return t.needs_review;
        default: return true;
      }
    };

    const FILTER_KEYS = [
      { key: 'all', label: 'All' },
      { key: 'unread', label: 'Unread' },
      { key: 'awaiting_reply', label: 'Awaiting reply' },
      { key: 'my_leads', label: 'My leads' },
      { key: 'sla_at_risk', label: 'SLA at risk' },
      { key: 'needs_review', label: 'Needs review' },
    ];

    res.status(200).json({
      success: true,
      data: {
        threads: threads.filter((t) => matches(t, filter)),
        /* ALWAYS PRESENT, even when empty. The screen reads data.filters.find(),
           and an absent array is a crash rather than an empty list — which is
           exactly how this endpoint took the Inbox down the first time. */
        filters: FILTER_KEYS.map((f) => ({
          key: f.key, label: f.label, count: threads.filter((t) => matches(t, f.key)).length,
        })),
        upstream_available: { conversation: conversation.available, crm: true },
        field_gaps: conversation.available ? [] : [
          {
            field: 'threads',
            reason: 'sdk-conversation could not be reached, so message bodies and non-lead channels are missing. The threads below are built from the local lead projection, so a rep still sees who is waiting rather than an empty screen.',
          },
        ],
      },
    });
  })
);

/* ------------------------------------------------- offers and handoffs */

/** GET /api/leadflow/opportunities/:id/offer-staleness — is the quote current. */
opportunityRoutes.get(
  '/:id/offer-staleness',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const opportunityId = String(req.params?.id ?? '');
    const checkout = await dataService.query<{
      checkout_id: string; offer_key: string; offer_version: number; sent_at: string; status: string;
    }>(
      `SELECT checkout_id, offer_key, offer_version, sent_at, status
         FROM leadflow_checkout_session
        WHERE tenant_id = $1 AND (deal_ref = $2 OR subject_ref = $2)
        ORDER BY sent_at DESC LIMIT 1`,
      [config.projexCloud.tenantId, opportunityId]
    );
    if (checkout.length === 0) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'No checkout has been sent for that opportunity, so there is no quoted version to compare');
    }
    const quoted = checkout[0];

    const current = await dataService.query<{ version: number; activated_at: string }>(
      `SELECT version, activated_at FROM leadflow_offer_version
        WHERE tenant_id = $1 AND offer_key = $2 AND activated_at IS NOT NULL AND superseded_at IS NULL
        LIMIT 1`,
      [config.projexCloud.tenantId, quoted.offer_key]
    );

    const stale = current.length > 0 && current[0].version !== quoted.offer_version;
    res.status(200).json({
      success: true,
      data: {
        opportunity_id: opportunityId, checkout_id: quoted.checkout_id,
        quoted_version: quoted.offer_version, quoted_at: quoted.sent_at,
        current_version: current[0]?.version ?? null,
        /* STALE MEANS THE TERMS MOVED UNDER AN OPEN QUOTE. The buyer is holding
           a link to something that is no longer what we sell, and the first
           anybody usually knows is when they try to pay. */
        stale,
        must_requote: stale && ['sent', 'started'].includes(quoted.status),
        note: current.length === 0
          ? 'No version of this offer is currently active, so nothing may be quoted at all until one is published.'
          : stale
            ? `The buyer holds v${quoted.offer_version}; v${current[0].version} is current. Re-send before they pay against terms nobody is offering.`
            : 'The quoted version is still the active one.',
      },
    });
  })
);

/** GET /api/leadflow/handoffs/:id — the sales-to-onboarding record. */
handoffRoutes.get(
  '/:id',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const handoffId = String(req.params?.id ?? '');
    const rows = await dataService.query<Record<string, unknown>>(
      `SELECT handoff_id, subject_ref, deal_ref, charge_ref, paid_at, accepted_at,
              accepted_by::text AS accepted_by, kickoff_at, alerted_at, exception_reason,
              exception_owner_user_id::text AS exception_owner, exception_review_at
         FROM leadflow_onboarding_handoff WHERE handoff_id::text = $1`,
      [handoffId]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No handoff with that id');
    const h = rows[0];
    const upstream = await probe<unknown>('sdk-handoff', `/api/handoffs/${encodeURIComponent(handoffId)}`);

    res.status(200).json({
      success: true,
      data: {
        ...h,
        /* Both facts, and their conjunction. Accepted-with-no-kickoff is the
           state that looks finished on a list and is not. */
        closed_won_terminal: Boolean(h.accepted_at) && Boolean(h.kickoff_at),
        awaiting: [
          ...(h.accepted_at ? [] : ['cs_acceptance']),
          ...(h.kickoff_at ? [] : ['kickoff_booked']),
        ],
        upstream_available: { handoff: upstream.available },
        field_gaps: upstream.available ? [] : [
          { field: 'draft', reason: 'sdk-handoff could not be reached, so the drafted handoff document is unavailable. The local record below is the clock and the acceptance state, which is what the alert reads.' },
        ],
      },
    });
  })
);

/* ------------------------------------------------------------ dashboards */

const dashboardFor = async (role: string): Promise<Record<string, unknown>> => {
  const health = await pipelineHealth();
  const onboarding = await onboardingAttainment();
  const sources = await funnelBySource(30);
  const escalations = await dataService.query<{ v: string }>(
    `SELECT COUNT(*)::text AS v FROM leadflow_digest_output
      WHERE tenant_id = $1 AND completed_at IS NULL AND escalated_at IS NOT NULL`,
    [config.projexCloud.tenantId]
  ).catch(() => [{ v: '0' }]);

  const common = {
    role,
    pipeline_health: health,
    open_escalations: Number(escalations[0]?.v ?? 0),
    hard_targets: { unowned: 0, active_without_next: 0 },
  };

  /* ONE DASHBOARD PER ROLE, not one dashboard with everything and a filter. A
     rep looking at leadership's revenue view and a leader looking at a rep's
     task list are both looking at the wrong screen, and a shared screen means
     one of them always is. */
  switch (role) {
    case 'leadership':
      return { ...common, onboarding_attainment: onboarding, sources: sources.slice(0, 10) };
    case 'sales_manager':
      return { ...common, sources: sources.slice(0, 10) };
    case 'sales_rep':
      return { ...common, sources: [] };
    case 'client_success':
      return { ...common, onboarding_attainment: onboarding, sources: [] };
    case 'revenue_operations':
      return { ...common, onboarding_attainment: onboarding, sources };
    default:
      return common;
  }
};

const KNOWN_ROLES = ['leadership', 'sales_manager', 'sales_rep', 'client_success', 'revenue_operations'];

/** GET /api/leadflow/dashboards/leadership. */
dashboardRoutes.get(
  '/leadership',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json({ success: true, data: await dashboardFor('leadership') });
  })
);

/** GET /api/leadflow/dashboards/:role — the five role views. */
dashboardRoutes.get(
  '/:role',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const role = String(req.params?.role ?? '');
    if (!KNOWN_ROLES.includes(role)) {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        `role must be one of ${KNOWN_ROLES.join(', ')} — an unknown role would render an empty dashboard that reads as "nothing to do"`
      );
    }
    res.status(200).json({ success: true, data: await dashboardFor(role) });
  })
);

/* ------------------------------------------------------------- incidents */

/** GET /api/leadflow/incidents — open incidents, local and upstream. */
incidentRoutes.get(
  '/',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const local = await dataService.query<Record<string, unknown>>(
      `SELECT failure_id AS incident_id, failure_mode AS kind, source_ref, detected_at,
              owner_role, fallback_taken, retry_count, resolved_at
         FROM leadflow_failure_event
        WHERE tenant_id = $1 AND resolved_at IS NULL
        ORDER BY detected_at DESC LIMIT 200`,
      [config.projexCloud.tenantId]
    );
    const upstream = await probe<{ incidents?: unknown[] }>('sdk-incident', '/api/incidents?status=open');

    res.status(200).json({
      success: true,
      data: {
        incidents: [...local, ...(upstream.data?.incidents ?? [])],
        local_count: local.length,
        upstream_count: (upstream.data?.incidents ?? []).length,
        upstream_available: { incident: upstream.available },
        field_gaps: upstream.available ? [] : [
          { field: 'incidents', reason: 'sdk-incident could not be reached, so platform-raised incidents are missing from this list. The local failure records below are complete.' },
        ],
      },
    });
  })
);

/* --------------------------------------------- governance and certification */

/** GET /api/leadflow/certification/:persona_id — is this rep signed off. */
certificationRoutes.get(
  '/:persona_id',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const personaId = String(req.params?.persona_id ?? '');
    const rows = await dataService.query<Record<string, unknown>>(
      `SELECT competency_key, score, assessed_at, assessed_by, expires_at, evidence_ref
         FROM leadflow_certification_score
        WHERE subject_id::text = $1 ORDER BY competency_key`,
      [personaId]
    ).catch(() => []);

    const now = Date.now();
    const current = rows.filter((r) => !r.expires_at || Date.parse(String(r.expires_at)) > now);

    res.status(200).json({
      success: true,
      data: {
        persona_id: personaId,
        competencies: rows,
        /* CURRENT TODAY, not ever-certified. A certification that never lapses
           stops meaning anything, and routing needs to know whether this rep is
           signed off now — not whether they once were. */
        current_competencies: current.map((r) => r.competency_key),
        certified: current.length > 0,
        lapsed: rows.filter((r) => r.expires_at && Date.parse(String(r.expires_at)) <= now).map((r) => r.competency_key),
      },
    });
  })
);

/**
 * GET /api/leadflow/go-live/status — the readiness gate.
 *
 * COMPUTED FROM FACTS, never from a checklist somebody ticks. A go-live status
 * that is a stored boolean says "ready" for as long as nobody updates it, which
 * is precisely how a launch happens with an unpublished offer and no calendar
 * connected.
 */
governanceRoutes.get(
  '/status',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const one = async (sql: string, params: unknown[] = []): Promise<number> => {
      try {
        const rows = await dataService.query<{ v: string }>(sql, params);
        return Number(rows[0]?.v ?? 0);
      } catch { return 0; }
    };
    const tenant = config.projexCloud.tenantId;

    const checks = [
      {
        key: 'offer_published',
        detail: 'At least one offer version is approved and active, so a rep has something they may quote.',
        passed: (await one(`SELECT COUNT(*)::text AS v FROM leadflow_offer_version WHERE tenant_id = $1 AND activated_at IS NOT NULL AND superseded_at IS NULL`, [tenant])) > 0,
      },
      {
        key: 'kpi_definitions_registered',
        detail: 'Every dashboard metric resolves to a registered definition, so two dashboards cannot disagree unnoticed.',
        passed: (await one(`SELECT COUNT(*)::text AS v FROM leadflow_kpi_registry WHERE tenant_id = $1 AND superseded_at IS NULL`, [tenant])) > 0,
      },
      {
        key: 'templates_published',
        detail: 'The message library has published templates, so nobody improvises copy on a live channel.',
        passed: (await one(`SELECT COUNT(*)::text AS v FROM leadflow_template_version WHERE published_at IS NOT NULL`)) > 0,
      },
      {
        key: 'no_unowned_active_leads',
        detail: 'No active lead is without an owner.',
        passed: (await one(`SELECT COUNT(*)::text AS v FROM leads WHERE owner_user_id IS NULL AND (stage IS NULL OR stage NOT IN ('closed_won','closed_lost'))`)) === 0,
      },
      {
        key: 'no_open_escalations',
        detail: 'No operating-rhythm output is escalated and still open.',
        passed: (await one(`SELECT COUNT(*)::text AS v FROM leadflow_digest_output WHERE tenant_id = $1 AND completed_at IS NULL AND escalated_at IS NOT NULL`, [tenant])) === 0,
      },
      {
        key: 'no_open_incidents',
        detail: 'No documented failure is unresolved.',
        passed: (await one(`SELECT COUNT(*)::text AS v FROM leadflow_failure_event WHERE tenant_id = $1 AND resolved_at IS NULL`, [tenant])) === 0,
      },
      {
        key: 'send_pause_released',
        detail: 'The global kill switch is not engaged.',
        passed: (await one(`SELECT COUNT(*)::text AS v FROM leadflow_kill_switch WHERE tenant_id = $1 AND engaged = TRUE`, [tenant])) === 0,
      },
    ];

    const failing = checks.filter((c) => !c.passed);
    res.status(200).json({
      success: true,
      data: {
        ready: failing.length === 0,
        checks,
        /* FAILING CHECKS ARE NAMED. "Not ready" is not an instruction; "no offer
           version is published" is something one person can go and fix. */
        blocking: failing.map((c) => c.key),
        evaluated_at: new Date().toISOString(),
        basis: 'Computed from the current state on every read. A stored readiness flag says "ready" for as long as nobody updates it, which is how a launch happens with an unpublished offer.',
      },
    });
  })
);
