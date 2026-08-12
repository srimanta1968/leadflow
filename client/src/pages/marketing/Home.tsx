import { Link } from 'react-router-dom';
import { Section } from '../../components/marketing/Section';
import { LeadForm } from '../../components/marketing/LeadForm';
import { SlaClockVisual } from '../../components/marketing/SlaClockVisual';
import {
  CAPABILITIES,
  DIFFERENTIATORS,
  OUTCOMES,
  POSITIONING,
  PROBLEMS,
} from '../../content/marketing';

/** Map a capability's token tone onto its accent classes. */
const TONE_CLASS: Record<string, string> = {
  blue: 'text-blue border-blue/30 bg-blue/10',
  green: 'text-green border-green/30 bg-green/10',
  gold: 'text-gold border-gold/30 bg-gold/10',
  purple: 'text-purple border-purple/30 bg-purple/10',
  cyan: 'text-cyan border-cyan/30 bg-cyan/10',
  orange: 'text-orange border-orange/30 bg-orange/10',
  mag: 'text-mag border-mag/30 bg-mag/10',
};

/**
 * The landing page.
 *
 * Ordered as a buyer reads: the promise, the cost of the status quo, the
 * mechanism that fixes it, proof it is real, and only then the ask. The demo
 * form appears twice — once in the hero for the ready buyer, once at the foot
 * for the one who needed convincing.
 */
