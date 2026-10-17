import { headers } from 'next/headers';
import type { CurrentBusinessResponse, Invite, Member } from '@floty/contracts';
import {
  loadAccount,
  loadCurrentBusiness,
  loadInvites,
  loadMembers,
  type Account,
} from '../../lib/account';
import { loadWebServerEnv } from '../../lib/env';

async function callOptions() {
  const { API_INTERNAL_URL } = loadWebServerEnv(process.env);
  return { baseUrl: API_INTERNAL_URL, cookie: (await headers()).get('cookie') };
}

/** The browser's account, asked from the api with its cookie (server components only). */
export async function currentAccount(): Promise<Account> {
  return loadAccount(await callOptions());
}

/** The session's active business, or `null`. */
export async function currentBusiness(): Promise<CurrentBusinessResponse | null> {
  return loadCurrentBusiness(await callOptions());
}

/** The active business's members, or `null` (e.g. staff may not list them). */
export async function currentMembers(): Promise<Member[] | null> {
  return loadMembers(await callOptions());
}

/** The active business's open invites, or `null`. */
export async function currentInvites(): Promise<Invite[] | null> {
  return loadInvites(await callOptions());
}
