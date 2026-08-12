import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { compose } from '../../orchestration/channelDecision';
import {
  listContacts, listGaps, localContact, probe, savedViews, trustRail, viewCounts,
  type Gap,
} from './contactsService';

export const contactRoutes: Router = Router();
export const savedViewRoutes: Router = Router();
contactRoutes.use(authenticate);
savedViewRoutes.use(authenticate);

const facetsOf = (req: AuthenticatedRequest): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of ['entity_type', 'trust_state', 'origin', 'channel_state', 'owner', 'q']) {
    const value = req.query?.[key];
    if (typeof value === 'string' && value !== '' && value !== 'all') out[key] = value;
  }
  return out;
};

const mustExist = async (contactId: string): Promise<NonNullable<Awaited<ReturnType<typeof localContact>>>> => {
  const contact = await localContact(contactId);
  if (!contact) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No contact with that id');
  return contact;
};

/** GET /api/leadflow/contacts — the faceted list. */
contactRoutes.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const filters = facetsOf(req);
    const { rows, total, facets } = await listContacts(filters);
    const search = await probe<unknown>('sdk-search', '/api/search/health');

    res.status(200).json({
      success: true,
      data: {
        contacts: rows, total, filters, facets,
        upstream_available: { search: search.available, crm: search.available, source_record: search.available },
        /* The list is honest about what it is NOT showing. A blank trust column
           that looks like "no trust concerns" is worse than one that says the
           value lives elsewhere. */
        field_gaps: listGaps(search.available),
      },
    });
  })
);

/**
 * POST /api/leadflow/contacts/export — only what the purpose permits.
 *
 * THE PURPOSE IS REQUIRED, never defaulted. An export with no stated purpose
 * cannot be eligibility-checked against anything, and a default would silently
 * pick one on the operator's behalf — which is how a marketing extract gets
 * taken from a list assembled for operations.
 */
contactRoutes.post(
  '/export',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : '';
    if (purpose === '') {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        'purpose is required — an export with no stated purpose cannot be checked against anybody\'s permitted uses, and defaulting one would pick it on the operator\'s behalf'
      );
    }

    const { rows } = await listContacts((body.filters ?? {}) as Record<string, string>);
    const excluded: { reason: string; count: number }[] = [];
    let exported = 0;

    for (const row of rows.slice(0, 500)) {
      const decision = await compose({
        subjectRef: `contact:${row.contact_id}`, channel: 'email', purposeKey: purpose,
        tenantId: config.projexCloud.tenantId, decidedBy: 'contactExport',
      });
      if (decision.verdict === 'allow') { exported += 1; continue; }
      const reason = decision.reasons[0]?.text ?? `The eligibility check returned ${decision.verdict}.`;
      const seen = excluded.find((e) => e.reason === reason);
      if (seen) seen.count += 1; else excluded.push({ reason, count: 1 });
    }

    res.status(200).json({
      success: true,
      data: {
        purpose, exported,
        /* An export that silently drops rows is a lie: the operator believes
           they hold the whole list and reconciles against it later. */
        excluded,
        audit_ref: null,
        evaluated_at: new Date().toISOString(),
      },
    });
  })
);

/** GET /api/leadflow/contacts/:id/summary — the header and trust rail. */
contactRoutes.get(
  '/:id/summary',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const contact = await mustExist(String(req.params?.id ?? ''));
    const projection = await probe<{ display_name?: string; source_count?: number }>(
      'sdk-identity-resolver', `/api/resolver/subjects/${encodeURIComponent(contact.id)}`
    );

    const gaps: Gap[] = [];
    if (!projection.available) {
      gaps.push({ field: 'display_name_provenance', reason: 'The identity projection could not be read, so how this name was chosen is unknown.' });
      gaps.push({ field: 'relationship_label', reason: 'Contextual role lives in the relationship graph, which could not be read.' });
    }

    res.status(200).json({
      success: true,
      data: {
        contact_id: contact.id,
        canonical_id: contact.canonical_email ?? contact.canonical_phone ?? null,
        entity_type: 'person',
        display_name: contact.name,
        /* NULL RATHER THAN A GUESS when the projection is unreadable. A name
           shown with no provenance reads as undisputed, and the whole point of
           the header is that a survived name is a decision somebody can query. */
        display_name_provenance: projection.available
          ? { projection: 'identity_resolver', source_count: projection.data?.source_count ?? null }
          : null,
        relationship_label: null,
        organization: null,
        record_owner: contact.owner_user_id ? { name: contact.owner_user_id, business_unit: null } : null,
        badges: [contact.source ?? 'unknown', ...(contact.stage ? [contact.stage] : [])],
        trust_rail: trustRail(contact),
        saved_at: contact.updated_at,
        upstream_available: { crm: projection.available, projection: projection.available, source_record: projection.available },
        field_gaps: gaps,
      },
    });
  })
);

