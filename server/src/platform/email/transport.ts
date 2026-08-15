import { config } from '../../config/env';
import { dataService } from '../../services/DataService';
import { checkBeforeSending } from './addressVerification';

/**
 * Outbound email for ACCOUNT LIFECYCLE only.
 *
 * WHAT THIS IS NOT. It is not a second path to the customer. Every message to a
 * prospect goes through `orchestration/channelDecision.compose()` and out via
 * sdk-notification, because that is the only path that consults consent,
 * policy, deliverability and quiet hours, and the only one that leaves a
 * decision id behind. A transport that could reach a customer without one would
 * defeat the control the whole product is built around, so this deliberately
 * cannot: it sends to a `users` row, addressed by the account's own email.
 *
 * The three things it carries are all consequences of somebody acting on an
 * account — verify the address you just registered, accept the invitation an
 * administrator sent you, set a new password because you asked to. None is
 * marketing, none needs a lawful basis beyond the act that triggered it, and
 * none can be suppressed by a marketing preference without locking the person
 * out of their own account.
 *
 * SENDGRID BY DEFAULT, over its REST API rather than a client library. Node 20
 * has global fetch, so this adds no dependency to an image that has to build
 * and boot in production — and a mail library is a large surface for something
 * this small. SMTP remains a documented alternative; it is not implemented,
 * and this says so rather than pretending to fall back.
 *
 * NOT CONFIGURED IS A VALID STATE, and it is `skipped`, never `failed`. A
 * deployment with no provider is a real one; recording it as a failure would
 * fill the ledger with errors nobody can act on and hide the real ones.
 */

export type EmailStatus = 'sent' | 'failed' | 'skipped' | 'blocked';

export interface EmailResult {
  status: EmailStatus;
  provider: string;
  messageId: string | null;
  error: string | null;
  /**
   * What the pre-send check concluded about the recipient. Null only when the
   * check did not run (which today means it threw, and it is written not to).
   *
   * CARRIED ON EVERY RESULT, not just refusals, because "we sent it and the
   * address was already suspect" is the answer to a bounce three days later.
   */
  verification?: {
    verdict: string;
    code: string;
    reason: string;
  } | null;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  /** Plain text. Always sent, and always first — see the note in send(). */
  text: string;
  html: string;
  templateKey: string;
  userId?: string | null;
}

const SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send';

/** True when a provider is configured well enough to attempt a send. */
export function isEmailConfigured(): boolean {
  return Boolean(config.email.sendgridApiKey && config.email.fromAddress);
}

/**
 * Record what happened, whatever happened.
 *
 * Written for every outcome including `skipped`, because the question an
 * operator asks is "did this person get their invitation" and a ledger that
 * only records successes cannot answer it.
 */
async function record(mail: OutboundEmail, result: EmailResult): Promise<void> {
  try {
    await dataService.query(
      `INSERT INTO leadflow_email_delivery
         (to_email, template_key, subject, provider, provider_message_id, status, error, user_id,
          verification_verdict, verification_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        mail.to, mail.templateKey, mail.subject, result.provider,
        result.messageId, result.status, result.error, mail.userId ?? null,
        result.verification?.verdict ?? null, result.verification?.code ?? null,
      ],
    );
  } catch (error) {
    // The ledger failing must not fail the send it is describing — the message
    // has already left. Logged rather than thrown for that reason.
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[email] delivery ledger write failed for ${mail.templateKey}: ${detail}`);
  }
}

/**
 * Send one message.
 *
 * BOTH PARTS, ALWAYS. A text/plain alternative is sent alongside the HTML
 * because a verification link that renders as nothing in a text-only client is
 * a person locked out of their account, and because HTML-only mail is scored as
 * spam by several providers — which is the same outcome arriving by a different
 * route.
 *
 * @returns What happened. Never throws: a failed notification must not fail the
 *          registration or invitation that triggered it, or a provider outage
 *          becomes an outage of the product.
 */
export async function sendEmail(mail: OutboundEmail): Promise<EmailResult> {
  /*
   * THE ADDRESS IS CHECKED BEFORE THE PROVIDER IS CALLED, and this is the
   * chokepoint that makes "before sending" true for every account-lifecycle
   * message rather than for whichever call sites remembered to ask.
   *
   * BLOCKED IS ITS OWN STATUS, not `failed`. Nothing failed: we decided not to
   * send, we know exactly why, and an operator reading the ledger needs to see
   * a refusal — which is fixable by correcting the address — rather than an
   * error, which reads as a provider problem and is not.
   *
   * ONLY FACTS BLOCK. See sendDecision(): an unresolvable domain stops the
   * send, a resolver that timed out does not, because a DNS blip must never
   * stop a password reset.
   */
  const { verification, decision } = await checkBeforeSending(mail.to);
  const verdict = {
    verdict: verification.verdict,
    code: verification.code,
    reason: verification.reason,
  };

  if (!decision.allowed) {
    const result: EmailResult = {
      status: 'blocked',
      provider: 'none',
      messageId: null,
      error: decision.reason,
      verification: verdict,
    };
    console.warn(`[email] ${mail.templateKey} to ${mail.to} BLOCKED — ${verification.code}: ${decision.reason}`);
    await record(mail, result);
    return result;
  }

  if (verification.verdict === 'risky' || verification.verdict === 'unknown') {
    /* SENT ANYWAY, AND SAID OUT LOUD. The line is what turns a bounce a week
       later into a five-second diagnosis instead of an investigation. */
    console.warn(`[email] ${mail.templateKey} to ${mail.to} — ${verification.code}: ${verification.reason} (sending anyway)`);
  }

  if (!isEmailConfigured()) {
    const result: EmailResult = {
      status: 'skipped',
      provider: 'none',
      messageId: null,
      error: 'No email provider is configured (SENDGRID_API_KEY / EMAIL_FROM_ADDRESS)',
      verification: verdict,
    };
    console.warn(`[email] ${mail.templateKey} to ${mail.to} SKIPPED — no provider configured`);
    await record(mail, result);
    return result;
  }

  try {
    const response = await fetch(SENDGRID_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.email.sendgridApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: mail.to }] }],
        from: { email: config.email.fromAddress, name: config.email.fromName },
        subject: mail.subject,
        content: [
          { type: 'text/plain', value: mail.text },
          { type: 'text/html', value: mail.html },
        ],
      }),
      signal: AbortSignal.timeout(config.email.timeoutMs),
    });

    if (response.status === 202) {
      const result: EmailResult = {
        status: 'sent',
        provider: 'sendgrid',
        // SendGrid returns the id in a header, not the body — it answers 202
        // with no content at all.
        messageId: response.headers.get('x-message-id'),
        error: null,
        verification: verdict,
      };
      await record(mail, result);
      return result;
    }

    /* THE BODY, NOT JUST THE STATUS. SendGrid explains a 400 in its response —
       an unverified sender, a malformed address — and recording only "400"
       makes every different cause look like one problem. */
    const body = await response.text().catch(() => '');
    const result: EmailResult = {
      status: 'failed',
      provider: 'sendgrid',
      messageId: null,
      error: `HTTP ${response.status}: ${body.slice(0, 400)}`,
      verification: verdict,
    };
    console.error(`[email] ${mail.templateKey} to ${mail.to} FAILED — ${result.error}`);
    await record(mail, result);
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const result: EmailResult = {
      status: 'failed', provider: 'sendgrid', messageId: null, error: detail,
      verification: verdict,
    };
    console.error(`[email] ${mail.templateKey} to ${mail.to} FAILED — ${detail}`);
    await record(mail, result);
    return result;
  }
}
