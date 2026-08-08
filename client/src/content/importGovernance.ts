/**
 * The governed vocabularies the import wizard's steps 4-6 speak.
 *
 * MIRRORED FROM sdk-import AND sdk-source-record, not invented here. The origin
 * classes are that SDK's `ORIGIN_CLASSES`, the targets its `CANONICAL_TARGETS`,
 * and the place list its `PLACE_TARGETS`. A second, divergent copy of a
 * governed vocabulary is how a screen ends up offering an origin class the
 * server rejects at commit — after the operator has signed the attestation.
 */

/**
 * The eight origin classes, in the order the SDK declares them.
 *
 * Note the mockup's dropdown shows only seven — it omits USER_PROVIDED. Eight
 * is correct: the SDK enumerates eight and the commit validates against them,
 * so a screen offering seven would silently make one class unreachable.
 */
export const ORIGIN_CLASSES = [
  'USER_PROVIDED',
  'FIRST_PARTY_DIRECT',
  'TENANT_FIRST_PARTY_CRM',
  'USER_AUTHORIZED_CONTACT_STORE',
  'PUBLIC_RECORD',
  'LICENSED_THIRD_PARTY',
  'PARTNER_PROVIDED',
  'UNKNOWN_QUARANTINED',
] as const;

export type OriginClass = (typeof ORIGIN_CLASSES)[number];

/** What each class means, for the person signing the attestation. */
export const ORIGIN_CLASS_LABEL: Record<OriginClass, { label: string; help: string }> = {
  USER_PROVIDED: {
    label: 'User provided',
    help: 'A person on your team typed or pasted these records themselves.',
  },
  FIRST_PARTY_DIRECT: {
    label: 'First-party direct',
    help: 'The people in this file gave you their details directly.',
  },
  TENANT_FIRST_PARTY_CRM: {
    label: 'Tenant first-party CRM',
    help: 'An export from a CRM your organisation owns and operates.',
  },
  USER_AUTHORIZED_CONTACT_STORE: {
    label: 'User-authorised contact store',
    help: 'A personal contact store a user authorised you to read, such as a connected Google or Apple account.',
  },
  PUBLIC_RECORD: {
    label: 'Public record',
    help: 'Published by a public authority or register.',
  },
  LICENSED_THIRD_PARTY: {
    label: 'Licensed third-party',
    help: 'Bought or licensed from a data vendor. Evidence of the licence is required.',
  },
  PARTNER_PROVIDED: {
    label: 'Partner provided',
    help: 'Shared by a partner under an agreement. Evidence of the agreement is required.',
  },
  UNKNOWN_QUARANTINED: {
    label: 'Unknown — quarantined',
    help: 'Provenance cannot be established. The run is quarantined rather than guessed at.',
  },
};

/**
 * Origins whose attestation CANNOT be signed without attached evidence.
 *
 * These are the two where the right to hold the data comes from a document
 * somebody else wrote — a licence or a partner agreement. For every other class
 * the attester is speaking about their own organisation's collection, and their
 * signed word IS the evidence. For these two it is not: "we licensed it" with
 * no licence is exactly the claim a regulator asks to see behind.
 */
export const EVIDENCE_REQUIRED_ORIGINS: readonly OriginClass[] = [
  'LICENSED_THIRD_PARTY',
  'PARTNER_PROVIDED',
];

export const PERMITTED_USES = [
  'Customer service',
  'Sales follow-up',
  'Marketing email',
  'Marketing SMS',
  'Data enrichment',
] as const;

export type PermittedUse = (typeof PERMITTED_USES)[number];

/** The canonical targets, mirrored from sdk-import's CANONICAL_TARGETS. */
export const CANONICAL_TARGETS = [
  'person.given_name',
  'person.family_name',
  'person.full_name',
  'person.date_of_birth',
  'contact.email',
  'contact.phone',
  'contact.handle',
  'org.name',
  'org.domain',
  'org.size',
  'place.address_line1',
  'place.address_line2',
  'place.locality',
  'place.region',
  'place.postal_code',
  'place.country',
  'external.id',
  'attribute.custom',
  'unmapped',
] as const;

export type CanonicalTarget = (typeof CANONICAL_TARGETS)[number];

