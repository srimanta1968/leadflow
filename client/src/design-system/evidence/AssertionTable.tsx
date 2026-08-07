import { DataTable, type Column } from '../data/DataTable';
import { originChipClass, toneClass } from '../tokens';
import {
  ASSERTION_COLUMNS,
  isSuperseded,
  type Assertion,
  type AssertionStatus,
} from './assertions';

/**
 * The Data & Provenance tab's assertion table.
 *
 * Built on <DataTable> rather than beside it — an evidence table is still a
 * table, and the guard in dataPrimitives.test.ts exists to stop this file being
 * the fifth hand-rolled one.
 */

const STATUS_ROLE: Record<AssertionStatus, Parameters<typeof toneClass>[0]> = {
  Primary: 'success',
  Survives: 'info',
  Assertion: 'identity',
  // Not `blocked`: a superseded assertion is not an error, it lost a comparison.
  // Red would tell an operator something went wrong when the system worked.
  Superseded: 'warning',
};

/** Confidence, or an honest blank. */
function Confidence({ value }: { value: number | null }) {
  // Null is not zero. A source that does not score itself has NO confidence
  // figure; rendering 0% would assert the opposite of what is known.
  if (value === null) return <span className="text-soft" title="This source does not score itself">—</span>;
  const role = value >= 0.8 ? 'success' : value >= 0.5 ? 'warning' : 'blocked';
  return <span className={`tabular-nums ${toneClass(role)}`}>{Math.round(value * 100)}%</span>;
}

export interface AssertionTableProps {
  rows: Assertion[];
  /** Opens the evidence behind a row. Reveal is audited by the caller. */
  onOpenEvidence?: (assertion: Assertion) => void;
  loading?: boolean;
}

export function AssertionTable({ rows, onOpenEvidence, loading }: AssertionTableProps) {
  const columns: Column<Assertion>[] = [
    {
      key: 'assertion',
      header: ASSERTION_COLUMNS[0],
      sortValue: (r) => r.assertion,
      cell: (r) => <span className="font-semibold text-text">{r.assertion}</span>,
    },
    {
      key: 'value',
      header: ASSERTION_COLUMNS[1],
      sortValue: (r) => r.value,
      cell: (r) =>
        r.sensitive ? (
          // Masked until an audited reveal. The masked form is what the table
          // holds; the real value is fetched at reveal time so that not calling
          // the audited path means not seeing it.
          <span className="font-mono text-soft" title="Hidden until revealed">••••••</span>
        ) : (
          <span className="font-mono">{r.value}</span>
        ),
    },
    {
      key: 'source',
      header: ASSERTION_COLUMNS[2],
      sortValue: (r) => r.source,
      cell: (r) => (
        <span>
          {r.source}
          {r.crosswalkRef && <span className="ml-2 font-mono text-[11px] text-soft">{r.crosswalkRef}</span>}
        </span>
      ),
    },
    {
      key: 'origin',
      header: ASSERTION_COLUMNS[3],
      sortValue: (r) => r.originClass,
      cell: (r) => <span className={`lf-pill ${originChipClass(r.originClass)}`}>{r.originClass}</span>,
    },
    {
      key: 'confidence',
      header: ASSERTION_COLUMNS[4],
      align: 'right',
      // Nulls sort last via DataTable's rule, which is right here too: "unscored"
      // is not "least confident".
      sortValue: (r) => r.confidence,
      cell: (r) => <Confidence value={r.confidence} />,
    },
    {
      key: 'effective',
      header: ASSERTION_COLUMNS[5],
      sortValue: (r) => (r.effectiveAt ? Date.parse(r.effectiveAt) : null),
      cell: (r) => <span className="text-soft">{r.effectiveAt?.slice(0, 10) ?? '—'}</span>,
    },
    {
      key: 'retrieved',
      header: ASSERTION_COLUMNS[6],
      sortValue: (r) => (r.retrievedAt ? Date.parse(r.retrievedAt) : null),
      cell: (r) => <span className="text-soft">{r.retrievedAt?.slice(0, 10) ?? '—'}</span>,
    },
    {
      key: 'status',
      header: ASSERTION_COLUMNS[7],
      sortValue: (r) => r.status,
      cell: (r) => (
        <div className="flex flex-col gap-0.5">
          <span className={`lf-pill self-start ${toneClass(STATUS_ROLE[r.status])}`}>{r.status}</span>
          {/*
            THE ACCEPTANCE CONDITION, rendered. The type guarantees the reason
            exists on a superseded row; this is where it becomes visible. A bare
            "Superseded" tells an operator their data was overruled without
            saying by what or on what grounds.
          */}
          {isSuperseded(r) && (
            <span className="text-[11px] leading-snug text-soft">
              {r.supersededReason}
              {r.supersededBy && <> · superseded by <span className="font-mono">{r.supersededBy}</span></>}
            </span>
          )}
        </div>
      ),
    },
  ];

  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.id}
      loading={loading}
      caption="Assertions behind this record, with the source and survivorship status of each"
      empty="No assertions recorded for this record yet."
      rowHeight={56}
      height={420}
      rowActions={
        onOpenEvidence
          ? (r) =>
              r.evidenceRef ? (
                <button
                  type="button"
                  onClick={() => onOpenEvidence(r)}
                  className="lf-btn-secondary px-2.5 py-1 text-[11px]"
                >
                  Evidence
                </button>
              ) : null
          : undefined
      }
    />
  );
}
