import { LeadForm } from '../../components/marketing/LeadForm';

/** What the session actually covers, so nobody arrives expecting a slide deck. */
const AGENDA = [
  {
    minutes: '0–10',
    title: 'Your capture sources, wired live',
    body: 'We connect the sources you actually use and watch a real lead land through the universal intake.',
  },
  {
    minutes: '10–25',
    title: 'Routing and the clock, against your calendar',
    body: 'Your business hours, your holidays, your team. We route a lead, let it breach on purpose, and walk the escalation ladder.',
  },
  {
    minutes: '25–40',
    title: 'A dry-run import of one of your lists',
    body: 'Bring a CSV. We map it, show the impact before commit, and produce the exception file. Nothing is written unless you say so.',
  },
  {
    minutes: '40–50',
    title: 'The audit trail of everything we just did',
    body: 'Every decision made during the session, queryable, with the evidence attached. This is the part that closes security reviews.',
  },
];

/**
 * The demo request page.
 *
 * The form here is the detailed variant — someone reaching this page has
 * already decided, so asking for company and context costs nothing and makes
 * the first conversation materially better.
 */
export default function Demo() {
  return (
    <section className="bg-bg py-20 sm:py-24">
      <div className="lf-container grid items-start gap-14 lg:grid-cols-[1fr_0.9fr]">
        <div>
          <p className="lf-eyebrow">Book a demo</p>
          <h1 className="lf-h1 mt-4">Fifty minutes. Your data. No slides.</h1>
          <p className="lf-lede mt-7 max-w-xl">
            We do not demo on sample data. Bring one week of inbound leads and a list you have been
            afraid to import, and we will show you exactly where your current process loses revenue
            — and what the system does about it.
          </p>

          <ol className="mt-12 space-y-5">
            {AGENDA.map((item) => (
              <li key={item.minutes} className="flex gap-5">
                <span className="w-14 shrink-0 pt-0.5 font-mono text-xs font-bold text-blue">
                  {item.minutes}
                </span>
                <div className="border-l border-line pl-5 pb-1">
                  <h2 className="text-base font-bold text-text">{item.title}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <p className="mt-10 rounded-xl border border-line bg-panel px-5 py-4 text-sm leading-relaxed text-muted">
            <span className="font-semibold text-text">Nothing is written without consent.</span> The
            import runs in dry-run mode for the whole session, and anything committed is reversible
            for 24 hours afterwards.
          </p>
        </div>

        <div className="lg:sticky lg:top-24">
          <LeadForm
            source="landing_page"
            heading="Request your session"
            submitLabel="Request the session"
            detailed
          />
        </div>
      </div>
    </section>
  );
}
