import { dataService } from '../../services/DataService';
import {
  DEFAULT_RESEARCH_SOURCES,
  researchSourceByKey,
  partitionRequestedSources,
} from '../../config/researchSources';
import { promptTemplateVersion } from '../../config/promptTemplates';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { AppError, ErrorCodes } from '../../utils/errors';
import { assertOfferTruth } from './offerTruth';
import { appendAuditEntry } from '../../platform/audit/auditLog';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { BRAND } from '../../config/verticalProfile';

/**
 * The AI SDR module.
 *
 * Qualifies a lead, researches it from permitted sources only, and drafts a
 * first touch — all of which is a PROPOSAL. There is no send path in this file
 * and no send path anywhere in the module: the SOP requires a qualified human
 * to review consequential outputs, and the way to guarantee that is not a flag
 * on a send function but the absence of the send function.
 */

export type SdrChannel = 'email' | 'sms';

export interface ScoreComponent {
  criterion: string;
  awarded: number;
  max: number;
  /** Why the points were or were not awarded, in the rep's terms. */
  because: string;
}

export interface ResearchFact {
  sourceKey: string;
  factKey: string;
  factValue: string | null;
  retrievedAt: string;
  costCredits: number;
}

export interface SdrProposal {
  id: string;
  leadId: string;
  status: 'proposed' | 'accepted' | 'rejected';
  channel: SdrChannel;
  /**
   * Always false, and present so the caller can assert it.
   *
   * A field that is structurally incapable of being true is worth more than a
   * comment saying nothing sends: a test can read it.
   */
  sent: false;
  score: number;
  scoreAttribution: ScoreComponent[];
  draftSubject: string | null;
  draftBody: string | null;
  bookingOptions: string[];
  research: ResearchFact[];
  /** Permitted sources that could not be reached, so partial research is visible. */
  researchUnavailable: string[];
  templateVersion: string;
}

/**
 * The approved first-touch template this module renders from.
 *
 * READ FROM THE VERSIONED LIBRARY rather than typed here. It was a literal until
 * the library existed, and a second copy of a version string is a second thing
 * to forget: the day somebody publishes a new first-touch template, the copy
 * that does not get updated is the one stamped onto every proposal.
 */
export const TEMPLATE_VERSION = promptTemplateVersion('sdr_first_touch');

/**
 * The qualification criteria.
 *
 * DETERMINISTIC AND ATTRIBUTED, not a model call. Two reasons. A model cannot
 * promise the same lead scores the same twice, and a rep who sees a lead move
 * from 62 to 71 with nothing changed stops believing any of it. And the
 * criterion asks for feature attribution — every point traceable to the rule
 * that awarded it — which a language model can only narrate after the fact.
 */
interface LeadRow {
  id: string;
  name: string | null;
  email: string | null;
  source: string | null;
  canonical_phone: string | null;
  attribution_campaign_id: string | null;
  utm_campaign: string | null;
  attribution_form_id: string | null;
  activation_state: string | null;
  created_at: Date;
}

function scoreLead(lead: LeadRow): ScoreComponent[] {
  const contactable = Boolean(lead.email || lead.canonical_phone);
  const attributed = Boolean(
    lead.attribution_campaign_id || lead.utm_campaign || lead.attribution_form_id
  );
  const ageHours = (Date.now() - new Date(lead.created_at).getTime()) / 3_600_000;

  return [
    {
      criterion: 'contactable',
      awarded: contactable ? 30 : 0,
      max: 30,
      because: contactable
        ? 'A usable email or phone is on the record.'
        : 'No usable channel. Weighted heaviest because a lead nobody can reach cannot be worked at any score.',
    },
    {
      criterion: 'named',
      awarded: lead.name && lead.name.trim().length > 0 ? 15 : 0,
      max: 15,
      because: lead.name
        ? 'The record carries a name, so a first touch can open with one.'
        : 'No name. A personalised opening is the one thing the SOP asks of every first touch, and it cannot be written without this.',
    },
    {
      criterion: 'attributed',
      awarded: attributed ? 15 : 0,
      max: 15,
      because: attributed
        ? 'Campaign, UTM or form is known, so the draft can reference what they responded to.'
        : 'No attribution. The draft must open generically, which the SOP explicitly discourages.',
    },
    {
      criterion: 'known_source',
      awarded: lead.source && lead.source.trim().length > 0 ? 15 : 0,
      max: 15,
      because: lead.source
        ? `Arrived through ${lead.source}.`
        : 'Source unknown, so neither the provenance chain nor the source-quality report can include this lead.',
    },
    {
      criterion: 'fresh',
      // Graded, not a cliff: a lead 25 hours old is not meaningfully worse
      // than one 23 hours old, and a threshold there would make the score jump
      // for a reason nobody could explain to a rep.
      awarded: ageHours <= 24 ? 15 : ageHours <= 72 ? 8 : 0,
      max: 15,
      because:
        ageHours <= 24
          ? 'Arrived within the last day, when response rates are highest.'
          : ageHours <= 72
            ? 'Two to three days old. Still workable, past the best window.'
            : 'Older than three days. The SOP treats a cold inbound as a different play.',
    },
    {
      criterion: 'activation_ready',
      awarded: lead.activation_state === 'active' ? 10 : 0,
      max: 10,
      because:
        lead.activation_state === 'active'
          ? 'Passed the required-field activation gate.'
          : 'Has not passed the activation gate, so required fields are still missing.',
    },
  ];
}

