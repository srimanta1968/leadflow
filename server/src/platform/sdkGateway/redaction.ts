/**
 * Redaction of requests and responses BEFORE they reach a log.
 *
 * This gateway carries the whole product's personal data: names, emails, phone
 * numbers, signature hashes, vault ciphertext and the bearer token itself. A log
 * line that helps debug an outage must not be the thing that turns a 500 into a
 * disclosure — logs are shipped, indexed, retained on a different schedule from
 * the database, and read by people who have no grant on the record.
 *
 * The rule here is DENY BY DEFAULT ON KEY NAME, not allow-by-default with a
 * blocklist. A blocklist only redacts what somebody thought of; the first field
 * an SDK adds is unredacted until somebody notices. So a value survives into the
 * log only if its key is recognised as non-identifying.
 */

/** Key names that may be logged in full — ids, states, counts, timings. */
const SAFE_KEYS = new Set([
  'id', 'ids', 'tenant_id', 'tenantId', 'app_id', 'appId', 'lead_id', 'leadId',
  'source_record_id', 'sourceRecordId', 'event_id', 'eventId', 'sourceEventId',
  'correlation_id', 'correlationId', 'causation_id', 'causationId',
  'trace_id', 'traceId', 'traceparent', 'request_id', 'requestId',
  'status', 'state', 'outcome', 'code', 'error', 'reason', 'detail', 'details',
  'kind', 'type', 'event_type', 'eventType', 'platform', 'sdk', 'method', 'path',
  'count', 'total', 'limit', 'offset', 'page', 'attempt', 'duration_ms', 'durationMs',
  'created_at', 'createdAt', 'updated_at', 'updatedAt', 'occurred_at', 'occurredAt',
  'origin_class', 'originClass', 'trust_state', 'trustState', 'retention_class',
  'success', 'delivered', 'version', 'schema', 'message',
]);

/**
 * Keys that are redacted even though they might look structural.
 *
 * `message` is in SAFE_KEYS because an upstream error message is the single most
 * useful thing in a log line — but an AUTH message can quote the credential, so
 * the credential keys below win. Order matters: this set is checked first.
 */
const ALWAYS_REDACT = /^(authorization|auth|api[-_]?key|apikey|client[-_]?secret|secret|token|access[-_]?token|refresh[-_]?token|password|passphrase|signature|cookie|set-cookie|x-api-key|idempotency-key)$/i;

/** How deep to walk before giving up and summarising. */
const MAX_DEPTH = 6;

const REDACTED = '[redacted]';

/**
 * Returns a copy safe to log. Never mutates the input.
 *
 * Mutating would be a far worse bug than a verbose log: the redacted object is
 * built while the real one is still on its way to the gateway, so redacting in
 * place would send `[redacted]` as the actual payload.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[depth-limit]';

  if (Array.isArray(value)) {
    // Length is preserved because "we sent 400 records" is diagnostic and the
    // records themselves are not.
    if (value.length > 20) {
      return [...value.slice(0, 20).map((v) => redact(v, depth + 1)), `[+${value.length - 20} more]`];
    }
    return value.map((v) => redact(v, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (ALWAYS_REDACT.test(key)) {
        out[key] = REDACTED;
      } else if (SAFE_KEYS.has(key)) {
        out[key] = typeof inner === 'object' && inner !== null ? redact(inner, depth + 1) : inner;
      } else if (typeof inner === 'object' && inner !== null) {
        // Unknown container: keep walking, so a safe id nested under an unknown
        // wrapper is still visible.
        out[key] = redact(inner, depth + 1);
      } else {
        out[key] = REDACTED;
      }
    }
    return out;
  }

  // A bare scalar with no key to judge it by. Reached only for an array of
  // strings or a top-level primitive, and we cannot tell an email from a status,
  // so it does not get logged.
  return typeof value === 'number' || typeof value === 'boolean' ? value : REDACTED;
}

/** Header map with every credential-bearing header removed. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = ALWAYS_REDACT.test(key) ? REDACTED : value;
  }
  return out;
}

/**
 * A one-line, log-safe summary of a call.
 *
 * The idempotency key is redacted rather than logged. It is derived from a
 * provider event id often enough that logging it leaks the upstream identifier,
 * and the correlation id already gives an operator the thread to pull.
 */
export function callSummary(input: {
  sdk: string;
  method: string;
  path: string;
  status: number | null;
  attempt: number;
  durationMs: number;
  correlationId: string;
  /** The joinable id. Ours and ProjexCloud's logs index by the same value. */
  traceId?: string;
  body?: unknown;
}): Record<string, unknown> {
  return {
    sdk: input.sdk,
    method: input.method,
    path: input.path,
    status: input.status,
    attempt: input.attempt,
    durationMs: input.durationMs,
    correlationId: input.correlationId,
    // The whole point of deriving it: when ProjexCloud answers 500 with nothing
    // but {"error":"InternalError"}, this is the id their log can be searched by.
    traceId: input.traceId,
    body: input.body === undefined ? undefined : redact(input.body),
  };
}
