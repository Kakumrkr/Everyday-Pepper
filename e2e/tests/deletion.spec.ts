import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { hydrated, onboardOwner, PASSWORD, signUp, unique } from './helpers.js';
import { expectTapTargets } from './tap-targets.js';

// Deleting the business and the account through the screens (S51.2, ADR-0054, AC-W1-40,
// AC-W1-42): the owner finds "Delete" under Your data, is offered the download first, types
// the business's name, sees the day and keeps it again; the account is refused while it alone
// owns a live business, then scheduled by its password and kept. The deleting after 30 days
// is in the api's and the worker's integration tests.

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function checkScreen(page: Page, name: string, frame: 'app' | 'account' = 'app') {
  // The screens refresh after an action (`router.refresh()`), and while the new payload renders
  // the document can be briefly without its <title>: axe checks the settled screen (CI, S61.2).
  await expect(page).toHaveTitle(/ · Pepper$/, { timeout: 15_000 });
  const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    [],
  );
  await expectTapTargets(page, name);
  // The one action within thumb reach (D3): above the tabs, or at the bottom of an account screen.
  const action =
    frame === 'app'
      ? page.getByTestId('deletion-actions')
      : page.getByRole('button', { name: /Delete my account|Keep my account/ });
  const bar = await action.boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  expect(bar).not.toBeNull();
  expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBeGreaterThan(height - 160);
}

test('deletion (AC-W1-40, AC-W1-42): the owner schedules and keeps the business, then the account', async ({
  page,
}) => {
  test.setTimeout(150_000);
  // A name of its own per run (its booking link is made from it).
  const name = `Juniper Leaving ${unique('studio')}`;
  await onboardOwner(page, { business: name });

  // The business: More → Download your data → Delete.
  await page.goto('/more');
  await page.getByRole('link', { name: 'Download your data' }).click();
  await page.getByRole('link', { name: new RegExp(`Delete ${name}`) }).click();
  await expect(page).toHaveURL(/\/more\/data\/delete$/);
  await expect(page.getByRole('heading', { name: `Delete ${name}`, level: 1 })).toBeVisible();
  // The download is offered first, before the name to type (the S51 retro's top-up).
  const download = page.getByRole('button', { name: 'Download your data' });
  const confirm = page.getByLabel(`Type ${name} to confirm`);
  const [downloadBox, confirmBox] = await Promise.all([
    download.boundingBox(),
    confirm.boundingBox(),
  ]);
  expect(downloadBox?.y ?? Infinity).toBeLessThan(confirmBox?.y ?? 0);
  await checkScreen(page, 'Delete business');

  const remove = await hydrated(page.getByRole('button', { name: `Delete ${name}` }));
  await confirm.fill('Juniper');
  await remove.click();
  await expect(page.getByText('That isn’t the business’s name.')).toBeVisible();
  await confirm.fill(name.toLowerCase());
  await remove.click();
  await expect(
    page.getByRole('heading', { name: `${name} is being deleted`, level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId('business-deletion-due')).toContainText('Pepper deletes');
  await checkScreen(page, 'Business being deleted');

  // More says so too.
  await page.goto('/more');
  await expect(page.getByTestId('business-deletion-notice')).toContainText(
    `Pepper deletes ${name} on`,
  );

  await expect(page.getByRole('link', { name: 'Keep it' })).toHaveAttribute(
    'href',
    '/more/data/delete',
  );

  // Home says so in one quiet line, and its owner keeps the business there (S52, AC-W1-45).
  await page.goto('/');
  const line = page.getByTestId('home-deletion-line');
  await expect(line).toContainText(`Pepper deletes ${name} on`);
  await expectTapTargets(page, 'Home while the business is being deleted');
  await (await hydrated(line.getByRole('button', { name: `Keep ${name}` }))).click();
  await expect(line).toHaveCount(0);
  await page.goto('/more');
  await expect(page.getByTestId('business-deletion-notice')).toHaveCount(0);
  await page.goto('/more/data/delete');
  await expect(page.getByRole('heading', { name: `Delete ${name}`, level: 1 })).toBeVisible();

  // The account: refused while it alone owns a live business.

  await page.goto('/more');
  await page.getByRole('link', { name: 'Delete your account' }).click();
  await expect(page).toHaveURL(/\/account\/delete$/);
  await expect(page.getByRole('heading', { name: 'Delete your account', level: 1 })).toBeVisible();
  await checkScreen(page, 'Delete account', 'account');
  const deleteAccount = await hydrated(page.getByRole('button', { name: 'Delete my account' }));
  await page.getByLabel('Your password').fill('not my password');
  await deleteAccount.click();
  await expect(page.getByText('That password isn’t right.')).toBeVisible();
  await page.getByLabel('Your password').fill(PASSWORD);
  await deleteAccount.click();
  await expect(page.getByText('You’re the only owner of a business.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Delete the business' })).toBeVisible();
});

test('deletion (AC-W1-42): an account with no business is scheduled and kept', async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page, `${unique('leaver')}@example.test`);
  await expect(page).toHaveURL(/\/onboarding\/business$/, { timeout: 20_000 });
  await page.goto('/account/delete');
  const deleteAccount = await hydrated(page.getByRole('button', { name: 'Delete my account' }));
  await page.getByLabel('Your password').fill(PASSWORD);
  await deleteAccount.click();
  await expect(
    page.getByRole('heading', { name: 'Your account is being deleted', level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId('account-deletion-due')).toContainText(
    'Pepper deletes your account on',
  );
  await checkScreen(page, 'Account being deleted', 'account');
  await (await hydrated(page.getByRole('button', { name: 'Keep my account' }))).click();
  await expect(page.getByRole('heading', { name: 'Delete your account', level: 1 })).toBeVisible();
});
