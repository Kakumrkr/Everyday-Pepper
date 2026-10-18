import { UserIdSchema } from '@pepper/contracts';
import {
  authDatabaseAdapter,
  listUserBusinesses,
  newId,
  withUser,
  type Database,
} from '@pepper/db';
import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import type { AuthConfig } from '../config.js';

/** Where Better Auth's endpoints are served (forwarded by the web app, ADR-0012). */
export const AUTH_BASE_PATH = '/api/auth';

/** Shortest accepted password. No breached-password check yet (Phase 11), so longer than 8. */
export const MIN_PASSWORD_LENGTH = 10;

export interface BetterAuthOptions extends AuthConfig {
  db: Database;
  /** Receives Better Auth's own log lines (they go through the redacting logger). */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * The Better Auth instance (ADR-0007, ADR-0012): email and password sign-in, TOTP second
 * factor with backup codes, database sessions in HttpOnly SameSite=Lax cookies, rate limits on,
 * telemetry off. Tenant membership and roles stay in our own tables; auth only proves identity.
 */
export function createBetterAuth(options: BetterAuthOptions) {
  return betterAuth({
    appName: 'Pepper',
    baseURL: options.baseUrl,
    basePath: AUTH_BASE_PATH,
    secret: options.secret,
    trustedOrigins: [options.baseUrl],
    database: authDatabaseAdapter(options.db),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: 128,
      autoSignIn: true,
      // Needs the email channel (Phase 5); until then addresses are not verified.
      requireEmailVerification: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      // Read the session from the database on every request, so sign-out, revocation and
      // business switches take effect at once.
      cookieCache: { enabled: false },
      additionalFields: {
        // Set only by the api after a membership check (`AuthService.setActiveTenant`).
        activeTenantId: { type: 'string', required: false, input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // A new session starts in the user's first business (oldest membership), so signing
          // in again does not ask which business to open. Switching is `PUT /v1/me/active-tenant`.
          before: async (session) => ({
            data: { ...session, activeTenantId: await firstBusinessOf(options.db, session.userId) },
          }),
        },
      },
    },
    user: {
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    plugins: [twoFactor({ issuer: 'Pepper' })],
    // Built-in limits (stricter on sign-in, sign-up and second-factor checks), kept in memory:
    // enough for one api instance; move to Redis before running several.
    rateLimit: { enabled: true, storage: 'memory' },
    advanced: {
      // Better Auth skips its origin (CSRF) checks when NODE_ENV is "test"; pin them on so
      // tests exercise exactly what runs in production.
      disableCSRFCheck: false,
      disableOriginCheck: false,
      cookiePrefix: 'pepper',
      useSecureCookies: options.baseUrl.startsWith('https:'),
      database: { generateId: () => newId() },
    },
    telemetry: { enabled: false },
    logger: {
      level: 'warn',
      log: (level, message) => {
        options.log(level, message);
      },
    },
  });
}

export type BetterAuth = ReturnType<typeof createBetterAuth>;

async function firstBusinessOf(db: Database, userId: string): Promise<string | null> {
  const [first] = await withUser(db, UserIdSchema.parse(userId), listUserBusinesses);
  return first?.tenantId ?? null;
}
