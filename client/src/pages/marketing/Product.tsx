import { Link } from 'react-router-dom';
import { Section } from '../../components/marketing/Section';
import { SlaClockVisual } from '../../components/marketing/SlaClockVisual';
import { CAPABILITIES } from '../../content/marketing';

/** The fourteen source channels the universal intake accepts. */
const SOURCES = [
  'Web forms',
  'Landing pages',
  'Facebook',
  'Instagram',
  'LinkedIn',
  'TikTok',
  'Google Ads',
  'Live chat',
  'Phone',
  'Email',
  'Referral',
  'Webhook',
  'API',
  'CSV import',
];

/** The P0–P4 trust ladder applied to every asserted contact fact. */
const TRUST_LADDER = [
  { level: 'P0', label: 'Raw', body: 'Exactly as received. Immutable, never edited, always retained.' },
  { level: 'P1', label: 'Normalised', body: 'Parsed and standardised, with the transformation recorded.' },
  { level: 'P2', label: 'Candidate', body: 'Matched to a possible existing identity, not yet linked.' },
  { level: 'P3', label: 'Linked', body: 'Attached to a canonical record under a stated confidence.' },
  { level: 'P4', label: 'Verified', body: 'Confirmed first-party — the only level treated as trusted.' },
];

/** The ten governed import steps. */
const IMPORT_STEPS = [
  'Source',
  'Connect / upload',
  'File & schema preview',
  'Origin attestation',
  'Column mapping',
  'Transform plan',
  'Identity strategy',
  'Access & ownership',
  'Consent import',
  'Dry run & commit',
];

/** The five AI agent modules. */
const AI_MODULES = [
  {
    name: 'AI SDR',
    does: 'Qualifies the lead, researches the company, scores it, drafts the opening email and books the meeting.',
  },
  {
    name: 'AI Sales Coach',
    does: 'Listens to calls, scores the conversation, suggests the next question and flags objections as they land.',
  },
  {
    name: 'AI Manager',
    does: 'Predicts SLA breach before it happens, surfaces pipeline risk and churn signal, and calibrates the forecast.',
  },
  {
    name: 'AI RevOps',
    does: 'Detects duplicates, finds routing faults and proposes workflow changes with the evidence behind them.',
  },
  {
    name: 'AI Marketing',
    does: 'Resolves attribution, recommends the next campaign and optimises nurture against actual conversion.',
  },
];

/**
 * The product page.
 *
 * Deeper than the landing page: the mechanisms, in the order a lead moves
 * through them — capture, resolve, route, respond, progress, evidence.
 */
