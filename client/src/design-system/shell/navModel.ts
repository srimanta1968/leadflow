/**
 * The sidebar, as data.
 *
 * Kept out of the component on purpose. The nav is the one place where a missing
 * permission gate or a duplicated route is invisible in review and obvious in a
 * test, so the structure is asserted in tests/unit/shellNav.test.ts rather than
 * eyeballed in JSX.
 *
 * GROUPS FOLLOW THE MOCKUP'S ORDER AND ITS GRAMMAR. The three groups it defines —
 * CONTACT OPERATIONS, IDENTITY & TRUST, RELATED — are reproduced verbatim, and the
 * LeadFlow revenue sections are added in the identical form rather than in a style
 * of their own, so a screen added later does not announce which half of the product
 * it came from.
 */

/** The counts the shell can render, each keyed to a projection field. */
export type CountKey =
  | 'captureUnresolved'
  | 'captureSlaRisk'
  | 'browserCaptures'
  | 'leadsOpen';

export type NavItem = NavItemBase & (
  /**
   * EVERY item declares one of these two, and the union is what makes the choice
   * deliberate: a screen is either gated on a REAL policy action or it states in
   * writing why it is open. There is no third option where somebody just forgot.
   *
   * The action must exist in server/src/config/roles.ts. Inventing a plausible
   * name is worse than leaving the item open, because usePermissions fails closed
   * on an unknown action — so a typo silently locks the screen for everyone. That
   * is not hypothetical: this nav first shipped with `lead.read`, `dashboard.view`
   * and `source_record.read`, none of which exist, and the whole sidebar rendered
   * as unclickable spans. The test asserts every action against that file.
   */
  | { action: string; ungated?: never }
  | { ungated: string; action?: never }
);

interface NavItemBase {
  label: string;
  /** The route, always under /app. */
  to: string;
  /** Which live count to show, if any. */
  count?: CountKey;
  /**
   * Shipped screens route; planned ones render disabled. Showing the shape of the
   * product is honest; a link that 404s is not.
   */
  planned?: boolean;
}

export interface NavGroup {
  /** The mockup renders these as .navgroup eyebrows. */
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Contact operations',
    items: [
      { label: 'Contact Command', to: '/app/command', action: 'dashboard.view_team', planned: true },
      { label: 'Contacts', to: '/app/contacts', ungated: 'reading contacts is tenant-scoped by the endpoint, not role-gated', planned: true },
      { label: 'Capture Inbox', to: '/app', ungated: 'every operator triages their own tenant queue; the rows are scoped server side and the per-row ACTIONS are gated individually', count: 'captureUnresolved' },
      { label: 'Quick Capture', to: '/app/capture', ungated: 'capturing a lead is the one thing every role may do; refusing it would lose the lead' },
      { label: 'Import Center', to: '/app/import', action: 'import.commit', planned: true },
    ],
  },
  {
    label: 'Identity & trust',
    items: [
      { label: 'Identity Review', to: '/app/identity', action: 'identity.merge_review', planned: true },
      { label: 'Consent & Preferences', to: '/app/consent', action: 'consent.purpose_manage', planned: true },
      { label: 'Enrichment Queue', to: '/app/enrichment', action: 'data.configure', planned: true },
      { label: 'Data Review', to: '/app/data-review', action: 'source_record.promote', planned: true },
      { label: 'Audit & History', to: '/app/audit', ungated: 'reading the chain is deliberately open — audit.delete_event is the only gated audit capability, and gating READS would defeat the point of an audit trail', planned: true },
    ],
  },
  {
    label: 'Revenue',
    items: [
      { label: 'Lead queue', to: '/app/leads', action: 'lead.work_assigned', count: 'leadsOpen' },
      { label: 'Pipeline', to: '/app/pipeline', action: 'stage.update', planned: true },
      { label: 'Routing rules', to: '/app/routing', action: 'routing.configure' },
      { label: 'SLA targets', to: '/app/sla', action: 'sla.configure', count: 'captureSlaRisk' },
      { label: 'Sequences', to: '/app/sequences', action: 'automation.publish', planned: true },
      { label: 'Calendar', to: '/app/calendar', action: 'meeting.book', planned: true },
      { label: 'Offers', to: '/app/offers', action: 'offer.change_terms', planned: true },
    ],
  },
  {
    label: 'Insight',
    items: [
      { label: 'Analytics', to: '/app/analytics', action: 'dashboard.view_team' },
      { label: 'Workflow Studio', to: '/app/workflows', action: 'automation.publish', planned: true },
      { label: 'Incidents', to: '/app/incidents', action: 'escalation.receive', planned: true },
    ],
  },
  {
    label: 'Related',
    items: [
      { label: 'Associated Properties', to: '/app/properties', ungated: 'a read of related records, scoped by the endpoint', planned: true },
      { label: 'Campaign Enrollment', to: '/app/campaigns', action: 'campaign.configure', planned: true },
    ],
  },
];

/** Every item, flattened — for permission prefetch and for the tests. */
export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** The distinct policy actions the shell must ask the PDP about, in one batch. */
export const NAV_ACTIONS: string[] = [
  ...new Set(ALL_NAV_ITEMS.map((i) => i.action).filter((a): a is string => Boolean(a))),
];

/** One-line description of each shipped screen, shown in the top bar. */
export const SCREEN_SUBTITLE: Record<string, string> = {
  '/app': 'Capture Inbox — unresolved captures awaiting a decision',
  '/app/capture': 'Quick Capture — enter a lead by hand',
  '/app/leads': 'Lead queue — routed, owned and SLA-tracked',
  '/app/routing': 'Routing rules — first match wins, in evaluation order',
  '/app/sla': 'SLA targets — response commitments by lead type',
  '/app/analytics': 'Analytics — response times and conversion across the funnel',
};
