import { randomInt } from 'node:crypto';
import { totpCode } from '@pepper/testing';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

// Shared steps of the journeys through the real stack (web → api → Postgres).
// Better Auth rate limits per client address and path; each test gets its own address
// (`x-forwarded-for`, which the web app passes on) so parallel projects do not share a bucket.

export const PASSWORD = 'correct horse battery';
let counter = 0;

export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(Date.now())}-${String(counter)}`;
}

/**
 * Waits until React has hydrated `locator`'s element (it then carries React's props). Before
 * that, a client form or dialog trigger does nothing, or a form submits natively and reloads
 * the page; slow CI runners make that race real.
 */
export async function hydrated(locator: Locator): Promise<Locator> {
  await expect
    .poll(() =>
      locator.evaluate((element) =>
        Object.keys(element).some((key) => key.startsWith('__reactProps$')),
      ),
    )
    .toBe(true);
  return locator;
}

/** Gives the browser context its own client address. */
export async function ownClientAddress(context: BrowserContext): Promise<void> {
  const address = `10.${String(randomInt(256))}.${String(randomInt(256))}.${String(randomInt(1, 255))}`;
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': address });
}

/** Waits for a code from a later 30-second window than `used` (codes are single use). */
export async function freshCode(secret: string, used: Set<string>): Promise<string> {
  for (;;) {
    const code = totpCode(secret);
    if (!used.has(code)) {
      used.add(code);
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Fills in the sign-up form; opens it first unless `onPage`. */
export async function signUp(
  page: Page,
  email: string,
  { name = 'Ana Reyes', onPage = false } = {},
): Promise<void> {
  if (!onPage) await page.goto('/sign-up');
  await hydrated(page.getByRole('button', { name: 'Create account' }));
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
}

export interface Owner {
  email: string;
  secret: string;
  backupCodes: string[];
  usedCodes: Set<string>;
  business: string;
}

/** Signs up, creates a business and turns on two-step verification. */
export async function onboardOwner(page: Page): Promise<Owner> {
  const email = `${unique('owner')}@example.test`;
  const business = `Juniper ${unique('studio')}`;
  await signUp(page, email);

  await expect(page).toHaveURL(/\/onboarding\/business$/);
  await hydrated(page.getByRole('button', { name: 'Create business' }));
  await page.getByLabel('Business name').fill(business);
  await expect(page.getByLabel('Booking link')).toHaveValue(/^juniper-studio-/);
  await page.getByRole('button', { name: 'Create business' }).click();

  // Owners must protect the business before they can use it.
  const { secret, backupCodes, usedCodes } = await setUpTwoFactor(page);

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('business-name')).toHaveText(business);
  await expect(page.getByTestId('business-role')).toHaveText('owner');
  return { email, secret, backupCodes, usedCodes, business };
}

/** On the two-step setup page: turns on TOTP; returns the secret, backup codes and used codes. */
export async function setUpTwoFactor(
  page: Page,
): Promise<{ secret: string; backupCodes: string[]; usedCodes: Set<string> }> {
  await expect(page).toHaveURL(/\/security\/two-factor$/);
  await hydrated(page.getByRole('button', { name: 'Continue' }));
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
  return { secret, backupCodes, usedCodes };
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
}

export async function enterPassword(page: Page, email: string, password = PASSWORD): Promise<void> {
  await hydrated(page.getByRole('button', { name: 'Sign in' }));
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** A separate browser for another person: the same device, their own client address. */
export async function anotherPerson(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = test.info().project.use;
  const context = await browser.newContext({
    ...(baseURL !== undefined && { baseURL }),
    ...(viewport !== undefined && { viewport }),
    ...(userAgent !== undefined && { userAgent }),
    ...(deviceScaleFactor !== undefined && { deviceScaleFactor }),
    ...(isMobile !== undefined && { isMobile }),
    ...(hasTouch !== undefined && { hasTouch }),
  });
  await ownClientAddress(context);
  return context.newPage();
}

/**
 * Calls the api as the signed-in browser (the app's own origin, as the api requires) and
 * expects `status`; returns the body parsed by `schema`.
 */
export async function callApi<T>(
  page: Page,
  method: 'POST' | 'PUT',
  path: string,
  body: object,
  schema: { parse: (value: unknown) => T },
  status = method === 'POST' ? 201 : 200,
): Promise<T> {
  const response = await page.request.fetch(path, {
    method,
    data: body,
    headers: { origin: new URL(page.url()).origin },
  });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(status);
  return schema.parse(await response.json());
}

/** Mailpit's API (the fake inbox of Compose): `MAILPIT_URL`, default the Compose port. */
const MAILPIT_URL = process.env['MAILPIT_URL'] ?? 'http://localhost:8025';

/** The emails Mailpit holds for `to`, newest first. */
export async function emailsTo(to: string): Promise<{ ID: string; Subject: string }[]> {
  const search = await fetch(
    `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  return ((await search.json()) as { messages: { ID: string; Subject: string }[] }).messages;
}

/**
 * The text of the newest email to `to` whose subject contains `subject`, waiting up to 15
 * seconds for it to arrive.
 */
export async function emailTo(to: string, subject: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const messages = await emailsTo(to);
    const found = messages.find((message) => message.Subject.includes(subject));
    if (found !== undefined) {
      const message = await fetch(`${MAILPIT_URL}/api/v1/message/${found.ID}`);
      return ((await message.json()) as { Text: string }).Text;
    }
    if (Date.now() > deadline) throw new Error(`No email to ${to} about "${subject}"`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
