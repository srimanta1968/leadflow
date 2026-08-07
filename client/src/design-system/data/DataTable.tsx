import { useMemo, useRef, useState, type ReactNode } from 'react';
import { computeWindow, sortRows } from './virtualWindow';

/**
 * The application's one table.
 *
 * Every list screen had grown its own <table> with its own sticky-header trick
 * and its own empty state, so "no rows" said something different on each. This is
 * the component the guard in tests/unit/designSystemGuard.test.ts points at.
 *
 * VIRTUALIZED BY DEFAULT, not as an option. A table that is fast only when
 * somebody remembers to switch it on is slow in exactly the place nobody tested —
 * the tenant with 100k rows. Rows are fixed height for the same reason: uniform
 * heights make the window O(1), and measured heights are what turn a large table
 * into a scroll-jank generator.
 */

export interface Column<T> {
  key: string;
  header: string;
  /** What to render. Kept separate from the sort value on purpose. */
  cell: (row: T) => ReactNode;
  /**
   * The comparable value. A cell renders "3 hr" and sorts on 180 — sorting the
   * rendered string puts "3 hr" after "12 min", which is the classic table bug.
   */
  sortValue?: (row: T) => string | number | null;
  width?: string;
  align?: 'left' | 'right';
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Hover actions, the mockup's .tdactions. */
  rowActions?: (row: T) => ReactNode;
  loading?: boolean;
  /** Shown when there are genuinely no rows — never when a read failed. */
  empty?: ReactNode;
  rowHeight?: number;
  /** Viewport height in px. */
  height?: number;
  caption?: string;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  rowActions,
  loading,
  empty,
  rowHeight = 44,
  height = 520,
  caption,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return rows;
    return sortRows(rows, column.sortValue, sort.direction);
  }, [rows, columns, sort]);

  const win = computeWindow({
    total: sorted.length,
    rowHeight,
    viewportHeight: height,
    scrollTop,
  });

  const visible = sorted.slice(win.startIndex, win.endIndex);

  function toggleSort(key: string): void {
    setSort((s) =>
      s?.key === key
        ? { key, direction: s.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
    // Back to the top: leaving the scroll position after a re-sort shows row
    // 4,000 of a list the operator has just reordered, which reads as a bug.
    viewport.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }

  if (loading) {
    return (
      <div className="lf-panel overflow-hidden p-0">
        <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading rows">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-8 animate-pulse rounded-lg bg-panel2" />
          ))}
        </div>
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="lf-panel p-0">
        <p className="px-4 py-10 text-center text-sm text-soft">
          {empty ?? 'Nothing to show.'}
        </p>
      </div>
    );
  }

  return (
    <div className="lf-panel overflow-hidden p-0">
      <div
        ref={viewport}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        style={{ height }}
        className="overflow-auto"
      >
        <table className="w-full border-collapse text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="sticky top-0 z-10 bg-panel">
            <tr className="border-b border-line">
              {columns.map((column) => {
                const active = sort?.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    style={{ width: column.width }}
                    className={`px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-soft ${
                      column.align === 'right' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                        className="inline-flex items-center gap-1 hover:text-muted"
                      >
                        {column.header}
                        <span aria-hidden="true">{active ? (sort.direction === 'asc' ? '↑' : '↓') : ''}</span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
              {rowActions && <th scope="col" className="w-10" />}
            </tr>
          </thead>

          <tbody>
            {/* Spacers keep the rows in normal flow, so the browser still sizes
                the columns. Absolute positioning would need every width pinned
                in JS, which is how a virtual table loses autosizing. */}
            {win.paddingTop > 0 && <tr aria-hidden="true"><td style={{ height: win.paddingTop }} colSpan={columns.length + 1} /></tr>}

            {visible.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={{ height: rowHeight }}
                className={`group border-b border-line/60 ${
                  onRowClick ? 'cursor-pointer hover:bg-panel2' : ''
                }`}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`px-4 text-muted ${column.align === 'right' ? 'text-right tabular-nums' : ''}`}
                  >
                    {column.cell(row)}
                  </td>
                ))}
                {rowActions && (
                  // Revealed on hover AND on focus-within, or the actions are
                  // unreachable by keyboard — the usual cost of a hover affordance.
                  <td className="px-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    {rowActions(row)}
                  </td>
                )}
              </tr>
            ))}

            {win.paddingBottom > 0 && <tr aria-hidden="true"><td style={{ height: win.paddingBottom }} colSpan={columns.length + 1} /></tr>}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-soft">
        <span>
          {sorted.length.toLocaleString()} {sorted.length === 1 ? 'row' : 'rows'}
        </span>
        <span className="tabular-nums">
          showing {win.startIndex + 1}–{win.endIndex}
        </span>
      </div>
    </div>
  );
}
