import { UserIdSchema } from '@pepper/contracts';
import type { Mailer } from '@pepper/core';
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
import {
  AccountMailer,
  accountExistsEmail,
  changeOf,
  confirmChangeEmail,
  confirmNewEmailEmail,
  landingOn,
  resetPasswordEmail,
  RESET_LINK_MINUTES,
  verifyEmailEmail,
  VERIFY_LINK_HOURS,
} from './auth-emails.js';

/** Where Better Auth's endpoints are served (forwarded by the web app, ADR-0012). */
export const AUTH_BASE_PATH = '/api/auth';

/** Shortest accepted password. No breached-password check yet (Phase 11), so longer than 8. */
export const MIN_PASSWORD_LENGTH = 10;

export interface BetterAuthOptions extends AuthConfig {
  db: Database;
  /** Sends the account emails at once (ADR-0045); `null` when no SMTP_URL is configured. */
  mailer: Mailer | null;
  /** Receives Better Auth's own log lines (they go through the redacting logger). */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Stricter limits (per address, in the window's seconds) on the endpoints that send email, so
 * nobody floods an inbox; Better Auth's own stricter rules cover sign-in, sign-up and codes.
 */
export const EMAIL_RATE_LIMITS = {
  // A sign-up with a taken address emails its owner.
  '/sign-up/email': { window: 60, max: 3 },
  '/request-password-reset': { window: 60, max: 3 },
  '/send-verification-email': { window: 60, max: 3 },
  '/change-email': { window: 60, max: 3 },
} as const;

/**
 * The Better Auth instance (ADR-0007, ADR-0012, ADR-0045): email and password sign-in with a
 * checked email for new accounts, password reset and change of email by emailed links, TOTP
 * second factor with backup codes, database sessions in HttpOnly SameSite=Lax cookies, rate
 * limits on, telemetry off. Tenant membership and roles stay in our own tables; auth only
 * proves identity.
 */
/** Where the web app shows a change of email's two steps (`/email-confirmed`). */
export const CHANGE_CONFIRMED_PATH = '/email-confirmed?changed=pending';
export const EMAIL_CHANGED_PATH = '/email-confirmed?changed=1';

export function createBetterAuth(options: BetterAuthOptions) {
  const mail = new AccountMailer(options.mailer, (level, message) => {
    options.log(level, message);
  });
  if (options.mailer === null) {
    options.log(
      'error',
      'No SMTP_URL: new accounts cannot confirm their email or reset a password',
    );
  }
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
      // New accounts confirm their email before signing in (accounts from before S44 were
      // marked confirmed by migration). It also makes sign-up answer the same for a taken
      // address, whose owner gets an email instead (no account oracle).
      requireEmailVerification: true,
      sendResetPassword: ({ user, url }) =>
        mail.send('password reset', resetPasswordEmail(user, url)),
      resetPasswordTokenExpiresIn: RESET_LINK_MINUTES * 60,
      revokeSessionsOnPasswordReset: true,
      onExistingUserSignUp: ({ user }) =>
        mail.send('account exists', accountExistsEmail(user, `${options.baseUrl}/sign-in`)),
    },
    emailVerification: {
      // A change of address arrives here too (its second step, once the current address
      // confirmed), with `user.email` already the new address.
      sendVerificationEmail: ({ user, url, token }) => {
        const change = changeOf(token);
        return change === null
          ? mail.send('email check', verifyEmailEmail(user, url))
          : mail.send(
              'new email',
              confirmNewEmailEmail(user, change.to, landingOn(url, EMAIL_CHANGED_PATH)),
            );
      },
      sendOnSignUp: true,
      // An unconfirmed sign-in sends a fresh link (the old one may have run out).
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: VERIFY_LINK_HOURS * 60 * 60,
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
      // The current address confirms first, then the new one; nothing changes before both.
      changeEmail: {
        enabled: true,
        updateEmailWithoutVerification: false,
        sendChangeEmailConfirmation: ({ user, newEmail, url }) =>
          mail.send(
            'change of email',
            confirmChangeEmail(user, newEmail, landingOn(url, CHANGE_CONFIRMED_PATH)),
          ),
      },
      deleteUser: { enabled: false },
    },
    plugins: [twoFactor({ issuer: 'Pepper' })],
    // Built-in limits (stricter on sign-in, sign-up and second-factor checks), kept in memory:
    // enough for one api instance; move to Redis before running several.
    rateLimit: { enabled: true, storage: 'memory', customRules: { ...EMAIL_RATE_LIMITS } },
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
