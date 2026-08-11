import { useEffect, useState } from 'react';
import { Drawer } from '../../design-system/overlays/Drawer';
import { api, ApiError } from '../../services/api';
import { useToast } from '../feedback/ToastProvider';

/**
 * The Data Credits drawer (#creditsDrawer).
 *
 * EVERY LABEL BELOW IS THE MOCKUP'S OWN. "Request only - manager approval
 * required" is a statement about who may spend the organization's money, and an
 * operator comparing this screen against the policy they agreed needs the same
 * words in both places. Paraphrasing here would make the two disagree while
 * both looked right.
 *
 * FIGURES DEGRADE INDIVIDUALLY AND SAY SO. An unreachable credit account shows
 * a dash and the reason, never a zero: "0 credits" and "we could not ask" are
 * different facts, and a finance user reconciling against a zero that meant
 * "unknown" is the specific harm this avoids.
 */

interface BudgetControl {
  label: string;
  detail: string;
  allowance: string;
  mode: string;
}

interface LedgerRow {
  request_id: string | null;
  capability_key: string | null;
  reserved: number;
  charged: number;
  refunded: number;
  outcome: string | null;
  served_from_cache: boolean;
}

interface CreditsSummary {
  organization_balance: { balance: number | null; reserved: number | null; available: boolean };
  current_cycle: { used: number; saved_through_cache: number; available: boolean };
  capability_usage: { capability: string; credits: number }[];
  budget_controls: BudgetControl[];
  ledger_export: LedgerRow[];
  ledger_available: boolean;
  export_complete: boolean;
  operator_only_notice: string;
}

/** Capability keys read as the outcomes the mockup names, never as vendor terms. */
const CAPABILITY_LABELS: Record<string, string> = {
  validate_phone: 'Phone validation',
  validate_email: 'Email validation',
  find_contact_points: 'Contact append',
  find_possible_profiles: 'Profile candidates',
};

const number = (value: number | null | undefined): string =>
  typeof value === 'number' ? value.toLocaleString() : '--';

export interface DataCreditsDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function DataCreditsDrawer({ open, onClose }: DataCreditsDrawerProps) {
  const [summary, setSummary] = useState<CreditsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const { notify } = useToast();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    api
      .creditsSummary()
      .then((body) => {
        if (!cancelled) setSummary(body);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        notify({
          tone: 'error',
          title: 'The credits summary could not be loaded.',
          detail: error instanceof ApiError ? error.message : undefined,
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, notify]);

  /**
   * EXPORT IS A CLIENT-SIDE CSV OF WHAT THE DRAWER ALREADY HOLDS, so it cannot
   * disagree with the figures on screen. It carries reservation, actual charge
   * and refund per request, which is what a disputed invoice argues about.
   */
  const exportLedger = (): void => {
    if (!summary) return;
    const header = 'request_id,capability,reserved,charged,refunded,outcome,served_from_cache';
    const lines = summary.ledger_export.map((row) =>
      [
        row.request_id ?? '',
        row.capability_key ?? '',
        row.reserved,
        row.charged,
        row.refunded,
        row.outcome ?? '',
        row.served_from_cache,
      ].join(','),
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'data-credits-ledger.csv';
    link.click();
    URL.revokeObjectURL(url);
    if (!summary.export_complete) {
      // SAID OUT LOUD. An export taken while an upstream was unreachable is a
      // PARTIAL export, and somebody reconciling against it must know before
      // they treat it as the whole picture.
      notify({
        tone: 'warning',
        title: 'This export is incomplete.',
        detail: 'The credit ledger could not be read in full, so these rows are not the whole cycle.',
      });
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Data Credits"
      footer={
        <div className="flex justify-end gap-3">
          <button type="button" name="export_ledger" className="lf-btn" onClick={exportLedger}>
            Export Ledger
          </button>
          <button type="button" name="manage_budgets" className="lf-btn-primary" onClick={onClose}>
            Manage Budgets
          </button>
        </div>
      }
    >
      {loading && <p className="text-sm text-muted">Loading credit position...</p>}

      {summary && (
        <div className="space-y-6">
          <section>
            <h3 className="text-sm font-semibold text-text">Organization Balance</h3>
            <p className="mt-1 text-2xl font-bold text-text">
              {number(summary.organization_balance.balance)}
            </p>
            <p className="text-sm text-muted">
              {number(summary.organization_balance.reserved)} reserved
            </p>
            {!summary.organization_balance.available && (
              <p className="mt-1 text-sm text-muted">
                The credit account could not be read, so this is not a zero balance.
              </p>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-text">Current Cycle</h3>
            <p className="mt-1 text-sm text-text">{number(summary.current_cycle.used)} used</p>
            <p className="text-sm text-muted">
              {number(summary.current_cycle.saved_through_cache)} saved through cache
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-text">Capability Usage</h3>
            {summary.capability_usage.length === 0 ? (
              <p className="mt-1 text-sm text-muted">No capability has been charged this cycle.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {summary.capability_usage.map((row) => (
                  <li key={row.capability} className="flex justify-between text-sm">
                    <span className="text-text">
                      {CAPABILITY_LABELS[row.capability] ?? row.capability}
                    </span>
                    <span className="text-muted">{number(row.credits)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-text">Budget Controls</h3>
            <ul className="mt-2 space-y-2">
              {summary.budget_controls.map((tier) => (
                <li key={tier.label} className="flex items-start justify-between gap-4 text-sm">
                  <span>
                    <span className="block font-medium text-text">{tier.label}</span>
                    <span className="block text-muted">{tier.detail}</span>
                  </span>
                  <span className="whitespace-nowrap text-muted">{tier.allowance}</span>
                </li>
              ))}
            </ul>
          </section>

          <p className="rounded-md bg-surface-2 p-3 text-sm text-muted">
            {summary.operator_only_notice}
          </p>
        </div>
      )}
    </Drawer>
  );
}
