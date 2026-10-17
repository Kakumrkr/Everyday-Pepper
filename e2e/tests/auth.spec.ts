import { expect, test } from '@playwright/test';
import {
  enterPassword,
  freshCode,
  onboardOwner,
  ownClientAddress,
  signOut,
  unique,
} from './helpers.js';

// The owner journey through the real stack (web → api → Postgres): sign up, create a business,
// set up two-step verification, sign out, sign in again with a code or a backup code.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

test.describe('owner sign-in with two-step verification', () => {
  test('sign up, create a business, set up MFA, then sign in again with a code', async ({
    page,
  }) => {
    test.setTimeout(90_000); // may wait for the next 30-second code
    const owner = await onboardOwner(page);
    await signOut(page);

    await enterPassword(page, owner.email);
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    // A password alone opens nothing.
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);

    await enterPassword(page, owner.email);
    await page.getByLabel('Code').fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'didn’t work' })).toBeVisible();

    await page.getByLabel('Code').fill(await freshCode(owner.secret, owner.usedCodes));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('business-name')).toHaveText(owner.business);
  });

  test('a backup code works once instead of the app', async ({ page }) => {
    test.setTimeout(60_000);
    const owner = await onboardOwner(page);
    const [backup] = owner.backupCodes;
    await signOut(page);

    await enterPassword(page, owner.email);
    await page.getByRole('button', { name: 'Use a backup code instead' }).click();
    await page.getByLabel('Backup code').fill(backup ?? '');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByTestId('business-role')).toHaveText('owner');
  });

  test('a wrong password is refused without saying which part was wrong', async ({ page }) => {
    await page.goto('/sign-in');
    await enterPassword(page, `${unique('nobody')}@example.test`, 'not the password');
    // (Next's route announcer is an empty alert too, so match the form's by its text.)
    await expect(
      page.getByRole('alert').filter({ hasText: 'That email and password don’t match.' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test('pages that need an account send visitors to sign in', async ({ page }) => {
    for (const path of ['/', '/onboarding/business', '/security/two-factor']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in$/);
    }
  });

  test('the forms fit a phone screen', async ({ page }) => {
    for (const path of ['/sign-in', '/sign-up']) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
    }
  });
});
