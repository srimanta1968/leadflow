import { Link } from 'react-router-dom';
import { Section } from '../../components/marketing/Section';
import { TRUST_POINTS } from '../../content/marketing';

/** Reversibility guarantees — the part most systems cannot offer at all. */
const REVERSIBILITY = [
  {
    action: 'A link was wrong',
    remedy: 'Retract the link and replay the projection without it. Both source records survive intact — nothing was overwritten to begin with.',
  },
  {
    action: 'An import went wrong',
    remedy: 'Roll the run back within 24 hours. Full lineage records exactly which records it touched and what it changed.',
  },
  {
    action: 'Consent was withdrawn',
    remedy: 'Revocation cascades to every channel and suppression propagates immediately, including to sequences already in flight.',
  },
  {
    action: 'A subject exercises their rights',
    remedy: 'DSAR and erasure flows produce the record and remove it, with the removal itself evidenced.',
  },
];

/**
 * The security and compliance page.
 *
 * Deliberately avoids badge-wall theatre. It states the mechanisms, and it is
 * explicit about which certifications are held versus which the architecture is
 * built to support — overstating that is the fastest way to lose an enterprise
 * deal at the security review.
 */
export default function Security() {
  return (
    <>
      <section className="border-b border-line/60 bg-bg py-20 sm:py-24">
        <div className="lf-container max-w-3xl">
          <p className="lf-eyebrow">Security &amp; compliance</p>
          <h1 className="lf-h1 mt-4">Built to be audited, not just to pass a questionnaire</h1>
          <p className="lf-lede mt-7">
            Most systems can tell you what a record says today. The harder question — what did we
            know, when, on what basis were we allowed to act, and can we take it back — is what
            LeadFlow was designed around.
          </p>
        </div>
      </section>

      <Section
        eyebrow="The controls"
        title="Six mechanisms that carry the compliance posture"
        lede="These are architectural, not procedural. They hold whether or not anybody remembers the policy."
      >
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {TRUST_POINTS.map((point) => (
            <article key={point.title} className="lf-panel p-7">
              <h3 className="text-base font-bold text-text">{point.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted">{point.body}</p>
            </article>
          ))}
        </div>
      </Section>

      <Section
        id="reversibility"
        tone="raised"
        eyebrow="Reversibility"
        title="A governed system has to be able to take an action back"
        lede="If a mistake is permanent, the governance was decorative. Each of these is an implemented path, not a support ticket."
      >
        <div className="lf-panel divide-y divide-line/70">
          {REVERSIBILITY.map((item) => (
            <div key={item.action} className="grid gap-3 p-6 lg:grid-cols-[240px_1fr] lg:gap-8">
              <h3 className="text-sm font-bold text-text">{item.action}</h3>
              <p className="text-sm leading-relaxed text-muted">{item.remedy}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        eyebrow="Standards"
        title="What we hold, and what we are built for"
        lede="Stated plainly, because your security team will check."
      >
        <div className="grid gap-5 md:grid-cols-2">
          <article className="lf-panel border-green/25 bg-green/[0.04] p-7">
            <h3 className="text-base font-bold text-green">Enforced by the architecture today</h3>
            <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-muted">
              <li>Tenant isolation with relationship-based access control</li>
              <li>ABAC policy bundles enforcing the per-persona permission matrix</li>
              <li>Tamper-evident audit trail over every state change</li>
              <li>Consent receipts with notice versioning and signature evidence</li>
              <li>Encryption in transit and at rest; credentials held as SecretRefs</li>
              <li>SSO and MFA against the platform identity provider</li>
            </ul>
          </article>

          <article className="lf-panel border-gold/25 bg-gold/[0.04] p-7">
            <h3 className="text-base font-bold text-gold">
              Designed to support — confirm current status with us
            </h3>
            <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-muted">
              <li>GDPR and CCPA subject-rights workflows</li>
              <li>SOC 2 Type II control evidence</li>
              <li>HIPAA-ready deployment topology</li>
              <li>Regional data residency per tenant</li>
            </ul>
            <p className="mt-5 border-t border-gold/20 pt-4 text-xs leading-relaxed text-soft">
              We will not claim a certification we do not currently hold. Ask us for the present
              status and the evidence package — that conversation is faster than a questionnaire.
            </p>
          </article>
        </div>

        <div className="mt-12 text-center">
          <Link to="/demo" className="lf-btn-primary px-7 py-3.5">
            Request the security package
          </Link>
        </div>
      </Section>
    </>
  );
}
