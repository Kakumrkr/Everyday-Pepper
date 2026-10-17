import {
  CurrentBusinessResponseSchema,
  MeResponseSchema,
  type CurrentBusinessResponse,
  type MeResponse,
} from '@floty/contracts';

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

/** The session's active business (`GET /v1/tenant`), or `null` if the api refuses or fails. */
export async function loadCurrentBusiness(
  options: ApiCallOptions,
): Promise<CurrentBusinessResponse | null> {
  const response = await getJson('/v1/tenant', options);
  if (response?.status !== 200) return null;
  const parsed = CurrentBusinessResponseSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  return parsed.success ? parsed.data : null;
}

/** Pages the signed-in flow sends people to. */
export const ROUTES = {
  signIn: '/sign-in',
  signUp: '/sign-up',
  createBusiness: '/onboarding/business',
  twoFactor: '/security/two-factor',
  home: '/',
} as const;

/**
 * Where someone must go before the home page: sign in, create a business, then (owners) set
 * up two-step verification, mirroring the api's tenant guard. `null`: the home page is fine.
 */
export function requiredStep(account: Account): string | null {
  if (account.state === 'signed-out') return ROUTES.signIn;
  if (account.state === 'unavailable') return null;
  const { me } = account;
  if (me.businesses.length === 0) return ROUTES.createBusiness;
  const active = me.businesses.find((business) => business.tenantId === me.activeTenantId);
  if (active?.role === 'owner' && !me.user.twoFactorEnabled) return ROUTES.twoFactor;
  return null;
}
