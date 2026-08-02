import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Logo } from '../marketing/Logo';
import { useSession } from '../../context/SessionContext';
import { ProfileChip } from '../../features/auth';
import { useToast } from '../feedback/ToastProvider';
import { SUCCESS } from '../../content/messages';

/** One-line description of each screen, shown in the top bar. */
const SCREEN_SUBTITLE: Record<string, string> = {
  '/app': 'Capture Inbox — unresolved captures awaiting a decision',
  '/app/capture': 'Quick Capture — enter a lead by hand',
  '/app/routing': 'Routing rules — first match wins, in evaluation order',
  '/app/sla': 'SLA targets — response commitments by lead type',
  '/app/analytics': 'Analytics — response times and conversion across the funnel',
};

/**
 * The application navigation.
 *
 * Entries marked `planned` are visible but disabled — the screens they lead to
 * are tracked epics that have not shipped yet. Showing them greyed is honest
 * about the shape of the product; a link that 404s is not.
 */
const NAV: { label: string; to: string; planned?: boolean }[] = [
  { label: 'Capture Inbox', to: '/app' },
  { label: 'Quick Capture', to: '/app/capture' },
  { label: 'Routing rules', to: '/app/routing' },
  { label: 'SLA targets', to: '/app/sla' },
  { label: 'Analytics', to: '/app/analytics' },
  { label: 'Contacts', to: '/app/contacts', planned: true },
  { label: 'Pipeline', to: '/app/pipeline', planned: true },
  { label: 'Import Center', to: '/app/import', planned: true },
  { label: 'Identity Review', to: '/app/identity', planned: true },
  { label: 'Consent', to: '/app/consent', planned: true },
  { label: 'Audit & History', to: '/app/audit', planned: true },
  { label: 'Workflow Studio', to: '/app/workflows', planned: true },
];

/** Chrome for the signed-in application. */
export function AppShell() {
  const { user, signOut } = useSession();
  const { notify } = useToast();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  function handleSignOut(): void {
    signOut();
    notify(SUCCESS.signedOut());
    navigate('/', { replace: true });
  }

  /**
   * The identity the chip renders.
   *
   * The ACCOUNT REFERENCE — the `LUP-1001` half of the mockup's secondary line —
   * is a ProjexCloud tenant concept and is not in the local session, so it shows
   * an em dash until the platform session supplies one. Inventing a plausible
   * reference would be worse than an obvious blank: an operator would quote it
   * to support, who would find no such account.
   */
  const identity = {
    name:
      [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email || 'Signed in',
    role: user?.role ?? 'Member',
    accountRef: '—',
  };

  return (
    <div className="flex min-h-screen bg-bg">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-sidebar lg:flex">
        <div className="flex h-16 items-center border-b border-line px-5">
          <Logo to="/app" />
        </div>

        <nav className="flex-1 space-y-1 p-3" aria-label="Application">
          {NAV.map((item) =>
            item.planned ? (
              <span
                key={item.to}
                aria-disabled="true"
                title="Planned — not yet available"
                className="flex cursor-not-allowed items-center justify-between rounded-lg px-3 py-2.5 text-sm text-soft"
              >
                {item.label}
                <span className="text-[10px] font-semibold uppercase tracking-wider text-soft/70">
                  Soon
                </span>
              </span>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                end
                className={({ isActive }) =>
                  `block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-panel2 text-text'
                      : 'text-muted hover:bg-panel hover:text-text'
                  }`
                }
              >
                {item.label}
              </NavLink>
            )
          )}
        </nav>

        <div className="border-t border-line">
          {/* The mockup's sidebottom identity block. Same component as the
              topbar chip so the two cannot drift apart. */}
          <ProfileChip identity={identity} variant="sidebar" />
          <div className="p-3 pt-0">
            <button type="button" onClick={handleSignOut} className="lf-btn-ghost w-full">
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-line bg-bg2 px-6">
          <div className="lg:hidden">
            <Logo to="/app" />
          </div>
          <p className="hidden text-sm text-muted lg:block">
            {SCREEN_SUBTITLE[pathname] ?? 'LeadFlow'}
          </p>
          <button type="button" onClick={handleSignOut} className="lf-btn-ghost lg:hidden">
            Sign out
          </button>
        </header>

        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