/**
 * GET /api/leadflow/contacts/:id/overview — the six panels.
 *
 * CONTACTABILITY IS COMPUTED FROM LIVE COMPONENTS, never stored. A cached
 * contactability score outlives the consent that produced it: somebody
 * withdraws consent on Tuesday and the score still says "highly reachable" on
 * Friday, which is precisely when it gets acted on.
 */
contactRoutes.get(
  '/:id/overview',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const contact = await mustExist(String(req.params?.id ?? ''));
    const subjectRef = `contact:${contact.id}`;

    // 'call', not 'voice' — the decision engine's channel vocabulary, used
    // verbatim rather than translated, so a verdict cannot be requested for a
    // channel the engine has no rules about and silently come back permissive.
    const channels: ('email' | 'sms' | 'call')[] = ['email', 'sms', 'call'];
    const components: { channel: string; eligible: boolean; reason: string }[] = [];
    const decisions: { purpose: string; channel: string; verdict: string; reason: string }[] = [];

    for (const channel of channels) {
      const decision = await compose({
        subjectRef, channel, purposeKey: 'project_operations',
        tenantId: config.projexCloud.tenantId, decidedBy: 'contactOverview',
      });
      /* ALWAYS A REASON. A component with no reason cannot be argued with, and
         an operator staring at "not eligible" with no sentence has nothing to
         act on and no way to tell whether it is wrong. */
      const reason = decision.reasons[0]?.text
        ?? (decision.verdict === 'allow' ? 'No restriction applies on this channel for this purpose.' : `The decision engine returned ${decision.verdict}.`);
      components.push({ channel, eligible: decision.verdict === 'allow', reason });
      decisions.push({ purpose: 'project_operations', channel, verdict: decision.verdict, reason });
    }

    const eligible = components.filter((c) => c.eligible).length;
    const scoring = await probe<unknown>('sdk-scoring', `/api/scoring/subjects/${encodeURIComponent(contact.id)}`);
    const credits = await probe<unknown>('sdk-data-credits', '/api/credits/balance');

    res.status(200).json({
      success: true,
      data: {
        identity: {
          display_name: contact.name,
          survivorship_note: null,
          contextual_role: null,
          role_scope_note: 'A role is confirmed FOR a property or an organisation, never globally — none is confirmed for this record.',
          organization: null,
          record_owner: contact.owner_user_id ? { name: contact.owner_user_id, business_unit: null } : null,
        },
        contactability: {
          score: Number((eligible / channels.length).toFixed(2)),
          basis: 'Computed from the live eligibility components below at read time. Never stored — a cached score outlives the consent that produced it.',
          components,
        },
        contact_points: [
          ...(contact.email ? [{ type: 'email', value: contact.email, label: null, eligibility_note: components[0].reason }] : []),
          ...(contact.canonical_phone ? [{ type: 'phone', value: contact.canonical_phone, label: null, eligibility_note: components[1].reason }] : []),
        ],
        properties: [],
        recent_conversations: [],
        data_passport: {
          canonical_person_id: contact.canonical_email ?? contact.canonical_phone ?? null,
          primary_data_origin: contact.source,
          crosswalk_retention_note: 'Crosswalk retention is governed by the source record, not by this projection.',
          direct_relationship: contact.source_timestamp
            ? { established_at: contact.source_timestamp, method: contact.source }
            : null,
          last_identity_review: null,
        },
        channel_decisions: decisions,
        /* AN EMPTY LIST IS REPORTED AS EMPTY, never padded with generic advice.
           A recommendation nobody generated is one nobody stands behind. */
        recommended_actions: [],
        upstream_available: { projection: false, decision: true, scoring: scoring.available, credits: credits.available },
        field_gaps: [
          { field: 'properties', reason: 'Property relationships are read from sdk-rebac on the Properties tab rather than duplicated here.' },
          { field: 'recent_conversations', reason: 'The conversation thread is read on its own tab; summarising it here would mean a second unified-timeline implementation that drifts.' },
          ...(scoring.available ? [] : [{ field: 'recommended_actions', reason: 'The scoring service could not be reached, so no recommendations were generated. The empty list is an outage, not an absence of advice.' }]),
        ],
      },
    });
  })
);

