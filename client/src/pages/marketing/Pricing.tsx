import { Link } from 'react-router-dom';
import { Section } from '../../components/marketing/Section';
import { FAQS, PLANS } from '../../content/marketing';

/**
 * The pricing page.
 *
 * The figures are indicative and labelled as such rather than presented as
 * final — an enterprise motion with per-tenant configuration does not have a
 * true self-serve price, and pretending otherwise wastes both sides' time.
 */
export default function Pricing() {
  return (
    <>
      <section className="border-b border-line/60 bg-bg py-20 sm:py-24">
        <div className="lf-container max-w-3xl">
          <p className="lf-eyebrow">Pricing</p>
          <h1 className="lf-h1 mt-4">Priced per seat. Governed the same at every tier.</h1>
          <p className="lf-lede mt-7">
            Audit, consent and reversibility are not an enterprise upsell — they are the foundation
            and every tier gets them. What changes between tiers is reach: how many channels, how
            much AI, and how much configuration control.
          </p>
        </div>
      </section>

      <section className="bg-bg py-16 sm:py-20">
        <div className="lf-container">
          <div className="grid gap-6 lg:grid-cols-3">
            {PLANS.map((plan) => (
              <article
                key={plan.name}
                className={`relative flex flex-col rounded-2xl border p-8 ${
                  plan.featured
                    ? 'border-blue/50 bg-panel shadow-glow'
                    : 'border-line bg-panel'
                }`}
              >
                {plan.featured && (
                  <span className="absolute -top-3 left-8 rounded-full bg-blue px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-white">
                    Most chosen
                  </span>
                )}

                <h2 className="text-lg font-bold text-text">{plan.name}</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">{plan.best}</p>

                <div className="mt-6 flex items-baseline gap-2">
                  <span className="font-cond text-4xl font-bold tracking-tight text-text">
                    {plan.price}
                  </span>
                  <span className="text-sm text-soft">{plan.cadence}</span>
                </div>

                <ul className="mt-7 flex-1 space-y-3">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5 text-sm text-muted">
                      <svg
                        width="17"
                        height="17"
                        viewBox="0 0 18 18"
                        fill="none"
                        className="mt-0.5 shrink-0"
                        aria-hidden="true"
                      >
                        <path
                          d="M4 9.5l3.2 3.2L14 5.6"
                          stroke={plan.featured ? '#3d82ff' : '#00d59a'}
                          strokeWidth="2.1"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      {feature}
                    </li>
                  ))}
                </ul>

                <Link
                  to="/demo"
                  className={`mt-8 ${plan.featured ? 'lf-btn-primary' : 'lf-btn-secondary'}`}
                >
                  {plan.cta}
                </Link>
              </article>
            ))}
          </div>

          <p className="mt-8 text-center text-xs leading-relaxed text-soft">
            Figures are indicative for planning. Final pricing depends on seat count, channel volume
            and deployment topology, and is confirmed in writing before any commitment.
          </p>
        </div>
      </section>

      <Section
        tone="raised"
        eyebrow="Questions"
        title="The things buyers actually ask"
        lede="Answered directly, including where the answer is a limitation."
      >
        <div className="mx-auto max-w-3xl space-y-3">
          {FAQS.map((faq) => (
            <details key={faq.q} className="lf-panel group p-6">
              <summary className="cursor-pointer list-none text-base font-bold text-text marker:hidden">
                <span className="flex items-start justify-between gap-4">
                  {faq.q}
                  <span className="mt-1 shrink-0 text-muted transition-transform group-open:rotate-45">
                    +
                  </span>
                </span>
              </summary>
              <p className="mt-4 text-sm leading-relaxed text-muted">{faq.a}</p>
            </details>
          ))}
        </div>
      </Section>
    </>
  );
}
