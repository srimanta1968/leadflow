import { Request, Response } from 'express';
import { AuthService } from '../services/AuthService';
import { consume, sendVerificationEmail } from '../platform/email';
import { validateLogin, validateRegister } from '../validators/authValidators';
import { AuthenticatedRequest } from '../middleware/auth';
import { AppError } from '../utils/errors';

/**
 * HTTP surface for the authentication adapter.
 *
 * Status codes follow the project convention: creating a user at the collection
 * root returns 201; exchanging credentials for a token is an action, so it
 * returns 200; reads return 200.
 */
export class AuthController {
  /**
   * POST /api/auth/register — create a user and return a session token.
   *
   * THE VERIFICATION EMAIL IS SENT AFTER THE ACCOUNT EXISTS, and its failure is
   * REPORTED rather than thrown. The account is already durable at that point;
   * turning "the mail did not go" into "the sign-up failed" would lose the
   * account as well as the message, and the caller can offer a resend. The
   * response says which happened so the client does not claim "check your
   * inbox" for a message nobody sent.
   */
  static async register(req: Request, res: Response): Promise<void> {
    const input = validateRegister(req.body as Record<string, unknown>);
    const result = await AuthService.register(input);

    const delivery = await sendVerificationEmail(
      result.user.id, result.user.email, result.user.first_name ?? null,
    );

    res.status(201).json({
      success: true,
      data: {
        ...result,
        email_verification: {
          sent: delivery.status === 'sent',
          status: delivery.status,
          /* STATED, not implied by an absent field. "skipped" means no provider
             is configured — a valid deployment — and a client that cannot tell
             it from "sent" tells the person to check an inbox nothing is
             arriving in. */
          detail:
            delivery.status === 'sent'
              ? 'A confirmation link has been sent to that address.'
              : delivery.status === 'skipped'
                ? 'Email is not configured on this deployment, so no confirmation was sent.'
                : /* BLOCKED CARRIES ITS REASON THROUGH. This is the one failure
                     the person reading it can fix themselves — "there is no
                     domain called gmial.com" tells them to correct the address,
                     where "could not be sent" tells them to wait for something
                     that will never happen. */
                  delivery.status === 'blocked'
                  ? `That address cannot receive email: ${delivery.verification?.reason ?? 'it did not pass the deliverability check'}`
                  : 'The confirmation email could not be sent. You can request another.',
          /* The verdict itself, for a client that wants to offer "did you mean"
             rather than re-render the sentence. */
          address_check: delivery.verification ?? null,
        },
      },
    });
  }

  /**
   * POST /api/auth/verify-email — redeem a confirmation link.
   *
   * UNAUTHENTICATED BY DESIGN. The token IS the proof, and requiring a session
   * would mean somebody who cannot sign in until they verify can never verify.
   */
  static async verifyEmail(req: Request, res: Response): Promise<void> {
    const token = typeof (req.body as { token?: unknown })?.token === 'string'
      ? String((req.body as { token: string }).token)
      : '';
    if (token === '') throw AppError.badRequest('token is required');

    const claim = await consume(token, 'verify');
    /* ONE ANSWER FOR WRONG, SPENT AND EXPIRED. Distinguishing them lets an
       anonymous caller probe for live tokens. */
    if (!claim) {
      throw AppError.badRequest('That confirmation link is not valid, has already been used, or has expired.');
    }

    await AuthService.markEmailVerified(claim.userId);
    res.status(200).json({
      success: true,
      data: { verified: true, email: claim.email },
    });
  }

  /**
   * POST /api/auth/resend-verification — send another confirmation link.
   *
   * ALWAYS ANSWERS THE SAME WAY, whether or not the address is on the register.
   * A different response for a known address turns this into a way to discover
   * who has an account.
   */
  static async resendVerification(req: Request, res: Response): Promise<void> {
    const email = typeof (req.body as { email?: unknown })?.email === 'string'
      ? String((req.body as { email: string }).email).trim().toLowerCase()
      : '';
    if (email === '') throw AppError.badRequest('email is required');

    const user = await AuthService.findUnverifiedByEmail(email);
    if (user) {
      await sendVerificationEmail(user.id, user.email, user.first_name ?? null);
    }
    res.status(200).json({
      success: true,
      data: {
        note: 'If that address has an unconfirmed account, a new confirmation link is on its way.',
      },
    });
  }

  /**
   * POST /api/auth/accept-invitation — set the first password and activate.
   *
   * An invited account is created with an UNUSABLE credential and is_active
   * FALSE, so this link is the only way in: without it the person has an
   * account they cannot sign in to and cannot reset either.
   */
  static async acceptInvitation(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as { token?: unknown; password?: unknown };
    const token = typeof body.token === 'string' ? body.token : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (token === '') throw AppError.badRequest('token is required');
    if (password.length < 8) throw AppError.badRequest('password must be at least 8 characters');

    const claim = await consume(token, 'invite');
    if (!claim) {
      throw AppError.badRequest('That invitation is not valid, has already been used, or has expired.');
    }

    /* Accepting an invitation proves the address as surely as a verification
       link does — the token only ever existed in an email sent to it — so this
       marks it verified rather than asking the person to confirm twice. */
    const result = await AuthService.acceptInvitation(claim.userId, password);
    res.status(200).json({ success: true, data: result });
  }

  /** POST /api/auth/login — exchange credentials for a session token. */
  static async login(req: Request, res: Response): Promise<void> {
    const input = validateLogin(req.body as Record<string, unknown>);
    const result = await AuthService.login(input);
    res.status(200).json({ success: true, data: result });
  }

  /** GET /api/auth/me — return the caller's own user projection. */
  static async me(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!req.session) {
      throw AppError.unauthenticated();
    }
    const user = await AuthService.getById(req.session.userId);
    res.status(200).json({ success: true, data: { user } });
  }
}
