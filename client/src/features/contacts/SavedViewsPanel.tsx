import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ContactFacets,
  type SavedView,
  type SavedViewScope,
} from '../../services/api';
import { Modal } from '../../design-system/overlays/Modal';
import { useToast } from '../../components/feedback/ToastProvider';

/**
 * Saved Views — operational shortcuts based on source, trust and actionability.
 *
 * A VIEW STORES THE FILTER, NEVER THE RESULT SET. That is the acceptance
 * condition and it is the difference between a shortcut and a lie: a stored
 * result says "5" forever while the queue moves on, and the operator who trusts
 * it works a list that stopped being true the day it was saved. Every count on
 * this panel is computed from the stored PREDICATE at read time.
 *
 * THE COUNTS REFRESH IN ONE BATCHED CALL. Ten pinned views must not be ten
 * requests: the sidebar is rendered on every screen, so a per-view fetch turns
 * the cheapest chrome in the product into its heaviest.
 *
 * A COUNT THAT COULD NOT BE COMPUTED SHOWS AS `--`, NOT AS 0. Zero is a claim
 * that the queue is empty, and an operator who reads it as such stops working a
 * queue that may be full.
 */

/** The four shipped views, worded as the mockup words them. */
const SHIPPED_VIEW_COPY: Record<string, string> = {
  'Unresolved captures': 'Captures that arrived but have not been resolved to a person.',
  'Possible duplicates': 'Records that may describe the same person, awaiting a decision.',
  'No property relationship': 'People with no property linked, so no work can be scoped to them.',
  'Campaign eligible': 'People with a policy-approved channel for at least one campaign purpose.',
};

const SCOPES: { value: SavedViewScope; label: string }[] = [
  { value: 'private', label: 'Private' },
  { value: 'team', label: 'Team' },
  { value: 'organization', label: 'Organization' },
];

export function SavedViewsPanel({
  activeFilters,
  onApply,
}: {
  activeFilters: ContactFacets;
  onApply: (filters: Record<string, string>) => void;
}) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.savedViews();
      setViews(list.views);
      setError(null);

      // The batched refresh. Deliberately a SECOND call rather than a field on
      // the list: the definitions are stable and cacheable, the counts are not,
      // and merging them would make every view read as expensive as its count.
      try {
        setCounts((await api.savedViewCounts()).counts);
      } catch {
        // A failed count refresh must not blank the views. The counts render as
        // unknown, which is what they are.
        setCounts({});
      }
    } catch (caught) {
      setViews([]);
      setError(caught instanceof ApiError ? caught.message : 'Saved views could not be read.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <aside className="lf-panel p-5" aria-label="Saved Views">
      <div className="flex items-baseline justify-between">
        <h2 className="lf-eyebrow">Saved Views</h2>
        <button
          type="button"
          name="save_view"
          onClick={() => setSaveOpen(true)}
          className="text-xs text-blue hover:underline"
        >
          Save this view
        </button>
      </div>

      <p className="mt-1 text-xs text-soft">
        Operational shortcuts based on source, trust and actionability. Each stores its filter, so
        the count is always current.
      </p>

      {error && (
        <p className="mt-3 rounded border border-red/40 bg-red/10 px-3 py-2 text-xs text-red">
          {error}
        </p>
      )}

      {loading && (
        <p role="status" className="mt-3 text-sm text-muted">
          Reading saved views...
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {views.map((view) => {
          const count = counts[view.view_id];
          return (
            <li key={view.view_id}>
              <button
                type="button"
                onClick={() => onApply(view.filters)}
                className="w-full rounded-lg border border-line bg-panel2 p-3 text-left hover:border-blue/60"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-text">{view.name}</span>
                  {/* Never a false zero. See the module comment. */}
                  <span className="text-xs tabular-nums text-muted">
                    {count === null || count === undefined ? '--' : count}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-soft">
                  {view.description ?? SHIPPED_VIEW_COPY[view.name] ?? 'No description recorded.'}
                </p>
                <p className="mt-1 text-[11px] text-soft">
                  {view.scope} · {view.pinned ? 'Pinned to the sidebar' : 'Not pinned'}
                </p>
              </button>
            </li>
          );
        })}

        {!loading && views.length === 0 && !error && (
          <li className="text-sm text-muted">No saved views yet.</li>
        )}
      </ul>

      <SaveViewModal
        open={saveOpen}
        filters={activeFilters}
        onClose={() => setSaveOpen(false)}
        onSaved={() => {
          setSaveOpen(false);
          void load();
        }}
      />
    </aside>
  );
}

/** Saves the CURRENT filter set under a name and a sharing scope. */
function SaveViewModal({
  open,
  filters,
  onClose,
  onSaved,
}: {
  open: boolean;
  filters: ContactFacets;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<SavedViewScope>('private');
  const [pinned, setPinned] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { notify } = useToast();

  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      await api.createSavedView({
        name: name.trim(),
        description: description.trim() || undefined,
        // The FILTER is what is stored. Nothing here sends a row list.
        filters: Object.fromEntries(
          Object.entries(filters).filter(([, value]) => value !== undefined),
        ) as Record<string, string>,
        scope,
        pinned,
      });
      notify({ tone: 'success', title: 'View saved', detail: 'Its count updates as the data does.' });
      onSaved();
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : 'The view could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save this view"
      subtitle="Stores the filter definition, never the rows it currently matches."
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" name="cancel_save_view" onClick={onClose} className="lf-btn-secondary px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            name="confirm_save_view"
            disabled={name.trim() === '' || saving}
            onClick={() => void save()}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save view'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {failure && (
          <p className="rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{failure}</p>
        )}

        <div>
          <label className="lf-label" htmlFor="view_name">
            Name
          </label>
          <input
            id="view_name"
            name="view_name"
            className="lf-input mt-1 w-full"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div>
          <label className="lf-label" htmlFor="view_description">
            Description
          </label>
          <input
            id="view_description"
            name="view_description"
            className="lf-input mt-1 w-full"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div>
          <label className="lf-label" htmlFor="view_scope">
            Sharing scope
          </label>
          <select
            id="view_scope"
            name="view_scope"
            className="lf-input mt-1 w-full"
            value={scope}
            onChange={(event) => setScope(event.target.value as SavedViewScope)}
          >
            {SCOPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-soft">
            Scope is enforced by policy on the server. Sharing a view never shares access to rows
            the recipient may not already see.
          </p>
        </div>

        <button
          type="button"
          name="pin_to_sidebar"
          onClick={() => setPinned((current) => !current)}
          aria-pressed={pinned}
          className="lf-btn-secondary px-3 py-1.5"
        >
          {pinned ? 'Pinned to the sidebar' : 'Pin to the sidebar'}
        </button>
      </div>
    </Modal>
  );
}
