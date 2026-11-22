import { expect, test, type Page } from '@playwright/test';
import {
  anotherPerson,
  hydrated,
  onboardOwner,
  ownClientAddress,
  setUpTwoFactor,
  signUp,
  toast,
  unique,
} from './helpers.js';
import { stripeSays } from './payments-helpers.js';

// Payments on screen (S65.2, AC-X-106…109, ADR-0067), through the Stripe sandbox: the owner
// connects from More, comes back from "Stripe" (the sandbox's onboarding link returns straight
// to Pepper), reads what Stripe still needs in words and by when, and the account reaches
// "ready". The sandbox's dev route plays Stripe: it moves the account and delivers a signed
// event through the real webhook. A manager reads the same page without buttons; staff never
// see it.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

/** Stripe's codes never reach the screen (AC-X-107). */
async function noStripeCodes(page: Page): Promise<void> {
  await expect(page.getByTestId('payments-status')).toBeVisible();
  const text = (await page.locator('main').textContent()) ?? '';
  expect(text).not.toMatch(
    /external_account|tos_acceptance|individual\.|requirements\.|action_needed|not_connected/,
  );
}

/** On the team page: invites `email` as `role`; returns the link to share. */
async function invite(page: Page, email: string, role: 'Manager' | 'Staff'): Promise<string> {
  await page.goto('/team');
  await hydrated(page.getByRole('button', { name: 'Create invite link' }));
  await page.getByLabel('Their email').fill(email);
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption({ label: role });
  await page.getByRole('button', { name: 'Create invite link' }).click();
  return (await page.getByTestId('invite-link').textContent()) ?? '';
}

test('an owner connects Stripe from More, sends what it needs, and payments reach ready', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  await page.goto('/more');
  const row = page.getByRole('link', { name: /^Payments/ });
  await expect(row).toContainText('Take deposits with Stripe');
  await row.click();
  await expect(page).toHaveURL(/\/more\/payments$/);
  await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
  const status = page.getByTestId('payments-status');
  await expect(status).toContainText('Not connected');
  await expect(status).toContainText('Take deposits with Stripe');
  await expect(page.getByRole('button', { name: 'Open your Stripe dashboard' })).toHaveCount(0);

  // Connect: the sandbox's onboarding link comes straight back, as Stripe's return page would;
  // the page reads the account again and cleans the address.
  await (await hydrated(page.getByRole('button', { name: 'Connect with Stripe' }))).click();
  await expect(toast(page)).toContainText('You haven’t finished with Stripe yet.');
  await expect(page).toHaveURL(/\/more\/payments$/);
  await expect(status).toContainText('Finish with Stripe');
  await expect(page.getByRole('button', { name: 'Finish with Stripe' })).toBeVisible();

  // A run-out link (Stripe's refresh page) says so beside the button for a fresh one.
  await page.goto('/more/payments?stripe=refresh');
  await expect(page.getByRole('status').filter({ hasText: 'timed out' })).toContainText(
    'Tap “Finish with Stripe” to pick up where you left off.',
  );
  await expect(page).toHaveURL(/\/more\/payments$/);

  // Stripe needs a photo ID within 14 days: in words, with the day, never the code.
  await stripeSays(page, 'action_needed');
  await page.reload();
  await expect(status).toContainText('Stripe needs one more thing');
  await expect(status).toContainText(/Send it by [A-Z][a-z]{2} \d{1,2} so payments keep working\./);
  const needs = page.getByRole('region', { name: 'What Stripe needs' });
  await expect(needs.getByRole('listitem')).toHaveCount(1);
  await expect(needs.getByRole('listitem')).toContainText('A photo ID');
  await expect(needs.getByRole('listitem')).toContainText(/By [A-Z][a-z]{2} \d{1,2}/);
  await expect(page.getByRole('button', { name: 'Send it to Stripe' })).toBeVisible();
  await noStripeCodes(page);
  await page.goto('/more');
  await expect(page.getByRole('link', { name: /^Payments/ })).toContainText(
    /Stripe needs one more thing by [A-Z][a-z]{2} \d{1,2}/,
  );

  // The Express dashboard (the sandbox's stands in for Stripe's).
  await page.goto('/more/payments');
  await (await hydrated(page.getByRole('button', { name: 'Open your Stripe dashboard' }))).click();
  await expect(page.getByRole('status').filter({ hasText: 'sandbox' })).toContainText(
    'Stripe’s dashboard would open here.',
  );
  await expect(page).toHaveURL(/\/more\/payments$/);

  // Sent: Stripe checks, and the owner can ask again.
  await stripeSays(page, 'pending');
  await page.reload();
  await expect(status).toContainText('Stripe is checking your details');
  await (await hydrated(page.getByRole('button', { name: 'Check with Stripe now' }))).click();
  await expect(toast(page)).toContainText('Stripe is still checking.');

  // Ready: the page and More say so.
  await stripeSays(page, 'ready');
  await page.reload();
  await expect(status).toContainText('Ready');
  await expect(status).toContainText('Payments are ready');
  await expect(page.getByRole('region', { name: 'What Stripe needs' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open your Stripe dashboard' })).toBeVisible();
  await expect(page.getByRole('button', { name: /with Stripe$/ })).toHaveCount(0);
  await noStripeCodes(page);
  await page.goto('/more');
  await expect(page.getByRole('link', { name: /^Payments/ })).toContainText('Payments are on');
});

test('a manager reads payments without any button; staff never see them', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000); // two people join; the manager's two-step setup may wait for a code
  const owner = await onboardOwner(page);
  const managerEmail = `${unique('jess')}@example.test`;
  const managerLink = await invite(page, managerEmail, 'Manager');
  const staffEmail = `${unique('priya')}@example.test`;
  const staffLink = await invite(page, staffEmail, 'Staff');

  const jess = await anotherPerson(browser, baseURL);
  await jess.goto(managerLink);
  await jess.getByRole('link', { name: 'Create an account' }).click();
  await signUp(jess, managerEmail, { name: 'Jess', onPage: true });
  await jess.getByRole('button', { name: `Join ${owner.business}` }).click();
  await setUpTwoFactor(jess);
  await expect(jess.getByTestId('business-role')).toHaveText('manager');

  await jess.goto('/more');
  await jess.getByRole('link', { name: /^Payments/ }).click();
  await expect(jess).toHaveURL(/\/more\/payments$/);
  await expect(jess.getByText('Only the owner connects and changes payments.')).toBeVisible();
  await expect(jess.getByTestId('payments-status')).toContainText('Not connected');
  await expect(jess.locator('main').getByRole('button')).toHaveCount(0);

  const priya = await anotherPerson(browser, baseURL);
  await priya.goto(staffLink);
  await priya.getByRole('link', { name: 'Create an account' }).click();
  await signUp(priya, staffEmail, { name: 'Priya', onPage: true });
  await priya.getByRole('button', { name: `Join ${owner.business}` }).click();
  await expect(priya.getByTestId('business-role')).toHaveText('staff');
  await priya.goto('/more');
  await expect(priya.getByRole('heading', { name: 'More', level: 1 })).toBeVisible();
  await expect(priya.getByRole('link', { name: /^Payments/ })).toHaveCount(0);
  await priya.goto('/more/payments');
  await expect(priya).toHaveURL(/\/more$/);
});
