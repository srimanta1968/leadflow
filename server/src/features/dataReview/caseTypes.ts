/**
 * The eight case types the Data Review screen triages, and who owns each.
 *
 * ONE PLACE, BECAUSE THE TILE AND THE ROW MUST AGREE. The rail counts cases by
 * type and the queue labels each row with the same type; deriving those from
 * two lists is how a tile reading 12 sits above a filter that finds 9. The
 * screen renders whatever this exports, in this order.
 *
 * OWNERSHIP IS A POLICY QUESTION, NOT A CONSTANT (AC4). What is fixed here is
 * the ROLE that owns each kind of case - a consent ambiguity belongs to the
 * privacy officer whatever the tenant's staffing - and the PERSON is resolved
 * from that role through sdk-policy at read time. Hard-coding a name would put
 * a specific human on a queue they may have left, and hard-coding nothing would
 * leave every case unowned. The role is the durable half of the answer.
 */

export type RiskLevel = 'high' | 'medium' | 'low';

/** The four families the type filter offers, above the eight case types. */
export type CaseFamily = 'identity' | 'source_rights' | 'consent' | 'relationship';

export interface CaseTypeDef {
  key: string;
  /** The tile heading, in the mockup's words. */
  label: string;
  /** The sentence under it. Says what the case IS, not how to fix it. */
  description: string;
  family: CaseFamily;
  /**
   * The role that adjudicates this kind of case. Resolved to a person through
   * sdk-policy; never a name in this file.
   */
  ownerRole: 'data_steward' | 'privacy_officer' | 'sales_manager';
}

export const CASE_TYPES: readonly CaseTypeDef[] = [
  {
    key: 'possible_duplicates',
    label: 'Possible Duplicates',
    description: 'Two records may describe the same person, and nothing has decided whether they do.',
    family: 'identity',
    ownerRole: 'data_steward',
  },
  {
    key: 'contact_point_conflicts',
    label: 'Contact Point Conflicts',
    description: 'Two sources disagree about a phone number or address, and both claim to be current.',
    family: 'identity',
    ownerRole: 'data_steward',
  },
  {
    key: 'source_rights',
    label: 'Source Rights',
    description: 'A record was obtained under terms that may not permit the use it is being put to.',
    family: 'source_rights',
    ownerRole: 'privacy_officer',
  },
  {
    key: 'consent_ambiguity',
    label: 'Consent Ambiguity',
    description: 'A permission exists but does not clearly cover this purpose or this channel.',
    family: 'consent',
    ownerRole: 'privacy_officer',
  },
  {
    key: 'relationship_conflicts',
    label: 'Relationship Conflicts',
    description: 'A person is attached to two accounts or properties that cannot both be right.',
    family: 'relationship',
    ownerRole: 'sales_manager',
  },
  {
    key: 'stale_data',
    label: 'Stale Data',
    description: 'A field has gone long enough without confirmation that acting on it is a risk.',
    family: 'identity',
    ownerRole: 'data_steward',
  },
  {
    key: 'suppression_mismatch',
    label: 'Suppression Mismatch',
    description: 'The provider and the platform disagree about whether somebody may be contacted.',
    family: 'consent',
    ownerRole: 'privacy_officer',
  },
  {
    key: 'promotion_evidence',
    label: 'Promotion Evidence',
    description: 'A source record was promoted to a lead without the evidence the promotion claimed.',
    family: 'source_rights',
    ownerRole: 'data_steward',
  },
];

export const CASE_TYPE_KEYS: readonly string[] = CASE_TYPES.map((t) => t.key);

export const RISK_LEVELS: readonly RiskLevel[] = ['high', 'medium', 'low'];

export const CASE_FAMILIES: readonly CaseFamily[] = [
  'identity',
  'source_rights',
  'consent',
  'relationship',
];

export const caseTypeByKey = (key: string): CaseTypeDef | undefined =>
  CASE_TYPES.find((t) => t.key === key);

/**
 * How close a case is to breaching, as a band the screen colours by (AC3).
 *
 * BANDS RATHER THAN A RAW NUMBER, because the escalation is the point: an
 * operator scanning the queue needs to see which rows are about to breach
 * without reading twenty durations and doing the arithmetic. `breached` is
 * separate from `critical` on purpose - a case that has already missed its
 * deadline is a different conversation from one that is about to.
 */
export type SlaBand = 'breached' | 'critical' | 'warning' | 'ok' | 'unknown';

export function slaBand(minutesRemaining: number | null): SlaBand {
  if (minutesRemaining === null) return 'unknown';
  if (minutesRemaining <= 0) return 'breached';
  if (minutesRemaining <= 60) return 'critical';
  if (minutesRemaining <= 240) return 'warning';
  return 'ok';
}
