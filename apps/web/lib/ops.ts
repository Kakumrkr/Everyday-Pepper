import {
  OperatorMeSchema,
  SAVED_REPLY_FIRST_NAME,
  SUPPORT_OVERDUE_HOURS,
  type HeldReason,
  type OperatorInboxView,
  type OperatorMe,
  type PublicSupportStatus,
  type SupportRating,
  type SupportReference,
  type SupportMailStop,
  type SupportStatus,
} from '@pepper/contracts';
import { errorCodeOf } from './client-api';

// Pepper's support console (S59.2, ADR-0062, AC-X-19…22): its paths and words. The api decides
// who may open it; these only say things.

export const OPS_PATHS = {
  inbox: '/ops',
  replies: '/ops/replies',
  held: '/ops/held',
  metrics: (days: 7 | 30 = 7) => (days === 7 ? '/ops/metrics' : '/ops/metrics?days=30'),
  view: (view: OperatorInboxView) => (view === 'waiting' ? '/ops' : `/ops?view=${view}`),
  thread: (id: string) => `/ops/threads/${id}`,
  request: (id: string) => `/ops/requests/${id}`,
} as const;

export const OPS_VIEWS: readonly { value: OperatorInboxView; label: string }[] = [
  { value: 'waiting', label: 'Waiting on us' },
  { value: 'answered', label: 'Answered' },
  { value: 'solved', label: 'Solved' },
];

/** The inbox view a `?view=` names; anything else is the waiting view. */
export function opsView(value: string | string[] | undefined): OperatorInboxView {
  return value === 'answered' || value === 'solved' ? value : 'waiting';
}

type Tone = 'neutral' | 'info' | 'ok';

/** A business thread's status in the console's words (the team's side of AC-X-15's words). */
export const OPS_THREAD_STATUS: Readonly<Record<SupportStatus, { label: string; tone: Tone }>> = {
  waiting_on_pepper: { label: 'Waiting on us', tone: 'neutral' },
  pepper_replied: { label: 'We replied', tone: 'info' },
  solved: { label: 'Solved', tone: 'ok' },
};

export const OPS_PUBLIC_STATUS: Readonly<
  Record<PublicSupportStatus, { label: string; tone: Tone }>
> = {
  open: { label: 'Open', tone: 'neutral' },
  answered: { label: 'Answered', tone: 'info' },
  solved: { label: 'Solved', tone: 'ok' },
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long a request has waited, in words (AC-X-20): "Just in", "12 min", "3 h", "2 d".
 * Whole units, rounded down; a clock a little ahead of the server reads "Just in".
 */
export function waitedFor(since: string, now: number): string {
  const waited = now - Date.parse(since);
  if (!Number.isFinite(waited) || waited < MINUTE) return 'Just in';
  if (waited < HOUR) return `${String(Math.floor(waited / MINUTE))} min`;
  if (waited < DAY) return `${String(Math.floor(waited / HOUR))} h`;
  return `${String(Math.floor(waited / DAY))} d`;
}

/** "3 h waiting" in the waiting view; "3 h ago" in the others. */
export function waitingWords(view: OperatorInboxView, since: string, now: number): string {
  const waited = waitedFor(since, now);
  if (waited === 'Just in') return waited;
  return view === 'waiting' ? `${waited} waiting` : `${waited} ago`;
}

/** Waited past the same day we promise (AC-X-14's "we answer the same day"): 4 h and more. */
export function waitedLong(since: string, now: number): boolean {
  return now - Date.parse(since) >= SUPPORT_OVERDUE_HOURS * HOUR;
}

/**
 * What the inbox says of a request waiting past the same-day promise (S59.2.2, AC-X-25): in
 * words, not only in colour. `null` in the other views and under 4 h.
 */
export function overdueNote(view: OperatorInboxView, since: string, now: number): string | null {
  return view === 'waiting' && waitedLong(since, now)
    ? `Over ${String(SUPPORT_OVERDUE_HOURS)} h: answer next`
    : null;
}

/** The opener's "Did this help?" in the console's words (AC-X-26). */
export const OPS_RATING: Readonly<Record<SupportRating, { label: string; tone: 'ok' | 'warn' }>> = {
  helpful: { label: 'Helpful', tone: 'ok' },
  not_helpful: { label: 'Not helpful', tone: 'warn' },
};

/**
 * A saved reply ready to edit (AC-X-23): `{first name}` becomes the requester's first name, or
 * "there" ("Hi there,") when there is none.
 */
export function fillSavedReply(body: string, requesterName: string | null): string {
  const first = requesterName?.trim().split(/\s+/)[0] ?? '';
  return body.split(SAVED_REPLY_FIRST_NAME).join(first === '' ? 'there' : first);
}

/**
 * A reply by email to someone who couldn't sign in (AC-X-21): the console never sends mail to
 * a typed address itself (AC-X-17); the team writes from their own inbox, the reference in
 * the subject.
 */
export function replyByEmailHref(email: string, reference: SupportReference): string {
  const subject = encodeURIComponent(`Re: [${reference}] Your Pepper support request`);
  return `mailto:${encodeURIComponent(email).replace('%40', '@')}?subject=${subject}`;
}

/** The inbox header's count of held mail (S59.3.2's top-up, AC-X-46); `null` for none. */
export function heldLabel(held: number): string | null {
  return held > 0 ? `${String(held)} held` : null;
}

/** Why an email was held, in words the team can act on (AC-X-44). */
export const OPS_HELD_REASON: Readonly<Record<HeldReason, string>> = {
  unknown_sender: 'Not from someone who may write there',
  unverified_sender: 'Sender not verified',
};

/** "Mail stopped" on a request (AC-X-43), in words: why, and since when (UTC date). */
export function mailStoppedWords(stop: {
  reason: SupportMailStop['reason'];
  since: string;
}): string {
  const day = new Date(stop.since).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return stop.reason === 'complaint'
    ? `Mail stopped: they marked our email as spam (${day})`
    : `Mail stopped: their address bounced (${day})`;
}

/** What `/ops` may show the signed-in account (AC-X-19). */
export type OpsAccess =
  | { state: 'operator'; me: OperatorMe }
  | { state: 'mfa_required' }
  | { state: 'refused' }
  | { state: 'unavailable' };

/**
 * `GET /v1/ops/me`'s answer as what the console shows: the console, "turn on two-step
 * verification" (only an operator hears `mfa_required`: the api checks the grant first), not
 * found, or "try again".
 */
export function opsAccessOf(status: number, body: unknown): OpsAccess {
  if (status === 200) {
    const me = OperatorMeSchema.safeParse(body);
    return me.success ? { state: 'operator', me: me.data } : { state: 'unavailable' };
  }
  if (status === 403 && errorCodeOf(body) === 'mfa_required') return { state: 'mfa_required' };
  if (status === 401 || status === 403) return { state: 'refused' };
  return { state: 'unavailable' };
}
