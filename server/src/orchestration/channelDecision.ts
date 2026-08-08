import { dataService } from '../services/DataService';
import { SdkGatewayClient } from '../platform/sdkGateway';

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
  tenantId?: string | null;
  correlationId?: string;
  decidedBy?: string | null;
}

export interface ChannelDecision {
  id: string;
  verdict: Verdict;
  reasons: DecisionReason[];
  checksRan: string[];
  /** True when at least one input could not be reached. */
  degraded: boolean;
}

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
export async function compose(input: ChannelDecisionInput): Promise<ChannelDecision> {
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
        const res = await SdkGatewayClient.call<{ data?: { granted?: boolean; revoked_at?: string | null } }>({
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
      const res = await SdkGatewayClient.call<{ data?: { effect?: string; reason?: string } }>({
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
        const res = await SdkGatewayClient.call<{ data?: { deliverable?: boolean; reason?: string; suppressed?: boolean } }>({
          sdk: 'sdk-deliverability',
          path: '/api/deliverability/check',
          method: 'POST',
          body: { tenant_id: tenantId, subject_ref: input.subjectRef, channel: input.channel },
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
      const res = await SdkGatewayClient.call<{ data?: { quiet_hours?: boolean; cap_reached?: boolean; next_allowed_at?: string } }>({
        sdk: 'sdk-notification',
        path: '/api/notifications/send-window',
        method: 'POST',
        body: { tenant_id: tenantId, subject_ref: input.subjectRef, channel: input.channel },
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

  const rows = await dataService.query<{ id: string }>(
    `INSERT INTO leadflow_channel_decision
       (subject_ref, channel, purpose_key, audience, verdict, reasons, checks_ran,
        degraded, correlation_id, decided_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)
     RETURNING id`,
    [
      input.subjectRef, input.channel, input.purposeKey ?? null, audience, verdict,
      JSON.stringify(reasons), JSON.stringify(checksRan), degraded,
      input.correlationId ?? null, input.decidedBy ?? null,
    ],
  );

  return { id: rows[0].id, verdict, reasons, checksRan, degraded };
}

/** Bulk compose. Sequential on purpose — see the note. */
export async function composeBulk(inputs: ChannelDecisionInput[]): Promise<ChannelDecision[]> {
  const out: ChannelDecision[] = [];
  // SEQUENTIAL, not Promise.all. A bulk decision for a thousand recipients fired
  // at once is a thousand simultaneous calls to four SDKs, which trips their rate
  // limits and then the circuit breaker — turning a routine campaign check into
  // an outage for every other feature sharing those SDKs.
  for (const input of inputs) {
    out.push(await compose(input));
  }
  return out;
}

/** Read a decision back, for the audit panel and for send-time verification. */
export async function decisionById(id: string): Promise<Record<string, unknown> | null> {
  const rows = await dataService.query<Record<string, unknown>>(
    `SELECT * FROM leadflow_channel_decision WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
