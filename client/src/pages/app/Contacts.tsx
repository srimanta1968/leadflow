import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  api,
  ApiError,
  type ContactFacets,
  type ContactList,
  type ContactRow,
} from '../../services/api';
import { DataTable, type Column } from '../../design-system/data/DataTable';
import { Modal } from '../../design-system/overlays/Modal';
import { originChipClass } from '../../design-system/tokens';
import { useToast } from '../../components/feedback/ToastProvider';
import { SavedViewsPanel } from '../../features/contacts/SavedViewsPanel';

/**
 * Contacts (#view-contacts) — canonical people and organizations.
 *
 * EXPORT ELIGIBLE RE-EVALUATES AT EXPORT TIME. This is the acceptance condition
 * and the reason the button demands a purpose before it will do anything. A
 * cached "eligible" flag is a statement about a moment that has passed: a person
 * who revoked an hour ago is still flagged eligible, and an export is precisely
 * the operation that turns that stale flag into thousands of contacts nobody was
 * permitted to make. The purpose is required rather than defaulted because
 * eligibility is not a property of a person at all — it is a property of a
 * (person, purpose, channel) triple, and a default would silently pick one.
 *
 * THE EXPORT IS AUDITED and reports what it EXCLUDED. An export that quietly
 * drops the ineligible rows and reports a count is indistinguishable from one
 * that found fewer people, so the result names each exclusion reason with its
 * count.
 *
 * ALL FIVE FACETS LIVE IN THE URL. A filtered queue is something operators send
 * each other; holding the facets in component state makes that link a lie, since
 * it reopens on the unfiltered list.
 */

const FRAMING =
  'A person is not one wide row. Each handle, relationship and assertion is its own record with its own source, validity and eligibility.';

/**
 * The five facets, their URL keys, and where their options come from.
 *
 * `label` NAMES THE FIELD and `allLabel` is the unset option. They were briefly
 * the same string, which is the obvious shape and wrong twice: a label that
 * repeats its own empty-state option tells the operator nothing the option did
 * not, and rendering one string in both places puts the same text on screen
 * twice, so anything selecting by that text matches two elements.
 */
const FACETS = [
  { key: 'entity_type', label: 'Entity type', allLabel: 'All entity types', options: 'entity_types' },
  { key: 'trust_state', label: 'Trust state', allLabel: 'All trust states', options: 'trust_states' },
  { key: 'origin', label: 'Origin', allLabel: 'All origins', options: 'origins' },
  { key: 'channel_state', label: 'Channel state', allLabel: 'All channel states', options: 'channel_states' },
  { key: 'owner', label: 'Record owner', allLabel: 'All record owners', options: 'owners' },
] as const;

/**
 * The purposes an export can be evaluated against.
 *
 * A fixed list because a purpose is a governed thing: the operator picks one the
 * policy engine actually knows, and a free-text box would produce purposes that
 * evaluate against nothing and therefore permit everything.
 */
const EXPORT_PURPOSES = [
  'Service message',
  'Appointment reminder',
  'Promotional marketing',
  'Transactional receipt',
];

const shown = (value: string | null): string => (value && value.trim() !== '' ? value : '--');

