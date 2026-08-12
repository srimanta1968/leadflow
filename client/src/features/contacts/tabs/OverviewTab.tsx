import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type ContactOverview } from '../../../services/api';
import { useContactRecord } from '../ContactRecordContext';
import { chipClass } from '../../../design-system/tokens';

/**
 * Contact 360 Overview (#c-overview) — the six panels.
 *
 * EVERY DENY OR REVIEW ROW STATES A CONCRETE REASON. That is the acceptance
 * condition, and it is the whole argument of the screen: a bare "Denied" tells
 * an operator they may not send without telling them what would change that, so
 * they either escalate or ignore it, and both are wrong. The reason is rendered
 * VERBATIM from the decision engine — composing a friendlier sentence here would
 * produce text that reads as authoritative while agreeing with nothing that was
 * actually decided. Where the engine returned no reason the row says the reason
 * is missing, which is a bug report rather than a silent blank.
 *
 * THE CONTACTABILITY METER IS COMPUTED, NOT STORED. It is drawn from the same
 * live eligibility components listed beneath it, so the number and the rows can
 * never disagree. A stored score is the failure mode this panel exists to avoid:
 * it survives the consent revocation that should have moved it and keeps
 * reporting a person as reachable after they asked not to be.
 *
 * RECOMMENDED ACTIONS COME FROM THE SCORING SDK. The mockup lists four, and
 * hard-coding those four would make the panel a picture of a recommendation
 * engine rather than one. An empty list renders as empty.
 */

/** A value, or a stated absence. Never a plausible-looking placeholder. */
function shown(value: string | null | undefined): string {
  return value && value.trim() !== '' ? value : 'Not recorded';
}

const VERDICT_ROLE = {
  allow: 'success',
  review: 'warning',
  deny: 'blocked',
} as const;

const VERDICT_LABEL = {
  allow: 'Allow',
  review: 'Review',
  deny: 'Deny',
} as const;

