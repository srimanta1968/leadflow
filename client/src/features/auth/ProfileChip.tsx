/**
 * The identity lock-up from the mockup: avatar initials, name, and a secondary
 * line reading `Owner · LUP-1001`.
 *
 * Appears in two places with the same shape and different density — the topbar
 * chip and the sidebar's bottom identity block — so it takes a `variant` rather
 * than existing twice. The mockup shows the same three elements in both, and
 * two components would let them drift apart.
 */

/** Everything the chip renders, already resolved by the caller. */
export interface ProfileIdentity {
  /** Display name. Falls back to the email local-part when a person has none. */
  name: string;
  /** Role label shown before the separator. */
  role: string;
  /** Account reference shown after it, e.g. `LUP-1001`. */
  accountRef: string;
}

/**
 * Up to two initials for the avatar.
 *
 * Takes the FIRST and LAST word rather than the first two, so "Ada King
 * Lovelace" reads AL, matching how a person would abbreviate their own name.
 * Falls back to the first two characters of a single word, and to a neutral
 * glyph when there is nothing usable — an empty avatar circle looks like a
 * failed image, which invites a bug report about a thing that is working.
 *
 * @param name Display name, possibly empty.
 */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return '·';
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

/**
 * The secondary line, exactly as the mockup writes it.
 *
 * A MIDDLE DOT (U+00B7) with a space either side, not a hyphen and not a pipe.
 * It is the one piece of this component that the acceptance criterion pins to
 * the mockup character-for-character, so it is built in one place and asserted
 * rather than retyped at each call site.
 */
export function secondaryLine(role: string, accountRef: string): string {
  return `${role} · ${accountRef}`;
}

interface ProfileChipProps {
  identity: ProfileIdentity;
  /** `topbar` is the compact chip; `sidebar` is the bottom identity block. */
  variant?: 'topbar' | 'sidebar';
}

export function ProfileChip({ identity, variant = 'topbar' }: ProfileChipProps) {
  const initials = initialsFor(identity.name);
  const secondary = secondaryLine(identity.role, identity.accountRef);

  return (
    <div
      className={
        variant === 'topbar'
          ? 'flex items-center gap-3 rounded-xl border border-line bg-panel2 px-3 py-2'
          : 'flex items-center gap-3 border-t border-line px-4 py-4'
      }
    >
      {/*
        aria-hidden: the initials are a visual shorthand for the name printed
        immediately beside them. Announcing "A L, Ada Lovelace" reads the same
        person twice.
      */}
      <span
        aria-hidden="true"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-panel3 text-xs font-bold text-text"
      >
        {initials}
      </span>
      <span className="min-w-0">
        {/* truncate, not wrap: a long name must not push the chip into the
            topbar's other controls. */}
        <span className="block truncate text-sm font-semibold text-text">{identity.name}</span>
        <span className="block truncate text-xs text-soft">{secondary}</span>
      </span>
    </div>
  );
}
