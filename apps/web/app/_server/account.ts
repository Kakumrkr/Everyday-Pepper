import { headers } from 'next/headers';
import { loadAccount, loadCurrentBusiness, type Account } from '../../lib/account';
import { loadWebServerEnv } from '../../lib/env';
import type { CurrentBusinessResponse } from '@floty/contracts';

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
