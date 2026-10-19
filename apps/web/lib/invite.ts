import { InviteTokenSchema, type InviteToken, type MembershipRole } from '@pepper/contracts';
import { ROUTES } from './account';

// The invite link (ADR-0014): `<origin>/invite#<token>`. The token is in the fragment, which
// browsers never send to a server, so it stays out of request logs and `Referer` headers. The
// invite page keeps it in sessionStorage while the invitee signs in or signs up.

/** Where the invite page keeps the token between pages (this tab only). */
export const INVITE_TOKEN_KEY = 'pepper.invite-token';

/** The link to share for an invite. */
export function inviteLink(origin: string, token: InviteToken): string {
  return new URL(`${ROUTES.invite}#${token}`, origin).href;
}

/** The token in a location fragment (`#...`), or `null` if there is none or it is malformed. */
export function inviteTokenFromHash(hash: string): InviteToken | null {
  const parsed = InviteTokenSchema.safeParse(hash.replace(/^#/, ''));
  return parsed.success ? parsed.data : null;
}

/**
 * The page to return to after signing in or up, from a `?next=` value. Only the invite page is
 * allowed, so the parameter cannot send anyone to another site (no open redirect).
 */
export function safeNext(value: unknown): string | null {
  return value === ROUTES.invite ? ROUTES.invite : null;
}

/**
 * The roles a member may offer in the invite form. Mirrors the api's rule (only owners make
 * owners); the api decides, this only hides choices it would refuse.
 */
export function grantableRoles(role: MembershipRole): MembershipRole[] {
  if (role === 'owner') return ['staff', 'manager', 'owner'];
  if (role === 'manager') return ['staff', 'manager'];
  return [];
}
