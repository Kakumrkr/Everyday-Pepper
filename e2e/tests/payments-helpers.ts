import type { SandboxPaymentState } from '@pepper/contracts';
import { expect, type Page } from '@playwright/test';
import { hydrated } from './helpers.js';

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

/** The policy `buildPolicy` builds (S67.2): a day’s notice, $20 for a no-show. */
export const POLICY_SENTENCE =
  'Please cancel or reschedule at least 24 hours before your visit. No-shows may be charged $20.';

/** The owner turns the cancellation policy on with a $20 no-show fee (S67.2, AC-X-130/131). */
export async function buildPolicy(page: Page): Promise<void> {
  const policy = page
    .getByRole('region', { name: 'Your booking page' })
    .getByRole('form', { name: 'Cancellation policy' });
  await (
    await hydrated(
      policy
        .getByRole('radiogroup', { name: 'Cancellation policy' })
        .getByRole('radio', { name: 'On' }),
    )
  ).click();
  const noShow = policy.getByRole('radiogroup', { name: 'A no-show costs' });
  await noShow.getByRole('radio', { name: 'Amount' }).click();
  await policy.getByLabel('No-show fee ($)').fill('20');
  await expect(policy.getByTestId('policy-preview')).toContainText(POLICY_SENTENCE);
  await policy.getByRole('button', { name: 'Save policy' }).click();
  await expect(
    policy.getByText('Saved. Clients see it when they book and in their emails.'),
  ).toBeVisible();
}
