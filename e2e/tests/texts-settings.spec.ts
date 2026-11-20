import { expect, test, type Page } from '@playwright/test';
import {
  anotherPerson,
  hydrated,
  onboardOwner,
  ownClientAddress,
  signUp,
  toast,
  unique,
} from './helpers.js';
import { newPhone, textTo, typed } from './sms-helpers.js';

// Texts and reminders on screen (S62.2, AC-X-77, ADR-0065): the owner finds them in More, each
// change saves at once and stays; staff read the same settings and cannot change them.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

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
  // Cards by text are for owners and managers: no number row for staff (S63.2).
  await expect(priya.getByTestId('card-texts')).toHaveCount(0);
});

test('an owner checks their number with the texted code and turns on cards by text; a new number turns them off', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const owner = await onboardOwner(page);
  await page.goto('/more/texts');
  const cards = page.getByTestId('card-texts');
  await expect(cards.getByTestId('my-number')).toHaveText('None yet');
  const switchRow = cards.getByRole('switch', { name: 'Text me cards' });
  await expect(await hydrated(switchRow)).toBeDisabled();
  await expect(switchRow).toHaveAccessibleDescription(/^Add your number first\./);

  // A number Pepper can't text, then a wrong code: each says what to do.
  await cards.getByRole('button', { name: 'Add your number' }).click();
  const sheet = page.getByRole('dialog', { name: 'Your mobile number' });
  await sheet.getByLabel('Mobile number').fill('+44 7700 900123');
  await sheet.getByRole('button', { name: 'Text me a code' }).click();
  await expect(sheet.getByRole('alert')).toHaveText('Use a US or Canadian mobile number.');
  const phone = newPhone();
  await sheet.getByLabel('Mobile number').fill(typed(phone));
  await sheet.getByRole('button', { name: 'Text me a code' }).click();
  const codeStep = page.getByRole('dialog', { name: 'Type the code' });
  await expect(codeStep).toContainText(
    `I texted a code to ${typed(phone)}. It works for 10 minutes.`,
  );
  const code =
    /your code is (\d{6})\./.exec(await textTo(page, phone, /your code is \d{6}/))?.[1] ?? '';
  await codeStep.getByLabel('6-digit code').fill(code === '000000' ? '111111' : '000000');
  await codeStep.getByRole('button', { name: 'Check the code' }).click();
  await expect(codeStep.getByRole('alert')).toHaveText(
    'That code isn’t right. Check the text and try again.',
  );
  await codeStep.getByLabel('6-digit code').fill(code);
  await codeStep.getByRole('button', { name: 'Check the code' }).click();
  await expect(codeStep).toHaveCount(0);
  await expect(toast(page).last()).toContainText(
    'Number checked. Turn on Text me cards to approve by text.',
  );
  await expect(cards.getByTestId('my-number')).toHaveText(typed(phone));

  // On, with the words the owner agrees to, and still on after a reload.
  await expect(switchRow).toHaveAccessibleDescription(
    `Text me cards that need my OK from ${owner.business} at this number. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.`,
  );
  await switchRow.click();
  await expect(toast(page).last()).toContainText('Saved. I’ll text you cards that need your OK.');
  await page.reload();
  await expect(await hydrated(cards.getByRole('switch', { name: 'Text me cards' }))).toBeChecked();

  // A new number: checked the same way, and cards by text are off until turned on again
  // (ADR-0066 §1). The code is pasted with a space, as it often is from a text.
  const second = newPhone();
  await cards.getByRole('button', { name: 'Change number' }).click();
  await sheet.getByLabel('Mobile number').fill(typed(second));
  await sheet.getByRole('button', { name: 'Text me a code' }).click();
  const secondCode =
    /your code is (\d{6})\./.exec(await textTo(page, second, /your code is \d{6}/))?.[1] ?? '';
  await codeStep
    .getByLabel('6-digit code')
    .fill(`${secondCode.slice(0, 3)} ${secondCode.slice(3)}`);
  await expect(codeStep.getByLabel('6-digit code')).toHaveValue(secondCode);
  await codeStep.getByRole('button', { name: 'Check the code' }).click();
  await expect(codeStep).toHaveCount(0);
  await expect(toast(page).last()).toContainText(
    'Number checked. Text me cards is off for the new number: turn it on again to get them.',
  );
  await expect(cards.getByTestId('my-number')).toHaveText(typed(second));
  await expect(cards.getByRole('switch', { name: 'Text me cards' })).not.toBeChecked();
});
