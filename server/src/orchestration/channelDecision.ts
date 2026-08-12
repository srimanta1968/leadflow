import { dataService } from '../services/DataService';
import { SdkGatewayClient } from '../platform/sdkGateway';
import {
  isSuppressed,
  suppressedSet,
  suppressionKey,
  type StopSignal,
} from '../features/consent/suppressionLedger';

/**
 * The ONE authority every send path must ask.
 *
 * Four separate systems each hold a veto over contacting somebody — consent,
 * policy, deliverability, and the tenant's quiet hours and frequency caps — and
 * before this they were consulted ad hoc, by whichever send path remembered to.
 * That arrangement fails in the direction that matters: the path that forgets is
 * the one that sends the message it should not have, and nothing records that a
 * decision was skipped rather than made permissive.
 *
 * SO THE COMPOSER IS THE ONLY WAY THROUGH, and it always writes a row. A send
 * carries a decision id; a decision id exists only because this ran. That turns
 * "no send path may bypass the check" from a rule people follow into one the
 * schema enforces, and `tests/unit/orchestration.test.ts` fails the build if a
 * module calls sdk-notification without one.
 *
 * THE REASONS ARE ORDERED AND THEY ARE THE ANSWER. Not a set, and not codes the
 * UI has to translate: the FIRST blocking reason is what an operator acts on,
 * and re-deriving wording at display time means the sentence they read is not
 * the sentence that was decided. They are stored exactly as composed.
 */

export type Verdict = 'allow' | 'review' | 'deny';
export type Channel = 'email' | 'sms' | 'call' | 'social' | 'push';
export type Audience = 'prospect' | 'internal';

export interface DecisionReason {
  /** Stable machine code, for metrics. Never rendered on its own. */
  code: string;
  /** The sentence the UI shows, verbatim. Written for the operator. */
  text: string;
  /** Which system said it, so a disputed answer can be taken to the right team. */
  source: string;
  effect: Verdict;
}

export interface ChannelDecisionInput {
  subjectRef: string;
  channel: Channel;
  /** The consent purpose the message would be sent under. */
  purposeKey?: string;
  /**
   * Who is being contacted. `internal` skips consent and deliverability because
   * neither applies to telling a colleague something — see the note in compose().
   */
  audience?: Audience;
  /**
   * Which sending identity would carry it — a from-address, a number, a page.
   * Deliverability is a property of the PAIR, not of the recipient alone: an
   * address can be perfectly reachable from one sending domain and suppressed
   * from another that burned its reputation, and asking without saying who is
   * sending gets an answer to a different question.
   */
  senderIdentityRef?: string;
  /**
   * The instant the send would happen, when it is not now. Quiet hours and
   * frequency caps are the two checks whose answer depends entirely on WHEN, so
   * a campaign scheduled for tomorrow morning must be evaluated against that
   * moment rather than against the moment somebody queued it.
   */
  at?: string;
  tenantId?: string | null;
  correlationId?: string;
  decidedBy?: string | null;
  /**
   * Suppression already resolved by the caller. The bulk path fills this from
   * ONE query for the whole page; without it a 100,000 audience would issue
   * 100,000 lookups, reintroducing per-subject round trips into the exact path
   * that was rebuilt to remove them.
   */
  suppressed?: { suppressed: boolean; signal: StopSignal | null; since: string | null };
}

export interface ChannelDecision {
  id: string;
  verdict: Verdict;
  reasons: DecisionReason[];
  checksRan: string[];
  /** True when at least one input could not be reached. */
  degraded: boolean;
  decidedAt: string;
  /** The instant after which this answer must be asked again. */
  expiresAt: string;
}

/**
 * What a decision looks like on the wire.
 *
 * `reasons` is a list of SENTENCES, not the internal objects. The `code` and
 * `source` on a DecisionReason exist for metrics and for routing a dispute to
 * the team that owns the answer; neither is something a caller should branch on,
 * and `source` in particular names the SDK behind the verdict, which is a vendor
 * detail no tenant asked about. Shipping them invites exactly the coupling this
 * endpoint exists to prevent — a client that switches on CONSENT_NOT_GRANTED has
 * pinned an internal constant, and the wording it renders will then drift from
 * the wording that was decided.
 *
 * So the projection is deliberately lossy, and lossy in one direction: the
 * ledger keeps everything, the wire carries what an operator reads.
 */
export interface PublicChannelDecision {
  decisionRef: string;
  verdict: Verdict;
  /** Ordered. The first entry is the one to act on. */
  reasons: string[];
  checksRan: string[];
  degraded: boolean;
  evaluatedAt: string;
  expiresAt: string;
}

