import { useEffect, type RefObject } from 'react';

/**
 * The three things every overlay owes a keyboard user, in one place.
 *
 * Modal and Drawer both need scroll lock, a focus trap, Escape dismissal and
 * focus restoration. Written twice they drift — one grows a fix the other never
 * gets, which is how the app ended up with four dialogs and only one of them
 * trapping focus.
 */

/** Everything focusable, in DOM order. Disabled controls are excluded. */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface OverlayBehaviourOptions {
  open: boolean;
  panel: RefObject<HTMLElement>;
  onClose: () => void;
  /** False for a dialog that must be answered — Escape is then ignored. */
  dismissable?: boolean;
}

export function useOverlayBehaviour({
  open,
  panel,
  onClose,
  dismissable = true,
}: OverlayBehaviourOptions): void {
  // Scroll lock, compensating for the scrollbar's width so the page behind does
  // not jump sideways as the overlay opens — a shift that reads as a glitch and
  // moves whatever the operator was about to click.
  useEffect(() => {
    if (!open) return undefined;
    const { body, documentElement } = document;
    const previousOverflow = body.style.overflow;
    const previousPad = body.style.paddingRight;
    const gap = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPad;
    };
  }, [open]);

  // Focus in on open, and BACK where it came from on close. Restoring is the half
  // everyone forgets: without it a keyboard user lands at the top of the document
  // and has to find their place again.
  useEffect(() => {
    if (!open) return undefined;
    const restoreTo = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    return () => restoreTo?.focus?.();
  }, [open, panel]);

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
        // escape to the page behind, which is the whole failure this prevents.
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
    // Capture phase, so a child that stops propagation cannot disable Escape.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, dismissable, panel]);
}
