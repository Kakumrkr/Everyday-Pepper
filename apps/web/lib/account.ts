import {
  CurrentBusinessResponseSchema,
  InvitesResponseSchema,
  MembersResponseSchema,
  MeResponseSchema,
  roleRequiresMfa,
  type CurrentBusinessResponse,
  type Invite,
  type MeResponse,
  type Member,
} from '@floty/contracts';
import type { z } from 'zod';

export interface ApiCallOptions {
  /** `API_INTERNAL_URL`. */
  baseUrl: string;
  /** The browser's `Cookie` header, passed through to the api. */
  cookie: string | null;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** What the api says about the browser's session. */
export type Account =
  { state: 'signed-out' } | { state: 'signed-in'; me: MeResponse } | { state: 'unavailable' };

async function getJson(path: string, options: ApiCallOptions): Promise<Response | null> {
  const { baseUrl, cookie, timeoutMs = 5_000, fetch = globalThis.fetch } = options;
  try {
    return await fetch(new URL(path, baseUrl), {
      headers: cookie === null ? {} : { cookie },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
}

/** The signed-in user and their businesses (`GET /v1/me`), from a server component. */
export async function loadAccount(options: ApiCallOptions): Promise<Account> {
  const response = await getJson('/v1/me', options);
  if (response?.status === 401) return { state: 'signed-out' };
  if (response?.status !== 200) return { state: 'unavailable' };
  const me = MeResponseSchema.safeParse(await response.json().catch(() => undefined));
  return me.success ? { state: 'signed-in', me: me.data } : { state: 'unavailable' };
}

/** A JSON body from the api, or `null` if the api refuses, fails or answers something else. */
async function loadJson<T extends z.ZodType>(
  path: string,
  schema: T,
  options: ApiCallOptions,
): Promise<z.infer<T> | null> {
  const response = await getJson(path, options);
  if (response?.status !== 200) return null;
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? parsed.data : null;
}

/** The session's active business (`GET /v1/tenant`), or `null` if the api refuses or fails. */
export function loadCurrentBusiness(
  options: ApiCallOptions,
): Promise<CurrentBusinessResponse | null> {
  return loadJson('/v1/tenant', CurrentBusinessResponseSchema, options);
}

/** The active business's members (`GET /v1/members`), or `null`. */
export async function loadMembers(options: ApiCallOptions): Promise<Member[] | null> {
  return (await loadJson('/v1/members', MembersResponseSchema, options))?.members ?? null;
}

/** The active business's open invites (`GET /v1/invites`), or `null`. */
export async function loadInvites(options: ApiCallOptions): Promise<Invite[] | null> {
  return (await loadJson('/v1/invites', InvitesResponseSchema, options))?.invites ?? null;
}

/** Pages the signed-in flow sends people to. */
export const ROUTES = {
  signIn: '/sign-in',
  signUp: '/sign-up',
  createBusiness: '/onboarding/business',
  twoFactor: '/security/two-factor',
  invite: '/invite',
  team: '/team',
  home: '/',
} as const;

/** `path` with `?next=` set to `next`, if any (sign-in and sign-up return there). */
export function withNext(path: string, next: string | null): string {
  return next === null ? path : `${path}?${new URLSearchParams({ next }).toString()}`;
}

/**
 * Where someone must go before the home page: sign in, create a business, then (owners and
 * managers) set up two-step verification, mirroring the api's tenant guard. `null`: the home page is fine.
 */
export function requiredStep(account: Account): string | null {
  if (account.state === 'signed-out') return ROUTES.signIn;
  if (account.state === 'unavailable') return null;
  const { me } = account;
  if (me.businesses.length === 0) return ROUTES.createBusiness;
  const active = me.businesses.find((business) => business.tenantId === me.activeTenantId);
  if (active !== undefined && roleRequiresMfa(active.role) && !me.user.twoFactorEnabled) {
    return ROUTES.twoFactor;
  }
  return null;
}
