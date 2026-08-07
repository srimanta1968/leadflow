import { useRef, type ReactNode } from 'react';
import { useOverlayBehaviour } from './useOverlayBehaviour';

/**
 * The right-anchored .drawer, for Data Credits and Enrichment.
 *
 * A drawer rather than a modal because both are REFERENCE surfaces: an operator
 * checks a credit balance or an enrichment queue while still working the record
 * behind, so the page stays visible at the left rather than being blacked out.
 * It is still modal to the keyboard — focus is trapped and Escape closes — since
 * a panel you can tab out of but cannot see is worse than either.
 *
 * Dimensions from the mockup: width min(680px, 96vw), full height, z-140 (below
 * the modal layer at 150, so a dialog opened FROM a drawer sits above it).
 */

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Drawer({ open, onClose, title, subtitle, children, footer }: DrawerProps) {
  const panel = useRef<HTMLDivElement>(null);
  useOverlayBehaviour({ open, panel, onClose });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[140] bg-black/50"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lf-drawer-title"
        tabIndex={-1}
        className="absolute right-0 top-0 flex h-full w-[min(680px,96vw)] flex-col border-l border-line bg-panel shadow-panel outline-none"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id="lf-drawer-title" className="text-base font-bold text-text">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-soft">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="lf-btn-ghost shrink-0 px-2.5 py-1 text-sm"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-line px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
