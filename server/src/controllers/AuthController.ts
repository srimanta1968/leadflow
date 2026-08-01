import { Request, Response } from 'express';
import { AuthService } from '../services/AuthService';
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
  /** POST /api/auth/register — create a user and return a session token. */
  static async register(req: Request, res: Response): Promise<void> {
    const input = validateRegister(req.body as Record<string, unknown>);
    const result = await AuthService.register(input);
    res.status(201).json({ success: true, data: result });
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
