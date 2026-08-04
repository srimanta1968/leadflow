/**
 * The closed registry of sources the AI SDR may research from.
 *
 * A CLOSED SET, and the closure is the control. "Research the company" is an
 * instruction with no natural boundary — a model given a browsing tool will
 * read whatever it finds, and the difference between a public filing and a
 * scraped private profile is invisible in the output. Naming the permitted
 * sources here means an unlisted source is refused at the edge rather than
 * discovered later in a draft.
 *
 * REFUSED, NOT SKIPPED. A source outside this list raises
 * RESEARCH_SOURCE_NOT_PERMITTED instead of being quietly dropped. A silently
 * dropped source produces a proposal that looks fully researched while missing
 * exactly the thing the rep would have wanted to know, and nobody reviewing the
 * draft can tell the difference.
 */

export interface ResearchSource {
  /** Stable key, recorded on every fact. Must never change. */
  key: string;
  label: string;
  /** Why this source is permitted, in the operator's terms. */
  basis: string;
  /**
   * True when the prospect themselves provided the data.
   *
   * Called out because a fact the prospect typed into our own form carries a
   * different weight from one inferred about them, and a first-touch email
   * quoting something they said reads as attentive where one quoting something
   * we found reads as surveillance.
   */
  volunteered: boolean;
  /**
   * Data credits spent per lookup.
   *
   * Non-zero sources are never used unless explicitly requested. The Quick
   * Capture surface promises no paid enrichment, and a research step that
   * silently spends credits would make that promise false somewhere else in the
   * product.
   */
  costCredits: number;
}

export const RESEARCH_SOURCES: ResearchSource[] = [
  {
    key: 'submitted_form_content',
    label: 'What the prospect told us',
    basis:
      'The lead capture itself. The strongest source there is: volunteered, current, and already lawfully held.',
    volunteered: true,
    costCredits: 0,
  },
  {
    key: 'crm_prior_interactions',
    label: 'Our own prior interactions',
    basis:
      'Records this tenant already holds about this person or company through sdk-crm. No new collection occurs.',
    volunteered: true,
    costCredits: 0,
  },
  {
    key: 'company_public_website',
    label: 'The company’s own public website',
    basis:
      'Published by the company for the purpose of being read. The narrowest possible reading of public.',
    volunteered: false,
    costCredits: 0,
  },
  {
    key: 'public_company_registry',
    label: 'Statutory company registry',
    basis:
      'Filings a company is legally required to publish — registration, officers, filing status.',
    volunteered: false,
    costCredits: 0,
  },
  {
    key: 'approved_data_partner',
    label: 'Contracted data provider',
    basis:
      'A provider under a data-processing agreement this tenant has signed. Permitted because the contract, not our convenience, establishes the basis.',
    volunteered: false,
    costCredits: 1,
  },
];

/** Sources usable without spending a credit or an explicit request. */
export const DEFAULT_RESEARCH_SOURCES: string[] = RESEARCH_SOURCES.filter(
  (source) => source.costCredits === 0
).map((source) => source.key);

export function researchSourceByKey(key: string): ResearchSource | undefined {
  return RESEARCH_SOURCES.find((source) => source.key === key);
}

export function isPermittedResearchSource(key: string): boolean {
  return RESEARCH_SOURCES.some((source) => source.key === key);
}

/**
 * Split a requested list into permitted and refused.
 *
 * Returns BOTH rather than throwing on the first refusal, so a caller naming
 * three bad sources is told about three, not asked to discover them one
 * request at a time.
 */
export function partitionRequestedSources(requested: string[]): {
  permitted: string[];
  refused: string[];
} {
  const permitted: string[] = [];
  const refused: string[] = [];
  for (const key of requested) {
    if (isPermittedResearchSource(key)) {
      permitted.push(key);
    } else {
      refused.push(key);
    }
  }
  return { permitted, refused };
}
