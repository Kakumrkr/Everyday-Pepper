import {
  BookingSchema,
  ClientSchema,
  CurrentBusinessResponseSchema,
  ServiceSchema,
  StaffMemberSchema,
  addDays,
  formatDate,
  fromZoned,
  toZoned,
} from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
import { onboardOwner, ownClientAddress } from './helpers.js';

// The calendar day view (S14) through the real stack: the owner's bookings show on the
// business's clock, one column per staff member, with day navigation and a staff filter.
// Services, staff and the booking are made through the api, as the screens for them come in
// later Phase 4 sessions.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

/** Calls the api as the signed-in browser (the app's own origin, as the api requires). */
async function api<T>(
  page: Page,
  path: string,
  body: object,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  const response = await page.request.post(path, {
    data: body,
    headers: { origin: new URL(page.url()).origin },
  });
  expect(response.status(), `${path}: ${await response.text()}`).toBe(201);
  return schema.parse(await response.json());
}

test('an owner sees a booking on the calendar on the business clock, moves between days and filters by staff member', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await onboardOwner(page);
  const tenant = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const { timeZone } = tenant.business;

  const service = await api(
    page,
    '/v1/services',
    { name: 'Haircut', durationMinutes: 60 },
    ServiceSchema,
  );
  const jess = await api(
    page,
    '/v1/staff',
    { displayName: 'Jess', color: '#0d5e4f', serviceIds: [service.id] },
    StaffMemberSchema,
  );
  await api(page, '/v1/staff', { displayName: 'Marco' }, StaffMemberSchema);
  const client = await api(page, '/v1/clients', { name: 'Maria Lopez' }, ClientSchema);
  // A week from today, 10:00 on the business's clock (no hours are set up: the owner overrides).
  const today = toZoned(timeZone, Date.now());
  const day = addDays(today, 7);
  const startsAt = new Date(fromZoned(timeZone, day, 10 * 60)).toISOString();
  await api(
    page,
    '/v1/bookings',
    {
      clientId: client.id,
      serviceId: service.id,
      staffMemberId: jess.id,
      startsAt,
      override: true,
    },
    BookingSchema,
  );

  await page.getByRole('link', { name: 'Calendar' }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Calendar' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'date');

  await page.goto(`/calendar?date=${formatDate(day)}`);
  const columns = page.getByTestId('calendar-column');
  await expect(columns).toHaveCount(2);
  const jessColumn = page.getByRole('region', { name: 'Jess' });
  const booking = jessColumn.getByTestId('booking-block');
  await expect(booking).toHaveCount(1);
  await expect(booking).toHaveAccessibleName(/^10:00\s?–\s?11:00\sAM, Haircut with Maria Lopez$/);
  await expect(
    page.getByRole('region', { name: 'Marco' }).getByTestId('booking-block'),
  ).toHaveCount(0);

  // The day after: nothing booked.
  await page.getByRole('link', { name: 'Next day' }).click();
  await expect(page).toHaveURL(new RegExp(`date=${formatDate(addDays(day, 1))}`));
  await expect(page.getByTestId('booking-block')).toHaveCount(0);
  await page.getByRole('link', { name: 'Previous day' }).click();
  await expect(page.getByTestId('booking-block')).toHaveCount(1);

  // Only Marco.
  await page
    .getByRole('navigation', { name: 'Staff' })
    .getByRole('link', { name: 'Marco' })
    .click();
  await expect(columns).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Marco' })).toBeVisible();
  await expect(page.getByTestId('booking-block')).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Staff' })
    .getByRole('link', { name: 'Everyone' })
    .click();
  await expect(columns).toHaveCount(2);

  // Mobile-first: the grid scrolls inside itself; the page never scrolls sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});
