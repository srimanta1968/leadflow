import raw from './tokens.json';

/**
 * The design system's typed surface.
 *
 * tokens.json holds every VALUE and every MEANING; this file adds types and the
 * helpers that turn a meaning into Tailwind classes. It deliberately declares no
 * data of its own — the Tailwind config and the CSS generator are plain JS and
 * cannot read a .ts module, so anything declared here would be invisible to them
 * and the source would be split in two again.
 *
 * WHY THE MAPS ARE THE ONLY LEGAL WAY TO PICK A COLOUR. Before this, three
 * components each declared their own `Record<string, string>` of Tailwind classes
 * — ToastProvider, CaptureInbox and the marketing Home page — and they had already
 * disagreed about what gold meant. A colour that means "awaiting review" on one
 * screen and "promotional" on another is not a design system, it is decoration, and
 * an operator learns to ignore it.
 */

const strip = <T extends Record<string, unknown>>(group: T) =>
  Object.fromEntries(Object.entries(group).filter(([k]) => !k.startsWith('_')));

export const color = strip(raw.color) as Record<string, string>;
export const radius = raw.radius;
export const space = raw.space;
export const font = raw.font;

export const SEMANTIC = raw.semantic;
export const ORIGIN_CLASS_ROLE = raw.originClassRole;
export const TRUST_STATE_ROLE = raw.trustStateRole;
export const CAPTURE_SOURCE_TOKEN = raw.captureSourceToken;

export type SemanticRole = keyof typeof raw.semantic;
export type OriginClass = keyof typeof raw.originClassRole;
export type TrustState = keyof typeof raw.trustStateRole;
export type CaptureSource = keyof typeof raw.captureSourceToken;
export type ColorToken = keyof typeof raw.color;

/** The CSS custom property for a token — what canvas/SVG code should read. */
export function cssVar(token: string): string {
  return `var(--${token})`;
}

/**
 * The tinted-chip treatment the mockup uses everywhere: a 40%-alpha border over a
 * 10%-alpha fill with full-strength text.
 *
 * Composed here rather than at each call site so the treatment stays identical.
 * The mockup's chips differ only in hue, and hand-rolled variants are exactly how
 * that stops being true.
 */
export function chipClass(role: SemanticRole): string {
  const t = SEMANTIC[role].token;
  return `border-${t}/40 bg-${t}/10 text-${t}`;
}

/** Accent-only classes for a bordered action button. */
export function accentClass(role: SemanticRole): string {
  const t = SEMANTIC[role].token;
  return `border-${t}/50 text-${t} hover:bg-${t}/10`;
}

/** Plain text in the role's colour. */
export function toneClass(role: SemanticRole): string {
  return `text-${SEMANTIC[role].token}`;
}

/** The chip for a capture's origin class, via its trust tier. */
export function originChipClass(origin: string): string {
  const role = (ORIGIN_CLASS_ROLE as Record<string, SemanticRole>)[origin];
  // An origin class nobody has mapped is not styled optimistically: an unknown
  // provenance reading as trusted blue is the one failure mode worth guarding.
  return chipClass(role ?? 'blocked');
}

/** The chip for a rung of the capture trust ladder. */
export function trustChipClass(state: string): string {
  const role = (TRUST_STATE_ROLE as Record<string, SemanticRole>)[state];
  return chipClass(role ?? 'warning');
}

/** The bare fill used by the capture-source breakdown bars. */
export function captureSourceFill(source: string): string {
  const t = (CAPTURE_SOURCE_TOKEN as Record<string, string>)[source];
  return `bg-${t ?? 'soft'}`;
}