/**
 * Targets that describe a PLACE.
 *
 * A place is its own entity, linked to a person by ASSOCIATED_WITH — never a
 * column on the person. That is not a modelling preference: a property outlives
 * its occupant and routinely has several over time, so flattening the address
 * onto the person destroys the relationship the moment somebody moves, and
 * silently reassigns the previous occupant's history to the new one.
 */
export const PLACE_TARGETS: readonly CanonicalTarget[] = [
  'place.address_line1',
  'place.address_line2',
  'place.locality',
  'place.region',
  'place.postal_code',
  'place.country',
];

export const PERSON_TARGETS: readonly CanonicalTarget[] = [
  'person.given_name',
  'person.family_name',
  'person.full_name',
  'person.date_of_birth',
];

/** Column-name fragments that indicate an address rather than a person field. */
const ADDRESS_HINTS = /(address|street|addr|city|town|locality|state|province|region|zip|postcode|postal|country)/i;

/**
 * Whether a source column looks like part of a property address.
 *
 * Used to REFUSE a person target for it rather than merely to suggest a place
 * one — see `mappingViolation`.
 */
export function looksLikeAddress(columnName: string): boolean {
  return ADDRESS_HINTS.test(columnName);
}

/**
 * The rule that makes AC3 enforceable rather than advisory.
 *
 * Returns the reason a mapping is refused, or null when it is allowed. An
 * address column pointed at a person field is not a warning the operator can
 * click past: the mapping is rejected and the Action column says why.
 */
export function mappingViolation(sourceColumn: string, target: CanonicalTarget): string | null {
  if (looksLikeAddress(sourceColumn) && PERSON_TARGETS.includes(target)) {
    return 'A property address cannot map to a person field. Addresses become a Place linked by ASSOCIATED_WITH, because a property outlives its occupants and routinely has several.';
  }
  return null;
}

/** The four coverage meters above the mapping table. */
export const COVERAGE_GROUPS = [
  { key: 'person', label: 'Person', targets: PERSON_TARGETS },
  { key: 'contact', label: 'Contact Points', targets: ['contact.email', 'contact.phone', 'contact.handle'] as CanonicalTarget[] },
  { key: 'place', label: 'Property Link', targets: PLACE_TARGETS },
  { key: 'crosswalk', label: 'Source Crosswalk', targets: ['external.id'] as CanonicalTarget[] },
] as const;

/**
 * The transformation plan.
 *
 * `defaultOn` is a governance decision per step, not a convenience. Everything
 * that NORMALISES a value while keeping the original is on; the one step that
 * asserts a business meaning the source never stated is off.
 */
export interface TransformStepSpec {
  key: string;
  label: string;
  detail: string;
  defaultOn: boolean;
  /** Stated on the row when the step is deliberately off by default. */
  offReason?: string;
}

export const TRANSFORM_STEPS: TransformStepSpec[] = [
  {
    key: 'e164',
    label: 'Normalise phone numbers to E.164',
    detail: 'The raw value is preserved alongside the normalised one, so a number we reformatted wrongly can still be read as it arrived.',
    defaultOn: true,
  },
  {
    key: 'split_name',
    label: 'Split full name into given and family name',
    detail: 'Only where a single name column was detected. The original full name is kept.',
    defaultOn: true,
  },
  {
    key: 'standardise_region',
    label: 'Standardise state and country codes',
    detail: 'TX to US-TX, United States to US, via sdk-geo canonicalisation.',
    defaultOn: true,
  },
  {
    key: 'labelled_types',
    label: 'Parse labelled contact types',
    detail: 'home, work and mobile labels become contact-point types rather than being discarded.',
    defaultOn: true,
  },
  {
    key: 'resolve_place',
    label: 'Resolve property-address candidates',
    detail: 'Addresses become Place entities linked by ASSOCIATED_WITH, never columns on the person.',
    defaultOn: true,
  },
  {
    key: 'lifecycle_to_lead',
    label: 'Map source lifecycle status to Lead',
    detail: 'Turns the source system’s own stage values into LeadFlow lead stages.',
    defaultOn: false,
    offReason:
      'OFF BY DEFAULT. Another system’s "qualified" is not this one’s, and importing it silently would drop thousands of records into a pipeline stage nobody assessed them for — they would then be worked, messaged and counted in forecasts on a judgement no human made. Enable it only when the source stages have actually been reconciled with ours.',
  },
];
