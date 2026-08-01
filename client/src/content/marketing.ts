/**
 * The single source of truth for LeadFlow's go-to-market copy.
 *
 * Every claim here traces to a capability that is actually planned and tracked:
 * the epic list in ProjexLight, the Lynked Up Pro Sales Workflow SOP v3.0, and
 * `docs/LeadFlow_Architecture_and_SDK_Decision.md`. Marketing pages render from
 * this file rather than hard-coding strings, so the story cannot drift from the
 * roadmap and a positioning change lands in one place.
 *
 * Rule for anything added here: if it does not map to an epic, it does not ship.
 */

export interface Capability {
  /** Short label used in nav and cards. */
  name: string;
  /** The customer-facing promise, in one line. */
  promise: string;
  /** What it actually does — concrete, not aspirational. */
  detail: string;
  /** The epic this traces to, so the claim is auditable. */
  epic: string;
  /** Token colour name carrying the status meaning for this capability. */
  tone: 'blue' | 'green' | 'gold' | 'purple' | 'cyan' | 'orange' | 'mag';
}

export interface Persona {
  role: string;
  pain: string;
  outcome: string;
  proof: string;
}

export interface Metric {
  value: string;
  label: string;
  footnote: string;
}

/** The one-line positioning. Used in the hero and the meta description. */
export const POSITIONING = {
  eyebrow: 'The AI Revenue Operating System',
  headline: 'Every lead owned. Every response inside 30 minutes.',
  headlineAccent: 'Every fact traceable to its source.',
  lede:
    'LeadFlow is not another CRM to fill in. It is the operating system that enforces your revenue process — routing every lead to a named owner, holding a business-hours clock against every response, and recording where every contact fact came from before it is ever trusted.',
  primaryCta: 'Book a working demo',
  secondaryCta: 'See how it works',
} as const;

/**
 * The problem statement. Deliberately specific — these are the four failures the
 * SOP was written to eliminate, and they are what a buyer recognises.
 */
export const PROBLEMS: { title: string; body: string }[] = [
  {
    title: 'Leads arrive and nobody owns them',
    body: 'A form fills at 4:55pm on a Friday. It sits in a shared inbox until Monday. By then the prospect has bought from whoever answered first. Most CRMs record this faithfully and change nothing.',
  },
  {
    title: 'The response clock is a wish, not a rule',
    body: 'Everyone agrees speed to lead matters. Nothing in the system stops a lead going cold, and nothing distinguishes a real human attempt from an auto-reply that ticked a box.',
  },
  {
    title: 'Contact data is trusted with no idea where it came from',
    body: 'An import overwrites a verified mobile number with a scraped one. Nobody can tell which value was right, when it changed, or who is allowed to be contacted under which consent.',
  },
  {
    title: 'Pipeline reflects optimism instead of evidence',
    body: 'Deals sit in a stage for weeks with no next action booked. The forecast is a set of feelings with dates attached, and the first anyone hears of a slip is the month it lands.',
  },
];

/**
 * The core capability set. Each maps to a tracked epic — the `epic` field is the
 * receipt for the claim.
 */
