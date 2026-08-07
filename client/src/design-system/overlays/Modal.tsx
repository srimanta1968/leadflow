import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The overlay base for every dialog in the application.
 *
 * THREE OF THE FOUR EXISTING MODALS HAD NONE OF THIS. Quick Contact, Resolve
 * Capture and Extension Preview each rolled their own dialog with no Escape
 * handler, no focus trap and no scroll lock — so a keyboard user could open one,
 * tab straight out into the page behind it, and interact with controls they could
 * no longer see. That is not a polish item; it is the dialog failing to be a
 * dialog. This component exists so no screen has to remember any of it.
 *
 * Sizes are the mockup's, measured from its own stylesheet rather than guessed:
 *   .modal      width:min(1000px,96vw)  max-height:92vh
 *   .modal.sm   width:min(620px,95vw)
 *   .modal.xl   width:min(1380px,98vw)
 *   .modal.full max-height:96vh
 */

export type ModalSize = 'sm' | 'lg' | 'xl' | 'full';

const SIZE: Record<ModalSize, string> = {
  sm: 'w-[min(620px,95vw)] max-h-[92vh]',
  lg: 'w-[min(1000px,96vw)] max-h-[92vh]',
  xl: 'w-[min(1380px,98vw)] max-h-[92vh]',
  full: 'w-[min(1380px,98vw)] max-h-[96vh]',
};

/** Everything focusable, in DOM order. Disabled controls are excluded. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Sub-line under the title, the mockup's .mhead secondary text. */
  subtitle?: string;
  size?: ModalSize;
  children: ReactNode;
  /** The .mfoot row. Actions belong here so every dialog puts them in one place. */
  footer?: ReactNode;
  /**
   * Set false for a dialog that must be answered — a governed confirmation, say.
   * Escape and backdrop clicks are then ignored, and the close button is hidden.
   */
  dismissable?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = 'lg',
  children,
  footer,
  dismissable = true,
}: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  // Scroll lock. The scrollbar's width is compensated so the page behind does not
  // jump sideways as the dialog opens — a shift that reads as a glitch and moves
  // whatever the operator was about to click.
  useEffect(() => {
    if (!open) return undefined;
    const { body, documentElement } = document;
    const previous = body.style.overflow;
    const previousPad = body.style.paddingRight;
    const gap = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    return () => {
      body.style.overflow = previous;
      body.style.paddingRight = previousPad;
    };
  }, [open]);

  // Focus in on open, and back where it came from on close. Returning focus is
  // the half everyone forgets: without it a keyboard user lands at the top of the
  // document and has to find their place again.
  useEffect(() => {
    if (!open) return undefined;
    restoreTo.current = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    return () => restoreTo.current?.focus?.();
  }, [open]);

  // Escape, and the tab cycle.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && dismissable) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;

      const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        // Nothing to move to — hold focus on the panel rather than letting Tab
        // escape to the page behind.
        e.preventDefault();
        panel.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, dismissable]);

  if (!open) return null;

  return (
    <div
      // .overlay — rgba(0,0,0,.72) with a 4px blur, z-150, from the mockup.
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/[0.72] p-2 backdrop-blur-[4px]"
      role="presentation"
      onMouseDown={(e) => {
        // mousedown, not click: a click that STARTED inside the dialog and ended
        // on the backdrop — a drag off the end of a text selection — would
        // otherwise close it and discard what was typed.
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lf-modal-title"
        tabIndex={-1}
        className={`lf-panel flex flex-col overflow-hidden rounded-[18px] p-0 shadow-panel outline-none ${SIZE[size]}`}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id="lf-modal-title" className="text-base font-bold text-text">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-soft">{subtitle}</p>}
          </div>
          {dismissable && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="lf-btn-ghost shrink-0 px-2.5 py-1 text-sm"
            >
              ✕
            </button>
          )}
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