/**
 * Joins the parts of a dedupe key. String.fromCharCode(0) rather than a NUL
 * escape in the literal: a raw control byte in a source file makes grep treat
 * the whole module as binary, so it silently drops out of every code search.
 */
const KEY_SEPARATOR = String.fromCharCode(0);

/**
 * How long each verdict stands.
 *
 * Unequal ON PURPOSE — see 020_channel_decision_validity.sql. An `allow` is the
 * only verdict that authorises a send, so it holds for the shortest time: acting
 * on a stale allow messages somebody who withdrew permission, while acting on a
 * stale deny merely re-refuses something that was almost certainly still refused.
 */
const VALIDITY_MS: Record<Verdict, number> = {
  allow: 5 * 60 * 1000,
  review: 30 * 60 * 1000,
  deny: 24 * 60 * 60 * 1000,
};

/**
 * A degraded decision was reached without every input, so it does not get the
 * full window: the check that could not be reached is precisely the one most
 * likely to have changed the answer.
 */
const DEGRADED_VALIDITY_MS = 60 * 1000;

function validityFor(verdict: Verdict, degraded: boolean): number {
  return degraded ? Math.min(DEGRADED_VALIDITY_MS, VALIDITY_MS[verdict]) : VALIDITY_MS[verdict];
}

/** The wire projection. Drops `code` and `source`; keeps the order. */
export function toPublicDecision(decision: ChannelDecision): PublicChannelDecision {
  return {
    decisionRef: decision.id,
    verdict: decision.verdict,
    reasons: decision.reasons.map((r) => r.text),
    checksRan: decision.checksRan,
    degraded: decision.degraded,
    evaluatedAt: decision.decidedAt,
    expiresAt: decision.expiresAt,
  };
}

/**
 * What each stop signal SAYS, in the words the operator sees.
 *
 * Distinct sentences rather than one generic "suppressed", because the right
 * next action differs: an unsubscribe may be reversed by the person themselves,
 * a wrong number means the record is about somebody else entirely and should be
 * corrected, and a spam complaint is a reputation event the tenant needs to
 * know about rather than quietly route around.
 */
const SUPPRESSION_TEXT: Record<StopSignal, string> = {
  sms_stop: 'They replied STOP, so we do not contact them on any channel.',
  sms_help: 'They asked for help. This does not stop contact.',
  email_unsubscribe: 'They unsubscribed from email.',
  spam_complaint: 'They marked a message as spam, so we do not email them.',
  hard_bounce: 'Email to this address permanently failed, so we do not retry it.',
  dnc_registration: 'They are on a do-not-call register, so we do not call or text them.',
  wrong_number: 'This number reaches somebody else, so we do not use it.',
  staff_revocation: 'Somebody here recorded that we must not contact them.',
  release: 'Contact was restored.',
};

/** Rank so the strictest verdict wins however the checks are ordered. */
const SEVERITY: Record<Verdict, number> = { allow: 0, review: 1, deny: 2 };