export default function Contacts() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [data, setData] = useState<ContactList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  /** The facets, read FROM the URL so the URL is the single source of truth. */
  const filters = useMemo<ContactFacets>(() => {
    const next: ContactFacets = {};
    for (const facet of FACETS) {
      const value = params.get(facet.key);
      if (value) next[facet.key] = value;
    }
    const q = params.get('q');
    if (q) next.q = q;
    return next;
  }, [params]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.contacts(filters));
      setError(null);
    } catch (caught) {
      setData(null);
      setError(caught instanceof ApiError ? caught.message : 'Contacts could not be read.');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const setFacet = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all' || value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: false });
  };

  const columns: Column<ContactRow>[] = [
    {
      key: 'contact',
      header: 'Contact',
      width: '24%',
      sortValue: (r) => r.display_name,
      cell: (r) => (
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-panel3 text-[11px] text-muted"
          >
            {r.initials}
          </span>
          <div className="min-w-0">
            <p className="truncate text-text">{shown(r.display_name)}</p>
            <p className="truncate text-[11px] text-soft">{shown(r.canonical_id)}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'trust',
      header: 'Trust / Role',
      width: '14%',
      cell: (r) => (
        <div>
          <p className="text-text">{shown(r.trust_state)}</p>
          <p className="text-[11px] text-soft">{shown(r.role)}</p>
        </div>
      ),
    },
    { key: 'points', header: 'Contact points', cell: (r) => shown(r.contact_point_summary), width: '13%' },
    { key: 'properties', header: 'Properties', cell: (r) => shown(r.property_summary), width: '11%' },
    {
      key: 'origin',
      header: 'Origin',
      width: '12%',
      cell: (r) =>
        r.origin ? <span className={`lf-pill ${originChipClass(r.origin)}`}>{r.origin}</span> : '--',
    },
    {
      key: 'consent',
      header: 'Consent / Eligibility',
      width: '14%',
      cell: (r) => (
        <div>
          <p className="text-text">{shown(r.channel_state)}</p>
          {/* The verdict without its reason is the thing this product exists to
              stop shipping. */}
          <p className="text-[11px] text-soft">{shown(r.channel_reason)}</p>
        </div>
      ),
    },
    { key: 'owner', header: 'Owner', cell: (r) => shown(r.owner), width: '7%' },
    { key: 'updated', header: 'Updated', cell: (r) => shown(r.updated_at), width: '5%' },
  ];

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Contacts</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted">{FRAMING}</p>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" name="import_contacts" className="lf-btn-secondary px-4 py-2">
            Import
          </button>
          <button type="button" name="quick_contact" className="lf-btn-primary px-4 py-2">
            Quick Contact
          </button>
        </div>
      </div>

      {/* ------------------------------------------------- the five facets */}
      <div className="lf-panel mt-6 p-4">
        <div className="flex flex-wrap items-end gap-3">
          {FACETS.map((facet) => (
            <div key={facet.key}>
              {/*
                VISIBLE, not sr-only. A bare select is legible only while it sits
                at its default: once the operator picks "P4" the control reads
                "P4" and nothing on screen says which facet that is. The mockup's
                compact filter bar gets away with it because every select in the
                picture is unset.
              */}
              <label className="lf-label block" htmlFor={facet.key}>
                {facet.label}
              </label>
              <select
                id={facet.key}
                name={facet.key}
                className="lf-input"
                value={filters[facet.key] ?? 'all'}
                onChange={(event) => setFacet(facet.key, event.target.value)}
              >
                <option value="all">{facet.allLabel}</option>
                {(data?.facets[facet.options] ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          ))}

          <button type="button" name="more_filters" className="lf-btn-ghost px-3 py-1.5">
            More filters
          </button>

          <button
            type="button"
            name="export_eligible"
            onClick={() => setExportOpen(true)}
            className="lf-btn-secondary ml-auto px-3 py-1.5"
          >
            Export eligible
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <div className="lf-panel p-5">
            <DataTable
              rows={data?.contacts ?? []}
              columns={columns}
              rowKey={(r) => r.contact_id}
              loading={loading}
              density="dense"
              caption="Contacts"
              height={620}
              error={error ? <span>{error}</span> : undefined}
              empty={<span>No contacts match these filters.</span>}
              onRowClick={(row) => navigate(`/app/contacts/${row.contact_id}/overview`)}
            />
            <p className="mt-3 text-xs text-soft">
              {data ? `${data.total} contacts match these filters.` : 'Reading the register...'}
            </p>
          </div>
        </div>

        <SavedViewsPanel
          activeFilters={filters}
          onApply={(next) => {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(next)) params.set(key, value);
            setParams(params);
          }}
        />
      </div>

      <ExportEligibleModal
        open={exportOpen}
        filters={filters}
        onClose={() => setExportOpen(false)}
      />
    </div>
  );
}

/**
 * Export eligible.
 *
 * The purpose is chosen BEFORE the export runs and the result reports the
 * exclusions. Both halves are the criterion: an export with no purpose cannot
 * have been eligibility-checked, and one that reports only a total has hidden
 * the interesting half of what it did.
 */
function ExportEligibleModal({
  open,
  filters,
  onClose,
}: {
  open: boolean;
  filters: ContactFacets;
  onClose: () => void;
}) {
  const [purpose, setPurpose] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.exportContacts>> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { notify } = useToast();

  const run = async () => {
    setRunning(true);
    setFailure(null);
    try {
      const outcome = await api.exportContacts({ purpose, filters });
      setResult(outcome);
      notify({
        tone: 'success',
        title: 'Export recorded as a governed action',
        detail: `${outcome.exported} contacts were permitted for ${purpose}.`,
      });
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : 'The export could not be run.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export eligible"
      subtitle="Eligibility is evaluated now, for the purpose you choose - never read from a stored flag."
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" name="cancel_export" onClick={onClose} className="lf-btn-secondary px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            name="run_export"
            disabled={purpose === '' || running}
            onClick={() => void run()}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? 'Evaluating...' : 'Export eligible'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {failure && (
          <p className="rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{failure}</p>
        )}

        <div>
          <label className="lf-label" htmlFor="export_purpose">
            Purpose
          </label>
          <select
            id="export_purpose"
            name="export_purpose"
            className="lf-input mt-1 w-full"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
          >
            <option value="">Choose a purpose</option>
            {EXPORT_PURPOSES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-soft">
            Required. Eligibility is a property of the person, the purpose and the channel
            together, so an export with no purpose cannot be checked against anything.
          </p>
        </div>

        {result && (
          <div className="rounded-lg border border-line bg-panel2 p-3 text-sm">
            <p className="text-text">{result.exported} contacts exported for {result.purpose}.</p>
            <p className="mt-1 text-xs text-soft">Evaluated {shown(result.evaluated_at)}</p>
            <ul className="mt-2 space-y-1">
              {result.excluded.map((exclusion) => (
                <li key={exclusion.reason} className="text-xs text-muted">
                  {exclusion.count} excluded - {exclusion.reason}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-soft">
              Audit reference {shown(result.audit_ref)}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
