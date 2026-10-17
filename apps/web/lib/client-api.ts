import { z } from 'zod';

/** The outcome of a browser call to the api, with a message fit to show the user. */
export type CallResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

const ErrorBodySchema = z.object({ code: z.string().optional(), message: z.string().optional() });

// Better Auth codes and our own (ApiErrorCodeSchema), in words a business owner understands.
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'That email and password don’t match.',
  INVALID_EMAIL: 'Enter a valid email address.',
  USER_ALREADY_EXISTS: 'An account with this email already exists. Sign in instead.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    'An account with this email already exists. Sign in instead.',
  PASSWORD_TOO_SHORT: 'Use a password of at least 10 characters.',
  PASSWORD_TOO_LONG: 'Use a password of at most 128 characters.',
  INVALID_PASSWORD: 'That password isn’t right.',
  INVALID_CODE: 'That code didn’t work. Check your authenticator app and try again.',
  INVALID_BACKUP_CODE: 'That backup code didn’t work.',
  INVALID_TWO_FACTOR_COOKIE: 'Your sign-in timed out. Start again.',
  ACCOUNT_TEMPORARILY_LOCKED: 'Too many wrong codes. Try again in 15 minutes.',
  slug_taken: 'That booking link is taken. Try another.',
  business_limit_reached: 'One account can own at most 5 businesses.',
  validation_failed: 'Some fields need another look.',
  unauthenticated: 'Your session ended. Sign in again.',
};

const FALLBACK = 'Something went wrong. Try again.';
const TOO_MANY = 'Too many attempts. Wait a few seconds and try again.';

/** The message for a failed call: by code, else rate limiting, else a generic one. */
export function messageFor(status: number, body: unknown): string {
  const parsed = ErrorBodySchema.safeParse(body);
  const code = parsed.success ? parsed.data.code : undefined;
  if (code !== undefined && code in MESSAGES) return MESSAGES[code] ?? FALLBACK;
  if (status === 429) return TOO_MANY;
  return FALLBACK;
}

/**
 * Sends JSON to the app's own origin (`/api/auth/*` or `/v1/*`, forwarded to the api). The
 * browser adds the session cookie and the `Origin` header the api checks.
 */
export async function sendJson<T = unknown>(
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CallResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, status: 0, message: 'You seem to be offline. Check your connection.' };
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok)
    return { ok: false, status: response.status, message: messageFor(response.status, data) };
  return { ok: true, data: data as T };
}
