import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { MarketingHeader } from './MarketingHeader';
import { MarketingFooter } from './MarketingFooter';

/**
 * Chrome shared by every marketing page.
 *
 * Also owns cross-page scroll behaviour: a plain navigation returns to the top,
 * while a link carrying a hash scrolls to that section once it has rendered.
 * Without this, React Router leaves the scroll position where it was and a
 * footer link to `/product#sla` appears to do nothing.
 */
export function MarketingLayout() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (hash) {
      const target = document.getElementById(hash.slice(1));
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [pathname, hash]);

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-blue focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>
      <MarketingHeader />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <MarketingFooter />
    </div>
  );
}
