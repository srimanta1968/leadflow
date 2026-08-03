/**
 * Reading the operator's selection — the extension's privacy boundary.
 *
 * This module is the whole of AC1. Everything the extension is allowed to know
 * about a page comes through here, so the guarantee "reads only user-selected
 * visible text, never hidden DOM or credentials" is a property of this file
 * rather than a habit spread across a content script.
 *
 * It takes a Selection-like object and returns text. It has no access to
 * document.cookie, no querySelector, no storage APIs, and no network call —
 * not because it politely declines to use them, but because nothing here can.
 * A guarantee enforced by discipline is a guarantee until someone is in a hurry.
 */

/** One row of the transmission preview the operator confirms. */
export interface TransmissionRow {
  field: string;
  value: string;
  /** 'always' | 'optional' | 'never' — the three classes in the mockup. */
  inclusion: 'always' | 'optional' | 'never';
  included: boolean;
  note: string;
}

/** The minimum of the DOM Selection API this reader needs. */
export interface SelectionLike {
  toString(): string;
  isCollapsed?: boolean;
}

/** An element the selection might sit inside, as far as we inspect it. */
export interface ElementLike {
  tagName?: string;
  type?: string;
  hidden?: boolean;
  ariaHidden?: string | null;
}

/**
 * Element kinds whose contents must never be read, even if a selection
 * somehow spans them.
 *
 * A password input is the obvious one. `hidden` and `aria-hidden` matter for a
 * subtler reason: text the operator cannot see is text they cannot have chosen
 * to share, so including it would break the consent the preview asks for even
 * though nothing about it is secret.
 */
export function isReadableElement(element: ElementLike | null | undefined): boolean {
  if (!element) {
    // No element context. Readable — a plain text selection with no element
    // information is the ordinary case, and refusing it would break capture
    // everywhere rather than protecting anything.
    return true;
  }
  const tag = (element.tagName ?? '').toUpperCase();
  const type = (element.type ?? '').toLowerCase();

  if (tag === 'INPUT' && (type === 'password' || type === 'hidden')) {
    return false;
  }
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
    return false;
  }
  if (element.hidden === true) {
    return false;
  }
  if (element.ariaHidden === 'true') {
    return false;
  }
  return true;
}

/**
 * The text the operator actually selected, or empty when there is none.
 *
 * A COLLAPSED selection returns empty. A collapsed selection is a cursor, not a
 * choice — treating a click as a capture is precisely the background
 * harvesting this feature exists to prevent, and it is the easiest version of
 * that mistake to make by accident.
 */
export function readSelection(
  selection: SelectionLike | null,
  container?: ElementLike | null
): string {
  if (!selection) {
    return '';
  }
  if (selection.isCollapsed === true) {
    return '';
  }
  if (!isReadableElement(container)) {
    return '';
  }
  return selection.toString();
}

/**
 * The transmission preview the operator confirms before anything is sent.
 *
 * THREE CLASSES, AND THE THIRD IS THE POINT. Visible selection is always
 * included; the source URL is included only if the box is ticked; cookies,
 * tokens and hidden DOM are listed as NEVER — with a row of their own rather
 * than being left out entirely.
 *
 * Listing what is never sent looks redundant and is not. An operator asked to
 * approve a transmission cannot tell the difference between "this build does
 * not send cookies" and "this build sends cookies and did not mention it". The
 * row is how the promise becomes checkable by the person making the decision.
 */
export function buildTransmissionPreview(input: {
  selectedText: string;
  sourceUrl: string | null;
  retainSourceUrl: boolean;
}): TransmissionRow[] {
  return [
    {
      field: 'Visible selected text',
      value: input.selectedText,
      inclusion: 'always',
      included: true,
      note: 'What you highlighted. This is the capture.',
    },
    {
      field: 'Source URL',
      value: input.sourceUrl ?? '',
      inclusion: 'optional',
      included: input.retainSourceUrl && Boolean(input.sourceUrl),
      note: input.retainSourceUrl
        ? 'Retained as provenance because you chose to.'
        : 'Not sent. Tick the box above to retain it.',
    },
    {
      field: 'Cookies, tokens and hidden fields',
      value: '',
      inclusion: 'never',
      included: false,
      // Present tense and unconditional. "Will not be sent" invites the reader
      // to wonder what would change that.
      note: 'Never read and never sent. The extension cannot access them.',
    },
  ];
}

/** True when there is something worth transmitting. */
export function hasTransmittableSelection(selectedText: string): boolean {
  return selectedText.trim().length > 0;
}