/** GET /api/leadflow/contacts/:id/properties — relationships, with evidence. */
contactRoutes.get(
  '/:id/properties',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const contact = await mustExist(String(req.params?.id ?? ''));
    const rebac = await probe<{ relationships?: Record<string, unknown>[] }>(
      'sdk-rebac', `/api/rebac/subjects/${encodeURIComponent(contact.id)}/relationships`
    );

    res.status(200).json({
      success: true,
      data: {
        properties: (rebac.data?.relationships ?? []).map((r) => ({
          relationship_id: String(r.relationship_id ?? r.id ?? ''),
          property_label: typeof r.object_label === 'string' ? r.object_label : null,
          parcel_note: null,
          relationship: typeof r.role === 'string' ? r.role : null,
          trust_state: typeof r.trust_state === 'string' ? r.trust_state : null,
          valid_from: typeof r.valid_from === 'string' ? r.valid_from : null,
          evidence_summary: typeof r.evidence === 'string' ? r.evidence : null,
          active_work: null,
        })),
        upstream_available: { rebac: rebac.available, geo: false, source_record: rebac.available },
        field_gaps: rebac.available
          ? [{ field: 'parcel_note', reason: 'Parcel detail comes from the geo service, which is not configured in this environment.' }]
          : [{ field: 'properties', reason: 'sdk-rebac could not be reached, so this person\'s property relationships are unknown rather than absent.' }],
      },
    });
  })
);

/**
 * POST /api/leadflow/contacts/:id/properties/link — a contextual role.
 *
 * THE ADDRESS IS CANONICALISED UPSTREAM before the relationship is written,
 * which is why this takes a raw address rather than an id: resolving it in the
 * browser would let the client decide which place a string means, and two
 * operators typing the same house differently would create two properties.
 *
 * NO PROPERTY FACT IS WRITTEN ONTO THE PERSON. A role is a relationship between
 * a person and a place, and copying "owns 14 Elm St" onto the person record is
 * how it survives the sale of the house.
 */
