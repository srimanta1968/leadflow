import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { api, ApiError, type ContactSummary } from '../../services/api';
import { TrustStateRail } from '../../design-system/evidence/TrustStateRail';
import type { RailState, TrustRailNodeKey } from '../../design-system/evidence/assertions';
import { isAllowed, usePermissions } from '../../platform/permissions';
import {
  ContactRecordProvider,
  type ContactRecord,
} from '../../features/contacts/ContactRecordContext';
import { CONTACT_TABS, DEFAULT_CONTACT_TAB } from '../../features/contacts/contactTabs';

/**
 * Contact 360 — the full-screen workspace (#contact360).
 *
 * THE HEADER NEVER SHOWS A DISPLAY NAME WITHOUT ITS PROVENANCE. That is the
 * task's acceptance condition and the reason the screen exists: the name at the
 * top is a SURVIVORSHIP PROJECTION over several disagreeing sources, not a field
 * somebody typed. Rendering it bare would present a contested value with the
 * authority of a fact, which is precisely the mistake the provenance tab is
 * there to undo. When the projection cannot be read the header says so rather
 * than falling back to a name with no note, because a missing note is
 * indistinguishable from an undisputed name.
 *
 * THE TRUST RAIL IS READ, NOT DRAWN. Every node's state comes from the record's
 * own rail; a node the server did not report renders `pending`, which is honest
 * about what is unknown. The mockup's rail is an illustration and this one must
 * not be — an operator reads it to decide whether they may act.
 *
 * TABS ARE ROUTES. Each is deep-linkable at /app/contacts/:id/<segment> and each
 * pane is `lazy` (see features/contacts/contactTabs.ts), so a link into
 * Conversations loads Conversations and not the other seven.
 */

/** The rail keys the server may report, mapped onto the design-system nodes. */
const RAIL_KEYS: TrustRailNodeKey[] = [
  'P0_CAPTURED',
  'P1_NORMALIZED',
  'P2_CANDIDATE',
  'P3_LINKED',
  'P4_DIRECT',
  'CONSENT',
];

const RAIL_STATES: RailState[] = ['reached', 'current', 'pending', 'blocked'];

/**
 * The three header actions and the grant each one really needs.
 *
 * Every action below exists in server/src/config/roles.ts. That is not a style
 * note: usePermissions FAILS CLOSED on an unknown action, so a plausible-looking
 * name nobody defined disables the control for everyone and looks like a
 * permission problem rather than a typo.
 *
 * `Create Lead` maps to next_action.create rather than to a lead.* grant because
 * there is no lead.create — capturing is open to every role (see navModel) and
 * what this button actually produces is the owned NEXT action the SOP requires
 * on a new lead. Gating on the thing it creates is both true and enforceable.
 */
const HEADER_ACTIONS = [
  { key: 'consent', label: 'Consent', action: 'consent.purpose_manage' },
  { key: 'enrich', label: 'Enrich', action: 'data.configure' },
  { key: 'create_lead', label: 'Create Lead', action: 'next_action.create' },
] as const;