export default function Product() {
  return (
    <>
      <section className="border-b border-line/60 bg-bg py-20 sm:py-24">
        <div className="lf-container max-w-3xl">
          <p className="lf-eyebrow">Product</p>
          <h1 className="lf-h1 mt-4">The path a lead takes, and what holds it at every step</h1>
          <p className="lf-lede mt-7">
            LeadFlow is built around one idea: the process should be enforced by the system, not
            remembered by the person. Here is what happens between a form fill and a closed deal,
            and which mechanism guarantees each step.
          </p>
        </div>
      </section>

      {/* Capture --------------------------------------------------------- */}
      <Section
        id="capture"
        eyebrow="Step one"
        title="Capture — one canonical record, fourteen front doors"
        lede="Every source lands through a single intake with idempotency and per-platform receivers. A signal policy engine decides create, merge, or no-record before anything becomes a lead."
      >
        <div className="flex flex-wrap gap-2.5">
          {SOURCES.map((source) => (
            <span key={source} className="lf-pill border-line2 bg-panel2 text-muted">
              {source}
            </span>
          ))}
        </div>

        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {[
            {
              title: 'Universal Quick Capture',
              body: 'Smart Paste, manual entry, business card scan and browser capture — with privacy guardrails and an offline queue for the field.',
            },
            {
              title: 'The Capture Inbox',
              body: 'Nothing is silently discarded. Unresolved captures queue for a human, with the raw evidence attached to each one.',
            },
            {
              title: 'Required-field activation gate',
              body: 'A record does not become an active lead until it carries what routing and attribution actually need.',
            },
          ].map((item) => (
            <article key={item.title} className="lf-panel p-6">
              <h3 className="text-base font-bold text-text">{item.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted">{item.body}</p>
            </article>
          ))}
        </div>
      </Section>

      {/* Provenance ------------------------------------------------------ */}
      <Section
        id="provenance"
        tone="raised"
        eyebrow="Step two"
        title="Resolve — source first, entity later. Link, never overwrite."
        lede="A contact fact is not a value in a column. It is an assertion carrying who said it, when, under what rights, and how much that source is trusted. What the record displays is a survivorship decision over those assertions — and you can ask why."
      >
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
          {TRUST_LADDER.map((rung) => (
            <article key={rung.level} className="lf-panel p-6">
              <span className="font-mono text-sm font-bold text-cyan">{rung.level}</span>
              <h3 className="mt-2 text-base font-bold text-text">{rung.label}</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted">{rung.body}</p>
            </article>
          ))}
        </div>

        <div className="mt-8 lf-panel border-cyan/25 bg-cyan/[0.04] p-7">
          <h3 className="text-base font-bold text-text">Why link-over-merge matters</h3>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted">
            A merge is destructive and, in practice, irreversible — the losing record's history is
            gone. LeadFlow links instead, keeping both sources intact under one canonical view. If a
            link turns out to be wrong, it is retracted and the projection is replayed without it.
            Enrichment writes assertions, never verified values, so a bought data point can never
            silently outrank something the customer told you directly.
          </p>
        </div>
      </Section>

      {/* Route & respond ------------------------------------------------- */}
      <Section
        id="sla"
        eyebrow="Steps three and four"
        title="Route and respond — a named owner who is actually available"
        lede="Routing reads schedules, PTO, meeting blocks, live presence, capacity caps and on-call rosters before it commits. Then the clock starts."
      >
        <div className="grid items-start gap-10 lg:grid-cols-2">
          <div className="space-y-6">
            {[
              {
                title: 'Six-step routing order',
                body: 'Skills, territory, account relationship, round-robin rotation, capacity and live availability — evaluated in order, with the decision recorded.',
              },
              {
                title: 'Acceptance clocks and backup takeover',
                body: 'An assigned lead that is not accepted moves to the backup rather than sitting. A zero-orphan validator continuously proves no lead is unowned.',
              },
              {
                title: 'Simulation before you change anything',
                body: 'A routing sandbox replays historical volume against a proposed rule set, with a fair-share audit, so a change is tested before it goes live.',
              },
            ].map((item) => (
              <div key={item.title} className="border-l-2 border-green/50 pl-5">
                <h3 className="text-base font-bold text-text">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
              </div>
            ))}
          </div>
          <SlaClockVisual />
        </div>
      </Section>

      {/* Import ---------------------------------------------------------- */}
      <Section
        id="import"
        tone="raised"
        eyebrow="Bringing data in"
        title="Governed import — ten steps, a dry run, and an undo"
        lede="Most import failures are discovered after the damage. This one shows you the exact impact before it commits, and stays reversible for 24 hours after."
      >
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {IMPORT_STEPS.map((step, index) => (
            <li key={step} className="lf-panel flex items-start gap-3 p-5">
              <span className="font-mono text-xs font-bold text-orange">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="text-sm font-semibold leading-snug text-text">{step}</span>
            </li>
          ))}
        </ol>
        <p className="mt-8 max-w-3xl text-sm leading-relaxed text-muted">
          Mapping templates are versioned and reusable, so the second import of the same shape is a
          one-click job. Rejected rows come back as an exception file you can fix and resubmit. The
          commit is atomic and idempotent — a retry after a timeout cannot double-import.
        </p>
      </Section>

      {/* AI -------------------------------------------------------------- */}
      <Section
        id="ai"
        eyebrow="The copilot layer"
        title="Five AI modules that do real work and still ask permission"
        lede="Every agent action passes a human-review gate before it reaches a customer. You configure which actions need review; the default is that all outbound does."
      >
        <div className="space-y-3">
          {AI_MODULES.map((module) => (
            <article
              key={module.name}
              className="lf-panel flex flex-col gap-2 p-6 sm:flex-row sm:items-baseline sm:gap-8"
            >
              <h3 className="w-40 shrink-0 text-base font-bold text-purple">{module.name}</h3>
              <p className="text-sm leading-relaxed text-muted">{module.does}</p>
            </article>
          ))}
        </div>
      </Section>

      {/* Capability index ------------------------------------------------ */}
      <Section
        tone="raised"
        eyebrow="Traceability"
        title="Every claim on this site maps to a tracked epic"
        lede="Marketing that outruns delivery is how trust is lost. This is the index."
      >
        <div className="lf-panel divide-y divide-line/70">
          {CAPABILITIES.map((capability) => (
            <div
              key={capability.name}
              className="flex flex-col gap-1.5 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-8"
            >
              <span className="text-sm font-bold text-text">{capability.name}</span>
              <span className="text-xs text-soft sm:text-right">{capability.epic}</span>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <Link to="/demo" className="lf-btn-primary px-7 py-3.5">
            See it against your own process
          </Link>
        </div>
      </Section>
    </>
  );
}
