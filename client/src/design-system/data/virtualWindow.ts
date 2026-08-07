/**
 * The windowing arithmetic behind <DataTable>.
 *
 * Pure, because this is the part that has to be right at 100k rows and is
 * invisible through the component: a windowing bug shows up as a blank strip
 * while scrolling, or a row that renders twice, and neither is something a
 * snapshot test catches.
 */

export interface WindowInput {
  /** Total rows in the dataset, not in the DOM. */
  total: number;
  /** Fixed row height in px. Uniform heights are what make this O(1). */
  rowHeight: number;
  /** Height of the scrolling viewport in px. */
  viewportHeight: number;
  /** Current scrollTop in px. */
  scrollTop: number;
  /**
   * Rows rendered beyond each edge. Not a performance knob so much as a
   * correctness one: with 0, a fast flick paints blank because scroll events
   * arrive after the pixels. 6 covers a normal wheel tick at 36px rows.
   */
  overscan?: number;
}

export interface WindowResult {
  /** First row index to render, inclusive. */
  startIndex: number;
  /** Last row index to render, EXCLUSIVE, so it slices directly. */
  endIndex: number;
  /** Spacer height above the rendered rows. */
  paddingTop: number;
  /** Spacer height below them. */
  paddingBottom: number;
  /** Full scrollable height, so the bar reflects the dataset not the DOM. */
  totalHeight: number;
}

/**
 * Which slice of rows to render for the current scroll position.
 *
 * TWO SPACERS RATHER THAN ABSOLUTE POSITIONING. A padded top and bottom keep the
 * rows in normal flow, so a <tbody> stays a valid table body and the browser's
 * own column sizing still works. Absolutely positioned rows need every column
 * width pinned in JS, which is how virtualized tables end up unable to autosize.
 */
export function computeWindow(input: WindowInput): WindowResult {
  const { total, rowHeight, viewportHeight } = input;
  const overscan = input.overscan ?? 6;

  // Degenerate inputs are answered rather than divided by. A viewport of 0 is
  // normal for one frame — before layout, and whenever the tab is hidden.
  if (total <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0, totalHeight: 0 };
  }

  const totalHeight = total * rowHeight;
  // Clamped: momentum scrolling and rubber-banding both produce a scrollTop
  // outside the range, and an unclamped start index reads past the array.
  const scrollTop = Math.max(0, Math.min(input.scrollTop, Math.max(0, totalHeight - viewportHeight)));

  const firstVisible = Math.floor(scrollTop / rowHeight);
  const visibleCount = Math.ceil(viewportHeight / rowHeight);

  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(total, firstVisible + visibleCount + overscan);

  return {
    startIndex,
    endIndex,
    paddingTop: startIndex * rowHeight,
    paddingBottom: Math.max(0, (total - endIndex) * rowHeight),
    totalHeight,
  };
}

/**
 * Sort a column without mutating the caller's array.
 *
 * Nulls sort LAST in both directions rather than as the smallest or largest
 * value. "No response time recorded" is not the fastest response, and a table
 * that says otherwise is worse than one that refuses to sort — the same rule the
 * analytics view already applies, kept identical here so the two cannot disagree.
 */
export function sortRows<T>(
  rows: T[],
  get: (row: T) => string | number | null | undefined,
  direction: 'asc' | 'desc',
): T[] {
  const dir = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    const aNull = av === null || av === undefined || av === '';
    const bNull = bv === null || bv === undefined || bv === '';
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}
