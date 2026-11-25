import { headers } from 'next/headers';
import { cache } from 'react';
import {
  SupportUnreadSchema,
  type CurrentBusinessResponse,
  type Invite,
  type Member,
} from '@pepper/contracts';
import type { z } from 'zod';
import {
  loadAccount,
  loadCurrentBusiness,
  loadInvites,
  loadJson,
  loadMembers,
  loadPaymentAccount,
  loadPublicBusiness,
  type Account,
  type PaymentsRead,
  type PublicPage,
} from '../../lib/account';
import {
  loadCalendarDay,
  loadCalendarWeek,
  type CalendarDay,
  type CalendarWeek,
} from '../../lib/calendar-data';
import { loadWebServerEnv } from '../../lib/env';
import { opsAccessOf, type OpsAccess } from '../../lib/ops';

async function callOptions() {
  const { API_INTERNAL_URL } = loadWebServerEnv(process.env);
  return { baseUrl: API_INTERNAL_URL, cookie: (await headers()).get('cookie') };
}

/**
 * The browser's account, asked from the api with its cookie (server components only). Asked
 * once per request: the app layout and the page share the answer.
 */
export const currentAccount = cache(async (): Promise<Account> => {
  return loadAccount(await callOptions());
});

/** The session's active business, or `null` (once per request, like the account). */
export const currentBusiness = cache(async (): Promise<CurrentBusinessResponse | null> => {
  return loadCurrentBusiness(await callOptions());
});

/** The active business's members, or `null` (e.g. staff may not list them). */
export async function currentMembers(): Promise<Member[] | null> {
  return loadMembers(await callOptions());
}

/** The active business's open invites, or `null`. */
export async function currentInvites(): Promise<Invite[] | null> {
  return loadInvites(await callOptions());
}

/** The active business's calendar data for [from, to) (the day view). */
export async function currentCalendarDay(range: {
  from: string;
  to: string;
}): Promise<CalendarDay> {
  return loadCalendarDay(await callOptions(), range);
}

/** One staff member's week for [from, to), the member chosen by `pick` (S69). */
export async function currentCalendarWeek(
  range: { from: string; to: string },
  pick: Parameters<typeof loadCalendarWeek>[2],
): Promise<CalendarWeek> {
  return loadCalendarWeek(await callOptions(), range, pick);
}

/**
 * A JSON answer of the api for the browser's session, checked against `schema`, or `null` if
 * the api refuses, fails or answers something else (the setup screens, S16).
 */
export async function currentJson<T extends z.ZodType>(
  path: string,
  schema: T,
): Promise<z.infer<T> | null> {
  return loadJson(path, schema, await callOptions());
}

/** Where the active business's payments stand (S65.2); More and the page share it. */
export const currentPayments = cache(async (): Promise<PaymentsRead> => {
  return loadPaymentAccount(await callOptions());
});

/**
 * A business's public booking page (no session; S17). The visitor's address goes along, so the
 * api's per-address limits count the visitor, not this server.
 */
export async function publicPage(slug: string): Promise<PublicPage> {
  const { API_INTERNAL_URL } = loadWebServerEnv(process.env);
  return loadPublicBusiness(slug, {
    baseUrl: API_INTERNAL_URL,
    cookie: null,
    forwardedFor: (await headers()).get('x-forwarded-for'),
  });
}

/**
 * The member's unread support answers (S59, AC-X-16), once per request: the shell and More both
 * show it. `null` when the api can't say (no count is shown then).
 */
export const currentSupportUnread = cache(async (): Promise<number | null> => {
  return (
    (await loadJson('/v1/support/unread', SupportUnreadSchema, await callOptions()))?.unread ?? null
  );
});

/** What `/ops` may show this account (S59.2, AC-X-19), from the api's own check. */
export async function currentOpsAccess(): Promise<OpsAccess> {
  const { baseUrl, cookie } = await callOptions();
  const response = await fetch(new URL('/v1/ops/me', baseUrl), {
    headers: cookie === null ? {} : { cookie },
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (response === null) return opsAccessOf(0, undefined);
  return opsAccessOf(response.status, await response.json().catch(() => undefined));
}
