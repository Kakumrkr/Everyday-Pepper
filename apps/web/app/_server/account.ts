import { headers } from 'next/headers';
import { cache } from 'react';
import type { CurrentBusinessResponse, Invite, Member } from '@floty/contracts';
import {
  loadAccount,
  loadCurrentBusiness,
  loadInvites,
  loadMembers,
  type Account,
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