/**
 * Gather research facts from permitted sources.
 *
 * A source that cannot be reached is REPORTED, not silently omitted. Partial
 * research that looks complete is the failure mode here: a rep reading a draft
 * has no way to tell whether the registry lookup found nothing or never ran,
 * and those warrant different amounts of trust in what the draft says.
 */
async function research(
  lead: LeadRow,
  sourceKeys: string[]
): Promise<{ facts: ResearchFact[]; unavailable: string[] }> {
  const facts: ResearchFact[] = [];
  const unavailable: string[] = [];
  const retrievedAt = new Date().toISOString();

  for (const key of sourceKeys) {
    const source = researchSourceByKey(key);
    if (!source) {
      continue;
    }

    if (key === 'submitted_form_content') {
      // What the prospect told us. No external call, and the strongest source
      // there is — volunteered, current, already lawfully held.
      const volunteered: [string, string | null][] = [
        ['name', lead.name],
        ['email', lead.email],
        ['source', lead.source],
        ['campaign', lead.attribution_campaign_id ?? lead.utm_campaign],
      ];
      for (const [factKey, factValue] of volunteered) {
        if (factValue) {
          facts.push({ sourceKey: key, factKey, factValue, retrievedAt, costCredits: 0 });
        }
      }
      continue;
    }

    if (!SdkGatewayClient.isConfigured()) {
      unavailable.push(key);
      continue;
    }

    try {
      const result = await SdkGatewayClient.call<{ data?: { facts?: Record<string, string> } }>({
        sdk: key === 'crm_prior_interactions' ? 'sdk-crm' : 'semantic-service',
        path: '/api/research/lookup',
        method: 'POST',
        body: { source: key, email: lead.email, name: lead.name },
      });

      const returned = result.data?.data?.facts ?? {};
      for (const [factKey, factValue] of Object.entries(returned)) {
        facts.push({
          sourceKey: key,
          factKey,
          factValue: String(factValue),
          retrievedAt,
          costCredits: source.costCredits,
        });
      }
      if (!result.delivered) {
        unavailable.push(key);
      }
    } catch {
      unavailable.push(key);
    }
  }

  return { facts, unavailable };
}

/**
 * Render the first touch from the approved template.
 *
 * RENDERED, NOT GENERATED. The SOP prescribes the first-response email and
 * requires the approved template voice; a model writing free prose would be
 * producing unapproved copy on every call, and reviewing it would fall to
 * whichever rep happened to read it carefully. Personalisation goes in the
 * slots the SOP marks as personalisable — the first line and the reference to
 * what they responded to — and nowhere else.
 */
function renderDraft(
  lead: LeadRow,
  channel: SdrChannel,
  facts: ResearchFact[]
): { subject: string | null; body: string } {
  const firstName = (lead.name ?? '').trim().split(/\s+/)[0] || 'there';
  const campaign = facts.find((fact) => fact.factKey === 'campaign')?.factValue ?? null;
  const reference = campaign
    ? `about ${campaign}`
    : lead.source
      ? `through ${lead.source}`
      : `about ${BRAND.tradingName}`;

  if (channel === 'sms') {
    // One CTA, and the identification the SOP requires on an outbound message.
    return {
      subject: null,
      body: `Hi ${firstName}, this is ${BRAND.tradingName} following up on your enquiry ${reference}. Is now a good time for a short call, or would later today suit you better? Reply STOP to opt out.`,
    };
  }

  return {
    subject: `We received your ${BRAND.tradingName} request`,
    body: [
      `Hi ${firstName},`,
      '',
      `Thanks for reaching out ${reference}. I am reviewing your request now and will call you shortly.`,
      '',
      'The goal is simple: understand what caught your attention, see whether the platform fits your workflow, and give you an honest next step.',
      '',
      'If a particular time suits you better, tell me which of the options below works and I will send the invite.',
    ].join('\n'),
  };
}

/** Three concrete times to offer. */
function bookingOptions(): string[] {
  const base = Date.now();
  const day = 86_400_000;
  return [
    new Date(base + day).toISOString(),
    new Date(base + day + 5 * 3_600_000).toISOString(),
    new Date(base + 2 * day).toISOString(),
  ];
}

export interface QualifyInput {
  leadId: string;
  channel: SdrChannel;
  /** Optional explicit source list. Defaults to the free, permitted sources. */
  researchSources?: string[];
  /** Who asked. Recorded on the research entry. */
  actor?: string | null;
}

