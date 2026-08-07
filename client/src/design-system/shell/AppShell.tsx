import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Logo } from '../../components/marketing/Logo';
import { useSession } from '../../context/SessionContext';
import { ProfileChip } from '../../features/auth';
import { useToast } from '../../components/feedback/ToastProvider';
import { SUCCESS } from '../../content/messages';
import { isAllowed, usePermissions } from '../../platform/permissions/usePermissions';
import { NAV_ACTIONS, NAV_GROUPS, SCREEN_SUBTITLE, type NavItem } from './navModel';
import { useShellCounts, type ShellCounts } from './useShellCounts';

/**
 * The application shell: sidebar, brandbar, topbar and the view outlet.
 *
 * THREE THINGS THIS FIXES, each of which was a real defect rather than a polish
 * item:
 *
 *   1. THERE WAS NO MOBILE NAVIGATION AT ALL. The sidebar was `hidden lg:flex`
 *      with no menu button anywhere, so on a phone a signed-in operator could
 *      reach whichever screen they landed on and no other. The drawer and scrim
 *      below are not a nicety.
 *   2. NAV ITEMS WERE UNGATED. Every screen behind them is policy-gated server
 *      side, so an operator could click into a screen that then refused them —
 *      discovering their own authority by being told no.
 *   3. THE SIDEBAR WAS STATIC. Counts now come from the same projection reads the
 *      screens use, so a badge cannot disagree with the header it links to.
 */

/** The collapse preference, remembered per browser rather than per session. */
const COLLAPSE_KEY = 'leadflow.shell.collapsed';

function readCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(COLLAPSE_KEY) === '1';
}

/** The count badge, or nothing when the number could not be read. */
function CountBadge({ value }: { value: number | null | undefined }) {
  // Absent and zero are deliberately different: a failed read renders no badge,
  // because "0" would read as "your queue is clear" and stop somebody looking.
  if (value === null || value === undefined) return null;
  return (
    <span
      className="lf-pill shrink-0 border-line2 bg-panel3 text-[11px] tabular-nums text-muted"
      aria-label={`${value} items`}
    >
      {value > 99 ? '99+' : value}
    </span>
  );
}

interface NavRowProps {
  item: NavItem;
  counts: ShellCounts;
  allowed: boolean;
  collapsed: boolean;
  onNavigate: () => void;
}

function NavRow({ item, counts, allowed, collapsed, onNavigate }: NavRowProps) {
  const count = item.count ? counts[item.count] : undefined;

  // Disabled states stay in the DOM as spans rather than being removed. A nav that
  // silently loses entries teaches nothing; one that shows them greyed with a
  // reason tells an operator the screen exists and who to ask.
  if (item.planned || !allowed) {
    const why = item.planned ? 'Planned — not yet available' : 'Your role does not include this screen';
    return (
      <span
        aria-disabled="true"
        title={why}
        className="flex cursor-not-allowed items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-soft"
      >
        <span className="truncate">{collapsed ? item.label.slice(0, 1) : item.label}</span>
        {!collapsed && (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-soft/70">
            {item.planned ? 'Soon' : 'Locked'}
          </span>
        )}
      </span>
    );
  }

  return (
    <NavLink
      to={item.to}
      end={item.to === '/app'}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
          isActive ? 'bg-panel2 text-text' : 'text-muted hover:bg-panel hover:text-text'
        }`
      }
    >
      <span className="truncate">{collapsed ? item.label.slice(0, 1) : item.label}</span>
      {!collapsed && <CountBadge value={count} />}
    </NavLink>
  );
}

export function AppShell() {
  const { user, signOut } = useSession();
  const { notify } = useToast();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const counts = useShellCounts(pathname);
  const permissions = usePermissions(
    NAV_ACTIONS.map((action) => ({ action, resourceType: 'screen' })),
  );

  useEffect(() => {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  // Escape closes the drawer. A modal-ish overlay that traps a keyboard user with
  // no way out is worse than no drawer.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

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
   * reference would be worse than an obvious blank: an operator would quote it to
   * support, who would find no such account.
   */
  const identity = {
    name:
      [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email || 'Signed in',
    role: user?.role ?? 'Member',
    accountRef: '—',
  };

  const sidebar = (
    <>
      <div className="flex h-16 items-center justify-between border-b border-line px-4">
        <Logo to="/app" />
      </div>

      <nav
        className="flex-1 space-y-4 overflow-y-auto p-3"
        aria-label="Application"
        data-collapsed={collapsed}
      >
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-soft">
                {group.label}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavRow
                  key={item.to}
                  item={item}
                  counts={counts}
                  // An item that states WHY it is open is open. Only a declared
                  // action is asked of the PDP, and that check fails closed.
                  allowed={item.action ? isAllowed(permissions, item.action) : true}
                  collapsed={collapsed}
                  onNavigate={() => setDrawerOpen(false)}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-line">
        <ProfileChip identity={identity} variant="sidebar" />
        <div className="space-y-2 p-3 pt-0">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-pressed={collapsed}
            className="lf-btn-ghost hidden w-full lg:block"
          >
            {collapsed ? 'Expand' : 'Collapse'}
          </button>
          <button type="button" onClick={handleSignOut} className="lf-btn-ghost w-full">
            Sign out
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen bg-bg">
      {/* Desktop rail */}
      <aside
        className={`hidden shrink-0 flex-col border-r border-line bg-sidebar transition-[width] lg:flex ${
          collapsed ? 'w-16' : 'w-60'
        }`}
      >
        {sidebar}
      </aside>

      {/* Mobile drawer + scrim. Rendered only when open so nothing off-screen is
          in the tab order — a hidden sidebar that is still focusable sends a
          keyboard user into invisible controls. */}
      {drawerOpen && (
        <>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          />
          <aside
            className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line bg-sidebar lg:hidden"
            aria-label="Application navigation"
          >
            {sidebar}
          </aside>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-line bg-bg2 px-4 lg:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
            aria-label="Open navigation"
            className="lf-btn-ghost px-3 lg:hidden"
          >
            Menu
          </button>

          <p className="hidden min-w-0 truncate text-sm text-muted lg:block">
            {SCREEN_SUBTITLE[pathname] ?? 'LeadFlow'}
          </p>

          <div className="flex items-center gap-3">
            {/* The mockup's ⌘K affordance. Labelled as unavailable rather than
                wired to nothing: a search box that swallows what you type is a
                worse lie than an honest placeholder. */}
            <span
              className="hidden items-center gap-2 rounded-lg border border-line bg-panel px-3 py-1.5 text-xs text-soft md:flex"
              title="Global search is not available yet"
            >
              Search
              <kbd className="rounded border border-line2 bg-panel3 px-1.5 py-0.5 font-mono text-[10px]">
                ⌘K
              </kbd>
            </span>
            <button type="button" onClick={handleSignOut} className="lf-btn-ghost lg:hidden">
              Sign out
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
