/**
 * Matching and ranking for the command palette.
 *
 * Pure functions, no React and no I/O, because this is the part that has to be
 * both correct and fast and neither is observable through the component. The
 * palette's promise is that the thing you meant is the thing already selected
 * when you press Enter — ranking IS the feature, not a detail of it.
 */

export interface Rankable {
  id: string;
  title: string;
  /** Extra words that should match without being shown, e.g. synonyms. */
  keywords?: string[];
  /** The group heading this result appears under. */
  group: string;
}

export interface UsageStats {
  /** Times the command has been run, ever. */
  count: number;
  /** When it was last run, epoch ms. */
  lastUsedAt: number;
}

export interface Ranked<T> {
  item: T;
  score: number;
  /** Index pairs of the matched characters in `title`, for highlighting. */
  hits: number[];
}

/**
 * Subsequence fuzzy match, scored by HOW the match happened rather than merely
 * whether it did.
 *
 * The scoring exists because a plain subsequence test ranks "Capture Consent"
 * and "Contacts" identically for "cc", and the operator meant one of them. Three
 * signals, in the order they matter:
 *
 *   - a run of consecutive characters beats scattered ones ("cap" in "Capture"
 *     over c…a…p spread across "Campaign Enrollment");
 *   - a match at a word boundary beats one mid-word, which is what makes
 *     initials work: "qc" finds "Quick Capture";
 *   - an earlier match beats a later one, so the prefix you typed wins.
 *
 * Returns null rather than 0 for "no match", so a caller cannot accidentally
 * treat an unmatched item as a weak one.
 */
export function fuzzyScore(query: string, text: string): { score: number; hits: number[] } | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const t = text.toLowerCase();

  let score = 0;
  let ti = 0;
  let runLength = 0;
  const hits: number[] = [];

  for (const ch of q) {
    let found = -1;
    for (let i = ti; i < t.length; i += 1) {
      if (t[i] === ch) { found = i; break; }
    }
    if (found === -1) return null;

    const isBoundary = found === 0 || /[\s\-_/·]/.test(t[found - 1]);
    const isConsecutive = found === ti && hits.length > 0;

    runLength = isConsecutive ? runLength + 1 : 0;
    score += 1;
    if (isConsecutive) score += 2 + runLength;   // runs compound
    if (isBoundary) score += 3;                  // initials and word starts
    score -= Math.min(found - ti, 6) * 0.15;     // distance penalty, bounded

    hits.push(found);
    ti = found + 1;
  }

  // A short title matching the same query is the more specific answer.
  score += Math.max(0, 12 - text.length) * 0.1;
  return { score, hits };
}

/** Half-life of the recency boost. A week-old command is worth half a fresh one. */
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Recency and frequency, folded into one boost.
 *
 * Frequency is damped with a log: without it a command run 200 times would
 * outrank everything forever, and the palette would stop being a search box and
 * become a list of what you did last month. Recency decays on a half-life so
 * yesterday's work surfaces without pinning itself there.
 */
export function usageBoost(stats: UsageStats | undefined, now: number): number {
  if (!stats || stats.count <= 0) return 0;
  const frequency = Math.log2(stats.count + 1) * 1.5;
  const age = Math.max(0, now - stats.lastUsedAt);
  const recency = 4 * 2 ** (-age / RECENCY_HALF_LIFE_MS);
  return frequency + recency;
}

/**
 * Rank a set of candidates for a query.
 *
 * An EMPTY QUERY is not an empty result: the palette opens showing what you
 * actually use, ordered by the same boost. An empty palette on ⌘K would make the
 * first keystroke mandatory and the feature slower than the sidebar it replaces.
 */
export function rankCommands<T extends Rankable>(
  query: string,
  candidates: T[],
  usage: Record<string, UsageStats>,
  now: number = Date.now(),
): Ranked<T>[] {
  const q = query.trim();

  if (!q) {
    // EVERYTHING, with what you use most at the top — not only what you use.
    //
    // Filtering to score > 0 was the obvious reading of "show recent and frequent"
    // and it was wrong: a browser with no history has no usage, so the palette
    // opened EMPTY for every first-time user and stayed empty until they guessed
    // a word. The browser test caught it. Ordering by boost gives a seasoned user
    // their favourites without hiding the product from everyone else.
    return candidates
      .map((item) => ({ item, score: usageBoost(usage[item.id], now), hits: [] }))
      .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  }

  const out: Ranked<T>[] = [];
  for (const item of candidates) {
    const onTitle = fuzzyScore(q, item.title);
    // Keywords match but score lower and never highlight: they are how you FIND
    // a command by a word that is not in its name, not a second name for it.
    const onKeyword = onTitle
      ? null
      : (item.keywords ?? [])
          .map((k) => fuzzyScore(q, k))
          .filter((r): r is { score: number; hits: number[] } => r !== null)
          .sort((a, b) => b.score - a.score)[0] ?? null;

    const base = onTitle ?? (onKeyword ? { score: onKeyword.score * 0.6, hits: [] } : null);
    if (!base) continue;

    out.push({
      item,
      score: base.score + usageBoost(usage[item.id], now),
      hits: base.hits,
    });
  }

  // Ties break on title so the order cannot shuffle between identical queries —
  // a list that reorders under your fingers is worse than one that ranks poorly.
  return out.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
}

/** Group ranked results in the given group order, preserving rank within each. */
export function groupRanked<T extends Rankable>(
  ranked: Ranked<T>[],
  order: string[],
): { group: string; results: Ranked<T>[] }[] {
  return order
    .map((group) => ({ group, results: ranked.filter((r) => r.item.group === group) }))
    .filter((g) => g.results.length > 0);
}