function strictest(a: Verdict, b: Verdict): Verdict {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

/**
 * One upstream check, reduced to a reason.
 *
 * A check that CANNOT BE REACHED returns `review`, never `allow`. This is the
 * single most consequential line in the file: treating an unreachable consent
 * service as permission is how a system sends to somebody who revoked it, and
 * "we could not ask" is not "they said yes". It is not `deny` either, because a
 * blanket outage would otherwise silently stop every legitimate message with no
 * human ever seeing it — review puts it in front of a person, which is the
 * honest answer to "we do not know".
 */
async function runCheck(
  name: string,
  source: string,
  call: () => Promise<DecisionReason | null>,
): Promise<{ reason: DecisionReason | null; degraded: boolean }> {
  try {
    return { reason: await call(), degraded: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      degraded: true,
      reason: {
        code: `${name.toUpperCase()}_UNAVAILABLE`,
        text: `We could not check ${name} just now, so this needs a person to approve it.`,
        source,
        effect: 'review',
      },
    };
  }
}

/**
 * Compose the verdict.
 *
 * THE CHECK ORDER IS THE READING ORDER, and it is deliberate: consent first
 * because it is the one a person actively expressed, then policy, then whether
 * the message could even arrive, then timing. An operator reading the list top
 * to bottom meets the most fundamental objection first.
 */
async function evaluate(
  input: ChannelDecisionInput,
  pre?: PrefetchedChecks,
): Promise<DecisionDraft> {
  const audience: Audience = input.audience ?? 'prospect';
  const reasons: DecisionReason[] = [];
  const checksRan: string[] = [];
  let verdict: Verdict = 'allow';
  let degraded = false;

  const record = (r: { reason: DecisionReason | null; degraded: boolean }, name: string): void => {
    checksRan.push(name);
    if (r.degraded) degraded = true;
    if (r.reason) {
      reasons.push(r.reason);
      verdict = strictest(verdict, r.reason.effect);
    }
  };

  const tenantId = input.tenantId ?? undefined;

  if (audience === 'prospect') {
    /* --------------------------------------------------- local suppression */
    /*
     * ASKED FIRST, AND IT IS A LOCAL READ.
     *
     * This is what makes "a STOP produces zero further automated sends within
     * one tick" true rather than aspirational. Every other check here is an
     * upstream call, and every upstream call has failure modes that resolve to
     * `review` — the honest answer for "we could not ask", but the wrong answer
     * for somebody who has already texted STOP, because a human working the
     * review queue may well approve it.
     *
     * So the stop is written to the local ledger synchronously when it arrives,
     * and read here from one indexed row. It DENIES outright, it does not
     * degrade, and it runs before anything that can be slow.
     */
    checksRan.push('suppression');
    const stop = input.suppressed ?? (await isSuppressed(input.subjectRef, input.channel, tenantId));
    if (stop.suppressed) {
      reasons.push({
        code: 'SUPPRESSED',
        text: SUPPRESSION_TEXT[stop.signal ?? 'staff_revocation']
          ?? 'They have asked not to be contacted.',
        source: 'leadflow',
        effect: 'deny',
      });
      verdict = 'deny';
      /*
       * RETURNS HERE rather than continuing through the other three checks.
       * Not an optimisation: once somebody has said stop, asking consent,
       * policy and deliverability produces reasons that invite an operator to
       * argue with the refusal ("consent is on file, so why...?"). The reason
       * list should say the one thing that matters and nothing that softens it.
       */
      return { input, audience, verdict, reasons, checksRan, degraded };
    }
  }

  if (audience === 'prospect') {
    /* ------------------------------------------------------------- consent */
    record(
      await runCheck('consent', 'sdk-consent', async () => {
        if (!input.purposeKey) {
          // A message with no stated purpose cannot be consent-checked, so it
          // cannot be sent. Defaulting to a purpose would be inventing the basis
          // on which somebody agreed to be contacted.
          return {
            code: 'PURPOSE_MISSING',
            text: 'This message does not say what it is for, so we cannot check whether they agreed to receive it.',
            source: 'sdk-consent',
            effect: 'deny',
          };
        }
        const res = pre?.consent ?? await SdkGatewayClient.call<{ data?: { granted?: boolean; revoked_at?: string | null } }>({
          sdk: 'sdk-consent',
          path: '/api/consents/check',
          method: 'POST',
          body: { tenant_id: tenantId, subject_ref: input.subjectRef, purpose_key: input.purposeKey, channel: input.channel },
          correlationId: input.correlationId,
        });
        if (!res.delivered) {
          // Not configured. Distinct from unreachable, and still not permission.
          return {
            code: 'CONSENT_NOT_CONFIGURED',
            text: 'Consent records are not connected, so we cannot confirm they agreed to hear from us.',
            source: 'sdk-consent',
            effect: 'review',
          };
        }
        const granted = res.data?.data?.granted === true;
        if (!granted) {
          return {
            code: 'CONSENT_NOT_GRANTED',
            text: 'They have not agreed to be contacted for this purpose.',
            source: 'sdk-consent',
            effect: 'deny',
          };
        }
        return null;
      }),
      'consent',
    );
  } else {
    // STATED, NOT SILENT. An internal notification is exempt from consent and
    // deliverability because neither concept applies to a colleague — but the
    // exemption appears in the reason list and in the stored row, so an audit
    // sees a decision that was made rather than a check that was skipped.
    checksRan.push('audience');
    reasons.push({
      code: 'INTERNAL_RECIPIENT',
      text: 'This goes to a colleague, not to the customer, so consent and deliverability do not apply.',
      source: 'leadflow',
      effect: 'allow',
    });
  }

  /* -------------------------------------------------------------- policy */
  record(
    await runCheck('policy', 'sdk-policy', async () => {
      const res = pre?.policy ?? await SdkGatewayClient.call<{ data?: { effect?: string; reason?: string } }>({
        sdk: 'sdk-policy',
        path: '/api/policies/evaluate',
        method: 'POST',
        body: {
          tenant_id: tenantId,
          subject_id: input.subjectRef,
          action: `message.send.${input.channel}`,
          resource: { type: 'subject', id: input.subjectRef },
        },
        correlationId: input.correlationId,
      });
      if (!res.delivered) return null;
      const effect = res.data?.data?.effect;
      if (effect === 'deny') {
        return {
          code: 'POLICY_DENIED',
          text: res.data?.data?.reason ?? 'A tenant policy blocks this message.',
          source: 'sdk-policy',
          effect: 'deny',
        };
      }
      if (effect === 'requires_approval') {
        return {
          code: 'POLICY_REQUIRES_APPROVAL',
          text: res.data?.data?.reason ?? 'A tenant policy requires a person to approve this message.',
          source: 'sdk-policy',
          effect: 'review',
        };
      }
      return null;
    }),
    'policy',
  );

  if (audience === 'prospect') {
    /* ------------------------------------------------------ deliverability */
    record(
      await runCheck('deliverability', 'sdk-deliverability', async () => {
        const res = pre?.deliverability ?? await SdkGatewayClient.call<{ data?: { deliverable?: boolean; reason?: string; suppressed?: boolean } }>({
          sdk: 'sdk-deliverability',
          path: '/api/deliverability/check',
          method: 'POST',
          body: {
            tenant_id: tenantId,
            subject_ref: input.subjectRef,
            channel: input.channel,
            sender_identity_ref: input.senderIdentityRef ?? null,
          },
          correlationId: input.correlationId,
        });
        if (!res.delivered) return null;
        const d = res.data?.data;
        if (d?.suppressed === true) {
          // A suppression is usually a complaint or a hard bounce. Sending again
          // damages the sending domain for every other message the tenant has.
          return {
            code: 'ADDRESS_SUPPRESSED',
            text: d.reason ?? 'This address is suppressed after a bounce or complaint.',
            source: 'sdk-deliverability',
            effect: 'deny',
          };
        }
        if (d?.deliverable === false) {
          return {
            code: 'NOT_DELIVERABLE',
            text: d.reason ?? 'This address or number does not look deliverable.',
            source: 'sdk-deliverability',
            effect: 'review',
          };
        }
        return null;
      }),
      'deliverability',
    );
  }

  /* -------------------------------------------- quiet hours and frequency */
  record(
    await runCheck('timing', 'sdk-notification', async () => {
      const res = pre?.timing ?? await SdkGatewayClient.call<{ data?: { quiet_hours?: boolean; cap_reached?: boolean; next_allowed_at?: string } }>({
        sdk: 'sdk-notification',
        // /send-window is not in the spec; quiet-hours is where the window lives.
      path: '/api/notifications/quiet-hours',
        method: 'POST',
        body: {
          tenant_id: tenantId,
          subject_ref: input.subjectRef,
          channel: input.channel,
          // Defaults to now. A scheduled send is evaluated against the moment it
          // would actually go out, not the moment it was queued.
          at: input.at ?? new Date().toISOString(),
        },
        correlationId: input.correlationId,
      });
      if (!res.delivered) return null;
      const d = res.data?.data;
      if (d?.quiet_hours === true) {
        // REVIEW, not deny. The message is fine, the moment is wrong — denying
        // it would throw away a legitimate send that simply needs to wait.
        return {
          code: 'QUIET_HOURS',
          text: d.next_allowed_at
            ? `It is outside their contact hours. The next allowed time is ${d.next_allowed_at}.`
            : 'It is outside their contact hours.',
          source: 'sdk-notification',
          effect: 'review',
        };
      }
      if (d?.cap_reached === true) {
        return {
          code: 'FREQUENCY_CAP',
          text: 'They have already had the maximum number of messages for this period.',
          source: 'sdk-notification',
          effect: 'review',
        };
      }
      return null;
    }),
    'timing',
  );

  if (reasons.length === 0) {
    // NEVER AN EMPTY LIST. "Allowed, and here is nothing" reads as a bug; the
    // UI renders this list unconditionally, so silence would be a blank panel.
    reasons.push({
      code: 'ALL_CHECKS_PASSED',
      text: 'Consent, policy, deliverability and timing all allow this message.',
      source: 'leadflow',
      effect: 'allow',
    });
  }

  return { input, audience, verdict, reasons, checksRan, degraded };
}

/**
 * An upstream answer the bulk path already has, so `evaluate` does no I/O.
 *
 * Shaped exactly like a single SdkGatewayClient result — `delivered` plus the
 * nested `data.data` envelope — so the check bodies read it with no branching
 * beyond one `??`. That is the point: the reason wording, the effects and the
 * order are composed by ONE code path, and a bulk decision cannot drift from
 * the single-subject decision for the same inputs.
 */
interface PrefetchedCheck<T> {
  delivered: boolean;
  data?: { data?: T };
}

interface PrefetchedChecks {
  consent?: PrefetchedCheck<{ granted?: boolean; revoked_at?: string | null }>;
  policy?: PrefetchedCheck<{ effect?: string; reason?: string }>;
  deliverability?: PrefetchedCheck<{ deliverable?: boolean; reason?: string; suppressed?: boolean }>;
  timing?: PrefetchedCheck<{ quiet_hours?: boolean; cap_reached?: boolean; next_allowed_at?: string }>;
}

/** A verdict that has been reached but not yet written down. */
interface DecisionDraft {
  input: ChannelDecisionInput;
  audience: Audience;
  verdict: Verdict;
  reasons: DecisionReason[];
  checksRan: string[];
  degraded: boolean;
}

/**
 * Write drafts to the ledger in ONE statement per batch and return them in the
 * order they were given.
 *
 * The per-row INSERT this replaces is what actually made a large audience
 * impossible. Four SDK calls per subject are slow but they overlap; 100,000
 * separate INSERTs do not overlap at all — each is a round trip that must
 * complete before the next begins, and at even a conservative 1ms that alone is
 * 100 seconds of the request budget spent on bookkeeping. A multi-row VALUES
 * turns it into one round trip per batch.
 *
 * `RETURNING id` on a multi-row INSERT returns ids in the order the rows were
 * supplied, which is what lets the caller match them back up positionally.
 */
async function persistDrafts(drafts: DecisionDraft[]): Promise<ChannelDecision[]> {
  if (drafts.length === 0) return [];

  const COLUMNS = 12;
  const params: unknown[] = [];
  const tuples: string[] = [];

  for (const d of drafts) {
    const decidedAt = new Date();
    const expiresAt = new Date(decidedAt.getTime() + validityFor(d.verdict, d.degraded));
    const base = params.length;
    tuples.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6}::jsonb,` +
        `$${base + 7}::jsonb,$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12})`,
    );
    params.push(
      d.input.subjectRef, d.input.channel, d.input.purposeKey ?? null, d.audience, d.verdict,
      JSON.stringify(d.reasons), JSON.stringify(d.checksRan), d.degraded,
      d.input.correlationId ?? null, d.input.decidedBy ?? null, decidedAt, expiresAt,
    );
  }

  if (params.length !== drafts.length * COLUMNS) {
    throw new Error('channel decision batch is malformed');
  }

  const rows = await dataService.query<{ id: string; decided_at: Date; expires_at: Date }>(
    `INSERT INTO leadflow_channel_decision
       (subject_ref, channel, purpose_key, audience, verdict, reasons, checks_ran,
        degraded, correlation_id, decided_by, decided_at, expires_at)
     VALUES ${tuples.join(',')}
     RETURNING id, decided_at, expires_at`,
    params,
  );

  return drafts.map((d, i) => ({
    id: rows[i].id,
    verdict: d.verdict,
    reasons: d.reasons,
    checksRan: d.checksRan,
    degraded: d.degraded,
    decidedAt: new Date(rows[i].decided_at).toISOString(),
    expiresAt: new Date(rows[i].expires_at).toISOString(),
  }));
}

/** Decide for one subject, and write it down. */
export async function compose(input: ChannelDecisionInput): Promise<ChannelDecision> {
  const [decision] = await persistDrafts([await evaluate(input)]);
  return decision;
}

/**
 * How many subjects go into one upstream bulk call.
 *
 * 1000 is the envelope limit sdk-consent, sdk-policy, sdk-deliverability and
 * sdk-notification all accept; over it they answer 400 for the whole request.
 */
const BULK_PAGE = 1000;

/**
 * How many subjects are evaluated at once when the bulk endpoints are NOT
 * reachable and each subject has to be asked about individually.
 */
const BULK_CONCURRENCY = Number(process.env.CHANNEL_DECISION_CONCURRENCY ?? 32);
/** How many decisions go into one INSERT. */
const BULK_INSERT_BATCH = Number(process.env.CHANNEL_DECISION_INSERT_BATCH ?? 1000);
/** How long a bulk evaluation may run before it answers with what it has. */
const BULK_BUDGET_MS = Number(process.env.CHANNEL_DECISION_BULK_BUDGET_MS ?? 25_000);

/** One entry of an upstream bulk envelope. */
interface BulkItem {
  index?: number;
  ok?: boolean;
  [key: string]: unknown;
}

/**
 * Ask all four authorities about one page, and return their answers indexed to
 * line up with the page.
 *
 * ZIPPED BY `index`, NEVER BY POSITION. The envelope is order-preserving and
 * every item also carries its own index, and using the index is not belt-and-
 * braces: an upstream that filters before it answers, or that grows a new
 * failure mode, silently shifts positions — and a misaligned consent verdict
 * means messaging somebody who withdrew. The index is the only thing that ties
 * an answer to the subject it is about.
 *
 * PER-ITEM FAILURE IS NOT PAGE FAILURE. An item that comes back `ok:false` is
 * simply left without a prefetched answer for that check, so `evaluate` falls
 * through to the same `review` it would reach for any input it could not
 * confirm. One malformed subject does not cost the other 999 their verdicts.
 *
 * Returns null when the endpoints are not reachable at all, which tells the
 * caller to fall back rather than treating an absent answer as an answer.
 */
async function prefetchPage(
  page: ChannelDecisionInput[],
): Promise<PrefetchedChecks[] | null> {
  const prospects = page
    .map((input, i) => ({ input, i }))
    .filter(({ input }) => (input.audience ?? 'prospect') === 'prospect');

  const ask = async <T>(
    sdk: string,
    path: string,
    items: { i: number; body: Record<string, unknown> }[],
  ): Promise<Map<number, PrefetchedCheck<T>> | null> => {
    if (items.length === 0) return new Map();
    try {
      const res = await SdkGatewayClient.call<{ data?: { results?: BulkItem[] } }>({
        sdk,
        path,
        method: 'POST',
        body: { items: items.map((it) => it.body) },
      });
      if (!res.delivered) return null;
      const out = new Map<number, PrefetchedCheck<T>>();
      for (const result of res.data?.data?.results ?? []) {
        if (typeof result.index !== 'number') continue;
        const target = items[result.index];
        // An item the upstream refused keeps NO prefetched answer, so the
        // composer reaches its own "we could not confirm this" reason.
        if (!target || result.ok === false) continue;
        out.set(target.i, { delivered: true, data: { data: result as T } });
      }
      return out;
    } catch {
      return null;
    }
  };

  const [consent, policy, deliverability, timing] = [
    await ask<{ granted?: boolean; revoked_at?: string | null }>(
      'sdk-consent', '/api/consents/check/bulk',
      prospects
        .filter(({ input }) => Boolean(input.purposeKey))
        .map(({ input, i }) => ({
          i,
          body: {
            tenant_id: input.tenantId ?? undefined,
            subject_ref: input.subjectRef,
            purpose_key: input.purposeKey,
            channel: input.channel,
          },
        })),
    ),
    await ask<{ effect?: string; reason?: string }>(
      'sdk-policy', '/api/policies/evaluate/bulk',
      page.map((input, i) => ({
        i,
        body: {
          tenant_id: input.tenantId ?? undefined,
          subject_id: input.subjectRef,
          action: `message.send.${input.channel}`,
          resource: { type: 'subject', id: input.subjectRef },
        },
      })),
    ),
    await ask<{ deliverable?: boolean; reason?: string; suppressed?: boolean }>(
      'sdk-deliverability', '/api/deliverability/check/bulk',
      prospects.map(({ input, i }) => ({
        i,
        body: {
          tenant_id: input.tenantId ?? undefined,
          subject_ref: input.subjectRef,
          channel: input.channel,
          sender_identity_ref: input.senderIdentityRef ?? null,
        },
      })),
    ),
    await ask<{ quiet_hours?: boolean; cap_reached?: boolean; next_allowed_at?: string }>(
      'sdk-notification', '/api/notifications/send-window/bulk',
      page.map((input, i) => ({
        i,
        body: {
          tenant_id: input.tenantId ?? undefined,
          subject_ref: input.subjectRef,
          channel: input.channel,
          at: input.at ?? new Date().toISOString(),
        },
      })),
    ),
  ];

  // If NONE of the four is reachable this deployment does not have the bulk
  // surface at all, and the caller should ask per subject instead.
  if (!consent && !policy && !deliverability && !timing) return null;

  return page.map((_, i) => ({
    consent: consent?.get(i),
    policy: policy?.get(i),
    deliverability: deliverability?.get(i),
    timing: timing?.get(i),
  }));
}

export interface BulkDecisionResult {
  decisions: ChannelDecision[];
  /**
   * Inputs the budget ran out before reaching, by their position in the request.
   * NEVER silently dropped — see the note in evaluateBulk.
   */
  undecided: number[];
}

/**
 * Decide for an audience.
 *
 * THREE THINGS MAKE THIS SURVIVE 100,000 SUBJECTS, and the old sequential loop
 * had none of them:
 *
 *  1. BOUNDED CONCURRENCY, not `Promise.all` and not one-at-a-time. Firing every
 *     subject at once is a hundred thousand simultaneous calls to four SDKs,
 *     which trips their rate limits and then the circuit breaker — turning a
 *     routine campaign check into an outage for every other feature sharing
 *     those SDKs. Doing them one at a time is safe and far too slow. A fixed
 *     worker pool is the only shape that is both.
 *
 *  2. BATCHED WRITES. See persistDrafts — this is the part that dominated.
 *
 *  3. DEDUPLICATION of identical questions. The same subject, channel, purpose
 *     and audience asked twice in one request is ONE question, and answering it
 *     twice would also write two ledger rows saying the same thing at the same
 *     instant. Both copies get the same decisionRef, which is the honest answer:
 *     there was one decision.
 *
 * AND A STATED BUDGET. If the deadline passes with subjects still unevaluated,
 * this returns the decisions it made and NAMES the positions it did not reach.
 * It does not truncate silently and it does not keep running past the budget:
 * a caller that believes it holds a verdict for all 100,000 when 60,000 were
 * never looked at is exactly the failure this whole endpoint exists to prevent,
 * and it would fail in the permissive direction.
 */
export async function evaluateBulk(inputs: ChannelDecisionInput[]): Promise<BulkDecisionResult> {
  // Every field that can change the answer, and nothing that cannot. NUL joins
  // them because it is the one byte none of these may contain, so two distinct
  // questions cannot collide into a single key.
  const keyOf = (i: ChannelDecisionInput): string =>
    [
      i.subjectRef, i.channel, i.purposeKey ?? '', i.audience ?? 'prospect',
      i.senderIdentityRef ?? '', i.at ?? '', i.tenantId ?? '',
    ].join(KEY_SEPARATOR);

  // One representative position per distinct question.
  const firstAsked = new Map<string, number>();
  const unique: number[] = [];
  inputs.forEach((input, position) => {
    const key = keyOf(input);
    if (firstAsked.has(key)) return;
    firstAsked.set(key, position);
    unique.push(position);
  });

  const deadline = Date.now() + BULK_BUDGET_MS;
  const draftAt = new Map<number, DecisionDraft>();
  let outOfTime = false;

  /*
   * PAGE THE AUDIENCE AND ASK EACH AUTHORITY ONCE PER PAGE.
   *
   * This is the arithmetic that makes AC3 a request-budget operation rather
   * than an impossibility. Asking per subject is 100,000 x 4 = 400,000 calls;
   * asking per page of 1,000 is 100 x 4 = 400, and each of those is a small
   * number of set-based queries upstream rather than a thousand round trips.
   *
   * THE FOUR CALLS PER PAGE STAY SEQUENTIAL. The reason the original design
   * serialized has not gone away — four authorities hit at once by every page
   * still trips their rate limits and then the circuit breaker. It is simply no
   * longer expensive to obey, because there are 400 calls to make rather than
   * 400,000.
   */
  for (let start = 0; start < unique.length; start += BULK_PAGE) {
    if (Date.now() >= deadline) { outOfTime = true; break; }
    const page = unique.slice(start, start + BULK_PAGE);

    /*
     * Suppression for the whole page in ONE query, attached to each input
     * before anything else runs. Left to `evaluate` it would be one indexed
     * lookup per subject — 100,000 of them for a full audience, which is the
     * per-subject round trip this path exists to avoid. It is resolved FIRST
     * because a suppressed subject short-circuits before any upstream call,
     * so the page's four bulk calls carry only subjects still in play.
     */
    const pageInputs = page.map((p) => inputs[p]);
    const stopped = await suppressedSet(
      pageInputs.map((i) => ({ subjectRef: i.subjectRef, channel: i.channel })),
      pageInputs[0]?.tenantId,
    );
    for (const input of pageInputs) {
      const hit = stopped.get(suppressionKey(input.subjectRef, input.channel));
      input.suppressed = hit
        ? { suppressed: true, signal: hit.signal, since: hit.since }
        : { suppressed: false, signal: null, since: null };
    }

    const prefetched = await prefetchPage(pageInputs);

    if (prefetched) {
      // No I/O left to do, so this loop is pure composition.
      for (let i = 0; i < page.length; i++) {
        draftAt.set(page[i], await evaluate(inputs[page[i]], prefetched[i]));
      }
      continue;
    }

    /*
     * The bulk endpoints are not reachable in this environment, so fall back to
     * asking per subject with a bounded worker pool. Kept rather than failing:
     * the single-subject routes are what this deployment actually has today,
     * and a campaign check that refuses to run until an upstream ships is worse
     * than one that runs more slowly.
     */
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const slot = next++;
        if (slot >= page.length) return;
        if (Date.now() >= deadline) { outOfTime = true; return; }
        draftAt.set(page[slot], await evaluate(inputs[page[slot]]));
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(BULK_CONCURRENCY, page.length)) }, worker),
    );
  }

  // Written in batches, in ask order, so the ledger reads chronologically.
  const evaluatedPositions = unique.filter((p) => draftAt.has(p));
  const decisionAt = new Map<number, ChannelDecision>();
  for (let i = 0; i < evaluatedPositions.length; i += BULK_INSERT_BATCH) {
    const slice = evaluatedPositions.slice(i, i + BULK_INSERT_BATCH);
    const written = await persistDrafts(slice.map((p) => draftAt.get(p) as DecisionDraft));
    slice.forEach((p, j) => decisionAt.set(p, written[j]));
  }

  const decisions: ChannelDecision[] = [];
  const undecided: number[] = [];
  inputs.forEach((input, position) => {
    const decision = decisionAt.get(firstAsked.get(keyOf(input)) as number);
    if (decision) decisions.push(decision);
    else undecided.push(position);
  });

  if (outOfTime && undecided.length === 0) {
    // The budget expired but every question happened to be answered — nothing
    // to report, and reporting it anyway would train callers to ignore it.
  }
  return { decisions, undecided };
}

/**
 * Back-compat wrapper for callers that want the decisions and nothing else.
 * Throws rather than returning a short list, because a caller using this shape
 * has no way to notice a subject it never got an answer for.
 */
export async function composeBulk(inputs: ChannelDecisionInput[]): Promise<ChannelDecision[]> {
  const { decisions, undecided } = await evaluateBulk(inputs);
  if (undecided.length > 0) {
    throw new Error(
      `channel decision budget exhausted with ${undecided.length} of ${inputs.length} subjects undecided`,
    );
  }
  return decisions;
}

/** Read a decision back, for the audit panel and for send-time verification. */
export async function decisionById(id: string): Promise<Record<string, unknown> | null> {
  const rows = await dataService.query<Record<string, unknown>>(
    `SELECT * FROM leadflow_channel_decision WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface DispatchAuthorisation {
  decision: ChannelDecision;
  /** True when the presented decision had lapsed and this is a fresh answer. */
  reEvaluated: boolean;
  /** The id the caller presented, when it differs from the one now in force. */
  supersededRef?: string;
}

