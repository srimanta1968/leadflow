import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ContactPointRow,
  type ContactProvenance,
} from '../../../services/api';
import { useContactRecord } from '../ContactRecordContext';
import { DataTable, type Column } from '../../../design-system/data/DataTable';
import { chipClass } from '../../../design-system/tokens';

/**
 * Contact 360 Contact Points (#c-contactpoints).
 *
 * EACH HANDLE IS ITS OWN RECORD, and the table is shaped to make that
 * unavoidable. The framing line is not decoration: the common CRM model treats
 * "the phone number" as an attribute of a person, and every governance failure
 * downstream follows from that — a number confirmed for an appointment reminder
 * silently becoming a number that may be marketed to, because the person, not
 * the handle, was marked contactable.
 *
 * A CANDIDATE IS NOT OPERATIONAL. The Confirm action exists so that becoming
 * usable is a decision somebody made rather than a side effect of an import.
 * Candidates therefore render the action and confirmed rows do not — an
 * always-present Confirm button would invite re-confirming things nobody
 * examined, which is how a review step becomes a formality.
 */

const FRAMING =
  'Each phone, email, address and profile is a separate handle with its own source, confidence, validity and eligibility.';

/** A value, or a stated absence. */
const shown = (value: string | null): string => (value && value.trim() !== '' ? value : '--');

const TRUST_ROLE: Record<string, 'success' | 'warning' | 'info'> = {
  Confirmed: 'success',
  Verified: 'success',
  Candidate: 'warning',
  Documented: 'info',
};

export default function ContactPointsTab() {
  const { contactId } = useContactRecord();
  const [data, setData] = useState<ContactProvenance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        setData(await api.contactProvenance(contactId, controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(
          caught instanceof ApiError ? caught.message : 'The contact points could not be read.',
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [contactId]);

  const columns: Column<ContactPointRow>[] = [
    { key: 'type', header: 'Type', cell: (r) => shown(r.type), width: '10%' },
    { key: 'value', header: 'Value', cell: (r) => shown(r.value), width: '22%' },
    { key: 'label', header: 'Label', cell: (r) => shown(r.label), width: '12%' },
    {
      key: 'trust_state',
      header: 'Trust State',
      width: '12%',
      cell: (r) =>
        r.trust_state ? (
          <span className={`lf-pill ${chipClass(TRUST_ROLE[r.trust_state] ?? 'info')}`}>
            {r.trust_state}
          </span>
        ) : (
          '--'
        ),
    },
    { key: 'source', header: 'Source', cell: (r) => shown(r.source), width: '16%' },
    {
      key: 'dates',
      header: 'Effective / Retrieved',
      width: '16%',
      // Two dates in one column because they are only meaningful together: a
      // value effective long before it was retrieved is stale data somebody
      // just found, and either date alone hides that.
      cell: (r) => `${shown(r.effective_at)} / ${shown(r.retrieved_at)}`,
    },
    { key: 'eligibility', header: 'Eligibility', cell: (r) => shown(r.eligibility), width: '12%' },
  ];

  return (
    <section aria-label="Contact Points">
      <div className="lf-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-text">Contact Points</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted">{FRAMING}</p>
          </div>
          <button type="button" name="add_contact_point" className="lf-btn-secondary px-3 py-1.5">
            Add Contact Point
          </button>
        </div>
      </div>

      <div className="lf-panel mt-4 p-5">
        <DataTable
          rows={data?.contact_points ?? []}
          columns={columns}
          rowKey={(r) => r.contact_point_id ?? `${r.type}:${r.value}`}
          loading={loading}
          caption="Contact points"
          density="dense"
          error={error ? <span>{error}</span> : undefined}
          empty={<span>No contact points are recorded for this person.</span>}
          rowActions={(row) =>
            row.requires_confirmation ? (
              <button type="button" name="confirm_contact_point" className="lf-btn-ghost px-2 py-1">
                Confirm
              </button>
            ) : null
          }
        />
      </div>
    </section>
  );
}