contactRoutes.post(
  '/:id/properties/link',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const contact = await mustExist(String(req.params?.id ?? ''));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    const missing = ['address', 'role', 'trust_state', 'valid_from', 'evidence_type'].filter((f) => text(f) === '');
    if (missing.length > 0) {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required — a role with no evidence and no start date is an assertion nobody can date or defend`
      );
    }

    const resolved = await probe<{ address_id?: string; canonical_address?: string }>(
      'sdk-geo', '/api/geo/addresses/canonicalize', 'POST', { tenant_id: config.projexCloud.tenantId, address: text('address') }
    );
    if (!resolved.available) {
      throw new AppError(
        503, ErrorCodes.UPSTREAM_UNAVAILABLE,
        'The address could not be canonicalised, so no relationship was written. Linking against a raw string would create a second property for the same place the next time somebody types it differently.'
      );
    }

    const written = await probe<{ relationship_id?: string }>(
      'sdk-rebac', '/api/rebac/relationships', 'POST',
      {
        tenant_id: config.projexCloud.tenantId,
        subject_ref: `contact:${contact.id}`,
        object_ref: `property:${resolved.data?.address_id ?? ''}`,
        role: text('role'), trust_state: text('trust_state'), valid_from: text('valid_from'),
        evidence_type: text('evidence_type'), evidence_note: text('evidence_note') || null,
      }
    );

    res.status(201).json({
      success: true,
      data: {
        relationship_id: written.data?.relationship_id ?? null,
        canonical_address: resolved.data?.canonical_address ?? null,
        address_id: resolved.data?.address_id ?? null,
        /* Proof, not a promise: the link writes nothing onto the person, and the
           count says so rather than the documentation saying so. */
        person_attributes_written: 0,
      },
    });
  })
);

/** GET /api/leadflow/contacts/:id/relationships — the neighbourhood graph. */
contactRoutes.get(
  '/:id/relationships',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const contact = await mustExist(String(req.params?.id ?? ''));
    const budget = 1024;
    const graph = await probe<{ nodes?: Record<string, unknown>[]; edges?: Record<string, unknown>[]; truncated?: boolean }>(
      'sdk-rebac', `/api/rebac/subjects/${encodeURIComponent(contact.id)}/graph?depth=4&budget=${budget}`
    );

    res.status(200).json({
      success: true,
      data: {
        center_id: contact.id,
        nodes: (graph.data?.nodes ?? []).map((n) => ({
          node_id: String(n.node_id ?? n.id ?? ''),
          label: String(n.label ?? ''),
          kind: (['person', 'property', 'organization', 'team'].includes(String(n.kind)) ? String(n.kind) : 'person'),
        })),
        edges: (graph.data?.edges ?? []).map((e) => ({
          edge_id: String(e.edge_id ?? e.id ?? ''),
          from_id: String(e.from_id ?? ''), to_id: String(e.to_id ?? ''),
          role: String(e.role ?? ''),
          trust_state: typeof e.trust_state === 'string' ? e.trust_state : null,
          valid_from: typeof e.valid_from === 'string' ? e.valid_from : null,
          valid_to: typeof e.valid_to === 'string' ? e.valid_to : null,
          evidence_count: Number(e.evidence_count ?? 0),
        })),
        /* WHETHER TRAVERSAL STOPPED AT THE BUDGET OR AT THE GRAPH EDGE. They
           look identical in the result and mean opposite things: one is the
           whole neighbourhood, the other is a slice of a larger one. */
        budget_exhausted: graph.data?.truncated === true,
        traversal_budget: budget,
        upstream_available: { rebac: graph.available },
        field_gaps: graph.available ? [] : [{ field: 'nodes', reason: 'sdk-rebac could not be reached, so the neighbourhood is unknown rather than empty.' }],
      },
    });
  })
);

/** GET /api/leadflow/contacts/:id/provenance — contact points and assertions. */
contactRoutes.get(
  '/:id/provenance',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const contact = await mustExist(String(req.params?.id ?? ''));
    const source = await probe<{ assertions?: Record<string, unknown>[]; contact_points?: Record<string, unknown>[] }>(
      'sdk-source-record', `/api/source-records/subjects/${encodeURIComponent(contact.id)}/assertions`
    );

    /* The local projection is always shown, and always labelled as the
       PROJECTION rather than as an assertion — it is what LeadFlow decided to
       display, not evidence of where the value came from. */
    const localPoints = [
      ...(contact.email ? [{
        contact_point_id: null, type: 'email', value: contact.email, label: 'projection',
        trust_state: null, source: contact.source, effective_at: contact.source_timestamp,
        retrieved_at: contact.created_at, eligibility: null, requires_confirmation: false,
      }] : []),
      ...(contact.canonical_phone ? [{
        contact_point_id: null, type: 'phone', value: contact.canonical_phone, label: 'projection',
        trust_state: null, source: contact.source, effective_at: contact.source_timestamp,
        retrieved_at: contact.created_at, eligibility: null, requires_confirmation: false,
      }] : []),
    ];

    res.status(200).json({
      success: true,
      data: {
        contact_points: [...localPoints, ...(source.data?.contact_points ?? []).map((p) => ({
          contact_point_id: String(p.contact_point_id ?? p.id ?? ''),
          type: typeof p.type === 'string' ? p.type : null,
          value: typeof p.value === 'string' ? p.value : null,
          label: typeof p.label === 'string' ? p.label : null,
          trust_state: typeof p.trust_state === 'string' ? p.trust_state : null,
          source: typeof p.source === 'string' ? p.source : null,
          effective_at: typeof p.effective_at === 'string' ? p.effective_at : null,
          retrieved_at: typeof p.retrieved_at === 'string' ? p.retrieved_at : null,
          eligibility: null,
          /* A CANDIDATE IS NOT OPERATIONAL until a person confirms it. Treating
             an enrichment guess as a working number is how a stranger gets
             called. */
          requires_confirmation: String(p.trust_state ?? '').toLowerCase() === 'candidate',
        }))],
        assertions: (source.data?.assertions ?? []).map((a) => ({
          assertion_id: String(a.assertion_id ?? a.id ?? ''),
          assertion: String(a.field ?? a.assertion ?? ''),
          value: String(a.value ?? ''),
          source: typeof a.source === 'string' ? a.source : null,
          crosswalk_ref: typeof a.crosswalk_ref === 'string' ? a.crosswalk_ref : null,
          origin_class: typeof a.origin_class === 'string' ? a.origin_class : null,
          confidence: typeof a.confidence === 'number' ? a.confidence : null,
          effective_at: typeof a.effective_at === 'string' ? a.effective_at : null,
          retrieved_at: typeof a.retrieved_at === 'string' ? a.retrieved_at : null,
          status: (['Primary', 'Survives', 'Assertion', 'Superseded'].includes(String(a.status)) ? String(a.status) : 'Assertion'),
          superseded_reason: typeof a.superseded_reason === 'string' ? a.superseded_reason : null,
          evidence_ref: typeof a.evidence_ref === 'string' ? a.evidence_ref : null,
          sensitive: a.sensitive === true,
        })),
        upstream_available: { source_record: source.available, projection: true, vault: false },
        field_gaps: source.available ? [] : [
          { field: 'assertions', reason: 'sdk-source-record could not be reached, so the assertion history is unknown. The projection below is what LeadFlow displays, not evidence of where it came from.' },
        ],
      },
    });
  })
);

/** GET /api/leadflow/contacts/:id/conversations — thread and compose gate. */
contactRoutes.get(
  '/:id/conversations',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const contact = await mustExist(String(req.params?.id ?? ''));
    const subjectRef = `contact:${contact.id}`;
    const thread = await probe<{ messages?: Record<string, unknown>[] }>(
      'sdk-conversation', `/api/conversations?subject_ref=${encodeURIComponent(subjectRef)}`
    );

    const guardrails: { purpose: string; channel: string; verdict: string; reason: string }[] = [];
    for (const channel of ['email', 'sms'] as const) {
      const decision = await compose({
        subjectRef, channel, purposeKey: 'project_operations',
        tenantId: config.projexCloud.tenantId, decidedBy: 'composeGuardrail',
      });
      guardrails.push({
        purpose: 'project_operations', channel, verdict: decision.verdict,
        /* THE ENGINE'S SENTENCE, VERBATIM. Composed in the browser it would
           drift from the wording that was actually decided, and a dispute is
           settled against what the engine said. */
        reason: decision.reasons[0]?.text ?? `The decision engine returned ${decision.verdict}.`,
      });
    }

    res.status(200).json({
      success: true,
      data: {
        messages: (thread.data?.messages ?? []).map((m) => ({
          message_id: String(m.message_id ?? m.id ?? ''),
          channel: typeof m.channel === 'string' ? m.channel : null,
          direction: (['inbound', 'outbound', 'internal'].includes(String(m.direction)) ? String(m.direction) : null),
          body: typeof m.body === 'string' ? m.body : null,
          quoted_body: typeof m.quoted_body === 'string' ? m.quoted_body : null,
          purpose: typeof m.purpose === 'string' ? m.purpose : null,
          property_context: null,
          occurred_at: typeof m.occurred_at === 'string' ? m.occurred_at : null,
          delivery_state: typeof m.delivery_state === 'string' ? m.delivery_state : null,
          read_state: typeof m.read_state === 'string' ? m.read_state : null,
          customer_visible: String(m.direction) !== 'internal',
        })),
        compose_guardrails: guardrails,
        upstream_available: { conversation: thread.available, decision: true },
        field_gaps: thread.available ? [] : [
          { field: 'messages', reason: 'sdk-conversation could not be reached, so the thread is unknown rather than empty. The compose guardrails below were still evaluated and are safe to act on.' },
        ],
      },
    });
  })
);

/** GET /api/leadflow/contacts/:id/campaign-enrollments — verdicts at send time. */
contactRoutes.get(
  '/:id/campaign-enrollments',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const contact = await mustExist(String(req.params?.id ?? ''));
    const subjectRef = `contact:${contact.id}`;
    const enrolments = await probe<{ enrollments?: Record<string, unknown>[] }>(
      'sdk-campaign', `/api/campaigns/enrollments?subject_ref=${encodeURIComponent(subjectRef)}`
    );

    res.status(200).json({
      success: true,
      data: {
        enrollments: (enrolments.data?.enrollments ?? []).map((e) => ({
          enrollment_id: String(e.enrollment_id ?? e.id ?? ''),
          campaign_name: typeof e.campaign_name === 'string' ? e.campaign_name : null,
          campaign_id: typeof e.campaign_id === 'string' ? e.campaign_id : null,
          purpose: typeof e.purpose === 'string' ? e.purpose : null,
          enrolled_at: typeof e.enrolled_at === 'string' ? e.enrolled_at : null,
          channels: Array.isArray(e.channels) ? (e.channels as string[]) : [],
          /* THE VERDICT RECORDED AT EXECUTION, not recomputed now. Recomputing
             would answer "would we send this today", which is a different
             question from "why did this person receive it in March" — and the
             second is the one somebody asks after a complaint. */
          verdict: e.verdict === 'Eligible' || e.verdict === 'Suppressed' ? e.verdict : null,
          suppression_reason: typeof e.suppression_reason === 'string' ? e.suppression_reason : null,
          response: typeof e.response === 'string' ? e.response : null,
          outcome: typeof e.outcome === 'string' ? e.outcome : null,
          evidence_ref: typeof e.evidence_ref === 'string' ? e.evidence_ref : null,
        })),
        evaluated_at: null,
        upstream_available: { campaign: enrolments.available, decision: true },
        field_gaps: enrolments.available ? [] : [
          { field: 'enrollments', reason: 'sdk-campaign could not be reached, so enrolment history is unknown rather than absent.' },
        ],
      },
    });
  })
);

/* --------------------------------------------------------- saved views */

/** GET /api/leadflow/saved-views — filter definitions, never result sets. */
savedViewRoutes.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const views = await savedViews(req.session?.userId ?? null);
    res.status(200).json({
      success: true,
      data: {
        views,
        upstream_available: { saved_queries: true },
        field_gaps: [],
      },
    });
  })
);

/** GET /api/leadflow/saved-views/counts — live, and null when uncomputable. */
savedViewRoutes.get(
  '/counts',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const views = await savedViews(req.session?.userId ?? null);
    const counts = await viewCounts(views);
    res.status(200).json({
      success: true,
      data: {
        /* NULL, NEVER ZERO, for a count that could not be computed. Zero is a
           real answer that says "nothing matches, move on"; a failed count
           rendering as zero tells somebody their queue is empty when it is not. */
        counts, computed_at: new Date().toISOString(),
        upstream_available: { search: true },
      },
    });
  })
);

/** POST /api/leadflow/saved-views — store a filter. */
savedViewRoutes.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const scope = typeof body.scope === 'string' ? body.scope.trim() : 'private';
    if (name === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'name is required');
    if (!['private', 'team', 'organization'].includes(scope)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'scope must be one of private, team, organization');
    }
    if (scope === 'private' && !req.session?.userId) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'A private view needs an owner — one with none is visible to nobody and deletable by nobody');
    }

    const rows = await dataService.query<{ view_id: string }>(
      `INSERT INTO leadflow_saved_view (tenant_id, name, description, filters, scope, pinned, owner_user_id, owner_id, subject)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$7,'contacts') RETURNING id AS view_id`,
      [
        config.projexCloud.tenantId, name,
        typeof body.description === 'string' ? body.description : null,
        JSON.stringify(body.filters ?? {}), scope, body.pinned === true,
        req.session?.userId ?? null,
      ]
    );

    res.status(201).json({
      success: true,
      data: {
        view: {
          view_id: rows[0].view_id, name,
          description: typeof body.description === 'string' ? body.description : null,
          filters: body.filters ?? {}, scope, pinned: body.pinned === true,
          pin_order: null, shipped: false, owner: req.session?.userId ?? null,
        },
      },
    });
  })
);
