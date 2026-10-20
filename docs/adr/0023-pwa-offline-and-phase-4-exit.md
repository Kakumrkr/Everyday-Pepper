# ADR-0023: Installable app with an offline page, security headers, and the accessibility gate

- **Status:** Accepted (user, 2026-10-20). At the S18 Session Brief the user chose Claude's recommendations: a hand-written service worker (no library), `@axe-core/playwright` failing on serious and critical violations, and fixing high and medium security findings while logging low ones. They asked Claude to complete the session on its recommendations and merge it. · **Date:** 2026-10-20 · Builds on ADR-0012 (one origin), ADR-0019 (design system), ADR-0022 (public booking page)

## Context
Phase 4 exits with S18. v1-scope promises a **mobile-first, installable PWA**. testing-strategy.md asks for **axe in Playwright with no serious violations** on key screens. security-and-tenancy.md asks for a security review before each phase exit. Three questions were open:
- What the app should do without a connection.
- How much a service worker should cache, given that pages and api answers hold a business's data and people's details.
- Which response headers the web app should send.

Push notifications are Phase 5 messaging and are not part of this decision.

## Decision
1. **Manifest and icons.**
   - `apps/web/public/manifest.webmanifest`: `standalone`, `start_url` and `scope` `/`, the light `bg` token as theme and background.
   - Icons: 192 and 512 px PNGs, a 512 px maskable one (the mark at 62% on `bg`), and a 180 px apple-touch icon. They were rendered once from `app/icon.svg` with the preinstalled Chromium.
   - The manifest is linked, and the worker registered, **only from the signed-in app's layout** (`app/(app)/layout.tsx`). The public booking page is a business's page for its clients: it offers no install and registers no worker in a client's browser.
2. **Service worker** (`apps/web/public/sw.js`, hand-written, about 40 lines, no dependency).
   - On install it caches one file: `/offline.html`.
   - On a failed page load (`mode: navigate`) it answers with that page. Every other request (api calls, scripts, styles, writes) goes to the network as if there were no worker.
   - **Nothing a business owns is ever cached**, so a shared front-desk device never shows one person's data to another, sign-out needs no clean-up, and an update never serves stale screens.
   - Older `pepper-*` caches are removed on activate; bump `VERSION` when the offline page changes.
   - Production builds only (`registerServiceWorker` in `apps/web/lib/pwa.ts`); it never throws.
   - `/sw.js` is served with `Cache-Control: no-cache`.
3. **Offline page** (`apps/web/public/offline.html`).
   - Self-contained: inline styles with the design tokens of both themes (a unit test keeps them equal to `tokens.ts`), the inline mark, and no external file. It is never tied to a build's hashed assets.
   - "Try again" reloads the page that was asked for, and so does the browser's `online` event.
4. **Security headers on every response** (`apps/web/lib/security-headers.ts`, set in `next.config.ts`):
   - `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` and `X-Frame-Options: DENY` (clickjacking).
   - `X-Content-Type-Options: nosniff`.
   - `Referrer-Policy: strict-origin-when-cross-origin`.
   - `Permissions-Policy` turning off camera, microphone, geolocation, payment and USB.
   - A script-restricting CSP needs per-request nonces for Next.js's inline scripts; it stays with HSTS in Phase 11.
5. **Api answers are not stored by the browser.** The forwarder (`apps/web/lib/forward.ts`) sets `Cache-Control: private, no-store` when the api sends no `Cache-Control`. The api may still opt in to caching later.
6. **Accessibility gate** (`e2e/tests/accessibility.spec.ts`, `@axe-core/playwright` 4.13.0, e2e devDependency only).
   - WCAG 2.2 A and AA rule tags, light and dark, phone and desktop.
   - Screens: home, calendar, booking sheet, new booking, clients, client profile, services, rules, team, staff page, sign-in, sign-up, the offline page, a broken booking link, and each public booking step up to the code.
   - Serious and critical violations fail. Moderate and minor ones are reported as test annotations.

## Consequences
- Owners and staff can add Pepper to the home screen. Without a connection they see a clear offline page instead of the browser's error. No business data is ever kept offline.
- The worker does not speed up loads; the HTTP cache already keeps hashed assets. Offline reading of today's calendar would need cached, per-user data and is not planned for V1.
- Playwright's offline mode does not reliably reach service workers. The offline journey therefore aborts every request with `context.route` (which Chromium applies to the worker's own fetches too).
- The Docker image now copies `apps/web/public` (standalone output leaves it out).
- Every page refuses to be framed; a future embeddable booking widget would need its own route with a narrower `frame-ancestors`.

## Alternatives considered
- **Serwist / next-pwa:** a build plugin and precache manifest for features we do not use (asset precaching, runtime caching). It is a larger dependency for a 40-line worker.
- **An offline page rendered by Next.js:** it would need the build's hashed scripts and styles in the cache and would break across deploys. A static page has no such link.
- **Caching recent pages or api answers for offline reading:** that is a privacy risk on shared devices and needs per-user cache keys and clean-up at sign-out. It was rejected for V1.
- **axe failing on every impact:** stricter, but moderate and minor rules include best-practice checks that are not WCAG failures. testing-strategy.md asks for no serious violations.
