import { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCodes } from '../utils/errors';
import { ApiFailure } from '../types';

/**
 * Terminal error handler. Converts anything thrown in the request pipeline into
 * the project's `{ success:false, error, code }` envelope.
 *
 * An AppError carries its own status and code. Anything else is reported as a
 * 500 INTERNAL_ERROR with a generic message — internal failure text is logged
 * server-side but never returned to the client.
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    const body: ApiFailure = {
      success: false,
      error: err.message,
      code: err.code,
    };
    if (err.details !== undefined) {
      body.details = err.details;
    }
    res.status(err.statusCode).json(body);
    return;
  }

  console.error('[errorHandler] unhandled error:', err.stack || err.message);

  const body: ApiFailure = {
    success: false,
    error: 'An unexpected error occurred',
    code: ErrorCodes.INTERNAL_ERROR,
  };
  res.status(500).json(body);
}

/** Catch-all for unmatched routes, so a 404 uses the same envelope. */
export function notFoundHandler(req: Request, res: Response): void {
  const body: ApiFailure = {
    success: false,
    error: `No route matches ${req.method} ${req.path}`,
    code: ErrorCodes.NOT_FOUND,
  };
  res.status(404).json(body);
}

/**
 * Wrap an async handler so a rejected promise reaches `errorHandler` instead of
 * becoming an unhandled rejection.
 */
export function asyncHandler<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: T, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
