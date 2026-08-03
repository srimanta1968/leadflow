import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildTransmissionPreview,
  hasTransmittableSelection,
  isReadableElement,
  readSelection,
} from '../../src/features/capture/browserSelection';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'features', 'capture', 'browserSelection.ts'),
  'utf8'
);
/** Comments stripped, so a negative assertion cannot fail on prose that
 *  explains the rule by naming the thing it forbids. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('what the extension is able to read', () => {
  it('reads a real selection', () => {
    expect(readSelection({ toString: () => 'Priya Raman', isCollapsed: false })).toBe(
      'Priya Raman'
    );
  });

  it('returns NOTHING for a collapsed selection', () => {
    // A collapsed selection is a cursor, not a choice. Treating a click as a
    // capture is the easiest possible version of background harvesting to
    // introduce by accident.
    expect(readSelection({ toString: () => 'whatever', isCollapsed: true })).toBe('');
  });

  it('returns nothing when there is no selection at all', () => {
    expect(readSelection(null)).toBe('');
  });

  it('refuses to read a password input', () => {
    expect(isReadableElement({ tagName: 'INPUT', type: 'password' })).toBe(false);
    expect(
      readSelection({ toString: () => 'hunter2', isCollapsed: false }, {
        tagName: 'INPUT',
        type: 'password',
      })
    ).toBe('');
  });

  it('refuses a hidden input', () => {
    expect(isReadableElement({ tagName: 'INPUT', type: 'hidden' })).toBe(false);
  });

  it('refuses script and style contents', () => {
    expect(isReadableElement({ tagName: 'SCRIPT' })).toBe(false);
    expect(isReadableElement({ tagName: 'STYLE' })).toBe(false);
    expect(isReadableElement({ tagName: 'NOSCRIPT' })).toBe(false);
  });

  it('refuses anything hidden from view', () => {
    // Text the operator cannot SEE is text they cannot have chosen to share,
    // even when nothing about it is secret.
    expect(isReadableElement({ tagName: 'DIV', hidden: true })).toBe(false);
    expect(isReadableElement({ tagName: 'DIV', ariaHidden: 'true' })).toBe(false);
  });

  it('reads an ordinary visible element', () => {
    expect(isReadableElement({ tagName: 'P' })).toBe(true);
    expect(isReadableElement({ tagName: 'INPUT', type: 'text' })).toBe(true);
  });

  it('reads a plain selection with no element context', () => {
    // Refusing this would break capture everywhere rather than protect
    // anything — a text selection with no element info is the ordinary case.
    expect(isReadableElement(null)).toBe(true);
  });
});

describe('the reader has no capability it should not have', () => {
  it('touches no cookie, storage or network API', () => {
    // The guarantee is meant to be a property of this file, not a habit. If any
    // of these ever appears here, the boundary has moved and this fails.
    const forbidden = [
      'document.cookie',
      'localStorage',
      'sessionStorage',
      'querySelector',
      'fetch(',
      'XMLHttpRequest',
      'innerHTML',
      'chrome.',
    ];
    for (const term of forbidden) {
      expect(CODE).not.toContain(term);
    }
  });

  it('performs no asynchronous work at all', () => {
    // Nothing here can transmit, because nothing here can wait.
    expect(CODE).not.toContain('await');
    expect(CODE).not.toContain('async ');
    expect(CODE).not.toContain('Promise');
  });
});

describe('the transmission preview', () => {
  const preview = (retain: boolean, url: string | null = 'https://example.com/p') =>
    buildTransmissionPreview({ selectedText: 'Priya Raman', sourceUrl: url, retainSourceUrl: retain });

  it('always includes the visible selection', () => {
    const row = preview(false).find((r) => r.inclusion === 'always');
    expect(row?.included).toBe(true);
    expect(row?.value).toBe('Priya Raman');
  });

  it('includes the source URL only when the box is ticked', () => {
    expect(preview(false).find((r) => r.inclusion === 'optional')?.included).toBe(false);
    expect(preview(true).find((r) => r.inclusion === 'optional')?.included).toBe(true);
  });

  it('does not claim retention when the box is ticked but no URL exists', () => {
    expect(preview(true, null).find((r) => r.inclusion === 'optional')?.included).toBe(false);
  });

  it('LISTS the never-sent class rather than omitting it', () => {
    // Looks redundant and is not: an operator approving a transmission cannot
    // tell "this build does not send cookies" from "this build sends cookies
    // and did not mention it". The row is how the promise becomes checkable by
    // the person actually making the decision.
    const never = preview(false).find((r) => r.inclusion === 'never');
    expect(never).toBeDefined();
    expect(never?.included).toBe(false);
    expect(never?.field.toLowerCase()).toContain('cookies');
  });

  it('states the never-row unconditionally, in the present tense', () => {
    const never = preview(false).find((r) => r.inclusion === 'never');
    // "Will not be sent" invites the reader to wonder what would change that.
    expect(never?.note).toContain('Never read and never sent');
  });

  it('carries no value for the never-sent row', () => {
    // If a value were ever populated here, the thing had already been read.
    expect(preview(true).find((r) => r.inclusion === 'never')?.value).toBe('');
  });
});

describe('transmittability', () => {
  it('treats whitespace-only as nothing to send', () => {
    expect(hasTransmittableSelection('   \n ')).toBe(false);
    expect(hasTransmittableSelection('Priya')).toBe(true);
  });
});
