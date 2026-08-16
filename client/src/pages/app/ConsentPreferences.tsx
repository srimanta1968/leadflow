import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, ConsentOverview } from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';
import { failureFor } from '../../content/messages';
import { chipClass } from '../../design-system/tokens';
import { CaptureConsentModal } from '../../components/app/CaptureConsentModal';

/**
 * Consent & Preferences — #view-consent, "Purpose-Specific Permission & Suppression".
 *
 * ONE FETCH FOR THE WHOLE SCREEN, and the expiring window goes to the SERVER
 * rather than being applied here, so the tiles and the register always describe
 * the same period. Filtering in the browser would leave the counters describing
 * a window the table no longer shows.
 *
 * NOTHING ON THIS SCREEN IS OPTIMISTIC. A revoked row updates only after the
 * server confirms, because reporting a revocation that did not happen tells a
 * person they have been removed when they have not, and they have no reason to
 * check again. That is the one failure this screen must never produce.
 */

/** Status chips, through the design system rather than hand-rolled. */
const STATUS_ROLE: Record<string, 'success' | 'warning' | 'blocked'> = {
  active: 'success',
  expiring: 'warning',
  revoked: 'blocked',
};

export default function ConsentPreferences() {
  const [data, setData] = useState<ConsentOverview | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const { notify } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    api
      .consentOverview(days)
      .then(setData)
      .catch((error: unknown) =>
        notify(failureFor(error instanceof ApiError ? error.code : 'INTERNAL_ERROR'))
      )
      .finally(() => setLoading(false));
  }, [days, notify]);

  useEffect(load, [load]);

  async function revoke(receiptId: string) {
    const reason = window.prompt('Why is this consent being withdrawn?')?.trim();
    /*
     * A REASON IS REQUIRED AND THE SERVER ENFORCES IT TOO. Asking here is a
     * courtesy so the operator is not bounced by a 400; the guarantee lives on
     * the endpoint, because a revocation with no stated reason is the one entry
     * a regulator will ask about and find empty.
     */
    if (!reason) return;
    setBusyId(receiptId);
    try {
      await api.revokeConsentReceipt(receiptId, reason);
      load(); // Re-read rather than patch state: the server is the authority.
    } catch (error) {
      notify(failureFor(error instanceof ApiError ? error.code : 'INTERNAL_ERROR'));
    } finally {
      setBusyId(null);
    }
  }

  const k = data?.kpis;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold">Consent &amp; Preferences</h1>
          <button
            type="button"
            onClick={() => setCapturing(true)}
            className="border-line rounded border px-3 py-1 text-sm"
          >
            Capture Consent
          </button>
        </div>
        <p className="text-soft max-w-3xl">
          Purpose-specific permission and suppression. A receipt records what a person was
          told and what they agreed to, for one purpose on one channel. Policy makes the
          final decision at send time.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Tile label="Active Receipts" caption="Direct relationship">
          {k?.active_receipts ?? 0}
        </Tile>
        <Tile label="Expiring Soon" caption={`Within ${data?.expiring_within_days ?? days} days`}>
          {k?.expiring_soon ?? 0}
        </Tile>
        <Tile label="Revoked" caption="Suppression propagated">
          {k?.revoked ?? 0}
        </Tile>
        <Tile label="SMS Permitted" caption="Campaign-specific eligibility varies">
          {k?.sms_permitted ? 'Available' : <NotMeasured reason="sdk-notification was unreachable." />}
        </Tile>
        <Tile label="Email Permitted" caption="Includes non-consent lawful basis">
          {k?.bounce_events === null ? (
            <NotMeasured reason="sdk-deliverability was unreachable." />
          ) : (
            `${k?.bounce_events ?? 0} bounces`
          )}
        </Tile>
        <Tile label="DNC / Suppressed" caption="Tenant and purpose specific">
          {(data?.suppressions ?? []).reduce((n, s) => n + (s.count ?? 0), 0)}
        </Tile>
      </section>

      <section className="flex flex-wrap items-center gap-2">
        <label htmlFor="expiring-window" className="text-soft text-sm">
          Expiring window
        </label>
        {/* AC1 — the window is configurable and defaults to 30 days. */}
        <select
          id="expiring-window"
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          className="border-line rounded border px-2 py-1"
        >
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
        {data?.register?.truncated && (
          <span className={`rounded-full border px-3 py-1 text-sm ${chipClass('warning')}`}>
            Showing {data.receipts?.length ?? 0} of{' '}
            {data.register.total === null ? 'an unknown total' : `${data.register.total} receipts`}
          </span>
        )}
        {/*
          A LOUD, UNMISSABLE STATE, because the failure it reports is silent by
          nature: receipts belonging to another tenant look exactly like ours
          once rendered. Zero is the only acceptable value here.
        */}
        {(data?.register?.foreign_dropped ?? 0) > 0 && (
          <span className={`rounded-full border px-3 py-1 text-sm ${chipClass('blocked')}`}>
            {data?.register?.foreign_dropped} receipts from another tenant were refused — report this
          </span>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Consent Receipt Register</h2>
        <table className="w-full text-left text-sm">
          <thead className="text-soft">
            <tr>
              <th className="py-2">Subject</th>
              <th>Purpose</th>
              <th>Jurisdiction</th>
              <th>Valid Until</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {(data?.receipts ?? []).slice(0, 50).map((row) => (
              <tr key={row.receipt_id ?? `${row.person_id}-${row.purpose_id}`}>
                {/*
                  THE NAME FIRST, THE ID UNDERNEATH — and the id stays. A privacy
                  officer deciding whether to withdraw a consent needs to know
                  whose it is, and the register showed them a column of uuids;
                  but the canonical id is what a DSAR, an erasure and every
                  upstream service quote back, so replacing it outright would
                  break the one identifier that travels.
                */}
                <td className="py-2">
                  {row.subject_name ? (
                    <>
                      <div>{row.subject_name}</div>
                      <div className="text-soft font-mono text-xs">{row.person_id ?? '-'}</div>
                    </>
                  ) : (
                    <>
                      <div className="font-mono text-xs">{row.person_id ?? '-'}</div>
                      {/* Not "unknown person": we hold no CONTACT for this
                          subject, which is a fact about our records rather than
                          about them. */}
                      <div className="text-soft text-xs">No contact in this workspace</div>
                    </>
                  )}
                </td>
                <td>
                  {row.purpose_label ? (
                    <>
                      <div>{row.purpose_label}</div>
                      <div className="text-soft font-mono text-xs">{row.purpose_id ?? '-'}</div>
                    </>
                  ) : (
                    <span className="font-mono text-xs">{row.purpose_id ?? '-'}</span>
                  )}
                </td>
                <td>{row.jurisdiction ?? '-'}</td>
                <td>{row.expires_at ? row.expires_at.slice(0, 10) : 'No expiry'}</td>
                <td>
                  <span
                    className={`rounded-full border px-2 py-0.5 ${chipClass(STATUS_ROLE[row.status] ?? 'blocked')}`}
                  >
                    {row.status}
                  </span>
                </td>
                <td>
                  {row.status === 'revoked' ? (
                    <span className="text-soft">Withdrawn</span>
                  ) : (
                    <button
                      type="button"
                      className="text-brand"
                      disabled={busyId === row.receipt_id}
                      onClick={() => row.receipt_id && revoke(row.receipt_id)}
                    >
                      {busyId === row.receipt_id ? 'Revoking...' : 'Revoke'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && (data?.receipts ?? []).length === 0 && (
          <p className="text-soft py-6">
            No receipts to show —{' '}
            {data?.upstream_available?.receipts === false
              ? 'could not reach the consent service, so the register is unavailable rather than empty.'
              : 'no consent has been captured for this tenant yet.'}
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Suppression Controls</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {(data?.suppressions ?? []).map((s) => (
            <div key={s.channel} className="border-line rounded border p-3">
              <div className="text-soft text-xs uppercase">{s.channel}</div>
              <div className="py-1 text-xl font-semibold">
                {/* AC2 — null is NOT zero. An unreachable provider says so. */}
                {s.count === null ? <NotMeasured reason={s.note ?? ''} /> : s.count}
              </div>
              <div className="text-soft text-xs">
                {s.reconciled ? 'Reconciled with provider' : 'Not reconciled'}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Purpose Taxonomy</h2>
        {/*
          AC4 — the taxonomy is READ, never hard-coded. It shipped as a written
          gap saying sdk-consent had no GET for purposes; it has one, and had all
          along. An empty list now means the tenant has registered nothing, and
          an unreachable service says so separately — the two are different facts
          and the screen no longer collapses them into a paragraph.
        */}
        {(data?.purposes ?? []).length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {data?.purposes?.map((p) => (
              <span
                key={p.purpose_id ?? Math.random()}
                title={p.legal_basis ? `Legal basis: ${p.legal_basis}` : undefined}
                className={`rounded-full border px-3 py-1 text-sm ${chipClass('identity')}`}
              >
                {p.description ?? p.purpose_id}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-soft">
            {data?.upstream_available?.purposes === false
              ? 'The purpose registry could not be reached, so the taxonomy is unknown rather than empty.'
              : 'No purposes are registered for this tenant yet.'}
          </p>
        )}
        <p className="text-soft mt-3 text-sm">
          Policy makes the final decision. A receipt permits a purpose; it does not
          guarantee a send.
        </p>
      </section>

      {capturing && (
        <CaptureConsentModal
          onClose={() => setCapturing(false)}
          onIssued={load}
        />
      )}
    </div>
  );
}

/** A value with no source, rendered so nobody reads it as zero. */
function NotMeasured({ reason }: { reason: string }) {
  return (
    <span className="text-soft" title={reason}>
      Not measured
    </span>
  );
}

function Tile({
  label,
  caption,
  children,
}: {
  label: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-line rounded-lg border p-4">
      <div className="text-soft text-xs uppercase tracking-wide">{label}</div>
      <div className="py-1 text-xl font-semibold">{children}</div>
      <div className="text-soft text-xs">{caption}</div>
    </div>
  );
}
