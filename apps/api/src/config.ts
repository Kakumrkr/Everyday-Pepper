import { hkdfSync } from 'node:crypto';
import { loadEnv, loadServiceConfig, type ServiceConfig } from '@pepper/runtime/instrument';
import { z } from 'zod';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const AuthEnvSchema = z.object({
  /** Signs session cookies and encrypts TOTP secrets. At least 32 characters; never logged. */
  AUTH_SECRET: z.string().min(32),
  /**
   * Public origin of the app the browser talks to (the web app, which forwards `/api/auth/*`
   * and `/v1/*` here). Cookies, CSRF origin checks and the MFA issuer link use it. HTTPS
   * except on this machine.
   */
  AUTH_BASE_URL: z
    .url({ protocol: /^https?$/ })
    .refine((value) => new URL(value).origin === value.replace(/\/$/, ''), 'Use an origin only')
    .refine(
      (value) => value.startsWith('https:') || LOCAL_HOSTS.has(new URL(value).hostname),
      'Use https outside localhost',
    ),
});

const MailEnvSchema = z.object({
  /**
   * Where email goes (ADR-0022): an `smtp://` or `smtps://` URL, credentials included if any.
   * Mailpit in development and CI (`smtp://localhost:1025`). Unset: nothing that needs email
   * (the booking page's codes) is offered. Never logged.
   */
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
  /** The sender of the emails, e.g. `Pepper <bookings@pepper.app>`. */
  MAIL_FROM: z.string().trim().min(3).max(200).default('Pepper <bookings@pepper.localhost>'),
});

export interface MailConfig {
  smtpUrl: string;
  from: string;
}

export interface AuthConfig {
  secret: string;
  /** Origin, without a trailing slash. */
  baseUrl: string;
}

/** The api's configuration. Never log it: it carries credentials and the auth secret. */
export interface ApiConfig extends ServiceConfig {
  auth: AuthConfig;
  /** `null`: no email sender configured. */
  mail: MailConfig | null;
  /** HMAC key of the booking page's code hashes, derived from `AUTH_SECRET`. */
  bookingCodeKey: Buffer;
}

/**
 * Reads the api's configuration. Used by `instrument.ts` (before anything else loads) and by
 * `main.ts`, so a missing variable stops the process at once.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const service = loadServiceConfig('api', env, { port: 4000 });
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const auth = loadEnv('api', AuthEnvSchema, present);
  const mail = loadEnv('api', MailEnvSchema, present);
  return {
    ...service,
    auth: { secret: auth.AUTH_SECRET, baseUrl: new URL(auth.AUTH_BASE_URL).origin },
    mail: mail.SMTP_URL === undefined ? null : { smtpUrl: mail.SMTP_URL, from: mail.MAIL_FROM },
    bookingCodeKey: deriveKey(auth.AUTH_SECRET, 'pepper/booking-page-codes'),
  };
}

/** A 32-byte key for one purpose, derived from the secret (HKDF-SHA256). */
function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, '', purpose, 32));
}