export default function OverviewTab() {
  const { contactId } = useContactRecord();
  const [data, setData] = useState<ContactOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        setData(await api.contactOverview(contactId, controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(caught instanceof ApiError ? caught.message : 'The overview could not be read.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [contactId]);

  const identity = data?.identity;
  const contactability = data?.contactability;
  const passport = data?.data_passport;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {error && (
        <p className="lg:col-span-2 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      {/* ------------------------------------ 1. Identity & Reachability */}
      <section className="lf-panel p-5" aria-label="Identity and Reachability">
        <h2 className="lf-eyebrow">Identity &amp; Reachability</h2>

        <div className="mt-3 space-y-3 text-sm">
          <div>
            <p className="lf-label">Preferred Display Name</p>
            <p className="text-text">{shown(identity?.display_name)}</p>
            <p className="mt-0.5 text-xs text-soft">{shown(identity?.survivorship_note)}</p>
          </div>

          <div>
            <p className="lf-label">Contextual Role</p>
            <p className="text-text">{shown(identity?.contextual_role)}</p>
            {/* A role is confirmed FOR something. Dropping the scope turns a
                narrow confirmation into a claim about the whole person. */}
            <p className="mt-0.5 text-xs text-soft">{shown(identity?.role_scope_note)}</p>
          </div>

          <div>
            <p className="lf-label">Organization</p>
            <p className="text-text">{shown(identity?.organization)}</p>
          </div>

          <div>
            <p className="lf-label">Record Owner</p>
            <p className="text-text">{shown(identity?.record_owner?.name)}</p>
            <p className="mt-0.5 text-xs text-soft">
              {shown(identity?.record_owner?.business_unit)}
            </p>
          </div>
        </div>

        {/* ------------------------------------- the contactability meter */}
        <div className="mt-4 border-t border-line pt-4">
          <div className="flex items-baseline justify-between">
            <p className="lf-label">Contactability</p>
            <p className="text-sm font-semibold text-text">
              {contactability?.score === null || contactability?.score === undefined
                ? '--'
                : `${contactability.score}%`}
            </p>
          </div>

          <div
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-panel3"
            role="meter"
            aria-valuenow={contactability?.score ?? undefined}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Contactability"
          >
            <div
              className="h-full bg-blue"
              style={{ width: `${Math.max(0, Math.min(100, contactability?.score ?? 0))}%` }}
            />
          </div>

          <p className="mt-2 text-xs text-soft">
            {shown(contactability?.basis) === 'Not recorded'
              ? 'Computed from the live channel eligibility below, never from a stored score.'
              : contactability?.basis}
          </p>

          <ul className="mt-2 space-y-1">
            {(contactability?.components ?? []).map((component) => (
              <li key={component.channel} className="text-xs">
                <span className={component.eligible ? 'text-green' : 'text-muted'}>
                  {component.channel}
                </span>
                <span className="text-soft"> — {component.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* --------------------------------------------- 2. Contact Points */}
      <section className="lf-panel p-5" aria-label="Contact Points">
        <div className="flex items-baseline justify-between">
          <h2 className="lf-eyebrow">Contact Points</h2>
          <Link to="../contact-points" className="text-xs text-blue hover:underline">
            Manage
          </Link>
        </div>

        <ul className="mt-3 space-y-3">
          {(data?.contact_points ?? []).map((point) => (
            <li key={`${point.type}:${point.value}`} className="text-sm">
              <p className="text-text">
                {point.value}
                {point.label ? <span className="text-soft"> · {point.label}</span> : null}
              </p>
              {/* Per-handle, because eligibility is a property of the HANDLE and
                  not of the person: one number may be reachable while another
                  on the same record is not. */}
              <p className="mt-0.5 text-xs text-soft">{point.eligibility_note}</p>
            </li>
          ))}
          {!loading && (data?.contact_points ?? []).length === 0 && (
            <li className="text-sm text-muted">No contact points recorded.</li>
          )}
        </ul>
      </section>

      {/* ------------------------------------------- 3. Properties & Work */}
      <section className="lf-panel p-5" aria-label="Properties and Work">
        <div className="flex items-baseline justify-between">
          <h2 className="lf-eyebrow">Properties &amp; Work</h2>
          <Link to="../properties" className="text-xs text-blue hover:underline">
            Link property
          </Link>
        </div>

        <ul className="mt-3 space-y-3">
          {(data?.properties ?? []).map((property) => (
            <li key={property.label} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-text">{property.label}</span>
                {property.trust_state && (
                  <span
                    className={`lf-pill ${chipClass(
                      property.trust_state === 'Confirmed' ? 'success' : 'warning',
                    )}`}
                  >
                    {property.trust_state}
                  </span>
                )}
              </div>
              {property.active_work && (
                <p className="mt-0.5 text-xs text-soft">{property.active_work}</p>
              )}
            </li>
          ))}
          {!loading && (data?.properties ?? []).length === 0 && (
            <li className="text-sm text-muted">No property relationships recorded.</li>
          )}
        </ul>
      </section>

      {/* ------------------------------------- 4. Recent Conversations */}
      <section className="lf-panel p-5" aria-label="Recent Conversations">
        <div className="flex items-baseline justify-between">
          <h2 className="lf-eyebrow">Recent Conversations</h2>
          <Link to="../conversations" className="text-xs text-blue hover:underline">
            View all
          </Link>
        </div>

        <ul className="mt-3 space-y-3">
          {(data?.recent_conversations ?? []).map((conversation, index) => (
            <li key={`${conversation.channel}:${index}`} className="text-sm">
              <p className="text-text">
                <span className="text-soft">{conversation.channel} · </span>
                {conversation.summary}
              </p>
              <p className="mt-0.5 text-xs text-soft">{shown(conversation.occurred_at)}</p>
            </li>
          ))}
          {!loading && (data?.recent_conversations ?? []).length === 0 && (
            <li className="text-sm text-muted">No conversations recorded.</li>
          )}
        </ul>
      </section>

      {/* -------------------------------------------- 5. Data Passport */}
      <section className="lf-panel p-5" aria-label="Data Passport">
        <div className="flex items-baseline justify-between">
          <h2 className="lf-eyebrow">Data Passport</h2>
          <Link to="../provenance" className="text-xs text-blue hover:underline">
            Full history
          </Link>
        </div>

        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="lf-label">Canonical Person ID</dt>
            <dd className="text-text">{shown(passport?.canonical_person_id)}</dd>
          </div>
          <div>
            <dt className="lf-label">Primary Data Origin</dt>
            <dd className="text-text">{shown(passport?.primary_data_origin)}</dd>
            {/* The crosswalk is retained even when the value is superseded, and
                saying so is the difference between provenance and a changelog. */}
            <dd className="mt-0.5 text-xs text-soft">
              {shown(passport?.crosswalk_retention_note)}
            </dd>
          </div>
          <div>
            <dt className="lf-label">Direct Relationship</dt>
            <dd className="text-text">{shown(passport?.direct_relationship?.established_at)}</dd>
            <dd className="mt-0.5 text-xs text-soft">
              {shown(passport?.direct_relationship?.method)}
            </dd>
          </div>
          <div>
            <dt className="lf-label">Last Identity Review</dt>
            <dd className="text-text">{shown(passport?.last_identity_review)}</dd>
          </div>
        </dl>
      </section>

      {/* ------------------------- 6. Channel Decision + Recommendations */}
      <section className="lf-panel p-5" aria-label="Channel Decision">
        <h2 className="lf-eyebrow">Channel Decision</h2>

        <ul className="mt-3 space-y-3">
          {(data?.channel_decisions ?? []).map((decision) => (
            <li key={`${decision.purpose}:${decision.channel}`} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`lf-pill ${chipClass(VERDICT_ROLE[decision.verdict])}`}>
                  {VERDICT_LABEL[decision.verdict]}
                </span>
                <span className="text-text">
                  {decision.purpose} · {decision.channel}
                </span>
              </div>
              {/*
                THE ACCEPTANCE CONDITION. Rendered verbatim, and a missing reason
                is reported as missing rather than left blank - a blank reads as
                "no reason needed", which for a Deny is the opposite of true.
              */}
              <p className="mt-1 text-xs text-soft">
                {decision.reason && decision.reason.trim() !== ''
                  ? decision.reason
                  : 'No reason was returned with this decision - report it, do not act on it.'}
              </p>
            </li>
          ))}
          {!loading && (data?.channel_decisions ?? []).length === 0 && (
            <li className="text-sm text-muted">No channel decisions available.</li>
          )}
        </ul>

        <div className="mt-4 border-t border-line pt-4">
          <h3 className="lf-eyebrow">Recommended Next Actions</h3>

          <ul className="mt-3 space-y-2">
            {(data?.recommended_actions ?? []).map((action) => (
              <li key={action.key} className="text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-text">{action.label}</span>
                  {/* The cost is shown BEFORE invocation. A credit-priced action
                      that reveals its price after the fact is a bill, not a
                      choice. */}
                  {action.credit_cost !== null && (
                    <span className="lf-pill">{action.credit_cost} credits</span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-soft">{action.detail}</p>
              </li>
            ))}
            {!loading && (data?.recommended_actions ?? []).length === 0 && (
              <li className="text-sm text-muted">
                The scoring service returned no recommendations for this record.
              </li>
            )}
          </ul>
        </div>
      </section>
    </div>
  );
}
