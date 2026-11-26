import {
  addDays,
  BookingSchema,
  BookingSeriesSchema,
  ClientSchema,
  CurrentBusinessResponseSchema,
  formatDate,
  fromZoned,
  ServiceSchema,
  StaffMemberSchema,
  toZoned,
  type CivilDate,
} from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
import { callApi, emailTo, hydrated, onboardOwner, ownClientAddress, unique } from './helpers.js';

// Recurring appointments through the real stack (S72, ADR-0070): the owner books a regular
// "every week, 4 visits" from the new-booking sheet; every date is checked (AC-X-182), a taken
// one shows the nearest free times and one is tapped instead (AC-X-187); the client gets one
// email with a link for every visit (AC-X-185); a visit's sheet says "Visit 2 of 4" and cancels
// it and the following ones in one go, with one email (AC-X-186).

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const EVERY_DAY = {
  intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
};

interface Salon {
  /** A week from today on the business's clock. */
  day: CivilDate;
  at: (day: CivilDate, minuteOfDay: number) => string;
  serviceId: string;
  staffMemberId: string;
}

async function salon(page: Page): Promise<Salon> {
  const { timeZone } = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  ).business;
  const service = await callApi(
    page,
    'POST',
    '/v1/services',
    { name: 'Haircut', durationMinutes: 60 },
    ServiceSchema,
  );
  const jess = await callApi(
    page,
    'POST',
    '/v1/staff',
    { displayName: 'Jess', serviceIds: [service.id] },
    StaffMemberSchema,
  );
  await callApi(page, 'PUT', `/v1/staff/${jess.id}/hours`, EVERY_DAY, {
    parse: (body: unknown) => body,
  });
  return {
    day: addDays(toZoned(timeZone, Date.now()), 7),
    at: (day, minute) => new Date(fromZoned(timeZone, day, minute)).toISOString(),
    serviceId: service.id,
    staffMemberId: jess.id,
  };
}

test('an owner books a regular every week, picks a nearby time for a taken date, then cancels the rest', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  const s = await salon(page);
  const maria = `${unique('maria')}@example.test`;
  const client = await callApi(
    page,
    'POST',
    '/v1/clients',
    { name: 'Maria Lopez', email: maria },
    ClientSchema,
  );
  // The third Tuesday is taken at 10:00 by someone else.
  const other = await callApi(page, 'POST', '/v1/clients', { name: 'Dan Cole' }, ClientSchema);
  await callApi(
    page,
    'POST',
    '/v1/bookings',
    {
      clientId: other.id,
      serviceId: s.serviceId,
      staffMemberId: s.staffMemberId,
      startsAt: s.at(addDays(s.day, 14), 10 * 60),
      notifyClient: false,
    },
    BookingSchema,
  );

  await page.goto(`/calendar?date=${formatDate(s.day)}`);
  await (await hydrated(page.getByRole('button', { name: 'New booking' }))).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name or email').fill(maria);
  await dialog.getByRole('button', { name: 'Search' }).click();
  await dialog.getByRole('button', { name: /Maria Lopez/ }).click();
  await dialog.getByTestId('free-times').getByRole('button', { name: '10:00 AM' }).click();
  await dialog.getByLabel('Repeat').selectOption({ label: 'Every week' });
  await dialog.getByLabel('For').selectOption({ label: '4 visits' });

  // Every date checked; the taken one offers the nearest free times (AC-X-182, AC-X-187).
  const dates = dialog.getByTestId('series-date');
  await expect(dates).toHaveCount(4);
  await expect(dialog.getByTestId('series-summary')).toHaveText('3 of 4 dates are free.');
  const taken = dates.nth(2);
  await expect(taken).toContainText('Not free');
  await expect(dialog.getByRole('button', { name: 'Book 3 visits' })).toBeVisible();
  await taken.getByRole('button').first().click();
  await expect(taken).toContainText('Moved');
  await expect(
    dialog.getByLabel('Email the client one confirmation with every date'),
  ).toBeChecked();
  await dialog.getByRole('button', { name: 'Book 4 visits' }).click();
  await expect(dialog).toBeHidden();

  // One email with a link for every visit (AC-X-185).
  const confirmation = await emailTo(maria, "You're booked at");
  expect(confirmation).toContain('4 visits');
  expect(confirmation.match(/\/book\/[a-z0-9-]+\/manage#[A-Za-z0-9_-]{43}/g)).toHaveLength(4);

  // The second visit's sheet: "Visit 2 of 4"; cancel it and the ones after (AC-X-186).
  await page.goto(`/calendar?date=${formatDate(addDays(s.day, 7))}`);
  const block = page.getByRole('region', { name: 'Jess' }).getByTestId('booking-block');
  await (await hydrated(block)).click();
  await expect(dialog.getByTestId('booking-series')).toHaveText('Visit 2 of 4 · every week');
  await dialog.getByRole('button', { name: 'Cancel booking' }).click();
  await dialog.getByRole('radio', { name: 'This and following (3)' }).click();
  await expect(dialog.getByTestId('booking-cancel-scope')).toHaveText(
    'Cancel this visit and the 2 after it? Their times become free again.',
  );
  await dialog.getByRole('button', { name: 'Cancel 3 visits' }).click();
  await expect(dialog).toBeHidden();
  await expect(block).toHaveCount(0);
  expect(await emailTo(maria, 'are cancelled')).toContain('These visits at');

  // The first visit stays booked; the series says so.
  const first = (await (
    await page.request.get(
      `/v1/bookings?from=${s.at(s.day, 0)}&to=${s.at(addDays(s.day, 1), 0)}&clientId=${client.id}`,
    )
  ).json()) as { bookings: { seriesId: string; status: string }[] };
  expect(first.bookings.map((visit) => visit.status)).toEqual(['confirmed']);
  const series = BookingSeriesSchema.parse(
    await (
      await page.request.get(`/v1/bookings/series/${first.bookings[0]?.seriesId ?? ''}`)
    ).json(),
  );
  expect(series.bookings.map((visit) => visit.status)).toEqual([
    'confirmed',
    'cancelled',
    'cancelled',
    'cancelled',
  ]);
});
