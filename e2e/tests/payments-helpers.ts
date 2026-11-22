import type { SandboxPaymentState } from '@pepper/contracts';
import { expect, type Page } from '@playwright/test';

// The Stripe sandbox from a journey (S65.2, AC-X-104): the dev route plays Stripe, moving the
// owner's sandbox account and delivering a signed event through the real webhook.

/** Moves the signed-in owner's sandbox account to `state`; the page must be on the app. */
export async function stripeSays(page: Page, state: SandboxPaymentState): Promise<void> {
  // A session's POST: the api checks it came from the app (its Origin), as for the browser.
  const response = await page.request.post('/v1/dev/payments/account', {
    data: { state },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(response.status(), await response.text()).toBe(200);
}
