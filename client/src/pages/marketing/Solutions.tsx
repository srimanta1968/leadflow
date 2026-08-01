import { Link } from 'react-router-dom';
import { Section } from '../../components/marketing/Section';
import { PERSONAS } from '../../content/marketing';

/** Segment-level fit, so a buyer can place themselves quickly. */
const SEGMENTS = [
  {
    name: 'SMB',
    headline: 'Put a real process behind inbound for the first time',
    body: 'You do not have a RevOps function. LeadFlow ships the process — routing, the SLA clock, stage gates and a 14-day cadence — configured rather than built.',
    fit: '5–50 seats',
  },
  {
    name: 'Mid-market',
    headline: 'Run multi-channel cadences without losing governance',
    body: 'Several teams, several territories, real volume. Coverage administration, capacity caps and routing simulation keep assignment fair as headcount moves.',
    fit: '50–500 seats',
  },
  {
    name: 'Enterprise',
    headline: 'Evidence every decision to a regulator or an auditor',
    body: 'Multi-entity, multi-region, contested data. The audit spine, consent receipts, data residency and signed evidence bundles are the reason this exists.',
    fit: '500+ seats',
  },
];

/**
 * The solutions page — by role, then by segment.
 *
 * Role comes first deliberately: the person reading is one of these six, and
 * they want to see their own problem named before they care about the segment
 * they belong to.
 */
export default function Solutions() {
  return (
    <>
      <section className="border-b border-line/60 bg-bg py-20 sm:py-24">
        <div className="lf-container max-w-3xl">
          <p className="lf-eyebrow">Solutions</p>
          <h1 className="lf-h1 mt-4">Six roles, one operating system</h1>
          <p className="lf-lede mt-7">
            A revenue system fails when it serves one role at everyone else's expense — the rep
            fills fields so the manager gets a report. LeadFlow gives each role something it wants
            for its own sake, and the data quality is the by-product.
          </p>
        </div>
      </section>

      <Section
        id="roles"
        eyebrow="By role"
        title="What changes for the person doing the work"
        lede="Each row states the pain honestly, the outcome specifically, and where in the product it comes from."
      >
        <div className="space-y-4">
          {PERSONAS.map((persona) => (
            <article
              key={persona.role}
              id={persona.role.toLowerCase().replace(/[^a-z]+/g, '')}
              className="lf-panel scroll-mt-24 p-7"
            >
              <div className="grid gap-6 lg:grid-cols-[180px_1fr]">
                <h3 className="text-lg font-bold text-text">{persona.role}</h3>
                <div className="space-y-4">
                  <div>
                    <p className="lf-eyebrow text-red/80">The pain</p>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted">{persona.pain}</p>
                  </div>
                  <div>
                    <p className="lf-eyebrow text-green/80">What changes</p>
                    <p className="mt-1.5 text-sm leading-relaxed text-text">{persona.outcome}</p>
                  </div>
                  <div className="border-t border-line pt-3.5">
                    <p className="text-xs leading-relaxed text-soft">
                      <span className="font-semibold">Delivered by:</span> {persona.proof}
                    </p>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      </Section>

      <Section
        tone="raised"
        eyebrow="By segment"
        title="Where you are determines which part matters most"
        centered
      >
        <div className="grid gap-5 md:grid-cols-3">
          {SEGMENTS.map((segment) => (
            <article key={segment.name} className="lf-panel flex flex-col p-7">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-lg font-bold text-text">{segment.name}</h3>
                <span className="text-xs font-semibold text-soft">{segment.fit}</span>
              </div>
              <p className="mt-4 text-base font-semibold leading-snug text-blue">
                {segment.headline}
              </p>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">{segment.body}</p>
            </article>
          ))}
        </div>

        <div className="mt-12 text-center">
          <Link to="/demo" className="lf-btn-primary px-7 py-3.5">
            Book a working demo
          </Link>
        </div>
      </Section>
    </>
  );
}
