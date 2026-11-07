import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { hydrated, onboardOwner, ownClientAddress, unique } from './helpers.js';
import { expectTapTargets } from './tap-targets.js';

// The help centre (S59, PCR-010, AC-X-13, AC-X-17): public, searchable, and every article ends
// in a way to ask: the public form when signed out (it reaches the team only), the app's form
// when signed in.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MAILPIT_URL = process.env['MAILPIT_URL'] ?? 'http://localhost:8025';

test('help (AC-X-13/17): signed out, search, read an article and write to the team', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/sign-in');
  await page.getByRole('link', { name: 'Get help' }).click();
  await expect(page).toHaveURL(/\/help\/sign-in$/);
  await page.getByRole('link', { name: 'All help' }).click();

  await expect(page.getByRole('heading', { name: 'How can we help?', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Getting started', level: 2 })).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    [],
  );
  await expectTapTargets(page, 'the help centre');

  const search = await hydrated(page.getByLabel('Search the help centre'));
  await search.fill('IMPORT');
  await expect(
    page.getByRole('link', { name: /Bring your clients from another app/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Invite your team/ })).toHaveCount(0);
  await search.fill('zebra quantum');
  await expect(page.getByText('No article matches')).toBeVisible();
  await search.fill('import');
  await page.getByRole('link', { name: /Bring your clients from another app/ }).click();

  await expect(
    page.getByRole('heading', { name: 'Bring your clients from another app', level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('Undo an import for 7 days', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Write to us' }).click();
  await expect(page).toHaveURL(/\/help\/contact\?topic=import-clients$/);

  const email = `${unique('locked')}@example.test`;
  await (await hydrated(page.getByRole('button', { name: 'Send to Pepper' }))).click();
  await expect(page.getByText('Enter the email we should answer.')).toBeVisible();
  await page.getByLabel('Your email').fill(email);
  await page.getByLabel('What’s going on?').fill('My import file is from an app you don’t list.');
  await page.getByRole('button', { name: 'Send to Pepper' }).click();
  await expect(page.getByTestId('support-sent')).toContainText(email);
  const reference = (await page.getByTestId('support-reference').textContent()) ?? '';
  expect(reference).toMatch(/^PEP-/);

  // It reaches the team with Reply-To the typed address; nothing goes to that address.
  const deadline = Date.now() + 15_000;
  let found: { ID: string; Subject: string } | undefined;
  while (found === undefined && Date.now() < deadline) {
    const search = await fetch(
      `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`subject:"${reference}"`)}`,
    );
    found = ((await search.json()) as { messages: { ID: string; Subject: string }[] }).messages[0];
    if (found === undefined) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  expect(found?.Subject).toBe(`[${reference}] Signed-out request`);
  const message = (await (
    await fetch(`${MAILPIT_URL}/api/v1/message/${found?.ID ?? ''}`)
  ).json()) as {
    To: { Address: string }[];
    ReplyTo: { Address: string }[];
    Text: string;
  };
  expect(message.To.map((to) => to.Address)).toEqual(['support@pepper.localhost']);
  expect(message.ReplyTo.map((to) => to.Address)).toEqual([email]);
  expect(message.Text).toContain('Help article: import-clients');
  const toThem = await fetch(
    `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  expect(((await toThem.json()) as { messages: unknown[] }).messages).toEqual([]);
});

test('help (AC-X-13): a screen’s help link opens its article; signed in, “Still stuck?” opens the app’s form', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  await page.goto('/clients/import');
  await page.getByRole('link', { name: 'How this works' }).click();
  await expect(page).toHaveURL(/\/help\/import-clients$/);
  await page.getByRole('link', { name: 'Tell us what went wrong' }).click();
  await expect(page).toHaveURL(
    /\/support\/new\?from=%2Fhelp%2Fimport-clients&topic=import-clients$/,
  );
  await expect(page.getByRole('radio', { name: /A question/ })).toBeChecked();
  // Signed in, the public form sends people to the app's own.
  await page.goto('/help/contact?topic=team');
  await expect(page).toHaveURL(/\/support\/new\?from=%2Fhelp%2Fcontact&topic=team$/);
});
