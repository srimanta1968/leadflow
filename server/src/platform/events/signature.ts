import crypto from 'crypto';

/**
 * Verification of a ProjexCloud webhook delivery.
 *
 * TRANSCRIBED FROM THE PRODUCER, not invented here. sdk-webhook's hmacSigner
 * builds the signed string as `${timestamp}.${event_id}.${raw_body}` and sends:
 *
 *   X-Projexcloud-Signature: t=<unix>,v1=<hex>
 *   X-Projexcloud-Algo:      hmac-sha256 | hmac-sha512
 *   X-Projexcloud-Timestamp: <unix>
 *   X-Projexcloud-Event-Id:  <event id>
 *
 * Every one of those three components matters and getting any of them wrong
 * fails CLOSED but silently-looking: a verifier that hashes only the body still
 * rejects everything, and the symptom is "no events are arriving", which reads
 * as an upstream problem rather than a local one.
 *
 * THE EVENT ID IS INSIDE THE SIGNATURE, which is the part worth noticing: it
 * means a replayed body cannot be re-attributed to a different event, and the
 * id we deduplicate on is the id the sender authenticated.
 */

export type SignatureState = 'verified' | 'unsigned' | 'bad_signature' | 'stale' | 'not_configured';

export interface VerificationResult {
  state: SignatureState;
  ok: boolean;
  /** What to say in a log or a 401, in the operator's terms. */
  detail: string;
}

/**
 * How far apart the clocks may be, in seconds.
 *
 * 300 is the producer's own default and is matched deliberately rather than
 * chosen. A receiver stricter than its sender rejects deliveries the sender
 * considers valid, and the failure looks like a signing bug.
 */
const MAX_SKEW_SECONDS = 300;

const SIGNATURE_PATTERN = /^t=(\d+),v1=([0-9a-f]+)$/i;

export interface VerifyInput {
  /** The exact bytes the sender signed. NEVER a re-serialised object. */
  rawBody: string;
  signatureHeader: string | undefined;
  eventId: string | undefined;
  algo: string | undefined;
  secret: string;
  /** Injectable so skew handling is testable without waiting five minutes. */
  nowSeconds?: number;
}

export function verifyDelivery(input: VerifyInput): VerificationResult {
  if (!input.secret) {
    // FAILS CLOSED. An unconfigured secret means we cannot tell a real delivery
    // from a forged one, and accepting on that basis would let anybody who
    // finds the URL write into the projections.
    return {
      state: 'not_configured',
      ok: false,
      detail: 'No ProjexCloud webhook signing secret is configured, so no delivery can be trusted',
    };
  }

  if (!input.signatureHeader) {
    return { state: 'unsigned', ok: false, detail: 'X-Projexcloud-Signature header is missing' };
  }
  if (!input.eventId) {
    // The id is part of the signed string, so without it there is nothing to
    // verify against — and nothing to deduplicate on either.
    return { state: 'unsigned', ok: false, detail: 'X-Projexcloud-Event-Id header is missing' };
  }

  const match = SIGNATURE_PATTERN.exec(input.signatureHeader);
  if (!match) {
    return {
      state: 'bad_signature',
      ok: false,
      detail: 'Signature header is not in the form t=<unix>,v1=<hex>',
    };
  }

  const [, timestamp, providedHex] = match;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = Math.abs(now - Number(timestamp));
  if (skew > MAX_SKEW_SECONDS) {
    // A REPLAY GUARD, separate from the signature being valid. An attacker who
    // captured a legitimate delivery could otherwise resend it forever; the
    // signature stays correct because the body never changed.
    return {
      state: 'stale',
      ok: false,
      detail: `Delivery is ${skew}s out of date, beyond the ${MAX_SKEW_SECONDS}s window`,
    };
  }

  const hash = input.algo === 'hmac-sha512' ? 'sha512' : 'sha256';
  const signedString = `${timestamp}.${input.eventId}.${input.rawBody}`;
  const expected = crypto.createHmac(hash, input.secret).update(signedString, 'utf8').digest();
  const provided = Buffer.from(providedHex, 'hex');

  // timingSafeEqual THROWS on a length mismatch rather than returning false, so
  // the lengths are compared first. A wrong-length signature is also the cheap
  // way to tell sha256 from sha512 without leaking which.
  if (provided.length !== expected.length) {
    return { state: 'bad_signature', ok: false, detail: 'Signature length does not match the algorithm' };
  }

  // Constant time. A byte-by-byte compare leaks how much of a forged signature
  // was right, which turns a computationally infeasible search into a few
  // thousand requests.
  if (!crypto.timingSafeEqual(provided, expected)) {
    return { state: 'bad_signature', ok: false, detail: 'Signature does not match the payload' };
  }

  return { state: 'verified', ok: true, detail: 'Signature verified' };
}
