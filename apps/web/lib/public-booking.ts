import {
  addDays,
  formatDate,
  ManageTokenSchema,
  PhoneSchema,
  type CivilDate,
  type PublicBusiness,
  type PublicService,
  type PublicStaffMember,
} from '@pepper/contracts';
import { dayRange, todayIn } from './calendar';
import { normalizeContact } from './booking';

// The public booking page (S17, ADR-0022): pure helpers for the client's screens. The api
// decides everything; these shape what the page asks and shows.

/** How many days ahead the page's day strip offers. */
export const BOOKING_DAYS = 14;

/** The api path of a business's booking page, plus `rest`. */
export function publicApiPath(slug: string, rest = ''): string {
  return `/v1/public/businesses/${encodeURIComponent(slug)}${rest}`;
}

/** `GET …/availability` over one local day, with one staff member or anyone. */
export function publicAvailabilityPath(
  slug: string,
  timeZone: string,
  date: CivilDate,
  query: { serviceId: string; staffMemberId: string | null },
): string {
  const params = new URLSearchParams({ ...dayRange(timeZone, date), serviceId: query.serviceId });
  if (query.staffMemberId !== null) params.set('staffMemberId', query.staffMemberId);
  return `${publicApiPath(slug, '/availability')}?${params.toString()}`;
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
