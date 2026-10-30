import {
  addDays,
  formatDate,
  ManageTokenSchema,
  OfferTokenSchema,
  parseDate,
  PhoneSchema,
  type BookingFunnelStep,
  type CivilDate,
  type PublicOffer,
  type PublicBusiness,
  type PublicService,
  type PublicStaffMember,
} from '@pepper/contracts';
import { dayRange, todayIn } from './calendar';
import { normalizeContact } from './booking';
import { plainZoneName } from './time-zones';
import type { CallResult } from './client-api';
import { z } from 'zod';

// The public booking page (S17, ADR-0022): pure helpers for the client's screens. The api
// decides everything; these shape what the page asks and shows.

/** How many days ahead the page's day strip offers. */
export const BOOKING_DAYS = 14;

/**
 * Tells the api a visit entered a booking step (S47, AC-W8-9): a random visit id and the step,
 * nothing about the client. Never waits and never fails the page; `keepalive` lets the last
 * one go out as the client leaves.
 */
export function recordBookingStep(
  slug: string,
  visitId: string,
  step: BookingFunnelStep,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): void {
  fetch(publicApiPath(slug, '/funnel'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitId, step }),
    credentials: 'same-origin',
    keepalive: true,
  }).catch(() => undefined);
}

/**
 * A random id for one visit (a v4 UUID). `crypto.randomUUID` exists only on https and
 * localhost; over plain http the page builds one from `getRandomValues`, so it never breaks.
 */
export function newVisitId(
  cryptoApi: Pick<Crypto, 'getRandomValues'> & Partial<Crypto> = crypto,
): string {
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The api path of a business's booking page, plus `rest`. */
export function publicApiPath(slug: string, rest = ''): string {
  return `/v1/public/businesses/${encodeURIComponent(slug)}${rest}`;
}

/** `GET …/availability` over [from, to), with one staff member or anyone. */
function availabilityPath(
  slug: string,
  range: { from: string; to: string },
  query: { serviceId: string; staffMemberId: string | null },
): string {
  const params = new URLSearchParams({ ...range, serviceId: query.serviceId });
  if (query.staffMemberId !== null) params.set('staffMemberId', query.staffMemberId);
  return `${publicApiPath(slug, '/availability')}?${params.toString()}`;
}

/** `GET …/availability` over one local day, with one staff member or anyone. */
export function publicAvailabilityPath(
  slug: string,
  timeZone: string,
  date: CivilDate,
  query: { serviceId: string; staffMemberId: string | null },
): string {
  return availabilityPath(slug, dayRange(timeZone, date), query);
}

/**
 * `GET …/availability` over the whole strip, first day to last (S46, AC-W8-4): one request,
 * well inside the api's 62 days, to find the first day with a free time.
 */
export function publicRangePath(
  slug: string,
  timeZone: string,
  days: readonly Pick<StripDay, 'date'>[],
  query: { serviceId: string; staffMemberId: string | null },
): string | null {
  const first = days[0];
  const last = days.at(-1);
  if (first === undefined || last === undefined) return null;
  const range = {
    from: dayRange(timeZone, parseDate(first.date)).from,
    to: dayRange(timeZone, parseDate(last.date)).to,
  };
  return availabilityPath(slug, range, query);
}

/**
 * What the strip-wide answer says about where to open (AC-W8-4): the day of its earliest time
 * (the api answers earliest first, so a cut-off answer still has it); `none` only when the
 * whole answer is in and empty; `unknown` when it cannot tell (a cut-off answer with no time,
 * or a first time outside the strip), so the strip stays where it is.
 */
export function firstFreeDay(
  answer: { slots: readonly { startsAt: string }[]; truncated: boolean },
  timeZone: string,
  days: readonly Pick<StripDay, 'date'>[],
): { kind: 'day'; date: string } | { kind: 'none' } | { kind: 'unknown' } {
  const earliest = answer.slots
    .map((slot) => Date.parse(slot.startsAt))
    .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
  if (earliest === Number.POSITIVE_INFINITY) {
    return answer.truncated ? { kind: 'unknown' } : { kind: 'none' };
  }
  const date = formatDate(todayIn(timeZone, earliest));
  return days.some((day) => day.date === date) ? { kind: 'day', date } : { kind: 'unknown' };
}

/** One day of the strip. */
export interface StripDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** `Tue`. */
  weekday: string;
  /** `3`. */
  day: number;
  /** `Nov`. */
  month: string;
  /** `Tuesday, November 3`, for screen readers. */
  label: string;
}

/** The next `count` days on the business's clock, today first. */
export function upcomingDays(timeZone: string, now: number, count = BOOKING_DAYS): StripDay[] {
  const today = todayIn(timeZone, now);
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(today, i);
    // Noon UTC of the civil date names the right weekday in any zone.
    const noon = new Date(Date.UTC(date.year, date.month - 1, date.day, 12));
    const part = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(noon);
    return {
      date: formatDate(date),
      weekday: part({ weekday: 'short' }),
      day: date.day,
      month: part({ month: 'short' }),
      label: part({ weekday: 'long', month: 'long', day: 'numeric' }),
    };
  });
}