export async function qualifyLead(input: QualifyInput): Promise<SdrProposal> {
  const requested = input.researchSources ?? DEFAULT_RESEARCH_SOURCES;
  const { permitted, refused } = partitionRequestedSources(requested);

  // Checked BEFORE the lead is loaded and before anything is written, so a bad
  // source list cannot leave a half-built proposal behind. Reports every
  // refusal at once rather than one per request.
  if (refused.length > 0) {
    throw new AppError(
      422,
      ErrorCodes.RESEARCH_SOURCE_NOT_PERMITTED,
      `Research sources not in the permitted registry: ${refused.join(', ')}`
    );
  }

  const lead = await dataService.queryOne<LeadRow>(
    `SELECT id, name, email, source, canonical_phone, attribution_campaign_id, utm_campaign,
            attribution_form_id, activation_state, created_at
       FROM leads WHERE id = $1`,
    [input.leadId]
  );

  if (!lead) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Lead not found');
  }

  const attribution = scoreLead(lead);
  const score = attribution.reduce((total, component) => total + component.awarded, 0);

  const { facts, unavailable } = await research(lead, permitted);
  const draft = renderDraft(lead, input.channel, facts);

  // Checked before the proposal is stored. A rejected draft must not sit in the
  // rep's queue looking reviewable — the point of rejecting rather than editing
  // is that somebody finds out the generator produced unusable copy.
  assertOfferTruth(draft.subject, 'Draft subject');
  assertOfferTruth(draft.body, 'Draft body');

  const options = bookingOptions();

  const row = await dataService.queryOne<{ id: string }>(
    `INSERT INTO ai_sdr_proposal
       (lead_id, status, channel, score, score_attribution, draft_subject, draft_body,
        booking_options, template_version)
     VALUES ($1, 'proposed', $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      lead.id,
      input.channel,
      score,
      JSON.stringify(attribution),
      draft.subject,
      draft.body,
      JSON.stringify(options),
      TEMPLATE_VERSION,
    ]
  );

  const proposalId = row!.id;

  for (const fact of facts) {
    await dataService.query(
      `INSERT INTO ai_research_fact (proposal_id, source_key, fact_key, fact_value, retrieved_at, cost_credits)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [proposalId, fact.sourceKey, fact.factKey, fact.factValue, fact.retrievedAt, fact.costCredits]
    );
  }

  // WHICH SOURCES produced this draft, in the ledger. ai_research_fact answers
  // it too, but that table is redacted by an erasure — and "where did this
  // person's data come from" is a question most often asked BY the person
  // exercising that erasure. The ledger entry names sources, never values.
  await appendAuditEntry({
    event: AUDIT_EVENTS.AI_RESEARCH_PERFORMED,
    actor: input.actor ?? 'system',
    personaRole: 'system',
    purpose: 'lead_management',
    decisionRef: `research-sources:${permitted.join(',') || 'none'}`,
    evidenceRef: `proposal:${proposalId}`,
    causationId: lead.id,
    idempotencyRef: `research:${proposalId}`,
  });

  return {
    id: proposalId,
    leadId: lead.id,
    status: 'proposed',
    channel: input.channel,
    sent: false,
    score,
    scoreAttribution: attribution,
    draftSubject: draft.subject,
    draftBody: draft.body,
    bookingOptions: options,
    research: facts,
    researchUnavailable: unavailable,
    templateVersion: TEMPLATE_VERSION,
  };
}

export interface AcceptInput {
  proposalId: string;
  userId: string | null;
  acceptedAsWritten: boolean;
  editedBody: string | null;
}

/**
 * A rep accepts a proposal.
 *
 * The edit is stored ALONGSIDE the original rather than over it — the original
 * is the only evidence of what the model actually produced, and it is exactly
 * the record needed to tell whether the drafts are getting better.
 */
export async function acceptProposal(input: AcceptInput): Promise<{
  id: string;
  status: string;
  bodyToSend: string | null;
  wasEdited: boolean;
}> {
  const existing = await dataService.queryOne<{
    id: string;
    status: string;
    draft_body: string | null;
  }>('SELECT id, status, draft_body FROM ai_sdr_proposal WHERE id = $1', [input.proposalId]);

  if (!existing) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Proposal not found');
  }

  if (existing.status !== 'proposed') {
    // A conflict, not a silent no-op: two acceptances mean two people each
    // believed they were the one releasing the message, and answering 200 to
    // both hides a coordination failure worth surfacing.
    throw new AppError(409, ErrorCodes.CONFLICT, 'Proposal has already been decided');
  }

  if (input.editedBody !== null) {
    // A rep editing under time pressure can introduce the very promise the
    // constraints exist to prevent, and an unapproved discount is no more
    // approved for having been typed by a person.
    assertOfferTruth(input.editedBody, 'Edited draft');
  }

  await dataService.query(
    `UPDATE ai_sdr_proposal
        SET status = 'accepted', edited_body = $2, decided_by_user_id = $3,
            decided_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [input.proposalId, input.editedBody, input.userId]
  );

  return {
    id: input.proposalId,
    status: 'accepted',
    bodyToSend: input.editedBody ?? existing.draft_body,
    wasEdited: input.editedBody !== null,
  };
}
