import { z } from 'zod';

const WebServerEnvSchema = z.object({
  /** Base URL of the api as seen from the web server (Compose: `http://api:4000`). */
  API_INTERNAL_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:4000'),
  /**
   * Pepper's public origin, as the api knows it (S70.2): what the web server sends as `Origin`
   * when it calls the api itself (Google's return). Unset, the request's own origin (dev).
   */
  AUTH_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
});
export type WebServerEnv = z.infer<typeof WebServerEnvSchema>;

/** Server-only environment. Read per request so one image runs in every environment. */
export function loadWebServerEnv(env: Readonly<Record<string, string | undefined>>): WebServerEnv {
  const result = WebServerEnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error('Invalid web environment: API_INTERNAL_URL or AUTH_BASE_URL');
  }
  return result.data;
}