/**
 * The check a send path makes at the moment it dispatches.
 *
 * A DECISION IS NOT A TICKET. Holding an id proves a question was asked once; it
 * says nothing about whether the answer is still true, and between deciding and
 * dispatching a consent can be revoked, an address suppressed, or a quiet-hours
 * window entered. Every one of those changes the answer in the restrictive
 * direction, which is exactly the direction a cached allow gets wrong.
 *
 * So this re-derives rather than trusts. Inside its validity the stored verdict
 * stands — re-asking four SDKs for an answer given seconds ago is waste, and the
 * window is short precisely so that trusting it is safe. Past it, the decision is
 * COMPOSED AGAIN from current inputs, the new row supersedes the old, and the
 * caller is told which id is now in force so its audit trail follows the change.
 *
 * The lapsed decision is never silently reused and never merely rejected: an
 * error would push callers toward deciding early and dispatching late, which is
 * the behaviour this is meant to stop.
 */
export async function authoriseDispatch(
  decisionRef: string,
): Promise<DispatchAuthorisation | null> {
  const row = await dataService.queryOne<{
    id: string; subject_ref: string; channel: Channel; purpose_key: string | null;
    audience: Audience; verdict: Verdict; reasons: DecisionReason[]; checks_ran: string[];
    degraded: boolean; correlation_id: string | null; decided_by: string | null;
    decided_at: Date; expires_at: Date; superseded_by: string | null;
  }>(
    `SELECT * FROM leadflow_channel_decision WHERE id = $1`,
    [decisionRef],
  );
  if (!row) return null;

  const live = row.superseded_by === null && new Date(row.expires_at).getTime() > Date.now();
  if (live) {
    return {
      reEvaluated: false,
      decision: {
        id: row.id,
        verdict: row.verdict,
        reasons: row.reasons,
        checksRan: row.checks_ran,
        degraded: row.degraded,
        decidedAt: new Date(row.decided_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
      },
    };
  }

  const fresh = await compose({
    subjectRef: row.subject_ref,
    channel: row.channel,
    purposeKey: row.purpose_key ?? undefined,
    audience: row.audience,
    correlationId: row.correlation_id ?? undefined,
    decidedBy: row.decided_by,
  });

  // Recorded on the OLD row, so the ledger shows what replaced it rather than
  // leaving a lapsed decision looking like it is still the current answer.
  await dataService.query(
    `UPDATE leadflow_channel_decision SET superseded_by = $2 WHERE id = $1`,
    [row.id, fresh.id],
  );

  return { decision: fresh, reEvaluated: true, supersededRef: row.id };
}
