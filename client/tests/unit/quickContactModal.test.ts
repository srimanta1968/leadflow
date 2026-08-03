import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_MODES,
  CAPTURE_ORIGIN_OPTIONS,
  CAPTURE_ORIGIN_VALUES,
} from '../../src/content/captureOriginClasses';
import { detectEntities, isEmptyCandidate } from '../../src/components/app/QuickContactModal';

const MODAL_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'components', 'app', 'QuickContactModal.tsx'),
  'utf8'
);

describe('the four capture modes', () => {
  it('offers exactly the four the mockup specifies', () => {
    expect(CAPTURE_MODES.map((mode) => mode.id)).toEqual([
      'smart_paste',
      'manual',
      'business_card',
      'browser_capture',
    ]);
  });

  it('renders a section for every mode, so none is a dead tab', () => {
    for (const mode of CAPTURE_MODES) {
      expect(MODAL_SOURCE).toContain(`mode === '${mode.id}'`);
    }
  });

  it('puts the provenance footer OUTSIDE the per-mode sections', () => {
    // One shared footer, not four. The provenance decision does not change with
    // how the text arrived, and a footer per mode is how one of them ends up
    // without it — which would be a capture with no declared origin.
    const originFieldsets = MODAL_SOURCE.match(/<fieldset name="originClass">/g) ?? [];
    expect(originFieldsets).toHaveLength(1);
  });
});

describe('the origin class vocabulary', () => {
  it('carries all eight classes the server accepts', () => {
    // Pinned so a drift from server/src/features/capture/inboxQuery.ts fails
    // here rather than as a 422 on a real operator's capture.
    expect(CAPTURE_ORIGIN_VALUES).toEqual([
      'USER_PROVIDED',
      'FIRST_PARTY_DIRECT',
      'TENANT_FIRST_PARTY_CRM',
      'USER_AUTHORIZED_CONTACT_STORE',
      'PUBLIC_RECORD',
      'LICENSED_THIRD_PARTY',
      'PARTNER_PROVIDED',
      'UNKNOWN_QUARANTINED',
    ]);
  });

  it('explains what each choice commits the organisation to', () => {
    // The operator is making a provenance claim on the organisation's behalf.
    // 'PARTNER_PROVIDED' tells them nothing about whether they may then email
    // the person; the meaning line has to.
    for (const option of CAPTURE_ORIGIN_OPTIONS) {
      expect(option.meaning.length).toBeGreaterThan(20);
      expect(option.label).not.toBe(option.value);
    }
  });

  it('HAS NO DEFAULT — origin class starts null and blocks save', () => {
    // The criterion is "required and has no default value". 422 protects
    // against OMISSION; it cannot protect against a default the UI supplied,
    // because a defaulted value is indistinguishable from a chosen one on the
    // wire. So the guarantee has to live here.
    expect(MODAL_SOURCE).toMatch(/useState<CaptureOriginClass \| null>\(null\)/);
    // And it must actually gate the action, not merely start empty.
    expect(MODAL_SOURCE).toMatch(/originClass !== null/);
    expect(MODAL_SOURCE).toMatch(/disabled=\{!canSave\}/);
  });

  it('refuses to submit even if the disabled button is bypassed', () => {
    // A form can be submitted by keyboard. The guard is repeated in the handler
    // so a capture with no declared provenance cannot leave this component.
    expect(MODAL_SOURCE).toMatch(/if \(originClass === null\) \{/);
  });
});

describe('no enrichment can be invoked', () => {
  it('calls exactly one API method, and it is the capture', () => {
    const apiCalls = MODAL_SOURCE.match(/api\.\w+\(/g) ?? [];
    expect(apiCalls).toEqual(['api.quickCapture(']);
  });

  it('invokes nothing that could spend a Data Credit', () => {
    // The hard rule is that this modal never spends a Data Credit, and the
    // surest way to keep it is to have no code path that could.
    //
    // Matches CALLS, not the word. The modal's own copy says "No paid
    // enrichment or destructive merge" — banning the word would forbid the
    // sentence that states the guarantee, which is the opposite of useful. What
    // matters is that nothing is invoked.
    const invocations = [
      /\benrich\w*\s*\(/i,
      /\bdata_?credits?\w*\s*\(/i,
      /\bpurchase\w*\s*\(/i,
      /\bappendData\w*\s*\(/i,
      /\b\w*lookup\w*\s*\(/i,
    ];
    for (const pattern of invocations) {
      expect(MODAL_SOURCE).not.toMatch(pattern);
    }
  });

  it('detects entities locally, with no network call in the parser', () => {
    const parser = MODAL_SOURCE.slice(
      MODAL_SOURCE.indexOf('export function detectEntities'),
      MODAL_SOURCE.indexOf('export function isEmptyCandidate')
    );
    expect(parser).not.toContain('await');
    expect(parser).not.toContain('fetch');
    expect(parser).not.toContain('api.');
  });
});

describe('smart-paste preview', () => {
  const SAMPLE = [
    'Priya Raman',
    'Raman Roofing Ltd',
    'priya@ramanroofing.example',
    '07700 900123',
    '42 Bridge Road, Leeds',
  ].join('\n');

  it('separates the candidate into distinct entity groups', () => {
    const detected = detectEntities(SAMPLE);

    // The criterion is that the preview SEPARATES entities. A blended blob
    // would let an operator accept an address on the strength of an email.
    expect(detected.person.length).toBeGreaterThan(0);
    expect(detected.contactPoints.length).toBeGreaterThan(0);
    expect(detected.organization.length).toBeGreaterThan(0);
    expect(detected.property.length).toBeGreaterThan(0);
  });

  it('gives every proposed field its own confidence', () => {
    const detected = detectEntities(SAMPLE);
    const every = [
      ...detected.person,
      ...detected.contactPoints,
      ...detected.property,
      ...detected.organization,
      ...detected.notes,
    ];

    expect(every.length).toBeGreaterThan(0);
    for (const field of every) {
      expect(field.confidence).toBeGreaterThan(0);
      expect(field.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('rates a pattern-matched email above a street-like string', () => {
    const detected = detectEntities(SAMPLE);
    const email = detected.contactPoints.find((f) => f.field === 'Email');
    const address = detected.property.find((f) => f.field === 'Address');

    // Per-field confidence only earns its place if the numbers differ in a way
    // that reflects reality. An email regex is near-certain about what it
    // matched; a street-like string is a long way from a property this person
    // is connected to.
    expect(email?.confidence).toBeGreaterThan(address?.confidence ?? 1);
  });

  it('never auto-accepts on confidence — there is no threshold', () => {
    const parser = MODAL_SOURCE.slice(
      MODAL_SOURCE.indexOf('export function detectEntities'),
      MODAL_SOURCE.indexOf('export function isEmptyCandidate')
    );
    // A threshold is a dial someone eventually turns, and turning it converts a
    // proposal into a silent fact. Confidence is reported, never acted on.
    expect(parser).not.toMatch(/confidence\s*[><]=?\s*0?\.\d/);
  });

  it('returns an empty candidate for empty input rather than throwing', () => {
    expect(isEmptyCandidate(detectEntities(''))).toBe(true);
    expect(isEmptyCandidate(detectEntities('   '))).toBe(true);
  });

  it('keeps unmatched text as a note rather than discarding it', () => {
    const detected = detectEntities('Called about a leak above the kitchen');

    // Evidence the parser could not classify is still evidence. Dropping it
    // would quietly lose the only part a human might have needed.
    expect(isEmptyCandidate(detected)).toBe(false);
  });
});
