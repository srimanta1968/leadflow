import { useRef, type ReactNode } from 'react';
import { useOverlayBehaviour } from './useOverlayBehaviour';

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

  // Scroll lock, focus trap, Escape and focus restoration all live in the shared
  // hook, so Modal and Drawer cannot drift apart on any of them.
  useOverlayBehaviour({ open, panel, onClose, dismissable });

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
