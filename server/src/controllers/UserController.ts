import { Response } from 'express';
import { dataService } from '../services/DataService';
import { AuthenticatedRequest } from '../middleware/auth';
import { PublicUser, UserRow } from '../types';

/**
 * HTTP surface for the team roster.
 *
 * Any signed-in operator may read the roster — routing configuration, ownership
 * reassignment and coverage all need to name a colleague, and hiding the roster
 * from the people who must route to it would make the product unusable. The
 * projection returned here never includes the password hash.
 */
export class UserController {
  /** GET /api/users — list users who can own a lead. */
  static async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const activeOnly = req.query.active !== 'false';

    const rows = activeOnly
      ? await dataService.query<UserRow>(
          'SELECT * FROM users WHERE is_active = TRUE ORDER BY created_at ASC'
        )
      : await dataService.query<UserRow>('SELECT * FROM users ORDER BY created_at ASC');

    const users: PublicUser[] = rows.map((row) => ({
      id: row.id,
      email: row.email,
      username: row.username,
      first_name: row.first_name,
      last_name: row.last_name,
      phone: row.phone,
      role: row.role,
      is_active: row.is_active,
      email_verified: row.email_verified,
      last_login: row.last_login ? row.last_login.toISOString() : null,
      created_at: row.created_at.toISOString(),
    }));

    res.status(200).json({ success: true, data: { users, total: users.length } });
  }
}