/** Initials for the avatar. Never more than two, never a stray separator. */
function initialsOf(name: string | null): string {
  if (!name) return '--';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '--';
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * The subtitle, assembled only from parts that are actually known.
 *
 * A placeholder in this line would read as a real value at a glance — "Person ·
 * unknown · P4" looks like a canonical id nobody recognises rather than one
 * nobody read.
 */
function subtitleOf(summary: ContactSummary | null): string {
  if (!summary) return 'Record not read';
  return [summary.entity_type, summary.canonical_id, summary.relationship_label]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

export default function Contact360() {
  const { contactId = '' } = useParams();
  const [summary, setSummary] = useState<ContactSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const permissions = usePermissions(
    HEADER_ACTIONS.map((a) => ({ action: a.action, resourceType: 'contact', resourceId: contactId })),
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await api.contactSummary(contactId));
      setError(null);
    } catch (caught) {
      // The header keeps rendering. Blanking the workspace on a failed read
      // loses the operator's place and tells them nothing about why.
      setSummary(null);
      setError(caught instanceof ApiError ? caught.message : 'The record could not be read.');
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  const record: ContactRecord = useMemo(
    () => ({ contactId, summary, loading, error, reload: () => void load() }),
    [contactId, summary, loading, error, load],
  );

  /** Server rail -> design-system rail, ignoring nodes it does not define. */
  const railStates = useMemo(() => {
    const states: Partial<Record<TrustRailNodeKey, RailState>> = {};
    for (const node of summary?.trust_rail ?? []) {
      const key = node.node as TrustRailNodeKey;
      if (RAIL_KEYS.includes(key) && RAIL_STATES.includes(node.state)) {
        states[key] = node.state;
      }
    }
    return states;
  }, [summary]);

  const railEvidence = useMemo(() => {
    const evidence: Partial<Record<TrustRailNodeKey, string>> = {};
    for (const node of summary?.trust_rail ?? []) {
      const key = node.node as TrustRailNodeKey;
      if (RAIL_KEYS.includes(key) && node.evidence) evidence[key] = node.evidence;
    }
    return evidence;
  }, [summary]);

  const provenance = summary?.display_name_provenance ?? null;

  return (
    <div className="mx-auto max-w-6xl">
      {/* ----------------------------------------------------- the header */}
      <div className="lf-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <span
              aria-hidden="true"
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-panel3 text-lg font-semibold text-text"
            >
              {initialsOf(summary?.display_name ?? null)}
            </span>

            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-text">
                {summary?.display_name ?? 'Display name unavailable'}
              </h1>

              {/*
                THE ACCEPTANCE CONDITION. The name and its provenance ship
                together or the absence is stated - never a name on its own.
              */}
              <p className="mt-1 text-xs text-soft" data-testid="survivorship-note">
                {provenance
                  ? `Survivorship projection · ${
                      provenance.source_count === null
                        ? 'source count unavailable'
                        : `${provenance.source_count} sources`
                    }`
                  : 'Survivorship provenance unavailable - the display projection could not be read'}
              </p>

              <p className="mt-1.5 text-sm text-muted">{subtitleOf(summary)}</p>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                {(summary?.badges ?? []).map((badge) => (
                  <span key={badge} className="lf-pill">
                    {badge}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {HEADER_ACTIONS.map((action) => {
                const permitted = isAllowed(permissions, action.action);
                return (
                  <button
                    key={action.key}
                    type="button"
                    name={action.key}
                    disabled={!permitted}
                    title={
                      permitted
                        ? undefined
                        : `${action.label} requires ${action.action}`
                    }
                    className="lf-btn-secondary px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {action.label}
                  </button>
                );
              })}
            </div>

            {/*
              The mockup's Saved indicator. It reports the record's own last
              write, so "Saved" is never asserted about a record nobody read.
            */}
            <p className="text-xs text-soft">
              {summary?.saved_at ? `Saved ${summary.saved_at}` : 'No unsaved changes'}
            </p>
          </div>
        </div>

        {error && (
          <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
            {error}
          </p>
        )}
      </div>

      {/* ------------------------------------------------- the trust rail */}
      <section className="lf-panel mt-4 p-5" aria-label="Trust status">
        <h2 className="lf-eyebrow">Trust status</h2>
        <p className="mb-4 mt-1 text-xs text-soft">
          Consent runs alongside the identity ladder, never on top of it. A record can be fully
          verified and still carry no permission to contact.
        </p>
        <TrustStateRail states={railStates} evidence={railEvidence} />
      </section>

      {/* --------------------------------------------------- the eight tabs */}
      <nav className="mt-4 flex flex-wrap gap-1 border-b border-line" aria-label="Contact sections">
        {CONTACT_TABS.map((tab) => (
          <NavLink
            key={tab.segment}
            // ABSOLUTE, not relative. `to={tab.segment}` resolved against the
            // CURRENT route — from /app/contacts/X/overview a bare
            // "contact-points" became /app/contacts/X/overview/contact-points,
            // which matches no route, so every tab click landed on NotFound.
            // The tabs are the primary navigation of this screen and none of
            // them worked.
            to={`/app/contacts/${contactId}/${tab.segment}`}
            title={tab.hint}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-3 py-2 text-sm ${
                isActive
                  ? 'border-blue font-semibold text-text'
                  : 'border-transparent text-muted hover:text-text'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <ContactRecordProvider value={record}>
        <div className="mt-4">
          <Suspense
            fallback={
              <p role="status" className="lf-panel p-5 text-sm text-muted">
                Loading this section...
              </p>
            }
          >
            <ContactTabOutlet />
          </Suspense>
        </div>
      </ContactRecordProvider>
    </div>
  );
}

/**
 * Render the pane for the active segment.
 *
 * A plain <Outlet/> would need the eight panes wired into the route table, which
 * puts the tab list in two places that can disagree. Reading the segment here
 * keeps contactTabs.ts the single definition.
 */
function ContactTabOutlet() {
  const { tab = DEFAULT_CONTACT_TAB } = useParams();
  const active = CONTACT_TABS.find((t) => t.segment === tab) ?? CONTACT_TABS[0];
  const Pane = active.pane;
  return <Pane />;
}

export { DEFAULT_CONTACT_TAB };