export default function Home() {
  return (
    <>
      {/* Hero ------------------------------------------------------------ */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(61,130,255,0.16),transparent_58%)]"
        />
        <div className="lf-container relative grid gap-14 py-20 lg:grid-cols-[1.1fr_0.9fr] lg:py-28">
          <div className="animate-fade-up">
            <p className="lf-eyebrow">{POSITIONING.eyebrow}</p>
            <h1 className="lf-h1 mt-5">
              {POSITIONING.headline}{' '}
              <span className="bg-gradient-to-r from-blue via-cyan to-green bg-clip-text text-transparent">
                {POSITIONING.headlineAccent}
              </span>
            </h1>
            <p className="lf-lede mt-7 max-w-2xl">{POSITIONING.lede}</p>

            <div className="mt-9 flex flex-wrap gap-3">
              <Link to="/demo" className="lf-btn-primary px-6 py-3.5">
                {POSITIONING.primaryCta}
              </Link>
              <Link to="/product" className="lf-btn-secondary px-6 py-3.5">
                {POSITIONING.secondaryCta}
              </Link>
            </div>

            <dl className="mt-14 grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-4">
              {OUTCOMES.map((metric) => (
                <div key={metric.label}>
                  <dt className="font-cond text-3xl font-bold tracking-tight text-text">
                    {metric.value}
                  </dt>
                  <dd className="mt-1.5 text-xs font-semibold leading-snug text-muted">
                    {metric.label}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="lg:pt-6">
            <LeadForm source="landing_page" heading="See it against your own process" />
          </div>
        </div>
      </section>

      {/* Problem --------------------------------------------------------- */}
      <Section
        eyebrow="The status quo"
        title="Your CRM records the problem faithfully and changes nothing"
        lede="These four failures are why revenue leaks between the form fill and the first conversation. None of them are solved by a better field layout."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          {PROBLEMS.map((problem, index) => (
            <article key={problem.title} className="lf-panel p-7">
              <span className="font-mono text-xs font-bold text-soft">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="mt-3 text-lg font-bold text-text">{problem.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted">{problem.body}</p>
            </article>
          ))}
        </div>
      </Section>

      {/* SLA mechanism --------------------------------------------------- */}
      <Section
        id="sla"
        tone="raised"
        eyebrow="The mechanism"
        title="Speed to lead, enforced by a clock rather than a reminder"
        lede="Everyone agrees a fast first response wins. LeadFlow is the part that makes it non-negotiable — a business-hours clock, an automatic escalation ladder, and a definition of a valid human attempt that an auto-reply cannot satisfy."
      >
        <div className="grid items-start gap-10 lg:grid-cols-2">
          <SlaClockVisual />
          <div className="space-y-6">
            {[
              {
                title: 'A real business calendar',
                body: 'Named IANA calendars with your holidays and late-coverage extension — never a fixed UTC offset that breaks the first time the clocks change.',
              },
              {
                title: 'An attempt has to be real',
                body: 'An auto-reply does not stop the clock. The system distinguishes a genuine human attempt from activity that merely looks like one, so attainment means something.',
              },
              {
                title: 'Breach is data, not blame',
                body: 'Every breach carries a reason code. Attainment reporting shows whether you have a coverage problem, a capacity problem or a routing problem — and which.',
              },
            ].map((item) => (
              <div key={item.title} className="border-l-2 border-gold/50 pl-5">
                <h3 className="text-base font-bold text-text">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Capabilities ---------------------------------------------------- */}
      <Section
        id="capabilities"
        eyebrow="What you get"
        title="Eight capabilities that hold the process together"
        lede="Each one is a tracked delivery epic, not a roadmap intention. The epic name is on the card so the claim is auditable."
      >
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {CAPABILITIES.map((capability) => (
            <article key={capability.name} className="lf-panel flex flex-col p-6">
              <span
                className={`lf-pill self-start ${TONE_CLASS[capability.tone] ?? TONE_CLASS.blue}`}
              >
                {capability.name}
              </span>
              <h3 className="mt-4 text-base font-bold leading-snug text-text">
                {capability.promise}
              </h3>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">{capability.detail}</p>
              <p className="mt-5 border-t border-line pt-4 text-[11px] leading-snug text-soft">
                {capability.epic}
              </p>
            </article>
          ))}
        </div>
      </Section>

      {/* Differentiators ------------------------------------------------- */}
      <Section
        tone="raised"
        eyebrow="Why this is different"
        title="Not a better CRM. A different category."
        centered
      >
        <div className="grid gap-5 md:grid-cols-2">
          {DIFFERENTIATORS.map((item) => (
            <article key={item.title} className="lf-panel p-7">
              <h3 className="text-lg font-bold text-text">{item.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted">{item.body}</p>
            </article>
          ))}
        </div>
      </Section>

      {/* Customer story ---------------------------------------------------
          Placed immediately before the closing CTA: the reader has seen the
          mechanism and the capabilities, and this is the evidence that a real
          business runs on it — read last, just before being asked to act.

          THE "50%+" FIGURE IS MEASURED, and it stays inside the quote for a
          different reason than being unverified: attribution is what makes a
          number like this land with a reader.

          It describes how fast LeadFlow was BUILT on ProjexCloud — a claim about
          the build, not about LeadFlow's runtime speed. On a PRODUCT page those
          two are easy to conflate, which is the specific reason not to lift it
          into our own voice here: "50% faster" in our words, on this page, reads
          as a claim about the software rather than about delivering it.

          The comparison behind it is held internally (a prior ~8-month effort
          with a team of 10 that missed schedule, versus ~3 months with an
          effective team of 4). It is not published here — it characterises
          someone else's failure to deliver, and this page is not the place to
          litigate it. */}
      <Section
        id="customer-story"
        tone="raised"
        eyebrow="Customer story"
        title="A roofing business, live on LeadFlow"
        lede="LynkedUp Pro runs inbound call capture, qualification and routing to the right sales representative on LeadFlow."
      >
        <figure className="mx-auto max-w-3xl">
          <blockquote className="space-y-5 border-l-2 border-blue pl-6 text-base leading-relaxed text-muted sm:pl-8">
            <p>
              &ldquo;LeadFlow has completely changed the way we handle inbound customer calls. As a
              roofing and residential construction business, every call can represent a real
              opportunity&nbsp;— and making sure the right sales representative gets the right
              customer information quickly is critical.
            </p>
            <p>
              What impressed me most is how quickly Projexlight built and deployed a solution
              specifically around our business process. Using ProjexCloud and its SDK, the team was
              able to develop and test our LeadFlow solution more than 50% faster&nbsp;— even
              compared with an already AI-powered software development process&nbsp;— without
              compromising quality.
            </p>
            <p>
              The result is more than just speed. It gives our team tremendous confidence that every
              customer call is being handled correctly, routed to the right sales representative,
              and acted on much faster than before. We can respond to customer needs, resolve
              issues, and move opportunities forward without the delays and manual effort we
              previously experienced.
            </p>
            <p>
              Projexlight has demonstrated that AI-powered development doesn&rsquo;t have to mean
              sacrificing quality for speed. With ProjexCloud, we can build highly customized
              business applications rapidly, validate them continuously, and adapt them as our
              business evolves.
            </p>
            <p>
              For us, this isn&rsquo;t just a technology upgrade&nbsp;— it gives our business a real
              competitive advantage. I would strongly recommend Projexlight and ProjexCloud to any
              company looking to build custom software faster, improve operational efficiency, and
              deliver a better customer experience.&rdquo;
            </p>
          </blockquote>
          <figcaption className="mt-8 flex items-center gap-4 border-t border-line pt-6">
            {/* Portrait only — the name and title stay as real text beside it rather than
                baked into the image, so they remain selectable, translatable and readable
                to a screen reader. Lazy because this sits well below the fold. */}
            <img
              src="/justin-johnson.jpg"
              alt="Justin Johnson"
              width={56}
              height={56}
              loading="lazy"
              decoding="async"
              className="h-14 w-14 flex-none rounded-full border border-line object-cover [object-position:center_22%]"
            />
            <div>
              <span className="block font-cond text-base font-bold tracking-tight text-text">
                Justin Johnson
              </span>
              <span className="mt-1 block text-sm text-muted">
                Founder &amp; CEO, LynkedUp Pro
              </span>
            </div>
          </figcaption>
          <div className="mt-5">
            <a
              className="inline-block text-sm font-semibold text-blue hover:underline"
              href="https://cloud.projexlight.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              LeadFlow is built on ProjexCloud →
            </a>
          </div>
        </figure>
      </Section>

      {/* Closing CTA ----------------------------------------------------- */}
      <section className="border-t border-line bg-bg py-20 sm:py-24">
        <div className="lf-container grid items-center gap-12 lg:grid-cols-[1fr_0.85fr]">
          <div>
            <h2 className="lf-h2">
              Bring one week of your inbound leads.
              <br />
              We will show you where they went cold.
            </h2>
            <p className="lf-lede mt-6 max-w-xl">
              A working demo, not a slide deck. We run your real capture sources through routing,
              the SLA clock and the stage gates, and show you exactly which leads your current
              process would have lost — and why.
            </p>
            <ul className="mt-8 space-y-3">
              {[
                'Your sources, your calendar, your routing rules',
                'A dry-run import of a real list, with the exception file',
                'The audit trail for every decision made during the session',
              ].map((point) => (
                <li key={point} className="flex items-start gap-3 text-sm text-muted">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 18 18"
                    fill="none"
                    className="mt-0.5 shrink-0"
                    aria-hidden="true"
                  >
                    <path
                      d="M4 9.5l3.2 3.2L14 5.6"
                      stroke="var(--green)"
                      strokeWidth="2.1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {point}
                </li>
              ))}
            </ul>
          </div>
          {/* A distinct submit label from the hero form above: two buttons with
              identical text on one page are ambiguous to both a screen reader
              and the BDD runner's text-based selector. */}
          <LeadForm
            source="landing_page"
            heading="Book the session"
            submitLabel="Book the session"
            detailed
          />
        </div>
      </section>
    </>
  );
}