export const CAPABILITIES: Capability[] = [
  {
    name: 'Universal capture',
    promise: 'Every lead reaches one canonical record, whatever door it came through.',
    detail:
      'Web forms, Meta, LinkedIn, TikTok, Google, live chat, phone, email, referral, webhook, API and CSV all land through one intake with idempotency and per-platform receivers. A signal policy engine decides create, merge, or no-record — so a duplicate never becomes a second lead.',
    epic: 'Universal Lead Intake & Canonical Lead Record',
    tone: 'blue',
  },
  {
    name: '30-minute SLA clock',
    promise: 'The response deadline is enforced by the system, not by good intentions.',
    detail:
      'A business-hours clock starts the moment a lead is created — against a named IANA calendar with real holidays, not a fixed UTC offset. A T+0 to T+45 escalation ladder fires automatically, and only a valid human attempt stops the clock. Breaches are recorded with reason codes and reported as attainment.',
    epic: '30-Minute SLA Clock, Alert Ladder & Escalation',
    tone: 'gold',
  },
  {
    name: 'Zero-orphan ownership',
    promise: 'No lead is ever without a named owner who is actually available.',
    detail:
      'A six-step routing engine assigns on skills, territory, capacity and live availability — reading schedules, PTO, meeting blocks and on-call rosters before it commits. Acceptance clocks and backup takeover mean an unaccepted lead moves rather than waiting.',
    epic: 'Ownership, Backup Coverage, Routing & Capacity',
    tone: 'green',
  },
  {
    name: 'Provenance-first contact data',
    promise: 'Source first, entity later. Link, never overwrite.',
    detail:
      'Every contact fact is an immutable assertion carrying its origin class, a P0 to P4 trust ladder, and bitemporal effective and retrieved dates. Enrichment writes assertions, never verified values. Explainable survivorship decides what the record shows, and a retraction replays the projection.',
    epic: 'Identity Resolution & Link-Over-Merge Stewardship',
    tone: 'cyan',
  },
  {
    name: 'Governed import',
    promise: 'Import with a dry run, an exception file and a 24-hour undo.',
    detail:
      'A ten-step wizard takes you from source through origin attestation, column mapping, transform plan, identity strategy and consent import to a dry run that shows the exact impact before anything commits. The commit is atomic and idempotent, and reversible for 24 hours.',
    epic: 'Import Center — Governed Source Ingestion & Reconciliation',
    tone: 'orange',
  },
  {
    name: 'Consent at execution time',
    promise: 'Eligibility is checked when the message sends, not when the list was built.',
    detail:
      'A purpose registry, consent receipts with notice versions and signature evidence, and a runtime channel decision engine that answers "may I contact this person, on this channel, for this purpose, right now". STOP and HELP handling and revocation cascade across every channel.',
    epic: 'Consent, Preferences & Suppression',
    tone: 'green',
  },
  {
    name: 'NO BLANK NEXT',
    promise: 'A deal cannot be saved without a booked next action.',
    detail:
      'A save-gate on every stage: entry and exit evidence, a dated next action, and a close reason taxonomy that captures why. Stage aging and a date-push log make a slipping deal visible the week it starts slipping, not the month it lands.',
    epic: 'Pipeline Stages, Stage Gates & NEXT-Action Enforcement',
    tone: 'mag',
  },
  {
    name: 'Five AI agent modules',
    promise: 'AI does the work and asks permission. It never acts unreviewed.',
    detail:
      'AI SDR qualifies, researches and drafts. AI Sales Coach scores calls and surfaces objections. AI Manager predicts SLA breach and pipeline risk. AI RevOps finds duplicates and routing faults. AI Marketing handles attribution and next campaign. Everything passes a human-review gate.',
    epic: 'AI Revenue Copilot & Agent Modules',
    tone: 'purple',
  },
];

/** The operating outcomes a buyer can point at. */
export const OUTCOMES: Metric[] = [
  {
    value: '30 min',
    label: 'Enforced first-response window',
    footnote: 'Business-hours clock with a T+0 to T+45 escalation ladder and breach reason codes.',
  },
  {
    value: '0',
    label: 'Leads without a named owner',
    footnote: 'Six-step routing with acceptance clocks, backup takeover and a zero-orphan validator.',
  },
  {
    value: '24 hr',
    label: 'Import rollback window',
    footnote: 'Atomic idempotent commit with full run lineage and a reversible undo.',
  },
  {
    value: 'P0–P4',
    label: 'Trust ladder on every contact fact',
    footnote: 'Immutable assertions with origin class and bitemporal effective and retrieved dates.',
  },
];

