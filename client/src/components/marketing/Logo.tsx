import { Link } from 'react-router-dom';

interface LogoProps {
  /** Where the mark links to. Defaults to the marketing home page. */
  to?: string;
}

/**
 * The LeadFlow wordmark.
 *
 * The mark is three stacked bars converging into one — the routing story the
 * product is built on. Drawn inline so it inherits the token colours and needs
 * no network request.
 */
export function Logo({ to = '/' }: LogoProps) {
  return (
    <Link to={to} className="inline-flex items-center gap-2.5" aria-label="LeadFlow home">
      <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
        <rect width="26" height="26" rx="7" fill="var(--blue)" fillOpacity="0.14" />
        <path d="M6 8h9" stroke="var(--blue)" strokeWidth="2.1" strokeLinecap="round" />
        <path d="M6 13h13" stroke="var(--green)" strokeWidth="2.1" strokeLinecap="round" />
        <path d="M6 18h6" stroke="var(--purple)" strokeWidth="2.1" strokeLinecap="round" />
      </svg>
      <span className="text-[17px] font-extrabold tracking-tight text-text">LeadFlow</span>
    </Link>
  );
}
