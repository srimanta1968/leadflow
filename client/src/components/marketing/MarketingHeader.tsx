import { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Logo } from './Logo';
import { MARKETING_NAV } from '../../content/marketing';

/**
 * Sticky header for the marketing site.
 *
 * Collapses to a disclosure menu below `md`. The menu is a plain conditional
 * render rather than a CSS-only toggle so the closed state is genuinely removed
 * from the accessibility tree.
 */
export function MarketingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);

  const linkClass = ({ isActive }: { isActive: boolean }): string =>
    `text-sm font-medium transition-colors ${
      isActive ? 'text-text' : 'text-muted hover:text-text'
    }`;

  return (
    <header className="sticky top-0 z-50 border-b border-line/70 bg-bg/85 backdrop-blur-xl">
      <div className="lf-container flex h-16 items-center justify-between gap-6">
        <Logo />

        <nav className="hidden items-center gap-8 md:flex" aria-label="Primary">
          {MARKETING_NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={linkClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link to="/signin" className="lf-btn-ghost px-3 py-2">
            Sign in
          </Link>
          <Link to="/demo" className="lf-btn-primary px-4 py-2.5">
            Book a demo
          </Link>
        </div>

        <button
          type="button"
          className="lf-btn-secondary px-3 py-2 md:hidden"
          aria-expanded={menuOpen}
          aria-controls="marketing-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? 'Close' : 'Menu'}
        </button>
      </div>

      {menuOpen && (
        <div id="marketing-menu" className="border-t border-line bg-bg2 md:hidden">
          <nav className="lf-container flex flex-col gap-1 py-4" aria-label="Primary mobile">
            {MARKETING_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-muted hover:bg-panel hover:text-text"
                onClick={() => setMenuOpen(false)}
              >
                {item.label}
              </NavLink>
            ))}
            <div className="mt-3 flex flex-col gap-2 border-t border-line pt-4">
              <Link to="/signin" className="lf-btn-secondary" onClick={() => setMenuOpen(false)}>
                Sign in
              </Link>
              <Link to="/demo" className="lf-btn-primary" onClick={() => setMenuOpen(false)}>
                Book a demo
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
