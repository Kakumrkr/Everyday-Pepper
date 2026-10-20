/** A response header as `next.config.ts` lists it. */
export interface Header {
  key: string;
  value: string;
}

/**
 * Headers on every response of the web app (S18 security review, ADR-0023). No page may be
 * framed by another site (clickjacking: a hidden "Cancel booking" or "Remove member" button);
 * the browser must not guess content types; links send only the origin to other sites, never
 * a path; and features the app never uses stay off. Scripts are not restricted by a CSP here:
 * Next.js's inline scripts need per-request nonces, planned with the Phase 11 hardening.
 */
export const SECURITY_HEADERS: readonly Header[] = [
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
];

/**
 * The service worker script: always checked for a new version (browsers cap this at a day
 * anyway) and allowed to control the whole app.
 */
export const SERVICE_WORKER_HEADERS: readonly Header[] = [
  { key: 'Cache-Control', value: 'no-cache' },
  { key: 'Service-Worker-Allowed', value: '/' },
];
