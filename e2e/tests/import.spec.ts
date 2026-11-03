import { AxeBuilder } from '@axe-core/playwright';
import { ClientSchema, ClientsResponseSchema } from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
import { callApi, hydrated, onboardOwner, ownClientAddress } from './helpers.js';
import { expectTapTargets } from './tap-targets.js';

// Client import through the screens and the real worker (S48.2, ADR-0049, AC-W1-17…21): an
// owner who checked the setup is offered "Bring your clients" on Home, picks a CSV export,
// checks and changes a column, sees the preview as one sentence with the row to fix first,
// imports, finds the clients, and undoes the whole import.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Made-up rows: two new clients, one already here who gains an email, one without a name,
// and a repeat of an earlier row. The birthday column is recognised but comes later (S49).
const IMPORT_CSV = [
  'Name,Email,Phone,Birthday',
  'Ana Ruiz,ana.ruiz@example.com,555-010-1001,1990-04-02',
  'Ben Ito,ben.ito@example.com,555-010-1002,',
  ',nobody@example.com,555-010-1003,',
  'Ana Ruiz,ana.ruiz@example.com,555-010-1001,1990-04-02',
  'Cara Diaz,,555-010-1004,',
].join('\n');

const SENTENCE = '2 new clients, 1 to fill in, 1 to fix, 1 left out';

/** A column of the file on the mapping step, by its name (each holds every field's option). */
function column(page: Page, name: string) {
  return page.getByTestId('import-column').filter({ has: page.getByLabel(name, { exact: true }) });
}

async function clientNamed(page: Page, name: string) {
  const { clients } = ClientsResponseSchema.parse(
    await (await page.request.get('/v1/clients?limit=50')).json(),
  );
  return clients.find((client) => client.name === name);
}

