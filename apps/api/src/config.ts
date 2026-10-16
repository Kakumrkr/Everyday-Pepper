import { loadEnv, loadServiceConfig, type ServiceConfig } from '@floty/runtime/instrument';
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

export interface AuthConfig {
  secret: string;
  /** Origin, without a trailing slash. */
  baseUrl: string;
}

/** The api's configuration. Never log it: it carries credentials and the auth secret. */
export interface ApiConfig extends ServiceConfig {
  auth: AuthConfig;
}

/**
 * Reads the api's configuration. Used by `instrument.ts` (before anything else loads) and by
 * `main.ts`, so a missing variable stops the process at once.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const service = loadServiceConfig('api', env, { port: 4000 });
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const auth = loadEnv('api', AuthEnvSchema, present);
  return {
    ...service,
    auth: { secret: auth.AUTH_SECRET, baseUrl: new URL(auth.AUTH_BASE_URL).origin },
  };
}
