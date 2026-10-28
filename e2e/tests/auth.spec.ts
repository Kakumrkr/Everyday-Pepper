import { expect, test } from '@playwright/test';
import {
  enterPassword,
  freshCode,
  hydrated,
  onboardOwner,
  ownClientAddress,
  PASSWORD,
  signOut,
  signUp,
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

  // S43.2 walkthrough: an empty sign-up said "Something went wrong"; a wrong setup code's error
  // sat under the action bar, out of view on a phone.
  test('sign-up says what each empty field needs, and focuses the first', async ({ page }) => {
    await page.goto('/sign-up');
    await (await hydrated(page.getByRole('button', { name: 'Create account' }))).click();
    await expect(page.getByLabel('Your name')).toBeFocused();
    await expect(page.getByLabel('Your name')).toHaveAccessibleDescription(/Enter your name/);
    await expect(page.getByText('Enter your email. You’ll sign in with it.')).toBeVisible();
    await expect(page.getByText('Use a password of at least 10 characters.')).toBeVisible();
    await expect(page).toHaveURL(/\/sign-up$/);
  });

  test('a wrong code while turning on two-step verification shows in view', async ({ page }) => {
    test.setTimeout(60_000);
    await signUp(page, `${unique('owner')}@example.test`);
    await expect(page).toHaveURL(/\/onboarding\/business$/, { timeout: 20_000 });
    await hydrated(page.getByRole('button', { name: 'Create business' }));
    await page.getByLabel('Business name').fill('Wrong Code Studio');
    await page.getByLabel('Booking link').fill(unique('shop'));
    await page.getByRole('button', { name: 'Create business' }).click();
    await expect(page).toHaveURL(/\/security\/two-factor$/, { timeout: 30_000 });
    await hydrated(page.getByRole('button', { name: 'Continue' }));
    await page.getByLabel('Confirm your password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Enter the 6-digit code').fill('000000');
    await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
    const error = page.getByText('That code didn’t work.', { exact: false });
    await expect(error).toBeInViewport({ ratio: 1 });
    // …and above the action bar fixed at the bottom of the screen.
    const box = await error.boundingBox();
    const bar = await page
      .getByRole('button', { name: 'Turn on two-step verification' })
      .boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThan(bar?.y ?? 0);
    await expect(page.getByLabel('Enter the 6-digit code')).toBeFocused();
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
