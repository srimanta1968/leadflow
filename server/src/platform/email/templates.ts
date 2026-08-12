import { config } from '../../config/env';

/**
 * The account-lifecycle messages, as text and HTML.
 *
 * WRITTEN FOR THE PERSON RECEIVING THEM, not for the system sending them. Each
 * one says who sent it, what it is for, what happens if the reader ignores it,
 * and when the link stops working — because a mail with a bare link and no
 * context is indistinguishable from a phishing attempt, and the people most
 * likely to click it are the ones we least want clicking unknown links.
 *
 * THE LINK IS SHOWN AS TEXT AS WELL AS LINKED. A button whose target cannot be
 * read is one a careful reader cannot verify before clicking, and a text-only
 * client renders nothing at all.
 *
 * NO TRACKING PIXEL, no click wrapper. This is transactional mail to somebody's
 * own account; instrumenting it would mean measuring a person's behaviour on a
 * message they cannot opt out of without losing access.
 */

const shell = (heading: string, body: string, cta: { url: string; label: string }): string => `
<div style="font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.6;color:#1c1c1a;max-width:34rem;margin:0 auto;padding:1.5rem">
  <h1 style="font-size:1.25rem;margin:0 0 1rem">${heading}</h1>
  ${body}
  <p style="margin:1.75rem 0">
    <a href="${cta.url}" style="background:#2f5fff;color:#fff;padding:.7rem 1.15rem;border-radius:6px;text-decoration:none;display:inline-block">${cta.label}</a>
  </p>
  <p style="font-size:.8rem;color:#6b6b64;margin:0 0 .35rem">
    If the button does not work, copy this address into your browser:
  </p>
  <p style="font-size:.8rem;color:#6b6b64;word-break:break-all;margin:0">${cta.url}</p>
  <hr style="border:none;border-top:1px solid #e2e2dd;margin:1.75rem 0">
  <p style="font-size:.78rem;color:#6b6b64;margin:0">
    Sent by ${config.appName}. If you were not expecting this, you can ignore it — nothing
    changes on your account unless the link above is opened.
  </p>
</div>`;

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** The link a person opens. Built from APP_BASE_URL so it is right per deployment. */
const link = (path: string, token: string): string =>
  `${config.email.appBaseUrl.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;

export function verifyEmail(firstName: string | null, token: string): RenderedEmail {
  const url = link('/verify-email', token);
  const hello = firstName ? `Hello ${firstName},` : 'Hello,';
  return {
    subject: `Confirm your email address for ${config.appName}`,
    text:
      `${hello}\n\n` +
      `Confirm this address so we know we can reach you about your ${config.appName} account.\n\n` +
      `${url}\n\n` +
      `The link works for 24 hours. If you did not create an account, ignore this message — ` +
      `nothing changes unless the link is opened.\n\n` +
      `${config.appName}\n`,
    html: shell(
      `Confirm your email address`,
      `<p>${hello}</p>
       <p>Confirm this address so we know we can reach you about your ${config.appName} account.
          Until you do, we will not send you anything else.</p>
       <p style="font-size:.9rem;color:#6b6b64">The link works for <strong>24 hours</strong>.</p>`,
      { url, label: 'Confirm my email address' },
    ),
  };
}

export function invitation(
  firstName: string | null,
  invitedBy: string | null,
  roleLabel: string,
  token: string,
): RenderedEmail {
  const url = link('/accept-invitation', token);
  const hello = firstName ? `Hello ${firstName},` : 'Hello,';
  const who = invitedBy ? `${invitedBy} has` : 'An administrator has';
  return {
    subject: `${who.replace(' has', '')} invited you to ${config.appName}`,
    text:
      `${hello}\n\n` +
      `${who} invited you to ${config.appName} as ${roleLabel}.\n\n` +
      `Choose a password and your account is ready:\n${url}\n\n` +
      `The invitation expires in 7 days. Until you accept it your account exists but ` +
      `cannot be signed in to.\n\n` +
      `${config.appName}\n`,
    html: shell(
      `You have been invited to ${config.appName}`,
      `<p>${hello}</p>
       <p>${who} invited you to ${config.appName} as <strong>${roleLabel}</strong>.</p>
       <p>Choose a password and your account is ready to use.</p>
       <p style="font-size:.9rem;color:#6b6b64">
         The invitation expires in <strong>7 days</strong>. Until you accept it, your account
         exists but cannot be signed in to.
       </p>`,
      { url, label: 'Accept the invitation' },
    ),
  };
}
