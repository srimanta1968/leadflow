import { AppError } from '../utils/errors';
import { LoginInput, RegisterInput } from '../types';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LENGTH = 8;

/** Read a required string field, trimming it and rejecting blanks. */
function requireString(body: Record<string, unknown>, field: string, max: number): string {
  const raw = body[field];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw AppError.badRequest(`'${field}' is required`, { field });
  }
  const value = raw.trim();
  if (value.length > max) {
    throw AppError.badRequest(`'${field}' must be at most ${max} characters`, { field });
  }
  return value;
}

/** Read an optional string field, returning undefined when absent or blank. */
function optionalString(
  body: Record<string, unknown>,
  field: string,
  max: number
): string | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw AppError.badRequest(`'${field}' must be a string`, { field });
  }
  const value = raw.trim();
  if (value.length === 0) {
    return undefined;
  }
  if (value.length > max) {
    throw AppError.badRequest(`'${field}' must be at most ${max} characters`, { field });
  }
  return value;
}

/**
 * Validate a POST /api/auth/register body.
 * @throws AppError(400 VALIDATION_ERROR) when a field is missing or malformed.
 */
export function validateRegister(body: Record<string, unknown>): RegisterInput {
  const email = requireString(body, 'email', 255).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw AppError.badRequest("'email' must be a valid email address", { field: 'email' });
  }

  const password = requireString(body, 'password', 200);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw AppError.badRequest(
      `'password' must be at least ${MIN_PASSWORD_LENGTH} characters`,
      { field: 'password' }
    );
  }

  return {
    email,
    password,
    username: optionalString(body, 'username', 100),
    first_name: optionalString(body, 'first_name', 100),
    last_name: optionalString(body, 'last_name', 100),
    phone: optionalString(body, 'phone', 40),
  };
}

/**
 * Validate a POST /api/auth/login body.
 * @throws AppError(400 VALIDATION_ERROR) when a field is missing or malformed.
 */
export function validateLogin(body: Record<string, unknown>): LoginInput {
  return {
    email: requireString(body, 'email', 255).toLowerCase(),
    password: requireString(body, 'password', 200),
  };
}
