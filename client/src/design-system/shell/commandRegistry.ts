import { ALL_NAV_ITEMS } from './navModel';
import type { Rankable } from './commandRanking';

/**
 * Everything the palette can offer, as data.
 *
 * THE NAVIGATION GROUP IS DERIVED FROM THE SIDEBAR rather than typed out again.
 * Two hand-maintained lists of the same screens is the drift this codebase has
 * already paid for twice — the token palette and the CSS mirror, then the nav's
 * colour maps. A screen added to the sidebar appears here for free, with the same
 * permission gate and the same planned flag.
 *
 * The groups reproduce the mockup's: Navigation, Action, Workflow, Capability and
 * Contact. Contact is entity search and is not in this registry — it arrives from
 * sdk-search at query time, which is why it is listed last in GROUP_ORDER.
 */

export interface Command extends Rankable {
  id: string;
  title: string;
  group: string;
  keywords?: string[];
  /** The policy action required, or undefined when the command is open to all. */
  action?: string;
  /** Where it goes. Commands that open a modal carry an intent instead. */
  to?: string;
  intent?: 'quick-capture' | 'extension-preview';
  /** Not yet shipped — excluded from the palette entirely (see below). */
  planned?: boolean;
}

/** The mockup's group order, top to bottom. */
export const GROUP_ORDER = ['Navigation', 'Action', 'Workflow', 'Capability', 'Contact'];

/**
 * Screens, from the sidebar.
 *
 * PLANNED SCREENS ARE EXCLUDED HERE, unlike in the sidebar where they show greyed.
 * The sidebar is a map of the product and showing the shape is honest; the palette
 * is a way to DO something, and an entry that cannot be run is noise in a list
 * whose whole value is that the first hit is the right one.
 */
const navigation: Command[] = ALL_NAV_ITEMS
  .filter((item) => !item.planned)
  .map((item) => ({
    id: `nav:${item.to}`,
    title: `Open ${item.label}`,
    group: 'Navigation',
    keywords: [item.label],
    action: item.action,
    to: item.to,
  }));

/** Things that happen here rather than somewhere else. */
const actions: Command[] = [
  {
    id: 'action:quick-capture',
    title: 'Quick Contact',
    group: 'Action',
    keywords: ['capture', 'new lead', 'add contact', 'quick add'],
    intent: 'quick-capture',
  },
  {
    id: 'action:extension-preview',
    title: 'Extension Preview',
    group: 'Action',
    keywords: ['browser capture', 'chrome'],
    intent: 'extension-preview',
  },
];

/**
 * Multi-step operations. Kept distinct from Action because the mockup does, and
 * because the distinction is real: an Action completes in the palette's own modal,
 * a Workflow takes you somewhere and asks for more.
 */
const workflows: Command[] = [
  {
    id: 'workflow:import',
    title: 'Start Contact Import',
    group: 'Workflow',
    keywords: ['import', 'csv', 'bulk'],
    action: 'import.commit',
    to: '/app/import',
    planned: true,
  },
  {
    id: 'workflow:consent',
    title: 'Capture Consent',
    group: 'Workflow',
    keywords: ['consent', 'permission', 'opt in'],
    action: 'consent.purpose_manage',
    to: '/app/consent',
    planned: true,
  },
];

/** Capabilities that spend credits or call an upstream. */
const capabilities: Command[] = [
  {
    id: 'capability:enrichment',
    title: 'Request Enrichment',
    group: 'Capability',
    keywords: ['enrich', 'append', 'data credits'],
    action: 'data.configure',
    to: '/app/enrichment',
    planned: true,
  },
];

export const COMMANDS: Command[] = [
  ...navigation,
  ...actions,
  ...workflows,
  ...capabilities,
].filter((c) => !c.planned);

/** The distinct policy actions the palette needs verdicts for. */
export const COMMAND_ACTIONS: string[] = [
  ...new Set(COMMANDS.map((c) => c.action).filter((a): a is string => Boolean(a))),
];
