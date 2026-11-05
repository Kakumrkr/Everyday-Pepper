import { AxeBuilder } from '@axe-core/playwright';
import { ServicesResponseSchema, StaffResponseSchema } from '@pepper/contracts';
import { expect, test } from '@playwright/test';
import { hydrated, onboardOwner, ownClientAddress } from './helpers.js';
import { expectTapTargets } from './tap-targets.js';

// "Haven't been back" through the screens and the real worker (S54.2, ADR-0057; AC-W4-6…9):
// a new owner finds the empty list saying what fills it, imports past visits from it, is told
// right away how many regulars are overdue and what they're worth, opens the list, and wins
// one back in two taps: "Draft email", then Approve.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const DAY_MS = 86_400_000;
/** A UTC calendar day `back` days ago: far enough from today that no time zone changes it. */
const daysAgo = (back: number) => new Date(Date.now() - back * DAY_MS).toISOString().slice(0, 10);

test("haven't been back (AC-W4-6…9): empty, import, the aha, draft and approve", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await onboardOwner(page, { type: 'Barbershop' });
  const origin = new URL(page.url()).origin;
  const { services } = ServicesResponseSchema.parse(
    await (await page.request.get('/v1/services')).json(),
  );
  const { staff } = StaffResponseSchema.parse(await (await page.request.get('/v1/staff')).json());
  const service = services.find((each) => each.active);
  const owner = staff[0]?.displayName;
  if (service === undefined || owner === undefined) throw new Error('no service or staff');
  // The list prices a regular at their service's price, else what the visit cost.
  const each = service.priceFromCents ?? 4500;
  const total = 2 * each;
  const dollars = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: total % 100 === 0 ? 0 : 2,
  }).format(total / 100);

  // AC-W4-9: the empty list says what fills it, and leads to the import.
  await page.goto('/clients/win-back');
  await expect(page.getByRole('heading', { name: 'Haven’t been back' })).toBeVisible();
  await expect(
    page.getByText('After 2 visits, a client who stops coming shows here.'),
  ).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map((v) => v.id),
  ).toEqual([]);
  await (await hydrated(page.getByRole('link', { name: 'Import past visits' }))).click();
  await expect(page).toHaveURL(/\/clients\/import$/);

  // Ana (with an email) last came 40 days ago, Ben (no email) 60 days ago: both past the
  // service's interval, Ana the more recently due; Cy came once.
  const csv = [
    'Date,Time,Client,Email,Phone,Service,Staff,Length,Price,Status',
    `${daysAgo(70)},10:00 AM,Ana Ruiz,ana.ruiz@example.com,555-010-2001,${service.name},${owner},45,45,done`,
    `${daysAgo(40)},10:00 AM,Ana Ruiz,ana.ruiz@example.com,555-010-2001,${service.name},${owner},45,45,done`,
    `${daysAgo(100)},11:00 AM,Ben Ito,,555-010-2002,${service.name},${owner},45,45,done`,
    `${daysAgo(60)},11:00 AM,Ben Ito,,555-010-2002,${service.name},${owner},45,45,done`,
    `${daysAgo(50)},1:00 PM,Cy Diaz,cy@example.com,555-010-2003,${service.name},${owner},45,45,done`,
  ].join('\n');
  await hydrated(page.getByRole('button', { name: 'Pick a file' }));
  await page.getByTestId('import-input').setInputFiles({
    name: 'appointments.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await page.getByRole('button', { name: 'Check the visits' }).click();
  await (await hydrated(page.getByRole('button', { name: 'Import 5 visits' }))).click();
  await expect(page.getByRole('heading', { name: 'Your visits are in' })).toBeVisible({
    timeout: 60_000,
  });

  // AC-W4-8: the aha, the list's own numbers.
  const aha = page.getByTestId('import-overdue');
  await expect(aha.getByRole('heading')).toHaveText(`2 regulars are overdue, about ${dollars}`);
  await expectTapTargets(page, 'the visits result with the aha');
  await (await hydrated(aha.getByRole('link', { name: 'See who' }))).click();
  await expect(page).toHaveURL(/\/clients\/win-back$/);

  // AC-W4-6: the most recently due first; why Ben can't be emailed; the address comes first.
  const rows = page.getByTestId('win-back-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Ana Ruiz');
  // The template's service names its own interval, so the days late follow it, not the gaps.
  await expect(rows.nth(0)).toContainText(/\d+ days? overdue/);
  await expect(rows.nth(1)).toContainText('Ben Ito');
  await expect(rows.nth(1).getByTestId('win-back-blocked')).toHaveText('No email on file');
  await expect(rows.nth(0).getByTestId('win-back-blocked')).toHaveText(
    'Add your mailing address first',
  );
  const address = await page.request.patch('/v1/feed/settings', {
    data: { mailingAddress: '12 Juniper Lane\nPortland, OR 97201' },
    headers: { origin },
  });
  expect(address.ok(), await address.text()).toBe(true);
  await page.reload();

  // AC-W4-7: one tap drafts it in place; Approve sends it.
  const ana = rows.filter({ hasText: 'Ana Ruiz' });
  await (await hydrated(ana.getByRole('button', { name: 'Draft email' }))).click();
  const card = ana.getByRole('article');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Ana');
  await expectTapTargets(page, 'the win-back list with a draft');
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map((v) => v.id),
  ).toEqual([]);
  await (await hydrated(card.getByRole('button', { name: 'Approve' }))).click();
  await expect(card.getByRole('status')).toHaveText('Done.');

  // The list says she was emailed; the Clients screen leads here with the count.
  await page.reload();
  await expect(ana.getByTestId('win-back-blocked')).toHaveText(/^Emailed /);
  await page.goto('/clients');
  await expect(page.getByRole('link', { name: /Haven’t been back/ })).toContainText(
    `2 regulars are overdue, about ${dollars}`,
  );
});
