/**
 * Presentation helpers for values the server hands over raw.
 *
 * Both of these exist because a screen was shipping the STORAGE form of a value
 * to an operator: a 36-character owner id in a column headed "Owner", and a
 * full ISO instant in a column headed "Last message". Neither is wrong data —
 * both are unreadable, and the second silently breaks the column width for
 * every row.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Label an owner, without inventing a name.
 *
 * WHEN THE SERVER SENDS AN ID, SAY SO. The temptation is to render the id and
 * let somebody work it out, which is what produced
 * "a3d528d3-df57-4def-8475-2a73a9552fbd" under a column headed Owner. But the
 * opposite temptation is worse: fabricating a display name from an id would
 * make an unresolved reference look like a resolved one, and an operator would
 * never know the join was missing.
 *
 * So an id is labelled AS an id, shortened enough to stay quotable. The real
 * fix is server-side — resolving the owner to a person — and this makes the
 * absence of that join visible rather than ugly.
 */
export function ownerLabel(value: string | null | undefined): string {
  if (!value || value.trim() === '') return 'Unassigned';
  if (UUID.test(value.trim())) return `Unresolved (${value.trim().slice(0, 8)})`;
  return value;
}

/**
 * A timestamp a person can read at a glance.
 *
 * Relative inside a day because that is the only question asked of a queue —
 * "how long has this been sitting" — and absolute beyond it, because "9 days
 * ago" stops being useful once you need to say which day. An unparseable value
 * is returned untouched rather than swallowed: showing the raw string is how
 * somebody notices the format changed.
 */
export function formatWhen(value: string | null | undefined): string {
  if (!value) return '--';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;

  const minutes = Math.round((Date.now() - at.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d ago`;

  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
