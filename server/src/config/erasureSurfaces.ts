/**
 * Every LeadFlow-local surface that can hold data about a data subject.
 *
 * THE CERTIFICATE IS ONLY AS HONEST AS THIS LIST. An erasure certificate names
 * a shred proof per surface; a surface missing here produces a certificate that
 * says the subject's data is gone while it is still sitting in a table. That is
 * worse than an incomplete erasure — it is a false attestation, and the person
 * relying on it has no way to know.
 *
 * Enumerated from the actual migrations rather than from memory. Verified
 * against server/src/db/migrations: the schema holds leads, users,
 * routing_rules, sla_metrics, sla_alerts, sla_policies, offline_capture_sync,
 * intake_event, intake_outage_queue, lead_source_event, ai_sdr_proposal,
 * ai_research_fact, ai_coach_call, ai_coach_scorecard, ai_proposal,
 * ai_completion, ai_agent_run, ai_capability_token, ai_budget, call_recording,
 * call_custody_event and call_artifact — and each is
 * classified below, including the ones that
 * hold NOTHING, because "we checked and it is clean" and "we forgot it
 * existed" must not look alike. `erasurePlan.test.ts` reads the live schema and
 * fails if a table is added without a decision here, which is how this list
 * stays true rather than merely starting true.
 */

/** How a surface is cleared. */
export type ErasureMethod =
  /** Row deleted outright. */
  | 'delete'
  /** Personal columns nulled, the row kept because something references it. */
  | 'redact'
  /** Encryption key destroyed, ciphertext left unreadable. */
  | 'crypto_shred'
  /** Nothing to do — recorded so the check is visible. */
  | 'no_subject_data';

export interface ErasureSurface {
  /** Table or store name. */
  surface: string;
  method: ErasureMethod;
  /** Columns carrying personal data, empty when none do. */
  personalColumns: string[];
  /** Why this method and not another. */
  rationale: string;
}