/** The staff members who offer a service. */
export function staffFor(
  business: Pick<PublicBusiness, 'staff'>,
  serviceId: string,
): PublicStaffMember[] {
  return business.staff.filter((member) => member.serviceIds.some((id) => id === serviceId));
}

/** A service by id, or `undefined`. */
export function serviceOf(
  business: Pick<PublicBusiness, 'services'>,
  serviceId: string | null,
): PublicService | undefined {
  return business.services.find((service) => service.id === serviceId);
}

/**
 * The business's clock in words (DESIGN.md §6, no zone ids): its plain name ("Central Time",
 * S46), else its city (`Europe/Paris` → "Paris time"), "UTC", or an offset zone by its offset
 * ("GMT-5": Etc's own names invert the sign), the offset in force `at` that moment (now).
 */
export function localTimeLabel(timeZone: string, at: number = Date.now()): string {
  const plain = plainZoneName(timeZone);
  if (plain !== undefined) return plain;
  if (
    ['UTC', 'GMT', 'Etc/UTC', 'Etc/GMT', 'Etc/UCT', 'Etc/Universal', 'Etc/Zulu'].includes(timeZone)
  ) {
    return 'UTC';
  }
  if (timeZone.startsWith('Etc/') || !timeZone.includes('/')) {
    const offset = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
    return offset ?? timeZone;
  }
  const city = timeZone.split('/').at(-1)?.replaceAll('_', ' ') ?? timeZone;
  return `${city} time`;
}

/** Up to two initials of a name: `Juniper Hair Studio` → `JH`. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((word) => /^\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

export interface ClientDetails {
  name: string;
  email: string;
  /** E.164 or `null`. */
  phone: string | null;
}

export type DetailsCheck =
  | { ok: true; details: ClientDetails }
  | { ok: false; errors: Partial<Record<keyof ClientDetails, string>> };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Checks the details form; US phone numbers may be typed locally. */
export function checkDetails(form: { name: string; email: string; phone: string }): DetailsCheck {
  const name = form.name.trim();
  const email = form.email.trim();
  const phoneText = form.phone.trim();
  const phone = phoneText === '' ? null : normalizeContact(phoneText);
  const errors: Partial<Record<keyof ClientDetails, string>> = {};
  if (name.length < 1 || name.length > 120) {
    errors.name = 'Enter your name so the business knows who’s coming.';
  }
  if (!EMAIL.test(email) || email.length > 254) {
    errors.email = 'Enter a valid email. We’ll send your code there.';
  }
  if (phone !== null && !PhoneSchema.safeParse(phone).success) {
    errors.phone = 'Enter a phone number like (555) 123-4567, or leave it empty.';
  }
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, details: { name, email, phone } };
}

/** The link secret from the page's fragment (`#<token>`), or `null` for a broken link. */
export function readManageToken(hash: string): string | null {
  const token = hash.startsWith('#') ? hash.slice(1) : hash;
  return ManageTokenSchema.safeParse(token).success ? token : null;
}

/** The claim secret from a waitlist offer link's fragment, or `null` when it is broken (S37). */
export function readOfferToken(hash: string): string | null {
  const token = hash.startsWith('#') ? hash.slice(1) : hash;
  return OfferTokenSchema.safeParse(token).success ? token : null;
}

/**
 * What an offer's state means for the client (S37). A used or taken offer never says who has
 * the time; only an open one can be claimed.
 */
export function offerStateText(status: PublicOffer['status']): string | null {
  switch (status) {
    case 'open':
      return null;
    case 'claimed':
      return 'You already claimed this time. Check your email for your booking.';
    case 'taken':
      return 'Sorry, someone else claimed this time first. You’re still on the waitlist.';
    case 'expired':
      return 'Sorry, this offer has expired. You’re still on the waitlist.';
  }
}

/**
 * What a refused claim says about the offer now (S37): 409 `waitlist_offer_used` is this
 * client's own claim, any other 409 someone else's (or the time went), 410 past its time.
 * `null`: not about the offer (a network error, a rate limit), so the page says try again.
 */
export function refusedClaimStatus(
  result: CallResult<unknown>,
): Exclude<PublicOffer['status'], 'open'> | null {
  if (result.ok) return null;
  if (result.status === 410) return 'expired';
  if (result.status !== 409) return null;
  const code = z.object({ code: z.string() }).safeParse(result.body);
  return code.success && code.data.code === 'waitlist_offer_used' ? 'claimed' : 'taken';
}

/** The client's page for their booking, with the secret in the fragment. */
export function managePath(slug: string, token: string): string {
  return `/book/${encodeURIComponent(slug)}/manage#${token}`;
}

/** What a failed confirmation means for the client, by the api's answer. */
export function confirmProblem(
  status: number,
  body: unknown,
): 'wrong_code' | 'expired' | 'used' | 'taken' | 'other' {
  const code = typeof body === 'object' && body !== null && 'code' in body ? body.code : undefined;
  if (code === 'wrong_code') return 'wrong_code';
  if (code === 'booking_request_expired' || code === 'booking_request_not_found') return 'expired';
  if (code === 'booking_request_used') return 'used';
  if (status === 409 && code === 'slot_unavailable') return 'taken';
  return 'other';
}
