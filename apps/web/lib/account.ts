import {
  CurrentBusinessResponseSchema,
  InvitesResponseSchema,
  MembersResponseSchema,
  MeResponseSchema,
  PublicBusinessSchema,
  roleRequiresMfa,
  type CurrentBusinessResponse,
  type Invite,
  type MeResponse,
  type Member,
  type PublicBusiness,
} from '@pepper/contracts';
import type { z } from 'zod';

export interface ApiCallOptions {
  /** `API_INTERNAL_URL`. */
  baseUrl: string;
  /** The browser's `Cookie` header, passed through to the api. */
  cookie: string | null;
  /** The browser's address (`X-Forwarded-For`), for the api's per-address rate limits. */
  forwardedFor?: string | null;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** What the api says about the browser's session. */
export type Account =
  { state: 'signed-out' } | { state: 'signed-in'; me: MeResponse } | { state: 'unavailable' };

async function getJson(path: string, options: ApiCallOptions): Promise<Response | null> {
  const { baseUrl, cookie, forwardedFor, timeoutMs = 5_000, fetch = globalThis.fetch } = options;
  const headers: Record<string, string> = {};
  if (cookie !== null) headers['cookie'] = cookie;
  if (forwardedFor !== undefined && forwardedFor !== null) {
    headers['x-forwarded-for'] = forwardedFor;
  }
  try {
    return await fetch(new URL(path, baseUrl), {
      headers,
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

/** A business's public booking page, as the page's server component loads it (ADR-0022). */
export type PublicPage =
  { state: 'found'; business: PublicBusiness } | { state: 'missing' } | { state: 'unavailable' };

/** `GET /v1/public/businesses/:slug`: the page, no page (404), or the api failing. */
export async function loadPublicBusiness(
  slug: string,
  options: ApiCallOptions,
): Promise<PublicPage> {
  const response = await getJson(`/v1/public/businesses/${encodeURIComponent(slug)}`, options);
  if (response?.status === 404) return { state: 'missing' };
  if (response?.status !== 200) return { state: 'unavailable' };
  const parsed = PublicBusinessSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? { state: 'found', business: parsed.data } : { state: 'unavailable' };
}

/** A JSON body from the api, or `null` if the api refuses, fails or answers something else. */
export async function loadJson<T extends z.ZodType>(
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
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
  /** Where an emailed link lands once opened (S44): a run-out link, or a changed email. */
  emailConfirmed: '/email-confirmed',
  changeEmail: '/account/email',
  more: '/more',
  /** The business export (S51, ADR-0053): owners only. */
  yourData: '/more/data',
  createBusiness: '/onboarding/business',
  twoFactor: '/security/two-factor',
  invite: '/invite',
  team: '/team',
  calendar: '/calendar',
  clients: '/clients',
  services: '/services',
  rules: '/services/rules',
  chat: '/chat',
  autonomy: '/autonomy',
  memory: '/memory',
  waitlist: '/waitlist',
  home: '/',
} as const;

/**
 * Where an emailed check link sends the browser once opened (S44): `/email-confirmed`, which
 * goes on to `next` (or home), or explains a link that has run out.
 */
export function confirmedUrl(next: string | null): string {
  return withNext(ROUTES.emailConfirmed, next);
}

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

export type SignUpField = 'name' | 'email' | 'password';

/**
 * The sign-up form checked in the browser (S43.2), so an empty or short field says what it needs
 * under itself; the api checks again. Empty when the form can be sent.
 */
export function checkSignUp(
  form: Record<SignUpField, string>,
): Partial<Record<SignUpField, string>> {
  const errors: Partial<Record<SignUpField, string>> = {};
  const name = form.name.trim();
  if (name === '' || name.length > 120) {
    errors.name = 'Enter your name, as your team and clients will see it.';
  }
  const email = emailError(form.email, 'Enter your email. You’ll sign in with it.');
  if (email !== undefined) errors.email = email;
  const password = passwordError(form.password);
  if (password !== undefined) errors.password = password;
  return errors;
}

/** `message` unless `email` looks like an email address (the api decides the rest). */
export function emailError(email: string, message = 'Enter your email.'): string | undefined {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? undefined : message;
}

/** Why a new password won't do, if it won't (Better Auth's lengths, ADR-0007). */
export function passwordError(password: string): string | undefined {
  if (password.length < 10) return 'Use a password of at least 10 characters.';
  if (password.length > 128) return 'Use a password of at most 128 characters.';
  return undefined;
}

/** The error for a change of email to `email` from `current`, if any. */
export function newEmailError(email: string, current: string): string | undefined {
  const invalid = emailError(email, 'Enter the new email you want to sign in with.');
  if (invalid !== undefined) return invalid;
  return email.trim().toLowerCase() === current.toLowerCase()
    ? 'That’s already your email. Enter a different one.'
    : undefined;
}
