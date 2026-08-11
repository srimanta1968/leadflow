import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type DataReviewCases,
  type SlaBand,
} from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';
import { Modal } from '../../design-system/overlays/Modal';
import { EstablishRelationshipModal } from '../../features/dataReview/EstablishRelationshipModal';

/**
 * Field-Level Verification & Source Conflict / Data Review (#view-review).
 *
 * BOTH FILTERS GO TO THE SERVER. Risk and case family are independent
 * predicates over the same set, so High + Consent means BOTH rather than
 * whichever was clicked last, and filtering in the browser would leave the
 * tiles counting a register the table is no longer showing.
 *
 * THE SLA COLUMN ESCALATES BY BAND, NOT BY READING A DURATION. An operator
 * scanning forty rows needs to see which are about to breach without doing
 * arithmetic forty times, and `breached` is coloured differently from
 * `critical` because a missed deadline is a different conversation from an
 * imminent one.
 */

const RISK_SEGMENTS = [
  { key: 'all', label: 'All' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
];

const FAMILY_SEGMENTS = [
  { key: 'all', label: 'All' },
  { key: 'identity', label: 'Identity' },
  { key: 'source_rights', label: 'Source Rights' },
  { key: 'consent', label: 'Consent' },
  { key: 'relationship', label: 'Relationship' },
];

/** The escalation. Colour carries the same meaning the band name does. */
const SLA_TONE: Record<SlaBand, string> = {
  breached: 'text-red font-semibold',
  critical: 'text-red',
  warning: 'text-gold',
  ok: 'text-muted',
  unknown: 'text-soft',
};

const SLA_LABEL: Record<SlaBand, string> = {
  breached: 'Breached',
  critical: 'Due within the hour',
  warning: 'Due today',
  ok: 'On track',
  unknown: 'No clock',
};

/** A count, or a dash when the register could not be read. Never a false zero. */
const count = (value: number | null): string => (value === null ? '--' : String(value));

function remaining(minutes: number | null): string {
  if (minutes === null) return '--';
  if (minutes <= 0) return `${Math.abs(minutes)}m over`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default function DataReview() {
  const [data, setData] = useState<DataReviewCases | null>(null);
  const [risk, setRisk] = useState('all');
  const [family, setFamily] = useState('all');
  const [loading, setLoading] = useState(true);
  const [establishOpen, setEstablishOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const { notify } = useToast();

  const load = useCallback(async (nextRisk: string, nextFamily: string) => {
    setLoading(true);
    try {
      setData(await api.dataReviewCases({ risk: nextRisk, family: nextFamily }));
    } catch (error) {
      notify({
        tone: 'error',
        title: 'The review queue could not be loaded.',
        detail: error instanceof ApiError ? error.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load(risk, family);
  }, [risk, family, load]);

  const ownerGap = data?.field_gaps.find((gap) => gap.field === 'owner');

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Field-Level Verification</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            Every case here is a disagreement the system will not resolve on its own. A person
            decides, and the decision is recorded against the evidence it was made on.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/*
            Reachable from the SCREEN, not only from inside a case. Establishing
            a first-party relationship is the remediation for several case types
            and is also done on its own after a rep speaks to somebody, so
            burying it one level down would make the common path the long one.
          */}
          <button
            type="button"
            name="establish_relationship_open"
            onClick={() => setEstablishOpen(true)}
            className="lf-btn-secondary px-4 py-2"
          >
            Establish Relationship
          </button>
          <button
            type="button"
            name="bulk_resolve"
            onClick={() => setBulkOpen(true)}
            className="lf-btn-secondary px-4 py-2"
          >
            Bulk resolve
          </button>
          <button type="button" name="case_report" className="lf-btn-secondary px-4 py-2">
            Case report
          </button>
          <button type="button" name="open_next_case" className="lf-btn-primary px-4 py-2">
            Open Next Case
          </button>
        </div>
      </div>

      {/* ------------------------------------------- the eight case tiles */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(data?.case_types ?? []).map((type) => (
          <button
            key={type.key}
            type="button"
            name={`tile_${type.key}`}
            onClick={() => setFamily(type.family)}
            className="lf-card p-4 text-left"
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-sm font-semibold text-text">{type.label}</h2>
              <span className="text-lg font-bold text-text">{count(type.count)}</span>
            </div>
            <p className="mt-1 text-xs text-muted">{type.description}</p>
          </button>
        ))}
      </div>

      {/* ------------------------------------------------ unified queue */}
      <h2 className="mt-8 text-lg font-semibold text-text">Unified Case Queue</h2>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {RISK_SEGMENTS.map((segment) => (
          <button
            key={segment.key}
            type="button"
            name={`risk_${segment.key}`}
            onClick={() => setRisk(segment.key)}
            className={`lf-pill px-3 py-1.5 ${
              risk === segment.key ? 'border-blue bg-blue/10 text-blue' : 'border-line2 text-muted'
            }`}
          >
            {segment.label}
            {segment.key !== 'all' && data?.risk_counts?.[segment.key] !== undefined && (
              <span className="ml-2">{data.risk_counts[segment.key]}</span>
            )}
          </button>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {FAMILY_SEGMENTS.map((segment) => (
          <button
            key={segment.key}
            type="button"
            name={`family_${segment.key}`}
            onClick={() => setFamily(segment.key)}
            className={`lf-pill px-3 py-1.5 ${
              family === segment.key ? 'border-blue bg-blue/10 text-blue' : 'border-line2 text-muted'
            }`}
          >
            {segment.label}
            {segment.key !== 'all' && data?.family_counts?.[segment.key] !== undefined && (
              <span className="ml-2">{data.family_counts[segment.key]}</span>
            )}
          </button>
        ))}
      </div>

      {ownerGap && <p className="mt-3 text-sm text-muted">{ownerGap.reason}</p>}

      {loading && <p className="mt-4 text-sm text-muted">Loading the case queue...</p>}

      {data && !loading && data.cases.length === 0 && (
        <p className="mt-4 text-sm text-muted">
          {data.upstream_available.register
            ? 'No cases match these filters.'
            : 'The case register could not be read, so this is not an empty queue.'}
        </p>
      )}

      {data && data.cases.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="py-2">Risk</th>
                <th>Case</th>
                <th>Type</th>
                <th>Entity</th>
                <th>Issue</th>
                <th>Evidence</th>
                <th>Owner</th>
                <th>SLA remaining</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.cases.map((row) => (
                <tr key={row.case_id ?? `${row.case_type}-${row.entity}`} className="border-t border-line2">
                  <td className="py-2 capitalize">{row.risk}</td>
                  <td className="font-semibold text-text">{row.case_id ?? '--'}</td>
                  <td>{row.case_type_label}</td>
                  <td>{row.entity ?? '--'}</td>
                  <td>{row.issue ?? '--'}</td>
                  <td className="text-muted">{row.evidence_summary ?? '--'}</td>
                  <td>
                    {/* The role always; the person when policy could name one. */}
                    <span className="block text-text">{row.owner ?? '--'}</span>
                    <span className="block text-xs text-muted">{row.owner_role ?? ''}</span>
                  </td>
                  <td className={SLA_TONE[row.sla_band]}>
                    <span className="block font-mono">{remaining(row.sla_minutes_remaining)}</span>
                    <span className="block text-xs">{SLA_LABEL[row.sla_band]}</span>
                  </td>
                  <td>{row.status}</td>
                  <td>
                    <button type="button" name="open_case" className="lf-btn-secondary px-3 py-1.5 text-xs">
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------------------------ quarantine note */}
      <p className="mt-6 text-xs text-soft">
        A quarantined record is held out of every downstream activation - no campaign, no export,
        no routing - until its case is resolved. Quarantine is a state of the record, not a filter
        on this screen, so it cannot be worked around by changing the view.
      </p>

      <EstablishRelationshipModal
        open={establishOpen}
        contactLabel={null}
        onClose={() => setEstablishOpen(false)}
      />

      <BulkResolveModal open={bulkOpen} onClose={() => setBulkOpen(false)} />
    </div>
  );
}

/**
 * Bulk resolution, gated on an explicit blast-radius confirmation.
 *
 * ONLY HOMOGENEOUS LOW-RISK CASES. The restriction is the safety property: a
 * bulk action over a mixed set applies one decision to cases that differ in
 * exactly the way that made them cases. The blast radius must therefore be
 * confirmed as a COUNT the operator reads, not as a checkbox they tick.
 */
function BulkResolveModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Bulk resolve"
      subtitle="Available only for homogeneous low-risk cases, and only after the blast radius is confirmed."
      size="sm"
      dismissable={false}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" name="cancel_bulk" onClick={onClose} className="lf-btn-secondary px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            name="confirm_bulk"
            disabled={!confirmed}
            onClick={onClose}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Resolve selected cases
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          A bulk action over a mixed set applies one decision to cases that differ in exactly the
          way that made them cases, so the selection must be one case type at one risk band.
        </p>

        <div className="rounded-lg border border-gold/40 bg-gold/10 p-3">
          <p className="text-xs font-semibold text-gold">Blast radius</p>
          <p className="mt-1 text-sm text-text">
            No cases are selected, so nothing would be resolved.
          </p>
        </div>

        <button
          type="button"
          name="acknowledge_blast_radius"
          onClick={() => setConfirmed((current) => !current)}
          aria-pressed={confirmed}
          className={`w-full rounded-lg border px-3 py-3 text-left text-sm ${
            confirmed ? 'border-blue/60 bg-panel3 text-text' : 'border-line bg-panel2 text-muted'
          }`}
        >
          I have read the blast radius above and accept it.
        </button>
      </div>
    </Modal>
  );
}
