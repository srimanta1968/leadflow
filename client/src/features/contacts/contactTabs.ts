import { lazy, type LazyExoticComponent } from 'react';

/**
 * The eight tabs of Contact 360, as data.
 *
 * KEPT OUT OF THE COMPONENT for the same reason the sidebar is (see
 * design-system/shell/navModel.ts): a tab whose route and whose pane disagree is
 * invisible in review, and here it is worse than in the nav — a mistyped segment
 * produces a tab that renders the WRONG pane rather than a 404, because the
 * router still matches the parent.
 *
 * EVERY PANE IS `lazy`. That is the acceptance condition ("lazily loaded"), and
 * it is not decoration: the Relationships pane pulls in a graph renderer and the
 * Provenance pane an assertion table, neither of which an operator who opened the
 * record to read a phone number should pay for. Importing them eagerly here would
 * satisfy the tab list and quietly defeat the requirement, since the shell
 * imports this module unconditionally.
 */

export interface ContactTab {
  /** The URL segment under /app/contacts/:contactId. */
  segment: string;
  label: string;
  /** What the pane is for, shown to a screen reader on the tab. */
  hint: string;
  pane: LazyExoticComponent<() => JSX.Element>;
}

export const CONTACT_TABS: ContactTab[] = [
  {
    segment: 'overview',
    label: 'Overview',
    hint: 'Identity, reachability, channel decisions and recommended actions',
    pane: lazy(() => import('./tabs/OverviewTab')),
  },
  {
    segment: 'contact-points',
    label: 'Contact Points',
    hint: 'Each handle with its own source, confidence, validity and eligibility',
    pane: lazy(() => import('./tabs/ContactPointsTab')),
  },
  {
    segment: 'properties',
    label: 'Properties',
    hint: 'Contextual property relationships and their evidence',
    pane: lazy(() => import('./tabs/PropertiesTab')),
  },
  {
    segment: 'conversations',
    label: 'Conversations',
    hint: 'Every interaction in one thread, with the compose guardrails',
    pane: lazy(() => import('./tabs/ConversationsTab')),
  },
  {
    segment: 'relationships',
    label: 'Relationships',
    hint: 'The contextual relationship graph and its table equivalent',
    pane: lazy(() => import('./tabs/RelationshipsTab')),
  },
  {
    segment: 'consent',
    label: 'Preferences & Consent',
    hint: 'Purpose and channel permissions, tracked separately from identity',
    pane: lazy(() => import('./tabs/ConsentTab')),
  },
  {
    segment: 'provenance',
    label: 'Data & Provenance',
    hint: 'Conflicting source values, and why the display projection chose one',
    pane: lazy(() => import('./tabs/ProvenanceTab')),
  },
  {
    segment: 'audit',
    label: 'Audit Timeline',
    hint: 'Every governed action taken on this record',
    pane: lazy(() => import('./tabs/AuditTab')),
  },
];

/** The default tab, so a bare /app/contacts/:id still lands somewhere real. */
export const DEFAULT_CONTACT_TAB = 'overview';
