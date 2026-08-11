import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  ApiError,
  type CampaignEnrollmentList,
  type CampaignEnrollmentRow,
} from '../../services/api';
import { DataTable, type Column } from '../../design-system/data/DataTable';
import { chipClass } from '../../design-system/tokens';

/**
 * Campaign Enrollment with execution-time eligibility (#view-campaigns).
 *
 * ELIGIBILITY IS EVALUATED WHEN THE MESSAGE IS SENT, NOT WHEN THE LIST WAS
 * BUILT. That single rule is the reason this screen exists, and it is the one
 * every marketing tool gets wrong: a segment is computed on Monday, the send
 * goes out on Thursday, and everybody who revoked in between is contacted
 * anyway — with an audit trail that looks perfectly clean, because at build time
 * they really were eligible. A build-time flag is a statement about the past
 * being used to justify an action in the present.
 *
 * A SUPPRESSED ROW SAYS WHY. "Suppressed" alone sends the operator to three
 * other screens to find out whether the person revoked, hit a frequency cap, or
 * fell outside the audience snapshot — three situations with completely
 * different responses. The reason ships with the row.
 *
 * SIX INDEPENDENT GATES, ALL OF THEM. Audience snapshot, source rights, purpose,
 * channel eligibility, suppression and frequency caps each refuse
 * independently, and current consent is checked on top of all of them at send
 * time. Passing five is not passing.
 */

const GATES = [
  'Audience snapshot',
  'Source rights',
  'Purpose',
  'Channel eligibility',
  'Suppression',
  'Frequency caps',
];

const shown = (value: string | null): string => (value && value.trim() !== '' ? value : '--');

export default function CampaignEnrollment() {
  const [params] = useSearchParams();
  const contactId = params.get('contact_id') ?? '';
  const [data, setData] = useState<CampaignEnrollmentList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (contactId === '') return;
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        setData(await api.campaignEnrollments(contactId, controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(
          caught instanceof ApiError ? caught.message : 'Enrollment history could not be read.',
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [contactId]);

  const columns: Column<CampaignEnrollmentRow>[] = [
    {
      key: 'campaign',
      header: 'Campaign',
      width: '20%',
      cell: (r) => (
        <div>
          <p className="text-text">{shown(r.campaign_name)}</p>
          <p className="text-[11px] text-soft">{shown(r.campaign_id)}</p>
        </div>
      ),
    },
    { key: 'purpose', header: 'Purpose', cell: (r) => shown(r.purpose), width: '14%' },
    { key: 'enrolled', header: 'Enrollment date', cell: (r) => shown(r.enrolled_at), width: '12%' },
    {
      key: 'channels',
      header: 'Channels',
      width: '12%',
      cell: (r) => (r.channels.length > 0 ? r.channels.join(', ') : '--'),
    },
    {
      key: 'verdict',
      header: 'Eligibility verdict',
      width: '20%',
      cell: (r) => (
        <div>
          {r.verdict ? (
            <span className={`lf-pill ${chipClass(r.verdict === 'Eligible' ? 'success' : 'blocked')}`}>
              {r.verdict}
            </span>
          ) : (
            '--'
          )}
          {/* The reason ships with the row. Without it the operator visits three
              other screens to find out which of six gates refused. */}
          {r.verdict === 'Suppressed' && (
            <p className="mt-1 text-[11px] text-soft">
              {r.suppression_reason ?? 'No reason was returned with this suppression.'}
            </p>
          )}
        </div>
      ),
    },
    { key: 'response', header: 'Response', cell: (r) => shown(r.response), width: '10%' },
    { key: 'outcome', header: 'Outcome', cell: (r) => shown(r.outcome), width: '12%' },
  ];

  return (
    <div className="mx-auto max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold text-text">Campaign Enrollment</h1>
        <p className="mt-1.5 max-w-4xl text-sm text-muted">
          Enrollment is governed by audience snapshot, source rights, purpose, channel
          eligibility, suppression, frequency caps and CURRENT CONSENT EVALUATED AT EXECUTION
          TIME - not at list-build time. A contact who revokes between build and send is never
          contacted.
        </p>
      </div>

      <section className="lf-panel mt-6 p-5" aria-label="The gates">
        <h2 className="lf-eyebrow">What every send is checked against</h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {GATES.map((gate) => (
            <li key={gate} className="lf-pill border-line2 text-muted">
              {gate}
            </li>
          ))}
          <li className="lf-pill border-blue text-blue">Current consent, at send time</li>
        </ul>
        <p className="mt-3 text-xs text-soft">
          Each refuses independently. Passing five is not passing. A segment computed on Monday
          and sent on Thursday is a statement about the past being used to justify an action in
          the present.
        </p>
      </section>

      <div className="lf-panel mt-4 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="lf-eyebrow">Contact Eligibility &amp; Enrollment History</h2>
          <p className="text-xs text-soft">
            {data?.evaluated_at
              ? `Verdicts evaluated ${data.evaluated_at}`
              : 'No evaluation timestamp recorded'}
          </p>
        </div>

        <div className="mt-3">
          <DataTable
            rows={data?.enrollments ?? []}
            columns={columns}
            rowKey={(r) => r.enrollment_id ?? `${r.campaign_id}:${r.enrolled_at}`}
            loading={loading}
            density="dense"
            caption="Campaign enrollment history"
            error={error ? <span>{error}</span> : undefined}
            empty={
              <span>
                {contactId === ''
                  ? 'Name a contact to read its enrollment history.'
                  : 'No campaign enrollments are recorded for this contact.'}
              </span>
            }
            rowActions={() => (
              <button type="button" name="open_evidence" className="lf-btn-ghost px-2 py-1">
                Evidence
              </button>
            )}
          />
        </div>
      </div>
    </div>
  );
}
