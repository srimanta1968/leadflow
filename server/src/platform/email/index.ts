import { config } from '../../config/env';
import { sendEmail, isEmailConfigured, type EmailResult } from './transport';
import { issue, consume, type ConsumedToken } from './tokens';
import { invitation, verifyEmail } from './templates';

export { isEmailConfigured, consume };
export type { EmailResult, ConsumedToken };

/**
 * Address verification. Exported from here so no caller has to reach past the
 * platform module into a file, and so the two send paths and the endpoint that
 * reports to a screen are demonstrably asking the same question of the same
 * code.
 */
export {
  verifyAddress, verifyAddresses, sendDecision, checkBeforeSending, describeConfiguration,
} from './addressVerification';
export type {
  AddressVerification, SendDecision, Verdict, VerificationCode, StageResult,
} from './addressVerification';

/**
 * The two account-lifecycle sends, as one call each.
 *
 * NEITHER THROWS. A provider outage must not fail the registration or the
 * invitation that triggered it: the account is already created and durable, and
 * turning "the email did not go" into "the sign-up failed" loses the account as
 * well as the message. The caller gets the result and reports it, which is why
 * both return it rather than void.
 *
 * THE TOKEN IS MINTED HERE, not by the caller, so there is no path that sends a
 * link without recording it or records one without sending.
 */

/** Confirm the address somebody just registered with. */
export async function sendVerificationEmail(
  userId: string,
  email: string,
  firstName: string | null,
): Promise<EmailResult> {
  const { token } = await issue(userId, email, 'verify');
  const rendered = verifyEmail(firstName, token);
  return sendEmail({
    to: email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    templateKey: 'account.verify_email',
    userId,
  });
}

/**
 * Invite a colleague.
 *
 * The link is the ONLY way into an invited account: `invite` creates the row
 * with an unusable credential and `is_active = FALSE`, so an invitation that is
 * never delivered leaves a person who cannot sign in and cannot ask for a reset
 * either. That is why the caller is told whether this landed rather than
 * assuming it.
 */
export async function sendInvitationEmail(input: {
  userId: string;
  email: string;
  firstName: string | null;
  roleLabel: string;
  invitedBy: string | null;
  invitedByUserId?: string | null;
}): Promise<EmailResult> {
  const { token } = await issue(input.userId, input.email, 'invite', input.invitedByUserId ?? null);
  const rendered = invitation(input.firstName, input.invitedBy, input.roleLabel, token);
  return sendEmail({
    to: input.email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    templateKey: 'account.invitation',
    userId: input.userId,
  });
}

/**
 * Warn once, at boot, about the one combination that locks people out.
 *
 * Verification required with no provider configured means every new
 * registration issues a token nobody can receive. That is a deployment mistake
 * rather than a code one, and the only place it can be caught before a user
 * finds it is at start-up.
 */
export function reportEmailReadiness(): void {
  /* Said at boot because the checking policy is invisible otherwise: an
     operator who has set EMAIL_ADDRESS_CHECK_MODE=off and forgotten will
     otherwise discover it from a bounce report. */
  const check = config.email.addressCheck;
  console.log(
    `[email] address checking is ${check.mode}` +
      `; mailbox probing ${check.probe ? 'ON (needs outbound port 25)' : 'off — domains are checked, individual mailboxes are not'}` +
      `${check.mode === 'enforce' ? `; refusing undeliverable${check.blockPlaceholder ? ', placeholder' : ''}${check.blockDisposable ? ', disposable' : ''}${check.blockRole ? ', role' : ''} addresses` : ''}`,
  );

  if (isEmailConfigured()) {
    console.log(
      `[email] sendgrid configured, sending as ${config.email.fromName} <${config.email.fromAddress}>` +
        `; links point at ${config.email.appBaseUrl}`,
    );
    return;
  }
  if (config.email.verificationRequired) {
    console.error(
      '[email] EMAIL_VERIFICATION_REQUIRED is true but no provider is configured — ' +
        'every new account will be unable to verify and therefore unable to sign in. ' +
        'Set SENDGRID_API_KEY and EMAIL_FROM_ADDRESS, or set EMAIL_VERIFICATION_REQUIRED=false.',
    );
    return;
  }
  console.warn(
    '[email] no provider configured; verification and invitation emails will be recorded as ' +
      'skipped rather than sent. Set SENDGRID_API_KEY and EMAIL_FROM_ADDRESS to enable them.',
  );
}
