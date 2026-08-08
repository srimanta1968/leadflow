import type { SemanticRole } from '../design-system/tokens';

/**
 * The eight import sources the product supports, as the mockup names them.
 *
 * A FIXED CATALOGUE, NOT A LIST OF WHAT IS CONNECTED. Every tile renders on
 * every tenant; what varies is whether it is usable, which is reported
 * alongside rather than by dropping the tile. A source hidden because nobody
 * connected it reads as "we do not support Google Contacts" — the operator
 * concludes the product cannot do the thing they came to do. Shown as
 * unavailable it reads as "you have not connected Google Contacts yet", which
 * is the only one of the two they can act on.
 *
 * `kind` is the key sdk-connectors uses, so availability can be joined without
 * a second mapping table living somewhere else and drifting.
 */
export interface ImportSourceTile {
  /** The product's own name for the source, and the tile's test handle. */
  kind: string;
  /**
   * The adapter key sdk-connectors actually registers, when it differs.
   *
   * Google Contacts is served by the `gworkspace` adapter, so joining on the
   * product name alone would report it unavailable on a tenant that HAS
   * connected Google — the one case the availability flag exists to get right.
   * Absent means the two names agree.
   */
  connectorKind?: string;
  label: string;
  /** The small badge on the tile. Absent where the mockup shows none. */
  recommendation?: string;
  description: string;
  /**
   * True when the source needs no connector at all — a file the operator
   * uploads. These are ALWAYS available, so they must never be marked
   * unavailable just because sdk-connectors could not be reached.
   */
  fileBased?: boolean;
}

export const IMPORT_SOURCES: ImportSourceTile[] = [
  {
    kind: 'google',
    connectorKind: 'gworkspace',
    label: 'Google Contacts',
    recommendation: 'OAuth / CSV',
    description: 'Selected account, incremental sync, or Google CSV export.',
  },
  {
    kind: 'apple',
    label: 'Apple Contacts',
    recommendation: 'Selected / vCard',
    description: 'Native selected contacts on Apple devices or vCard import.',
  },
  {
    kind: 'acculynx',
    label: 'AccuLynx',
    recommendation: 'API / Export',
    description: 'Connector credentials or source-specific CSV with preserved IDs.',
  },
  {
    kind: 'jobnimbus',
    label: 'JobNimbus',
    description: 'Approved connector or source-specific export mapping.',
  },
  {
    kind: 'salesrabbit',
    label: 'SalesRabbit',
    recommendation: 'API',
    description: 'Lead/contact activity connector with source crosswalks.',
  },
  {
    kind: 'hubspot',
    label: 'HubSpot',
    description: 'Contacts, companies, associations and selected lifecycle facts.',
  },
  {
    kind: 'vcard',
    label: 'vCard',
    description: 'One or many .vcf contact cards with labeled values.',
    fileBased: true,
  },
  {
    kind: 'custom',
    label: 'Custom CSV',
    recommendation: 'Flexible',
    description: 'AI-assisted mapping, transforms, dry run and reusable templates.',
    fileBased: true,
  },
];

/**
 * The four words the run table says, how each colours, and the one action it
 * offers.
 *
 * The tone is a SEMANTIC ROLE from the design system, never a raw hue. The
 * mockup draws Review in purple, which is the `publicRecord` role — "AI-assisted
 * pending human review" — and that is the meaning, not a coincidence of colour.
 * Writing 'purple' here would be a second colour vocabulary that drifts from the
 * tokens the moment either side is edited.
 *
 * ONE ACTION PER STATUS, because the mockup offers one: a completed run gets its
 * Report, a restricted one its Evidence, a quarantined one a Fix. Showing all
 * four everywhere would make the operator work out which applies, which is the
 * job the status column already did.
 */
export const RUN_STATUS_PRESENTATION = {
  review: { label: 'Review', role: 'publicRecord', action: 'Open' },
  complete: { label: 'Complete', role: 'success', action: 'Report' },
  restricted: { label: 'Restricted', role: 'warning', action: 'Evidence' },
  quarantined: { label: 'Quarantined', role: 'blocked', action: 'Fix' },
} as const;

export type RunPresentationStatus = keyof typeof RUN_STATUS_PRESENTATION;

/** The origin badge, in the table's own words. */
export const ORIGIN_ATTESTATION_LABEL: Record<string, { label: string; role: SemanticRole }> = {
  tenant_first_party: { label: 'Tenant First-Party', role: 'success' },
  third_party: { label: 'Third-Party', role: 'warning' },
  // Not collapsed into first-party. A run whose provenance nobody recorded is
  // the case the quarantine exists for, and the reassuring default would hide it.
  unknown: { label: 'Unknown', role: 'blocked' },
};

/** The segmented filter above the run table, in the mockup's order. */
export const RUN_FILTERS = ['All runs', 'In progress', 'Needs review', 'Completed'] as const;
export type RunFilter = (typeof RUN_FILTERS)[number];
