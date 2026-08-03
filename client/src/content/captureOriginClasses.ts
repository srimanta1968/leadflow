/**
 * The eight data origin classes a Quick Contact capture may declare.
 *
 * A SEPARATE VOCABULARY from `ORIGIN_OPTIONS` in `leadFields.ts`, and
 * deliberately so. That one describes a LEAD written to LeadFlow's own
 * projection (`first_party_declared`, `inferred`, …). These are the source-record
 * classes `sdk-source-record` recognises, and they are what the trust ladder
 * reads. They are not interchangeable, and mapping between them would invent a
 * provenance claim at the boundary — so the modal sends these, verbatim, to
 * `POST /api/leadflow/capture/quick`.
 *
 * The values MUST stay in step with `ORIGIN_CLASSES` in
 * `server/src/features/capture/inboxQuery.ts`. A value here that the server does
 * not know answers 422, which is the correct outcome but a poor way to discover
 * a typo — `captureOriginClasses.test.ts` pins the list so a drift fails a test
 * rather than a user's capture.
 */

export type CaptureOriginClass =
  | 'USER_PROVIDED'
  | 'FIRST_PARTY_DIRECT'
  | 'TENANT_FIRST_PARTY_CRM'
  | 'USER_AUTHORIZED_CONTACT_STORE'
  | 'PUBLIC_RECORD'
  | 'LICENSED_THIRD_PARTY'
  | 'PARTNER_PROVIDED'
  | 'UNKNOWN_QUARANTINED';

export interface CaptureOriginOption {
  value: CaptureOriginClass;
  label: string;
  /**
   * What choosing this actually commits the organisation to.
   *
   * Written for the operator making the claim, not for a developer. The person
   * clicking this radio is asserting where the data came from on the
   * organisation's behalf, and "PARTNER_PROVIDED" tells them nothing about
   * whether they may then email the person.
   */
  meaning: string;
}

export const CAPTURE_ORIGIN_OPTIONS: CaptureOriginOption[] = [
  {
    value: 'USER_PROVIDED',
    label: 'Provided by the person',
    meaning: 'They gave us these details themselves. The strongest basis to act on.',
  },
  {
    value: 'FIRST_PARTY_DIRECT',
    label: 'First-party — direct',
    meaning: 'Collected directly through our own channel, such as a form or a call.',
  },
  {
    value: 'TENANT_FIRST_PARTY_CRM',
    label: 'From our own CRM',
    meaning: 'Already held in this organisation’s records. Check how it got there.',
  },
  {
    value: 'USER_AUTHORIZED_CONTACT_STORE',
    label: 'From an authorised contact store',
    meaning: 'A store the person authorised us to read, such as a linked mailbox.',
  },
  {
    value: 'PUBLIC_RECORD',
    label: 'Public record',
    meaning: 'From a public source. Accurate is not the same as permitted.',
  },
  {
    value: 'LICENSED_THIRD_PARTY',
    label: 'Licensed third party',
    meaning: 'Bought under licence. The licence, not the record, sets what you may do.',
  },
  {
    value: 'PARTNER_PROVIDED',
    label: 'Partner provided',
    meaning: 'A partner passed it to us. Confirm their sharing rights before outbound.',
  },
  {
    value: 'UNKNOWN_QUARANTINED',
    label: 'Unknown — quarantine',
    meaning: 'Provenance cannot be established. It is stored, but never promoted.',
  },
];

/** Every value, for validation and for the tests that pin the vocabulary. */
export const CAPTURE_ORIGIN_VALUES: CaptureOriginClass[] = CAPTURE_ORIGIN_OPTIONS.map(
  (option) => option.value
);

/** The four ways an operator can produce a capture. */
export const CAPTURE_MODES = [
  {
    id: 'smart_paste' as const,
    label: 'Smart Paste',
    hint: 'Paste a signature, an email or a note and review what we detected.',
  },
  {
    id: 'manual' as const,
    label: 'Manual',
    hint: 'Type the details yourself.',
  },
  {
    id: 'business_card' as const,
    label: 'Business Card',
    hint: 'Upload a photo. Extraction produces proposals only, for you to review.',
  },
  {
    id: 'browser_capture' as const,
    label: 'Browser Capture',
    hint: 'Capture selected text from a page, with the page recorded as evidence.',
  },
];

export type CaptureModeId = (typeof CAPTURE_MODES)[number]['id'];

/** Who may see the resulting record. */
export const VISIBILITY_OPTIONS = [
  { value: 'private' as const, label: 'Private to me' },
  { value: 'business_unit' as const, label: 'My team' },
  { value: 'tenant' as const, label: 'Entire organisation' },
];

/** The relationship the operator is asserting, if any. */
export const RELATIONSHIP_OPTIONS = [
  { value: 'none' as const, label: 'Unknown' },
  { value: 'owner' as const, label: 'Possible owner' },
  { value: 'delegate' as const, label: 'Authorised representative' },
  { value: 'account_team' as const, label: 'Referral source' },
];
