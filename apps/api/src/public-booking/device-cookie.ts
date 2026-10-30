import { DeviceTokenSchema, REMEMBERED_DEVICE_DAYS, type DeviceToken } from '@pepper/contracts';

// The remembered-device cookie (S47, ADR-0047, AC-W8-8): the secret only, httpOnly so page
// scripts never read it, SameSite=Lax, Secure over https, and one per business: its path is
// that business's booking api, so the browser sends it nowhere else.

export const DEVICE_COOKIE = 'pepper_device';

function cookiePath(slug: string): string {
  return `/v1/public/businesses/${encodeURIComponent(slug)}`;
}

/** The device token the request's cookie carries, if it carries a well-formed one. */
export function deviceTokenOf(request: {
  headers: Record<string, string | string[] | undefined>;
}): DeviceToken | undefined {
  const header = request.headers['cookie'];
  const value = Array.isArray(header) ? header.join('; ') : header;
  for (const part of value?.split(';') ?? []) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== DEVICE_COOKIE) continue;
    const parsed = DeviceTokenSchema.safeParse(rest.join('='));
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/** The `Set-Cookie` value that remembers `token` for the business at `slug`. */
export function deviceCookie(slug: string, token: DeviceToken, secure: boolean): string {
  const maxAge = REMEMBERED_DEVICE_DAYS * 86_400;
  return [
    `${DEVICE_COOKIE}=${DeviceTokenSchema.parse(token)}`,
    `Path=${cookiePath(slug)}`,
    `Max-Age=${String(maxAge)}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** The `Set-Cookie` value that removes the business's device cookie. */
export function clearedDeviceCookie(slug: string, secure: boolean): string {
  return [
    `${DEVICE_COOKIE}=`,
    `Path=${cookiePath(slug)}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}
