import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { TenantIdSchema, UserIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { setSessionActiveTenant, type Database } from '@pepper/db';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { z } from 'zod';
import type { BetterAuth } from './better-auth.js';

/** The signed-in user, as the api sees them. */
export interface AuthUser {
  id: UserId;
  name: string;
  email: string;
  /** Whether a verified second factor (TOTP) is set up. */
  twoFactorEnabled: boolean;
}

/** A valid session: who is signed in, and which business they chose for this session. */
export interface AuthSession {
  id: string;
  user: AuthUser;
  activeTenantId: TenantId | null;
}

/**
 * Authentication as the rest of the api uses it (ADR-0007): resolve the session of a request,
 * remember the chosen business, and serve the sign-in endpoints. Only `BetterAuthService`
 * knows the library, so it can be replaced.
 */
export abstract class AuthService {
  /** The session the request's cookie proves, or `null` (no cookie, expired, signed out). */
  abstract getSession(headers: IncomingHttpHeaders): Promise<AuthSession | null>;
  /** Stores the business for the session. The caller has checked the user's membership. */
  abstract setActiveTenant(session: AuthSession, tenantId: TenantId | null): Promise<void>;
  /** Serves `/api/auth/*` (sign-up, sign-in, sign-out, second factor). */
  abstract handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

// What Better Auth returns for a session; parsed rather than trusted, since the shape belongs
// to the library.
const BetterAuthSessionSchema = z.object({
  session: z.object({
    id: z.string().min(1),
    activeTenantId: TenantIdSchema.nullish(),
  }),
  user: z.object({
    id: UserIdSchema,
    name: z.string(),
    email: z.string(),
    twoFactorEnabled: z.boolean().nullish(),
  }),
});

export class BetterAuthService extends AuthService {
  private readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;

  constructor(
    private readonly auth: BetterAuth,
    private readonly db: Database,
  ) {
    super();
    this.handler = toNodeHandler(auth);
  }

  async getSession(headers: IncomingHttpHeaders): Promise<AuthSession | null> {
    const result = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (result === null) return null;
    const { session, user } = BetterAuthSessionSchema.parse(result);
    return {
      id: session.id,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        twoFactorEnabled: user.twoFactorEnabled === true,
      },
      activeTenantId: session.activeTenantId ?? null,
    };
  }

  async setActiveTenant(session: AuthSession, tenantId: TenantId | null): Promise<void> {
    const found = await setSessionActiveTenant(
      this.db,
      { id: session.id, userId: session.user.id },
      tenantId,
    );
    if (!found) throw new Error('The session no longer exists');
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Rate limits key on the client IP from `x-forwarded-for`, which the web app sets when it
    // forwards a request. A direct caller gets its socket address instead of a shared bucket.
    if (request.headers['x-forwarded-for'] === undefined && request.socket.remoteAddress) {
      request.headers['x-forwarded-for'] = request.socket.remoteAddress;
    }
    await this.handler(request, response);
  }
}