/** Who buys, what hurts, and what changes. */
export const PERSONAS: Persona[] = [
  {
    role: 'CRO / VP Sales',
    pain: 'The forecast is built on stages nobody can evidence, and slippage surfaces too late to act on.',
    outcome: 'Stage gates require entry and exit evidence, so the forecast is made of booked next actions rather than opinions.',
    proof: 'Leadership Operational Dashboard, funnel and cohort analytics, forecast confidence.',
  },
  {
    role: 'Sales Manager',
    pain: 'Coaching is reactive — you find out a rep is behind when the month closes.',
    outcome: 'SLA attainment, overdue-NEXT queues and conversation scoring per rep, visible daily rather than monthly.',
    proof: 'Manager dashboard, AI Sales Coach, operating rhythm digests.',
  },
  {
    role: 'SDR / AE',
    pain: 'Half the day goes on admin, and the good leads are indistinguishable from the noise.',
    outcome: 'Leads arrive already routed, researched and scored, with the next action and the draft already prepared.',
    proof: 'AI SDR module, 14-day active cadence, unified inbox across email, SMS and voice.',
  },
  {
    role: 'RevOps',
    pain: 'Every integration is a bespoke pipeline and every data question takes a week to answer.',
    outcome: 'One canonical record with lineage, governed imports with dry runs, and a workflow studio with versioning and rollback.',
    proof: 'Import Center, Data Review case queues, Workflow & Automation Studio.',
  },
  {
    role: 'Marketing',
    pain: 'Attribution is contested, and campaign lists go out to people who should never have been on them.',
    outcome: 'Source quality measured per channel, and enrollment eligibility evaluated at execution time.',
    proof: 'Attribution and campaign performance, audience segments, execution-time eligibility.',
  },
  {
    role: 'Compliance / Legal',
    pain: 'You cannot prove what was known, when, or on what basis a person was contacted.',
    outcome: 'A tamper-evident audit spine, consent receipts with notice versions, DSAR and erasure wiring, and signed evidence bundles.',
    proof: 'Audit, Provenance, Evidence & Reversibility; Identity, Tenancy & Compliance Spine.',
  },
];

/** What makes this different from a CRM, stated plainly. */
export const DIFFERENTIATORS: { title: string; body: string }[] = [
  {
    title: 'It enforces, it does not record',
    body: 'A CRM is a database you fill in. LeadFlow holds clocks, gates and validators that refuse the shortcuts — a lead with no owner, a save with no next action, a send to someone who never consented.',
  },
  {
    title: 'Provenance is the foundation, not a field',
    body: 'Most systems store a phone number. LeadFlow stores who asserted it, when, under what rights, and how much that source is trusted — then decides what to display and can replay that decision if the source is retracted.',
  },
  {
    title: 'AI agents with a human-review gate',
    body: 'Five agent modules do real work — qualifying, coaching, forecasting, deduplicating, attributing. None of them act on a customer without passing a review gate you configure.',
  },
  {
    title: 'Built on shared platform primitives',
    body: 'LeadFlow runs on the ProjexCloud SDK platform. Identity, consent, audit, SLA, coverage and routing are shared primitives that harden across every vertical using them — not one-off code in one product.',
  },
];

/** Compliance and security posture. */
export const TRUST_POINTS: { title: string; body: string }[] = [
  {
    title: 'Tenant isolation and ReBAC',
    body: 'Relationship-based access control with ABAC policy bundles enforcing the permission matrix per persona, and data-residency wiring per tenant.',
  },
  {
    title: 'Tamper-evident audit spine',
    body: 'A correlated evidence timeline over every state change, with an advanced evidence query builder and exportable signed evidence bundles.',
  },
  {
    title: 'Consent, DSAR and erasure',
    body: 'A purpose registry with consent receipts, notice versions and signature evidence, plus DSAR and erasure flows that cascade through suppression.',
  },
  {
    title: 'Credential custody',
    body: 'Provider credentials held as SecretRefs rather than stored values, with scoped API key issuance and rotation.',
  },
  {
    title: 'SSO and MFA',
    body: 'Enterprise SSO and multi-factor authentication verified against the platform identity provider, with session policies per persona.',
  },
  {
    title: 'Reversibility as a guarantee',
    body: 'Link retraction, unmerge, projection replay and a 24-hour import rollback. A governed system has to be able to take an action back.',
  },
];

