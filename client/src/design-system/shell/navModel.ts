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
      { label: 'Contacts', to: '/app/contacts', ungated: 'reading contacts is tenant-scoped by the endpoint, not role-gated' },
      { label: 'Capture Inbox', to: '/app', ungated: 'every operator triages their own tenant queue; the rows are scoped server side and the per-row ACTIONS are gated individually', count: 'captureUnresolved' },
      { label: 'Quick Capture', to: '/app/capture', ungated: 'capturing a lead is the one thing every role may do; refusing it would lose the lead' },
      { label: 'Import Center', to: '/app/import', action: 'import.run_read' },  // Gated on the READ grant, not import.commit: this screen reviews imports,
      // it does not apply them, and requiring the commit grant to LOOK would hide
      // the register from the Privacy Officer who audits it.
    ],
  },
  {
    label: 'Identity & trust',
    items: [
      // NOT `planned`. Both shipped (TK-3957, TK-3961), both routed in App.tsx,
      // and both sat here flagged Soon — so the sidebar rendered a finished
      // screen as an unclickable span. A stale flag in this file is invisible
      // in review and total for the operator: the screen may as well not exist.
      { label: 'Identity Review', to: '/app/identity', action: 'identity.merge_review' },
      { label: 'Consent & Preferences', to: '/app/consent', action: 'consent.purpose_manage' },
      { label: 'Enrichment Queue', to: '/app/enrichment', action: 'data.configure' },
      { label: 'Data Review', to: '/app/data-review', action: 'source_record.promote' },
      { label: 'Audit & History', to: '/app/audit', ungated: 'reading the chain is deliberately open — audit.delete_event is the only gated audit capability, and gating READS would defeat the point of an audit trail' },
    ],
  },
  {
    label: 'Revenue',
    items: [
      { label: 'Lead queue', to: '/app/leads', action: 'lead.work_assigned', count: 'leadsOpen' },
      { label: 'Inbox', to: '/app/inbox', ungated: 'an operator reads the threads on their own records; the per-message SEND is gated by the channel decision, which is the control that matters' },
      { label: 'Pipeline', to: '/app/pipeline', action: 'stage.update' },
      { label: 'Routing rules', to: '/app/routing', action: 'routing.configure' },
      { label: 'Routing configuration', to: '/app/routing-config', action: 'routing.configure' },
      { label: 'Routing simulation', to: '/app/routing-simulation', action: 'routing.configure' },
      { label: 'Coverage', to: '/app/coverage', action: 'sla.configure' },
      { label: 'SLA targets', to: '/app/sla', action: 'sla.configure', count: 'captureSlaRisk' },
      { label: 'Sequences', to: '/app/sequences', action: 'automation.publish', planned: true },
      { label: 'Calendar', to: '/app/calendar', action: 'meeting.book' },
      { label: 'Offers', to: '/app/offers', action: 'offer.change_terms' },
      { label: 'Onboarding handoff', to: '/app/handoffs', action: 'handoff.accept' },
    ],
  },
  {
    label: 'Insight',
    items: [
      { label: 'Analytics', to: '/app/analytics', action: 'dashboard.view_team' },
      { label: 'Leadership', to: '/app/leadership', action: 'dashboard.view_team' },
      { label: 'Dashboards', to: '/app/dashboards', action: 'dashboard.view_team' },
      { label: 'Workflow Studio', to: '/app/workflows', action: 'automation.publish' },
      { label: 'Runs & release gate', to: '/app/workflow-runs', action: 'automation.publish' },
      { label: 'Incidents', to: '/app/incidents', action: 'escalation.receive' },
      { label: 'Governance', to: '/app/governance', action: 'legal_policy.approve' },
    ],
  },
  {
    label: 'Related',
    items: [
      { label: 'Associated Properties', to: '/app/properties', ungated: 'a read of related records, scoped by the endpoint', planned: true },
      { label: 'Campaign Enrollment', to: '/app/campaigns', action: 'campaign.configure' },
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
  '/app/enrichment': 'Enrichment Queue — permissioned data capabilities, priced in credits',
  '/app/contacts': 'Contacts — canonical people and organizations',
  '/app/data-review': 'Data Review — governed case queues',
  '/app/import': 'Import Center — runs, templates and the rollback register',
  '/app/identity': 'Identity Review — candidate links awaiting a decision',
  '/app/consent': 'Consent & Preferences — receipts, purposes and suppression',
  '/app/audit': 'Audit & History — evidence, causality and reversibility',
  '/app/routing-config': 'Routing configuration — the six-step decision engine',
  '/app/routing-simulation': 'Routing simulation — replay before you publish',
  '/app/coverage': 'Coverage — every window resolves to a named person',
  '/app/pipeline': 'Pipeline — stages, NEXT actions and the clocks on them',
  '/app/inbox': 'Inbox — every channel in one chronological thread',
  '/app/calendar': 'Calendar — book live and verify receipt on the call',
  '/app/offers': 'Commercial Review — offer version stamping and exceptions',
  '/app/handoffs': 'Onboarding handoff — what sales sold, in the words used',
  '/app/campaigns': 'Campaign Enrollment — eligibility evaluated at send time',
  '/app/leadership': 'Leadership — nine signals, each drilling into its list',
  '/app/dashboards': 'Dashboards — five roles over one KPI registry',
  '/app/workflows': 'Workflow Studio — canvas and keyboard outline, one model',
  '/app/workflow-runs': 'Runs & release gate — per-step state and the twelve tests',
  '/app/incidents': 'Incidents — severity-ordered, with a verification step to close',
  '/app/governance': 'Governance — post-mortems, certification and go-live',
};
