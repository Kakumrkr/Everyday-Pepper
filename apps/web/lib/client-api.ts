import { z } from 'zod';

/**
 * The outcome of a browser call to the api, with a message fit to show the user. A failure
 * keeps the api's body for answers that carry more (the 409 `slot_unavailable` alternatives).
 */
export type CallResult<T> =
  { ok: true; data: T } | { ok: false; status: number; message: string; body?: unknown };

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
  forbidden: 'Your role in this business doesn’t allow this.',
  member_not_found: 'That person is no longer in this business.',
  last_owner: 'A business needs at least one owner. Make someone else an owner first.',
  already_a_member: 'They’re already in this business.',
  invite_invalid: 'This invite link no longer works. Ask for a new one.',
  invite_wrong_account:
    'This invite is for a different email. Sign in with the email it was sent to.',
  invite_not_found: 'That invite was already used or cancelled.',
  invite_limit_reached: 'You have 20 open invites. Cancel some before inviting more.',
  feed_item_not_found: 'That suggestion is no longer open.',
  service_not_found: 'That service is no longer on the menu.',
  service_name_taken: 'You already have a service with this name.',
  staff_member_link_taken: 'That login is already linked to another staff member.',
  time_off_not_found: 'That time off was already removed.',
  staff_member_not_found: 'That staff member is no longer bookable.',
  client_not_found: 'I couldn’t find that client.',
  client_email_taken: 'A client with this email already exists. Search for them instead.',
  booking_not_found: 'That booking is gone, or it isn’t yours to change.',
  slot_unavailable: 'That time can’t be booked.',
  booking_not_changeable: 'This booking can’t be changed any more.',
  booking_not_started: 'Mark it done or a no-show once it has started.',
  waitlist_expired: 'Those times have already passed.',
  waitlist_day_too_far: 'That day is too far ahead. Pick a sooner day.',
  waitlist_offer_not_found: 'This offer link doesn’t work. Contact the business instead.',
  waitlist_offer_used: 'You already claimed this time. Check your email for the booking.',
  waitlist_offer_taken: 'Sorry, someone else claimed this time first.',
  waitlist_offer_expired: 'Sorry, this offer has expired.',
  booking_page_not_found: 'This booking page doesn’t exist.',
  booking_request_not_found: 'That booking request has expired. Start again.',
  booking_request_expired: 'That code has expired. Send a new one.',
  booking_request_used: 'This booking is already confirmed. Check your email.',
  wrong_code: 'That code isn’t right. Check the email and try again.',
  too_many_requests: 'Too many tries. Wait a little and try again.',
  email_unavailable: 'Online booking isn’t available right now. Contact the business.',
  temporarily_unavailable: 'This isn’t available right now. Try again in a moment.',
  // Chat and the AI's proposals and actions (S26).
  turn_in_progress: 'I’m still answering your last message. Wait for it, or press Stop.',
  conversation_not_found: 'That conversation is gone. Start a new one.',
  proposal_not_found: 'That suggestion is gone, or it isn’t yours to decide.',
  proposal_not_pending: 'That was already decided, or replaced by a newer version.',
  action_not_found: 'That action is gone, or it isn’t yours to undo.',
  undo_window_closed: 'This can no longer be undone.',
  undo_refused: 'This can’t be undone any more: things changed since. Nothing was changed.',
  // What Pepper remembers (S32).
  memory_fact_not_found: 'I no longer remember that.',
  memory_subject_not_found: 'That client, team member, service or visit is gone.',
  memory_episode_not_found: 'I no longer remember that conversation.',
  memory_limit_reached: 'I remember as much as I can here. Delete something first.',
  memory_paused: 'Remembering new things is paused for this business.',
  // Rebooking emails (S36).
  draft_refused:
    'Leave out links, email addresses, phone numbers and anything sensitive, and keep it to 120 words.',
  nudge_not_sendable: 'This email can’t go to this client any more. Nothing was sent.',
  unsubscribe_link_invalid: 'This unsubscribe link doesn’t work. Contact the business instead.',
};

const FALLBACK = 'Something went wrong. Try again.';
const TOO_MANY = 'Too many attempts. Wait a few seconds and try again.';
const OFFLINE = {
  ok: false,
  status: 0,
  message: 'You seem to be offline. Check your connection.',
} as const;

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
 * browser adds the session cookie and the `Origin` header the api checks. `body` `undefined`
 * sends none (e.g. for `DELETE`).
 */
export async function sendJson<T = unknown>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CallResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      ...(body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      credentials: 'same-origin',
    });
  } catch {
    return OFFLINE;
  }
  return answerOf<T>(response);
}

/**
 * Reads JSON from the app's own origin (`/v1/*`), checked against `schema`: an answer of
 * another shape is a failure, like any refusal.
 */
export async function fetchJson<T extends z.ZodType>(
  path: string,
  schema: T,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CallResult<z.infer<T>>> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin' });
  } catch {
    return OFFLINE;
  }
  const answer = await answerOf(response);
  if (!answer.ok) return answer;
  const parsed = schema.safeParse(answer.data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, status: response.status, message: FALLBACK };
}

async function answerOf<T>(response: Response): Promise<CallResult<T>> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: messageFor(response.status, data),
      body: data,
    };
  }
  return { ok: true, data: data as T };
}
