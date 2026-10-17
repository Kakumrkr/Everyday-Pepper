import { randomInt } from 'node:crypto';
import { totpCode } from '@floty/testing';
import { expect, test, type Page } from '@playwright/test';

// The owner journey through the real stack (web → api → Postgres): sign up, create a business,
// set up two-step verification, sign out, sign in again with a code or a backup code.
// Better Auth rate limits per client address and path; each test gets its own address
// (`x-forwarded-for`, which the web app passes on) so parallel projects do not share a bucket.

const PASSWORD = 'correct horse battery';
let counter = 0;

function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(Date.now())}-${String(counter)}`;
}

test.beforeEach(async ({ context }) => {
  const address = `10.${String(randomInt(256))}.${String(randomInt(256))}.${String(randomInt(1, 255))}`;
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': address });
});

/** Waits for a code from a later 30-second window than `used` (codes are single use). */
async function freshCode(secret: string, used: Set<string>): Promise<string> {
  for (;;) {
    const code = totpCode(secret);
    if (!used.has(code)) {
      used.add(code);
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Your name').fill('Ana Reyes');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
}

interface Owner {
  email: string;
  secret: string;
  backupCodes: string[];
  usedCodes: Set<string>;
  business: string;
}

/** Signs up, creates a business and turns on two-step verification. */
async function onboardOwner(page: Page): Promise<Owner> {
  const email = `${unique('owner')}@example.test`;
  const business = `Juniper ${unique('studio')}`;
  await signUp(page, email);

  await expect(page).toHaveURL(/\/onboarding\/business$/);
  await page.getByLabel('Business name').fill(business);
  await expect(page.getByLabel('Booking link')).toHaveValue(/^juniper-studio-/);
  await page.getByRole('button', { name: 'Create business' }).click();

  // Owners must protect the business before they can use it.
  await expect(page).toHaveURL(/\/security\/two-factor$/);
  await page.getByLabel('Confirm your password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  const secret = ((await page.getByTestId('totp-secret').textContent()) ?? '').replace(/\s/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  const backupCodes = (
    await page.getByTestId('backup-codes').locator('code').allTextContents()
  ).map((code) => code.trim());
  expect(backupCodes.length).toBeGreaterThanOrEqual(8);

  const usedCodes = new Set<string>();
  await page.getByLabel('Enter the 6-digit code').fill(await freshCode(secret, usedCodes));
  await page.getByRole('button', { name: 'Turn on two-step verification' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('business-name')).toHaveText(business);
  await expect(page.getByTestId('business-role')).toHaveText('owner');
  return { email, secret, backupCodes, usedCodes, business };
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
}

async function enterPassword(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

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
