import { expect, test, type Page } from '@playwright/test';
import { anotherPerson, hydrated, onboardOwner, signUp, toast, unique } from './helpers.js';

// Texts and reminders on screen (S62.2, AC-X-77, ADR-0065): the owner finds them in More, each
// change saves at once and stays; staff read the same settings and cannot change them.

/** On the team page: invites `email` as staff; returns the link to share. */
async function inviteStaff(page: Page, email: string): Promise<string> {
  await page.goto('/team');
  await hydrated(page.getByRole('button', { name: 'Create invite link' }));
  await page.getByLabel('Their email').fill(email);
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption({ label: 'Staff' });
  await page.getByRole('button', { name: 'Create invite link' }).click();
  return (await page.getByTestId('invite-link').textContent()) ?? '';
}

test('an owner changes the reminders from More, and they stay changed', async ({ page }) => {
  test.setTimeout(90_000);
  await onboardOwner(page);
  await page.goto('/more');
  const row = page.getByRole('link', { name: /^Texts and reminders/ });
  await expect(row).toContainText('A reminder the day before and a text 2 hours ahead');
  await row.click();
  await expect(page).toHaveURL(/\/more\/texts$/);
  await expect(page.getByRole('heading', { name: 'Texts and reminders', level: 1 })).toBeVisible();

  const sameDay = await hydrated(page.getByRole('switch', { name: 'On the day' }));
  await expect(sameDay).toBeChecked();
  await page.getByRole('radio', { name: '1 hour' }).click();
  await expect(toast(page)).toContainText('Saved. The text on the day goes 1 hour ahead.');
  await expect(page.getByRole('switch', { name: 'On the day' })).toHaveAccessibleDescription(
    'A short text 1 hour before they come in.',
  );

  await page.getByRole('switch', { name: 'The day before' }).click();
  await expect(toast(page).last()).toContainText('Saved. No reminder the day before.');

  // Saved on the api: a fresh load shows the same, and More sums it up.
  await page.reload();
  await expect(
    await hydrated(page.getByRole('switch', { name: 'The day before' })),
  ).not.toBeChecked();
  await expect(page.getByRole('radio', { name: '1 hour' })).toBeChecked();
  await page.goto('/more');
  await expect(page.getByRole('link', { name: /^Texts and reminders/ })).toContainText(
    'A text 1 hour ahead',
  );

  // Texts off: the same-day text waits (a text only), and More says no reminders go.
  await page.goto('/more/texts');
  await (await hydrated(page.getByRole('switch', { name: 'Texts to clients' }))).click();
  await expect(toast(page)).toContainText('Saved. No texts go to clients.');
  await expect(page.getByRole('switch', { name: 'On the day' })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'On the day' })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: '1 hour' })).toHaveCount(0);
  await page.goto('/more');
  await expect(page.getByRole('link', { name: /^Texts and reminders/ })).toContainText(
    'No reminders before a visit',
  );
});

test('staff read the reminders and cannot change them', async ({ page, browser, baseURL }) => {
  test.setTimeout(90_000);
  const owner = await onboardOwner(page);
  const email = `${unique('priya')}@example.test`;
  const link = await inviteStaff(page, email);

  const priya = await anotherPerson(browser, baseURL);
  await priya.goto(link);
  await priya.getByRole('link', { name: 'Create an account' }).click();
  await signUp(priya, email, { name: 'Priya', onPage: true });
  await priya.getByRole('button', { name: `Join ${owner.business}` }).click();
  await expect(priya.getByTestId('business-role')).toHaveText('staff');

  await priya.goto('/more');
  await priya.getByRole('link', { name: /^Texts and reminders/ }).click();
  await expect(priya.getByText('Only owners and managers change these.')).toBeVisible();
  for (const name of ['Texts to clients', 'The day before', 'On the day']) {
    await expect(priya.getByRole('switch', { name })).toBeDisabled();
  }
  // The lead is read out, not offered.
  await expect(priya.getByTestId('same-day-lead')).toHaveText('2 hours before.');
  await expect(priya.getByRole('radio', { name: '1 hour' })).toHaveCount(0);
});
