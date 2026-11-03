import { AxeBuilder } from '@axe-core/playwright';
import {
  AvailabilityResponseSchema,
  BookingSchema,
  ClientSchema,
  ClientsResponseSchema,
  ServicesResponseSchema,
} from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
import { callApi, hydrated, onboardOwner, ownClientAddress } from './helpers.js';
import { expectTapTargets } from './tap-targets.js';

// A client's lifecycle on the profile (S50, ADR-0051, AC-W1-30…32): an owner gives a client
// tags and a birthday, merges a duplicate into them (the visit moves, the email fills in), is
// told to cancel visits coming up before deleting, and deletes another client, who is then
// nowhere to be found.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function clientsNamed(page: Page, search: string) {
  const query = new URLSearchParams({ search, limit: '50' });
  return ClientsResponseSchema.parse(await (await page.request.get(`/v1/clients?${query}`)).json())
    .clients;
}

/** Books the client at the first free time of the business's first service. */
async function bookSoon(page: Page, clientId: string): Promise<void> {
  const { services } = ServicesResponseSchema.parse(
    await (await page.request.get('/v1/services')).json(),
  );
  const service = services.find((each) => each.active);
  if (service === undefined) throw new Error('No service to book');
  const from = new Date(Date.now() + 86_400_000);
  const range = new URLSearchParams({
    serviceId: service.id,
    from: from.toISOString(),
    to: new Date(from.getTime() + 7 * 86_400_000).toISOString(),
  });
  const { slots } = AvailabilityResponseSchema.parse(
    await (await page.request.get(`/v1/availability?${range}`)).json(),
  );
  const [slot] = slots;
  if (slot === undefined) throw new Error('No free time to book');
  await callApi(
    page,
    'POST',
    '/v1/bookings',
    {
      clientId,
      serviceId: service.id,
      staffMemberId: slot.staffMemberId,
      startsAt: slot.startsAt,
      notifyClient: false,
    },
    BookingSchema,
  );
}

test('clients (AC-W1-30…32): an owner edits tags and birthday, merges a duplicate and deletes a client', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await onboardOwner(page, { type: 'Barbershop' });
  const dee = await callApi(
    page,
    'POST',
    '/v1/clients',
    { name: 'Dee Hart', phone: '+15550102001' },
    ClientSchema,
  );
  const dupe = await callApi(
    page,
    'POST',
    '/v1/clients',
    { name: 'Dee H.', email: 'dee.h@example.test', tags: ['Color'] },
    ClientSchema,
  );
  await bookSoon(page, dupe.id);

  // AC-W1-32: tags and a birthday from the editor.
  await page.goto(`/clients/${dee.id}`);
  await (await hydrated(page.getByRole('button', { name: 'Edit details' }))).click();
  const editor = page.getByRole('dialog', { name: 'Edit Dee Hart' });
  await editor.getByLabel('Tags (optional)').fill('VIP, vip,  regular ');
  await editor.getByLabel('Month').selectOption({ label: 'March' });
  await editor.getByLabel('Day').fill('12');
  await editor.getByLabel('Year').fill('2023');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId('client-tags').getByRole('listitem')).toHaveText([
    'VIP',
    'regular',
  ]);
  await expect(page.getByTestId('client-birthday')).toHaveText('March 12, 2023');

  // AC-W1-30: merge the duplicate in; its visit and email move here, its tag joins.
  await (await hydrated(page.getByRole('button', { name: 'Merge with…' }))).click();
  const merge = page.getByRole('dialog', { name: 'Merge Dee Hart with…' });
  await merge.getByLabel('Find the other record by name or email').fill('Dee');
  await merge.getByRole('button', { name: 'Search' }).click();
  const picks = merge.getByRole('list', { name: 'Pick the other record' });
  // Dee Hart herself isn't offered.
  await expect(picks.getByRole('listitem')).toHaveCount(1);
  await picks.getByRole('button', { name: 'Pick Dee H.' }).click();
  await expect(merge.getByTestId('merge-confirm')).toContainText(
    'Dee H.’s 1 visit moves to Dee Hart.',
  );
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map((v) => v.id),
  ).toEqual([]);
  await expectTapTargets(page, 'the merge confirm');
  await merge.getByRole('button', { name: 'Merge into Dee Hart' }).click();
  await expect(merge).toHaveCount(0);
  await expect(page.getByTestId('client-contact')).toContainText('dee.h@example.test');
  await expect(page.getByTestId('client-tags').getByRole('listitem')).toHaveText([
    'VIP',
    'regular',
    'Color',
  ]);
  await expect(page.getByTestId('upcoming-visits').getByRole('listitem')).toHaveCount(1);
  expect((await clientsNamed(page, 'Dee')).map((client) => client.name)).toEqual(['Dee Hart']);
  expect((await page.request.get(`/v1/clients/${dupe.id}`)).status()).toBe(404);

  // AC-W1-31: with a visit coming up, deleting waits.
  await (await hydrated(page.getByRole('button', { name: 'Delete client' }))).click();
  const refuse = page.getByRole('dialog', { name: 'Delete Dee Hart?' });
  await expect(refuse.getByTestId('delete-confirm')).toHaveText(
    'Dee Hart has 1 visit coming up. Cancel or move it first, then delete.',
  );
  await expect(refuse.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
  await refuse.getByRole('button', { name: 'OK' }).click();
  await expect(refuse).toHaveCount(0);

  // AC-W1-31: a client without visits is forgotten, and found nowhere.
  const zoe = await callApi(
    page,
    'POST',
    '/v1/clients',
    { name: 'Zoe Quill', email: 'zoe.q@example.test' },
    ClientSchema,
  );
  await page.goto(`/clients/${zoe.id}`);
  await (await hydrated(page.getByRole('button', { name: 'Delete client' }))).click();
  const confirm = page.getByRole('dialog', { name: 'Delete Zoe Quill?' });
  await expect(confirm.getByTestId('delete-confirm')).toContainText(
    'I’ll forget Zoe Quill’s name, email, phone, tags and birthday, everywhere I keep them.',
  );
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map((v) => v.id),
  ).toEqual([]);
  await confirm.getByRole('button', { name: 'Delete Zoe Quill' }).click();
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByRole('list', { name: 'Clients' }).getByText('Zoe Quill')).toHaveCount(0);
  expect(await clientsNamed(page, 'Zoe')).toEqual([]);
  expect((await page.request.get(`/v1/clients/${zoe.id}`)).status()).toBe(404);
});
