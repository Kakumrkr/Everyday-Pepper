import { AxeBuilder } from '@axe-core/playwright';
import {
  ClientSchema,
  ClientsResponseSchema,
  ServicesResponseSchema,
  StaffResponseSchema,
} from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
import {
  callApi,
  hydrated,
  IMPORT_CSV,
  onboardOwner,
  ownClientAddress,
  visitsCsv,
} from './helpers.js';
import { expectTapTargets } from './tap-targets.js';

// Client import through the screens and the real worker (S48.2, ADR-0049, AC-W1-17…21): an
// owner who checked the setup is offered "Bring your clients" on Home, picks a CSV export,
// checks and changes a column, sees the preview as one sentence with the row to fix first,
// imports, finds the clients, and undoes the whole import.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

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
  await expect(
    page.getByRole('heading', { name: 'Pick your clients or appointments' }),
  ).toBeVisible();

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
  // S49: birthdays import now, found by the column's name.
  await expect(page.getByLabel('Birthday', { exact: true })).toHaveValue('birthday');
  await expect(column(page, 'Birthday')).toContainText('From the column’s name.');
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
  await expect(
    page.getByRole('heading', { name: 'Pick your clients or appointments' }),
  ).toBeVisible();
  await page.goto('/');
  await expect(page.getByTestId('import-offer')).toBeVisible();
});

test('import (AC-W1-46…48): Pepper suggests a column it couldn’t match, the owner uses it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  await page.goto('/clients/import');
  await hydrated(page.getByRole('button', { name: 'Pick a file' }));
  // "Guest" and "Fav" match no header or value; the scripted model calls "Guest" a name.
  await page.getByTestId('import-input').setInputFiles({
    name: 'guests.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'Guest,Email,Fav',
        'Ana Ruiz,ana.ruiz@example.com,Blue',
        'Cara Diaz,cara@example.com,Red',
      ].join('\n'),
    ),
  });
  await expect(page.getByRole('heading', { name: 'Check the columns' })).toBeVisible();
  const suggestion = column(page, 'Guest').getByTestId('import-suggestion');
  await expect(suggestion).toContainText('Looks like Full name to me.');
  await expect(column(page, 'Fav').getByTestId('import-suggestion')).toHaveCount(0);
  // Nothing is mapped until the owner uses it.
  await expect(page.getByLabel('Guest', { exact: true })).toHaveValue('');
  await expect(page.getByTestId('import-problem')).toContainText('the client’s name');
  await expectTapTargets(page, 'the import’s suggestion');

  await suggestion.getByRole('button', { name: 'Use it: Guest as Full name' }).click();
  await expect(page.getByLabel('Guest', { exact: true })).toHaveValue('name');
  await expect(column(page, 'Guest')).toContainText('You chose this.');
  await expect(page.getByTestId('import-suggestion')).toHaveCount(0);
  await expect(page.getByTestId('import-problem')).toHaveCount(0);

  // AC-W1-48: before Import, one line says what is left out and why.
  await page.getByRole('button', { name: 'Check the clients' }).click();
  await expect(page.getByTestId('import-sentence')).toHaveText(
    '2 new clients, 0 to fill in, 0 to fix',
  );
  await expect(page.getByTestId('import-left-out')).toHaveText(
    'Not imported: Fav (nothing in Pepper fits it).',
  );
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map((v) => v.id),
  ).toEqual([]);
  await expect(page.getByRole('button', { name: 'Import 2 clients' })).toBeEnabled();
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

