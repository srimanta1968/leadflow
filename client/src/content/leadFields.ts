import { LeadSource } from '../services/api';

/**
 * The lead-capture field vocabulary, shared by every form that creates a lead.
 *
 * These lists mirror `server/src/validators/leadValidators.ts` exactly. They are
 * declared once here so the operator form, the marketing form and any future
 * import mapping screen offer the same options — a channel that exists in the UI
 * but not in the validator is a guaranteed 400, and the reverse is a channel
 * nobody can select.
 */

export interface SourceOption {
  value: LeadSource;
  label: string;
  /** Grouping used by the select, matching how the SOP talks about channels. */
  group: 'Inbound' | 'Paid & social' | 'Direct' | 'System';
}

export const SOURCE_OPTIONS: SourceOption[] = [
  { value: 'web_form', label: 'Web form', group: 'Inbound' },
  { value: 'landing_page', label: 'Landing page', group: 'Inbound' },
  { value: 'live_chat', label: 'Live chat', group: 'Inbound' },
  { value: 'referral', label: 'Referral', group: 'Inbound' },
  { value: 'facebook', label: 'Facebook', group: 'Paid & social' },
  { value: 'instagram', label: 'Instagram', group: 'Paid & social' },
  { value: 'linkedin', label: 'LinkedIn', group: 'Paid & social' },
  { value: 'tiktok', label: 'TikTok', group: 'Paid & social' },
  { value: 'google_ads', label: 'Google Ads', group: 'Paid & social' },
  { value: 'phone', label: 'Phone', group: 'Direct' },
  { value: 'email', label: 'Email', group: 'Direct' },
  { value: 'webhook', label: 'Webhook', group: 'System' },
  { value: 'api', label: 'API', group: 'System' },
  { value: 'csv_import', label: 'CSV import', group: 'System' },
];

/** Distinct groups, in display order. */
export const SOURCE_GROUPS: SourceOption['group'][] = [
  'Inbound',
  'Paid & social',
  'Direct',
  'System',
];

export interface OriginOption {
  value: string;
  label: string;
  /** What asserting this origin class actually commits you to. */
  meaning: string;
}

/**
 * The eight origin classes from the ProjexCloud `sdk-source-record` trust
 * ladder. The operator is choosing what the organisation is willing to assert
 * about where this data came from, so each option states its consequence rather
 * than being a bare label.
 */
export const ORIGIN_OPTIONS: OriginOption[] = [
  {
    value: 'first_party_declared',
    label: 'First-party — declared',
    meaning: 'The person told us this directly. The strongest basis to act on.',
  },
  {
    value: 'first_party_observed',
    label: 'First-party — observed',
    meaning: 'We observed it in our own systems. Reliable but not stated by them.',
  },
  {
    value: 'partner_shared',
    label: 'Partner shared',
    meaning: 'A partner passed it to us. Check the sharing rights before outbound.',
  },
  {
    value: 'public_record',
    label: 'Public record',
    meaning: 'From a public source. Accurate is not the same as permitted.',
  },
  {
    value: 'third_party_licensed',
    label: 'Third-party licensed',
    meaning: 'Bought under licence. Permitted uses are limited by that licence.',
  },
  {
    value: 'inferred',
    label: 'Inferred',
    meaning: 'Derived, not stated. Never treat as verified.',
  },
  {
    value: 'user_asserted',
    label: 'User asserted',
    meaning: 'An operator typed it from memory or a conversation.',
  },
  {
    value: 'unknown',
    label: 'Unknown',
    meaning: 'Provenance is genuinely unknown. Enters the inbox for resolution.',
  },
];
