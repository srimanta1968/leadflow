import { NavLink } from 'react-router-dom';

/**
 * The always-visible first-level rail, from the phase-7 usability package.
 *
 * IT NEVER SCROLLS AND NEVER FOLDS, which is the whole point. The section
 * sidebar beside it grew to ~32 items and put Calendar below the fold — and the
 * SOP requires booking a meeting WHILE STILL ON THE CALL, so a rep was scrolling
 * to reach the one control they need mid-conversation. A fixed rail has that
 * property at any list length: adding a thirtieth screen cannot push a
 * first-class destination out of reach.
 *
 * ONLY DESTINATIONS THAT ARE ALWAYS APPROPRIATE live here. The rail is not a
 * favourites bar and not a second copy of the sidebar; anything gated, rare or
 * role-specific belongs in the sections, where it can be Locked or hidden by
 * experience without leaving a dead icon in the furniture.
 */

interface RailItem {
  to: string;
  label: string;
  /** Inline SVG path — the rail predates any icon dependency and needs none. */
  path: string;
  /** Live count, when the destination has one worth interrupting for. */
  count?: number | null;
}

/**
 * Rendered as an accessible list, not a row of bare links: a screen-reader user
 * gets "navigation, 6 items" rather than six unrelated buttons, and every icon
 * carries a real label rather than a title attribute nobody hears.
 */
export function IconRail({ items }: { items: RailItem[] }) {
  return (
    <nav
      aria-label="Primary"
      className="hidden w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-sidebar py-3 lg:flex"
    >
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/app'}
          title={item.label}
          className={({ isActive }) =>
            `relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
              isActive ? 'bg-blue/15 text-blue' : 'text-muted hover:bg-panel2 hover:text-text'
            }`
          }
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
            <path d={item.path} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="sr-only">{item.label}</span>

          {/* A badge only when there is something to act on. Rendering a zero
              trains people to ignore the position it appears in. */}
          {item.count !== null && item.count !== undefined && item.count > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red px-1 text-[10px] font-semibold text-white">
              {item.count > 99 ? '99+' : item.count}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

export type { RailItem };
