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

/**
 * A name no other test uses. The counter is per worker process, so the process id keeps two
 * workers apart within the same millisecond (S32: two owners got the same booking link).
 */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(Date.now())}-${String(process.pid)}-${String(counter)}`;
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

/**
 * Fills in the sign-up form (opening it first unless `onPage`), then, unless `confirm` is
 * false, opens the link of the email check (S44), which signs in and goes on.
 */
export async function signUp(
  page: Page,
  email: string,
  { name = 'Ana Reyes', onPage = false, confirm = true } = {},
): Promise<void> {
  if (!onPage) await page.goto('/sign-up');
  await hydrated(page.getByRole('button', { name: 'Create account' }));
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  if (!confirm) return;
  // Sign-up hashes the password: with several workers at once it can take longer than 5 s.
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible({
    timeout: 20_000,
  });
  await page.goto(await linkTo(email, 'Confirm your email for Pepper'));
}

/** The app link in the newest email to `to` about `subject`, as a path on the app. */
export async function linkTo(to: string, subject: string): Promise<string> {
  const text = await emailTo(to.toLowerCase(), subject);
  const link = /https?:\/\/\S+?(\/api\/auth\/\S+)/.exec(text)?.[1];
  if (link === undefined) throw new Error(`No link in the email to ${to} about "${subject}"`);
  return link;
}

export interface Owner {
  email: string;
  secret: string;
  backupCodes: string[];
  usedCodes: Set<string>;
  business: string;
}

/**
 * Signs up, creates a business and turns on two-step verification. `business` names it (the
 * screenshot tests need the same name every run; the booking link stays unique).
 */
export async function onboardOwner(
  page: Page,
  { business = `Juniper ${unique('studio')}` }: { business?: string } = {},
): Promise<Owner> {
  const email = `${unique('owner')}@example.test`;
  await signUp(page, email);

  await expect(page).toHaveURL(/\/onboarding\/business$/, { timeout: 20_000 });
  await hydrated(page.getByRole('button', { name: 'Create business' }));
  await page.getByLabel('Business name').fill(business);
  if (business.startsWith('Juniper ')) {
    await expect(page.getByLabel('Booking link')).toHaveValue(/^juniper-studio-/);
  } else {
    await page.getByLabel('Booking link').fill(unique('shop'));
  }
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
  // Creating a business and signing in again take a while on a busy runner (S31: 5 s missed
  // once with three workers); CI has no retries.
  await expect(page).toHaveURL(/\/security\/two-factor$/, { timeout: 30_000 });
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
  // Sign out sits in More's account section (S41).
  await page.goto('/more');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
}

/**
 * Opens a place as a member would (S41): from the tabs on a phone or the sidebar on a desktop,
 * and on a phone through More when it is not a tab (Services, Team, the Pepper group).
 */
export async function goTo(page: Page, name: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Main' });
  // The shell first, so a link not rendered yet is never taken for one that is not a tab.
  await expect(nav.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  const link = nav.getByRole('link', { name, exact: true });
  if ((await link.count()) === 0) {
    await (await hydrated(nav.getByRole('link', { name: 'More', exact: true }))).click();
    await expect(page).toHaveURL(/\/more$/);
    await page.getByRole('main').getByRole('link', { name, exact: true }).click();
    return;
  }
  await link.click();
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

/** The note in the app's toast area (S43): above the tabs on phones, bottom right on desktop. */
export function toast(page: Page): Locator {
  return page.getByRole('region', { name: /^Notifications/ }).getByRole('listitem');
}