/** Pricing tiers. Figures are indicative and marked as such on the page. */
export const PLANS: {
  name: string;
  price: string;
  cadence: string;
  best: string;
  features: string[];
  cta: string;
  featured: boolean;
}[] = [
  {
    name: 'Growth',
    price: '$49',
    cadence: 'per seat / month',
    best: 'SMB teams putting a real process behind inbound for the first time.',
    features: [
      'Universal capture across all 14 sources',
      '30-minute SLA clock with escalation ladder',
      'Six-step routing with backup coverage',
      'Pipeline stage gates and NO BLANK NEXT',
      'Email and SMS channels with consent gating',
      'Rep and manager dashboards',
    ],
    cta: 'Start with Growth',
    featured: false,
  },
  {
    name: 'Scale',
    price: '$99',
    cadence: 'per seat / month',
    best: 'Mid-market revenue teams running multi-channel cadences and AI assist.',
    features: [
      'Everything in Growth',
      'All five AI agent modules with review gates',
      'Conversation intelligence and call scoring',
      'Governed Import Center with dry run and rollback',
      'Identity resolution and stewardship queues',
      'Workflow Studio with versioning and simulation',
      'Forecasting and cohort analytics',
    ],
    cta: 'Talk to us about Scale',
    featured: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    cadence: 'annual agreement',
    best: 'Regulated and multi-entity organisations that must evidence every decision.',
    features: [
      'Everything in Scale',
      'SSO, SCIM and per-persona session policy',
      'Data residency and tenant isolation controls',
      'Signed evidence bundle export and DSAR workflows',
      'Custom ABAC policy bundles',
      'Dedicated environment and named support',
    ],
    cta: 'Contact sales',
    featured: false,
  },
];

/** Frequently asked, honestly answered. */
export const FAQS: { q: string; a: string }[] = [
  {
    q: 'Is this a CRM replacement or something we run alongside one?',
    a: 'It replaces the operational layer — capture, routing, SLA, cadence, pipeline and the communication center. Teams commonly keep an existing system of record during migration and use the governed Import Center to move across in stages with a dry run before each commit.',
  },
  {
    q: 'What does "enforced" actually mean for the 30-minute SLA?',
    a: 'A clock is created with the lead against a named business calendar. It pauses outside business hours and on holidays. An escalation ladder fires at defined intervals to the owner, the backup and then the manager. Only an attempt the system recognises as a genuine human contact stops it, and anything else is recorded as a breach with a reason code.',
  },
  {
    q: 'How is contact data handled differently from a normal CRM?',
    a: 'Nothing overwrites. Every fact is an assertion with a source, an origin class and a trust level. What you see on the record is a survivorship decision over those assertions, and it is explainable — you can ask why this value is showing. If a source is retracted, the projection is replayed without it.',
  },
  {
    q: 'Do the AI modules contact customers on their own?',
    a: 'No. Every agent action passes a human-review gate before it reaches a customer. You configure which actions require review; the default is that all outbound does.',
  },
  {
    q: 'What happens to an import that goes wrong?',
    a: 'The dry run shows the exact impact before commit, and rejected rows come back as an exception file. If a committed run turns out to be wrong, it is reversible for 24 hours with full lineage of what it touched.',
  },
];

/** Nav structure shared by the marketing header and footer. */
export const MARKETING_NAV = [
  { label: 'Product', to: '/product' },
  { label: 'Solutions', to: '/solutions' },
  { label: 'Security', to: '/security' },
  { label: 'Pricing', to: '/pricing' },
] as const;