test('import (AC-W1-17…21): an owner brings a CSV through the screens and undoes it', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await onboardOwner(page, { type: 'Barbershop' });
  // Ben is already a client, with a phone and no email.
  await callApi(
    page,
    'POST',
    '/v1/clients',
    { name: 'Ben Ito', phone: '+15550101002' },
    ClientSchema,
  );

  // AC-W1-20: no offer before the setup check; after it, "Bring your clients".
  await expect(page.getByTestId('setup-review')).toBeVisible();
  await expect(page.getByTestId('import-offer')).toHaveCount(0);
  await (await hydrated(page.getByRole('button', { name: 'I’ve checked these' }))).click();
  const offer = page.getByRole('region', { name: 'Bring your clients' });
  await expect(offer).toBeVisible();
  await offer.getByRole('link', { name: 'Bring your clients' }).click();
  await expect(page).toHaveURL(/\/clients\/import$/);
  await expect(page.getByRole('heading', { name: 'Pick your client list' })).toBeVisible();

  // A file that can't be read: what to fix, and nothing staged.
  const input = page.getByTestId('import-input');
  await hydrated(page.getByRole('button', { name: 'Pick a file' }));
  await input.setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.from('') });
  await expect(page.getByTestId('import-error')).toContainText('That file is empty');

  // The CSV: its columns, matched by name and values; birthdays come later.
  await input.setInputFiles({
    name: 'clients.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(IMPORT_CSV),
  });
  await expect(page.getByRole('heading', { name: 'Check the columns' })).toBeVisible();
  await expect(page).toHaveURL(/\/clients\/import\?batch=[0-9a-f-]{36}$/);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('name');
  await expect(page.getByLabel('Phone', { exact: true })).toHaveValue('phone');
  await expect(column(page, 'Birthday')).toContainText('Birthdays come in a later update.');
  await expectTapTargets(page, 'the import’s columns');

  // AC-W1-17: the owner changes a column and the preview follows; then puts it back.
  await page.getByLabel('Email', { exact: true }).selectOption({ label: 'Don’t import' });
  await expect(column(page, 'Email')).toContainText('Not imported.');
  await page.getByRole('button', { name: 'Check the clients' }).click();
  await expect(page.getByTestId('import-sentence')).not.toHaveText(SENTENCE);
  await page.getByRole('button', { name: 'Columns' }).click();
  await (
    await hydrated(page.getByLabel('Email', { exact: true }))
  ).selectOption({ label: 'Email' });
  await expect(column(page, 'Email')).toContainText('You chose this.');
  await page.getByRole('button', { name: 'Check the clients' }).click();

  // AC-W1-21: the counts in one sentence, the row to fix first, with its reason.
  await expect(page.getByTestId('import-sentence')).toHaveText(SENTENCE);
  const groups = page.getByRole('heading', { level: 3 });
  await expect(groups).toHaveText(['To fix · 1', 'Left out · 1', 'Ready to import · 3']);
  await expect(page.getByTestId('import-fix')).toContainText('Row 4');
  await expect(page.getByTestId('import-skipped')).toContainText('Row 5');
  await expect(page.getByTestId('import-ready').filter({ hasText: 'Ben Ito' })).toContainText(
    'Fills in',
  );
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map((v) => v.id),
  ).toEqual([]);
  await expectTapTargets(page, 'the import’s preview');

  // A refresh opens the import where it was.
  await page.reload();
  await expect(page.getByTestId('import-sentence')).toHaveText(SENTENCE);

  // Import: the worker runs it; the result says what it did, with Undo for a week.
  await (await hydrated(page.getByRole('button', { name: 'Import 3 clients' }))).click();
  await expect(page.getByRole('heading', { name: 'Your clients are in' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId('import-result')).toContainText(
    '2 new clients added, 1 filled in. You can undo it until',
  );
  expect(await clientNamed(page, 'Ana Ruiz')).toBeDefined();
  expect((await clientNamed(page, 'Ben Ito'))?.email).toBe('ben.ito@example.com');
  await page.getByRole('link', { name: 'See your clients' }).click();
  await expect(page.getByText('Cara Diaz')).toBeVisible();

  // AC-W1-20: once an import is in, Home stops offering it.
  await page.goto('/');
  await expect(page.getByTestId('booking-link')).toBeVisible();
  await expect(page.getByTestId('import-offer')).toHaveCount(0);

  // AC-W1-19: undo the whole import, after a confirmation.
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/clients\/import\?batch=/);
  await (await hydrated(page.getByRole('button', { name: /^Undo/ }))).click();
  const dialog = page.getByRole('dialog', { name: 'Undo this import?' });
  await dialog.getByRole('button', { name: 'Undo import' }).click();
  await expect(page.getByRole('heading', { name: 'Import undone' })).toBeVisible();
  await expect(page.getByTestId('import-result')).toHaveText(
    'Undone: 2 clients removed, 1 cleared again.',
  );
  expect(await clientNamed(page, 'Ana Ruiz')).toBeUndefined();
  const ben = await clientNamed(page, 'Ben Ito');
  expect(ben?.email ?? null).toBeNull();
  expect(ben?.phone).not.toBeNull();

  // Undone, the offer is back; and Import a file starts over.
  await page.getByRole('button', { name: 'Import a file' }).click();
  await expect(page).toHaveURL(/\/clients\/import$/);
  await expect(page.getByRole('heading', { name: 'Pick your client list' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByTestId('import-offer')).toBeVisible();
});

test('import: Clients offers Import to the owner; a link to an import of no one opens the start', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  await page.goto('/clients');
  await page.getByTestId('import-clients').click();
  await expect(page).toHaveURL(/\/clients\/import$/);
  await page.goto('/clients/import?batch=0190a0a0-0000-7000-8000-0000000000ff');
  await expect(page.getByTestId('import-error')).toHaveText(
    'I couldn’t find that import. Pick your file again.',
  );
  await expect(page.getByRole('button', { name: 'Pick a file' })).toBeVisible();
});
