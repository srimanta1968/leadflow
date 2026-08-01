import { Link } from 'react-router-dom';
import { Logo } from './Logo';

/** Footer column groups. Kept local — the footer is the only consumer. */
const COLUMNS: { heading: string; links: { label: string; to: string }[] }[] = [
  {
    heading: 'Product',
    links: [
      { label: 'Overview', to: '/product' },
      { label: 'Capture & routing', to: '/product#capture' },
      { label: 'SLA & escalation', to: '/product#sla' },
      { label: 'AI agent modules', to: '/product#ai' },
      { label: 'Pricing', to: '/pricing' },
    ],
  },
  {
    heading: 'Solutions',
    links: [
      { label: 'By role', to: '/solutions' },
      { label: 'For RevOps', to: '/solutions#revops' },
      { label: 'For compliance', to: '/security' },
      { label: 'Book a demo', to: '/demo' },
    ],
  },
  {
    heading: 'Trust',
    links: [
      { label: 'Security & compliance', to: '/security' },
      { label: 'Provenance model', to: '/product#provenance' },
      { label: 'Reversibility', to: '/security#reversibility' },
    ],
  },
];

/** Site footer, shared by every marketing page. */
export function MarketingFooter() {
  return (
    <footer className="border-t border-line bg-bg2">
      <div className="lf-container py-14">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted">
              The AI Revenue Operating System. Every lead owned, every response inside 30 minutes,
              every fact traceable to its source.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.heading}>
              <h2 className="lf-eyebrow">{column.heading}</h2>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      to={link.to}
                      className="text-sm text-muted transition-colors hover:text-text"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-line pt-7 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-soft">
            © {new Date().getFullYear()} LeadFlow. Built on the ProjexCloud SDK platform.
          </p>
          <p className="text-xs text-soft">
            Capability claims trace to tracked delivery epics, not to roadmap intentions.
          </p>
        </div>
      </div>
    </footer>
  );
}