test('import (AC-W1-27…29): an owner brings a visits file, finds its new clients, books a time taken again', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await onboardOwner(page, { type: 'Barbershop' });
  // Zoe was a client before the import: the filtered list leaves her out.
  await callApi(
    page,
    'POST',
    '/v1/clients',
    { name: 'Zoe Lin', phone: '+15550101009' },
    ClientSchema,
  );
  const { services } = ServicesResponseSchema.parse(
    await (await page.request.get('/v1/services')).json(),
  );
  const { staff } = StaffResponseSchema.parse(await (await page.request.get('/v1/staff')).json());
  // Not the first service: "Book again" must choose it, not fall on the default (AC-W1-33).
  const active = services.filter((each) => each.active);
  const chosen = active[1] ?? active[0];
  const service = chosen?.name ?? '';
  const owner = staff[0]?.displayName ?? '';
  expect(service).not.toBe('');
  expect(owner).not.toBe('');

  await page.goto('/clients/import');
  await hydrated(page.getByRole('button', { name: 'Pick a file' }));
  await expect(page.getByText('No one gets an email')).toBeVisible();
  await page.getByTestId('import-input').setInputFiles({
    name: 'appointments.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(visitsCsv({ service, staff: owner })),
  });
  await expect(page.getByRole('heading', { name: 'Check the columns' })).toBeVisible();
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue('visit_date');
  await expect(page.getByLabel('Tags', { exact: true })).toHaveValue('tags');
  // AC-W1-27: the steps speak of visits.
  await page.getByRole('button', { name: 'Check the visits' }).click();

  // The preview: one sentence, the notices, the row to fix, the time taken, the visits' lines.
  await expect(page.getByTestId('import-sentence')).toHaveText(
    '3 past visits, 1 upcoming, 3 new clients, 1 to fix, 1 time taken, 1 left out',
  );
  await expect(page.getByTestId('import-notice')).toHaveText([
    /“Beard sculpt” isn’t one of your services: 1 visit brings it in as a hidden service/,
    new RegExp(`“Jo” isn’t on your team: 1 visit goes to ${owner}`),
  ]);
  const groups = page.getByRole('heading', { level: 3 });
  await expect(groups).toHaveText([
    'To fix · 1',
    'Times taken · 1',
    'Left out · 1',
    'Ready to import · 4',
  ]);
  await expect(page.getByTestId('import-conflict')).toContainText('Dee Park');
  await expect(page.getByTestId('import-conflict')).toContainText('Time taken');
  await expect(page.getByTestId('import-ready').first()).toContainText(
    `Tue, Mar 4, 2025, 10:00 AM · ${service} with ${owner}`,
  );
  await expect(page.getByTestId('import-ready').filter({ hasText: '2099' })).toContainText(
    'Upcoming',
  );
  await expect(page.getByTestId('import-ready').filter({ hasText: 'May 20' })).toContainText(
    'No-show',
  );
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map((v) => v.id),
  ).toEqual([]);
  await expectTapTargets(page, 'the visits preview');

  // Import: what it added, that no one was emailed, and the time taken to book again.
  await (await hydrated(page.getByRole('button', { name: 'Import 4 visits' }))).click();
  await expect(page.getByRole('heading', { name: 'Your visits are in' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId('import-result')).toContainText(
    'Added 3 past visits, 1 upcoming appointment and 3 new clients. No one was emailed.',
  );
  const taken = page.getByTestId('import-taken');
  await expect(taken).toHaveCount(1);
  await expect(taken).toContainText('Dee Park');
  await expect(taken).toContainText(`Tue, Jun 2, 2099, 10:15 AM · ${service} with ${owner}`);
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map((v) => v.id),
  ).toEqual([]);
  await expectTapTargets(page, 'the visits result');

  // AC-W1-29, AC-W1-33: "Book again" opens Dee's profile with Book open on the visit's service
  // and staff member.
  await taken.getByRole('link', { name: /^Book again/ }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `/clients/[0-9a-f-]{36}\\?book=1&service=${chosen?.id ?? ''}&staff=${staff[0]?.id ?? ''}$`,
    ),
  );
  const book = page.getByRole('dialog', { name: 'Book Dee Park' });
  await expect(book).toBeVisible();
  await expect(book.getByLabel('Service')).toHaveValue(chosen?.id ?? '');
  await expect(book.getByLabel('With')).toHaveValue(staff[0]?.id ?? '');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { level: 1, name: 'Dee Park' })).toBeVisible();
  await page.goBack();

  // AC-W1-29: "See your clients" lists only the import's new clients; a search stays inside.
  await (await hydrated(page.getByTestId('import-see-clients'))).click();
  await expect(page).toHaveURL(/\/clients\?import=[0-9a-f-]{36}$/);
  await expect(page.getByTestId('clients-import-filter')).toContainText('New from your import');
  const list = page.getByRole('list', { name: 'Clients' });
  await expect(list.getByRole('link')).toHaveText([/Ana Ruiz/, /Ben Ito/, /Dee Park/]);
  await page.getByLabel('Search clients by name, email or phone').fill('Lin');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('No clients match “Lin”')).toBeVisible();

  // AC-W1-28: Ana's profile shows her tags and birthday.
  await page.getByRole('button', { name: 'Clear the search' }).click();
  await list.getByRole('link', { name: /Ana Ruiz/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ana Ruiz' })).toBeVisible();
  await expect(page.getByTestId('client-tags').getByRole('listitem')).toHaveText(['VIP', 'Color']);
  await expect(page.getByTestId('client-birthday')).toHaveText('April 2, 1990');
  await page.goBack();

  // "Show everyone" leaves the filter.
  await (await hydrated(page.getByRole('link', { name: 'Show everyone' }))).click();
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByTestId('clients-import-filter')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Clients' }).getByText('Zoe Lin')).toBeVisible();

  // The undo names what it takes back.
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/clients\/import\?batch=/);
  await (await hydrated(page.getByRole('button', { name: /^Undo/ }))).click();
  const dialog = page.getByRole('dialog', { name: 'Undo this import?' });
  await expect(dialog).toContainText('I’ll remove the 4 visits and 3 new clients it added');
  await dialog.getByRole('button', { name: 'Undo import' }).click();
  await expect(page.getByTestId('import-result')).toHaveText(
    'Undone: 4 visits and 3 clients removed.',
  );
});
