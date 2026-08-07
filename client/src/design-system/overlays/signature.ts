/**
 * The signature evidence hash.
 *
 * A CAPTURED SIGNATURE IS EVIDENCE, so what is stored is a hash rather than a
 * picture: the hash proves the same mark was made without keeping a biometric
 * image around to be leaked. The image itself goes to sdk-media if it is kept at
 * all; this is the value that lands in the audit trail.
 *
 * STABLE MEANS STABLE ACROSS MACHINES, not just across calls. The hash is taken
 * over the normalised STROKE DATA, never over a canvas PNG: toDataURL output
 * varies with device pixel ratio, browser anti-aliasing and even GPU, so two
 * captures of an identical signature on a laptop and a tablet would hash
 * differently and the evidence would prove nothing. Coordinates are rounded to
 * one decimal for the same reason — sub-pixel jitter is not signal.
 */

export interface SignaturePoint {
  x: number;
  y: number;
}

/** One continuous pen-down..pen-up stroke. */
export type SignatureStroke = SignaturePoint[];

/**
 * The canonical string a signature hashes over.
 *
 * Exported because the hash is only auditable if the input is reproducible: a
 * reviewer holding the stroke data must be able to recompute the digest and get
 * the same answer.
 */
export function canonicalise(strokes: SignatureStroke[]): string {
  return strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) =>
      stroke.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
    )
    .join('|');
}

/** Lower-case hex, the form the audit trail stores. */
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 over the canonical stroke data.
 *
 * Uses WebCrypto rather than a bundled implementation: it is present in every
 * target browser and in Node's test environment, and a hand-rolled SHA-256 in
 * the bundle is a liability nobody reviews.
 */
export async function signatureHash(strokes: SignatureStroke[]): Promise<string> {
  const canonical = canonicalise(strokes);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(digest);
}

/**
 * Whether there is enough here to call a signature.
 *
 * A stray tap produces one stroke of one point and would otherwise hash happily
 * into the audit trail as a signed consent. The floor is deliberately low —
 * refusing a genuine short mark is worse than accepting a deliberate one.
 */
export function isSignable(strokes: SignatureStroke[]): boolean {
  const points = strokes.reduce((n, s) => n + s.length, 0);
  return strokes.length > 0 && points >= 8;
}
