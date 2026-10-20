import { headers } from 'next/headers';
import { cache } from 'react';
import type { CurrentBusinessResponse, Invite, Member } from '@pepper/contracts';
import type { z } from 'zod';
import {
  loadAccount,
  loadCurrentBusiness,
  loadInvites,
  loadJson,
  loadMembers,
  loadPublicBusiness,
  type Account,
  type PublicPage,
} from '../../lib/account';
import { loadCalendarDay, type CalendarDay } from '../../lib/calendar-data';
import { loadWebServerEnv } from '../../lib/env';

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