export const ERASURE_SURFACES: ErasureSurface[] = [
  {
    surface: 'leads',
    method: 'redact',
    personalColumns: ['name', 'email', 'canonical_email', 'canonical_phone', 'canonical_social_id'],
    rationale:
      'The primary subject surface, and it holds LESS than it looks. The local projection stores name, email and source only — phone, company, message and utm are accepted by the capture validator and asserted upstream, never inserted here. This list previously named all six, and the four phantom columns would have made erasure fail with "column does not exist" at the exact moment somebody exercised their erasure right, on a path nobody walks in normal use. `erasurePlan.test.ts` now checks every named column against the live schema so it cannot drift again. The fields held upstream are cleared through the source record, which is a different surface and not this list. The canonical_* columns are NORMALISED COPIES of the same personal data, added for dedupe, and they must be redacted too — leaving them would keep the email and phone in the very table designed to be probed on every inbound signal. Doing so also stops an erased person being deduped against, which is correct: a later signal from them starts a fresh record rather than resurrecting the one they asked to be erased. REDACTED rather than deleted: sla_metrics, sla_alerts and every routing decision reference the lead id, and deleting the row would either cascade away the compliance record or break the FK. Nulling the personal columns removes the person while leaving the fact that a lead existed and was handled, which is what an SLA audit needs.',
  },
  {
    surface: 'users',
    method: 'redact',
    personalColumns: ['first_name', 'last_name', 'email', 'phone', 'username'],
    rationale:
      'Operators are data subjects too, and an employee erasure request is as valid as a prospect\'s. Redacted, not deleted, for the same reason: users.id is the target of five foreign keys across four tables, and removing it would erase who handled a lead rather than just who they were.',
  },
  {
    surface: 'sla_metrics',
    method: 'redact',
    personalColumns: ['note'],
    rationale:
      'Holds subject_lead_id plus a free-text note an operator wrote, which routinely quotes what the person said. The note is the only personal field; the timings and clock provenance are about our own performance and are retained.',
  },
  {
    surface: 'sla_alerts',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'References lead_id and recipient_user_id but stores no personal values of its own, so it is cleared transitively by the two surfaces above. Listed explicitly so a future column addition is a visible change to this file rather than a silent gap.',
  },
  {
    surface: 'routing_rules',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'Configuration. Holds assigned_user_id as a pointer, never personal values.',
  },
  {
    surface: 'sla_policies',
    method: 'no_subject_data',
    personalColumns: [],
    rationale: 'Configuration only — response targets by lead type.',
  },
  {
    surface: 'analytics_rollups',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'No rollup table of its own for the query-time dashboard: AnalyticsService aggregates over the leads table at read time, so once leads is redacted the dashboard reflects it on the next read. This entry USED to say LeadFlow had no rollup table AT ALL, which stopped being true when migration 015 added leadflow_dashboard_rollup - see that surface below. Kept under its own name because the erasure certificate names it, and a line that simply disappeared would read as a skipped check rather than a corrected one.',
  },
  {
    surface: 'template_merge_cache',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'Named in the brief; does not exist in LeadFlow today. Listed so that adding one later forces a decision here rather than quietly creating an unerasable surface.',
  },
  {
    surface: 'client_saved_view',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'The analytics saved view lives in the operator\'s own browser localStorage, not on the server, and holds filter selections — which can include an owner_user_id. It is out of reach of a server-side erasure and belongs to the operator\'s device rather than the tenant. Flagged so it is a known limit of the certificate rather than an unexamined one.',
  },
  {
    surface: 'offline_capture_sync',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'The idempotency ledger for offline sync. Holds a device-generated capture id, the source record id it produced, the capture kind and two timestamps — no name, no contact point, no captured content. The evidence itself lives in the source record, which is where erasure acts. AND THE ROW MUST BE KEPT, not merely left alone: if an erasure deleted it, a device still holding that capture in its queue would sync again, the server would see an id it has never seen, and it would create a NEW source record for the person just erased. Retaining the row is what makes the erasure stick — the replay answers duplicate and creates nothing. Deleting it would quietly undo the erasure through the most ordinary action in the system, a phone reconnecting.',
  },
  {
    surface: 'intake_event',
    method: 'redact',
    personalColumns: ['raw_payload'],
    rationale:
      'The raw intake archive. raw_payload holds whatever the platform sent — names, emails, phone numbers, call transcripts — so it is a real subject surface, and leaving it while redacting the lead would defeat the erasure entirely: the same personal data would still sit here, in the table specifically designed to survive everything else. REDACTED, NOT DELETED, for the same reason as the offline sync ledger: the row IS the replay key. Delete it and the next redelivery of that webhook looks new, and a lead is recreated for the person just erased — the erasure undone by a provider retry nobody controls. Nulling raw_payload removes the person while the (platform, source_event_id) pair stays to keep refusing the replay. What remains is that an event arrived and what became of it, which is the provenance record an audit needs and carries nothing about who it concerned.',
  },
  {
    surface: 'intake_outage_queue',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'Holds a platform, a source event id, which dependency was down, an attempt count and timestamps. No payload and no personal data — the content it refers to lives in intake_event, which is where erasure acts. Kept rather than cleared so the record of a delay survives: "this event sat queued for four hours during an outage" is exactly what gets asked afterwards, and a draining backfill would in any case find a redacted payload and create nothing.',
  },
  {
    surface: 'lead_source_event',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'One row per source event that contributed to a canonical lead. Holds a lead id, the platform, the event id that platform issued, which dedupe key matched, and a consent snapshot — no name, email, phone or handle. The person is identified only through lead_id, which the leads surface redacts. KEPT rather than cleared, and consent is the reason: the snapshot is the proof of what was permitted at the moment each signal arrived, including a revocation, and erasing it would destroy the evidence that the erasure itself was honoured. SOP §03 is explicit that a merge preserves every source event and consent record; erasure does not get to undo that, because the record of a privacy action must outlive the data it acted on.',
  },
  {
    surface: 'ai_sdr_proposal',
    method: 'redact',
    personalColumns: ['draft_subject', 'draft_body', 'edited_body'],
    rationale:
      'A drafted first touch is a document ABOUT a person and usually addressed to them by name — the draft body is as much a subject surface as the lead row it was written from. Redacted, not deleted, because ai_research_fact hangs off the proposal id and the score attribution is the record of how this person was judged, which an automated-decision request is entitled to see. Nulling the three copy columns removes what was going to be said to them while leaving that a proposal existed, what it scored and whether a human accepted it. The edited body is redacted alongside the original: a rep rewrite is no less about the person for having been typed by hand.',
  },
  {
    surface: 'ai_research_fact',
    method: 'redact',
    personalColumns: ['fact_value'],
    rationale:
      'Every fact the research step gathered, one row each. fact_value is the personal data — a name, a role, a headcount attached to an identifiable person — so it is nulled. The SOURCE KEY AND TIMESTAMP ARE KEPT, deliberately: "we looked this person up at an approved data partner on this date" is the record that answers where their data came from, and it is precisely what a subject access request asks for. Erasing the provenance along with the fact would leave us unable to answer the question the erasure request itself is usually attached to.',
  },
  {
    surface: 'ai_coach_call',
    method: 'redact',
    personalColumns: ['rep_email'],
    rationale:
      'Operators are data subjects too, and a rep leaving may exercise the same right a prospect does. rep_email is the only personal column — no transcript content is stored here by design, only identifiers, the recording basis and the pointer to sdk-conversation, so a revoked recording consent has no local content to purge. The consent basis reference is KEPT: it is a pointer into the consent service, not the consent itself, and it is the evidence that the call was lawfully recorded. Redacted rather than deleted because ai_coach_scorecard references the call id, and deleting it would take the coaching record with it.',
  },
  {
    surface: 'ai_coach_scorecard',
    method: 'redact',
    personalColumns: ['keep_behaviour', 'change_behaviour', 'practice_assignment'],
    rationale:
      'Coaching output about a named rep. The three free-text columns describe an identifiable person’s performance and go. The dimension scores are kept — they are the aggregate the team’s coaching trend is built from, and they carry no name once the call row is redacted. consent_verification is KEPT and this is the important one: it records HOW the recording basis was verified when the scorecard was produced, and it is the only durable evidence that this call was lawfully processed. Destroying it during an erasure would remove the proof of compliance at exactly the moment somebody is exercising a privacy right — the record of a privacy control must outlive the data it protected.',
  },
  {
    surface: 'ai_proposal',
    method: 'redact',
    personalColumns: ['content', 'edited_content', 'decision_note'],
    rationale:
      'The human-review gate holds whatever an agent proposed — a drafted message, a qualification score with its reasoning, a call summary — and all three are documents ABOUT a person, usually naming them. content and edited_content go together, and the reviewer note goes with them because a note explaining why a draft was rejected routinely quotes the draft. REDACTED, NOT DELETED, and the reason is the same one that keeps ai_sdr_proposal: what must survive is that a proposal existed, which agent made it, WHICH AUTHORITY A HUMAN NEEDED TO ACCEPT IT, and whether one did. That quartet is the evidence that no consequential output reached anybody without human acceptance, and it is exactly what an automated-decision request asks to see. Deleting the row would erase the proof of the control along with the data it controlled. Note the columns are JSONB, and nulling a JSONB column is a perfectly ordinary UPDATE — the erasure does not need to know their shape.',
  },
  {
    surface: 'ai_completion',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'The AI activity ledger, and it holds NO prompt and NO output text — by design, not by omission. It records the four controls (a consent receipt REFERENCE, a budget reservation reference, which redaction rules fired and how many spans each removed, and a trace id) plus the agent, template version and outcome. The redaction record is counts only: storing what was redacted would make this the one table holding the personal data every other layer removed. So there is nothing here to erase, and the row must be KEPT — it is the evidence that a given completion happened under a consent basis, which is precisely what somebody exercising a privacy right is entitled to be shown. The generated content lives on ai_proposal, which is where erasure acts.',
  },
  {
    surface: 'ai_agent_run',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'Operational record of a run: agent key, upstream run id, status, trace id, who started it and when. started_by is a persona or user identifier, not a personal value — the operator themselves is cleared through the users surface. Kept so that "what was running when we pulled the kill switch" stays answerable after an incident.',
  },
  {
    surface: 'ai_capability_token',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'Scope and lifecycle of the capability tokens issued to agents. Holds the capability list, the upstream token id and the timestamps — never the credential and never anything about a data subject. Listed explicitly so adding a column here forces a decision rather than creating a quiet gap.',
  },
  {
    surface: 'ai_budget',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'Per-tenant token allowance and spend for a period. Counters and a tenant id; nothing about a person. Kept for the same reason a bill is kept.',
  },
  {
    surface: 'call_artifact',
    method: 'redact',
    personalColumns: ['content'],
    rationale:
      'Everything derived from a recording — transcript segments, summary, objections, action items — and the transcript segments in particular are the person\'s own words. content is the personal column and it goes. THE OFFSETS AND THE KIND ARE KEPT, deliberately: what must survive an erasure is that an artifact existed, which stage produced it and where in the call it pointed, because that is the record showing the pipeline processed this person under a basis. Nulling content removes what was said while leaving the shape of the processing, which is exactly what an automated-decision or subject-access request asks to see. Note the redaction_applied column is counts only and carries nothing personal.',
  },
  {
    surface: 'call_recording',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'NO MEDIA IS HELD HERE, by design and not by omission — the row carries the sdk-media blob POINTER, the consent basis reference, the jurisdiction rule applied and a content hash. The audio itself never enters this database, which is the strongest available answer to "are you sure the recording is gone": it was never here. The row is KEPT rather than deleted, and the consent basis reference with it, because it is the evidence that the recording existed under a lawful basis and that the media was subsequently purged upstream. Destroying that during an erasure would remove the proof of the control at exactly the moment somebody is exercising a privacy right. Purging the upstream blob is an sdk-media action recorded as a purged custody event, not a delete here.',
  },
  {
    surface: 'call_custody_event',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'The append-only chain of custody: stage, actor, a detail line, a hash and a timestamp. Actors are operators or services, cleared through the users surface, and the detail lines are written about the PIPELINE rather than about the person — no transcript text, no contact point. AND IT COULD NOT BE ERASED EVEN IF IT HELD SOMETHING: migration 014 installs a trigger that refuses UPDATE and DELETE, because a chain the application can rewrite is not a chain. That is a deliberate constraint on erasure and it is the right one — the record of who handled a recording must outlive the recording, or the erasure itself becomes unprovable. Any future column here must therefore be non-personal by construction.',
  },
  {
    surface: 'leadflow_outbox',
    method: 'delete',
    personalColumns: ['payload'],
    rationale:
      'THE SURFACE MOST EASILY MISSED, because the data is only passing through. A pending row holds the full body of a write on its way to a ProjexCloud SDK — a name, an email, a phone number — and it sits there for as long as the dispatcher has not succeeded, which during an outage is hours. Erasing the lead while a queued row still describes them would re-send the erased person upstream on the next retry, turning an erasure into a delayed re-creation. DELETED rather than redacted: an outbox row is an INTENT, and an intent with its payload nulled is not a smaller intent, it is a broken one the dispatcher would retry forever. A dispatched row is equally deletable — the record of what was sent belongs in the audit ledger, which is sdk-audit\'s surface, not this one.',
  },
  {
    surface: 'leadflow_dashboard_rollup',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'Aggregates only: a KPI key, a window, a numeric value and a sample size. scope_id holds a team or owner id rather than a personal value, and it is cleared transitively through users. A rollup that named individuals would need a different method entirely; listed explicitly so adding such a column is a visible change to this file rather than a silent gap.',
  },
  {
    surface: 'leadflow_operating_rhythm_digest',
    method: 'delete',
    personalColumns: ['payload'],
    rationale:
      'The management digest embeds a SNAPSHOT — "these five leads are at risk", by name — so it carries personal data that outlives the records it was drawn from. Deleted rather than redacted, because a digest whose payload is nulled proves only that a digest happened, and the question worth answering (was the Monday review produced?) is still answerable from the period index. Regenerating one after an erasure is correct: it should describe the world after the erasure, not before it.',
  },
  {
    surface: 'leadflow_certification_score',
    method: 'redact',
    personalColumns: ['assessed_by'],
    rationale:
      'Operators are data subjects too. subject_id points at users and is cleared there, but assessed_by is free text that in practice holds an assessor\'s email. REDACTED rather than deleted: routing consults whether a certification is current, and deleting the row would silently make a certified representative ineligible as a side effect of somebody else\'s erasure request.',
  },
  {
    surface: 'leadflow_saved_view',
    method: 'delete',
    personalColumns: ['filters'],
    rationale:
      'A saved view stores a QUESTION, and a question can name a person — "everything for dana@example.com" is an ordinary saved filter. The value is personal data even though no column is named for it. Deleted rather than redacted because a view whose filter is nulled MATCHES EVERYTHING, which is worse than the view not existing: an operator opens it expecting a narrow queue and is handed the whole table.',
  },
  {
    surface: 'leadflow_template_library',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'Templates, not messages. The body holds merge placeholders; the rendered result containing a real name is transient and never stored here. A real person\'s details typed into a template is a content error rather than a schema one, and the approval step is where that is caught.',
  },
  {
    surface: 'leadflow_stage_config',
    method: 'no_subject_data',
    personalColumns: [],
    rationale: 'Configuration — the ten SOP §06 stages and their entry/exit evidence rules.',
  },
  {
    surface: 'leadflow_disposition_code',
    method: 'no_subject_data',
    personalColumns: [],
    rationale: 'Configuration — the contact-outcome vocabulary.',
  },
  {
    surface: 'leadflow_close_reason',
    method: 'no_subject_data',
    personalColumns: [],
    rationale: 'Configuration — why a record closed won or lost.',
  },
  {
    surface: 'leadflow_kpi_definition',
    method: 'no_subject_data',
    personalColumns: [],
    rationale: 'Configuration — KPI labels, units, direction and targets.',
  },
  {
    surface: 'leadflow_purpose_taxonomy_map',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'Maps a consent purpose key to this vertical\'s wording. The KEY is shared with ProjexCloud and the label is copy; neither identifies anybody. The consent RECEIPTS that reference these keys are sdk-consent\'s surface, not this one.',
  },
  {
    surface: 'leadflow_routing_config',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'Configuration — the tenant\'s routing preferences. Holds no subject data of its own: a rule pinning a territory to a representative stores that representative\'s id, and users is where that is cleared.',
  },
];

/** Surfaces that actually require an erasure action. */
export function actionableSurfaces(): ErasureSurface[] {
  return ERASURE_SURFACES.filter((surface) => surface.method !== 'no_subject_data');
}

/** Every surface name, for reconciling a certificate against the plan. */
export function allSurfaceNames(): string[] {
  return ERASURE_SURFACES.map((surface) => surface.surface);
}
