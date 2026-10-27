import { expect, test, type Page } from '@playwright/test';
import {
  anotherPerson,
  enterPassword,
  goTo,
  hydrated,
  onboardOwner,
  ownClientAddress,
  setUpTwoFactor,
  signUp,
  unique,
} from './helpers.js';

// Inviting people and managing the team through the real stack (ADR-0014): the owner creates
// an invite link, the invitee signs up or signs in with that email and joins; the owner changes
// their role and removes them; staff can only leave. Each person has their own browser.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

/** On the team page: invites `email` as `role`; returns the link to share. */
async function createInvite(page: Page, email: string, role: string): Promise<string> {
  await hydrated(page.getByRole('button', { name: 'Create invite link' }));
  await page.getByLabel('Their email').fill(email);
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption({ label: role });
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = (await page.getByTestId('invite-link').textContent()) ?? '';
  expect(link).toMatch(/\/invite#[A-Za-z0-9_-]{43}$/);
  return link;
}

test('an owner invites a manager, who signs up, joins and sets up MFA; the owner changes their role and removes them', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000); // two-step setups may wait for the next 30-second code
  const owner = await onboardOwner(page);
  await goTo(page, 'Team');
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
  await expect(page.getByTestId('member')).toHaveCount(1);
  await expect(page.getByTestId('member')).toContainText('(you)');

  const jessEmail = `${unique('jess')}@example.test`;
  const link = await createInvite(page, jessEmail, 'Manager');
  await expect(page.getByTestId('invite')).toContainText(jessEmail);

  // Jess opens the link without an account.
  const jess = await anotherPerson(browser, baseURL);
  await jess.goto(link);
  await expect(jess.getByRole('heading', { name: /invited to join/ })).toBeVisible();
  // The token left the address bar.
  expect(new URL(jess.url()).hash).toBe('');
  await jess.getByRole('link', { name: 'Create an account' }).click();
  await expect(jess).toHaveURL(/\/sign-up\?next=%2Finvite$/);
  await signUp(jess, jessEmail.toUpperCase(), { name: 'Jess', onPage: true });

  await expect(jess).toHaveURL(/\/invite$/);
  await expect(jess.getByRole('heading', { name: `Join ${owner.business}` })).toBeVisible();
  await expect(jess.getByTestId('invite-role')).toHaveText('a manager');
  await jess.getByRole('button', { name: `Join ${owner.business}` }).click();
  // Managers protect the business with a second factor before they can use it.
  await setUpTwoFactor(jess);
  await expect(jess).toHaveURL(/\/$/);
  await expect(jess.getByTestId('business-name')).toHaveText(owner.business);
  await expect(jess.getByTestId('business-role')).toHaveText('manager');

  // The link was single use.
  await jess.goto(link);
  await expect(jess.getByRole('alert').filter({ hasText: 'no longer works' })).toBeVisible();

  // The owner sees Jess in the team, the invite gone, and makes her staff.
  await page.reload();
  const row = page.getByTestId('member').filter({ hasText: 'Jess' });
  await expect(row.getByLabel('Role for Jess')).toHaveValue('manager');
  await expect(page.getByTestId('invite')).toHaveCount(0);
  // Choosing a role saves in the background: wait for the save, or the reload can cancel it.
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().includes('/v1/members/'),
  );
  await row.getByLabel('Role for Jess').selectOption('staff');
  expect((await saved).status()).toBe(200);
  await page.reload();
  await expect(row.getByLabel('Role for Jess')).toHaveValue('staff');

  await row.getByRole('button', { name: 'Remove Jess' }).click();
  await row.getByRole('button', { name: 'Yes, remove Jess' }).click();
  await expect(page.getByTestId('member')).toHaveCount(1);

  // Jess no longer belongs to any business.
  await jess.goto('/');
  await expect(jess).toHaveURL(/\/onboarding\/business$/);
  await jess.context().close();
});

test('a forwarded link is refused; the invited person signs in, joins as staff, and can only leave', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const owner = await onboardOwner(page);
  await page.goto('/team');
  const priyaEmail = `${unique('priya')}@example.test`;

  // Priya already has an account (for another business, or none yet).
  const priya = await anotherPerson(browser, baseURL);
  await signUp(priya, priyaEmail, { name: 'Priya' });
  await expect(priya).toHaveURL(/\/onboarding\/business$/);
  // Signed out again: she comes back through the link.
  await priya.context().clearCookies();

  const link = await createInvite(page, priyaEmail, 'Staff');

  // Someone else signed in opens the forwarded link.
  const stranger = await anotherPerson(browser, baseURL);
  await signUp(stranger, `${unique('stranger')}@example.test`, { name: 'Sam' });
  await expect(stranger).toHaveURL(/\/onboarding\/business$/);
  await stranger.goto(link);
  await expect(stranger.getByRole('alert').filter({ hasText: 'different email' })).toBeVisible();
  await expect(stranger.getByText(owner.business)).toHaveCount(0);
  await stranger.context().close();

  // Priya signs in from the link and joins.
  await priya.goto(link);
  await priya.getByRole('link', { name: 'Sign in' }).click();
  await expect(priya).toHaveURL(/\/sign-in\?next=%2Finvite$/);
  await enterPassword(priya, priyaEmail);
  await expect(priya).toHaveURL(/\/invite$/);
  await expect(priya.getByTestId('invite-role')).toHaveText('a team member');
  await priya.getByRole('button', { name: `Join ${owner.business}` }).click();
  // Staff need no second factor.
  await expect(priya).toHaveURL(/\/$/);
  await expect(priya.getByTestId('business-role')).toHaveText('staff');

  // Staff see no team list and no invite form, only "Leave".
  await goTo(priya, 'Team');
  await expect(priya.getByRole('heading', { name: 'Team' })).toBeVisible();
  await expect(priya.getByTestId('members')).toHaveCount(0);
  await expect(priya.getByRole('button', { name: 'Create invite link' })).toHaveCount(0);
  const overflow = await priya.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
  await priya.getByRole('button', { name: `Leave ${owner.business}` }).click();
  await priya.getByRole('button', { name: `Yes, leave ${owner.business}` }).click();
  await expect(priya).toHaveURL(/\/onboarding\/business$/);

  // The owner's team is back to one.
  await page.reload();
  await expect(page.getByTestId('member')).toHaveCount(1);
  await priya.context().close();
});

test('the team page fits a phone screen', async ({ page }) => {
  test.setTimeout(60_000);
  await onboardOwner(page);
  await page.goto('/team');
  await createInvite(page, `${unique('wide')}@example.test`, 'Staff');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test('the team and invite pages need an account', async ({ page }) => {
  await page.goto('/team');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/invite');
  await expect(page.getByRole('alert').filter({ hasText: 'incomplete' })).toBeVisible();
});
