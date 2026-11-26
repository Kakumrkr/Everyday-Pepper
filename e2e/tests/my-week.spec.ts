import {
  addDays,
  BookingSchema,
  BookingSeriesResultSchema,
  ClientSchema,
  CreateInviteResponseSchema,
  CurrentBusinessResponseSchema,
  formatDate,
  fromZoned,
  isoWeekday,
  MembersResponseSchema,
  ServiceSchema,
  StaffMemberSchema,
  toZoned,
  type CivilDate,
} from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
import { anotherPerson, callApi, hydrated, onboardOwner, signUp, unique } from './helpers.js';

// Staff's "My week" (S72.2, AC-X-189…194) through the real stack, on a 375 px phone: a staff
// member's bare Calendar opens on their own week as a list; a repeating visit says "2/4"; a
// colleague's visits never show; a row opens its sheet; an owner on no staff member sees Day.

test.use({ viewport: { width: 375, height: 812 } });

const WEEKDAYS = {
  intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
};

interface Salon {
  /** A Tuesday at least a week ahead. */
  tuesday: CivilDate;
  at: (day: CivilDate, minuteOfDay: number) => string;
  serviceId: string;
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
  let tuesday = addDays(toZoned(timeZone, Date.now()), 7);
  while (isoWeekday(tuesday) !== 2) tuesday = addDays(tuesday, 1);
  return {
    tuesday,
    at: (day, minute) => new Date(fromZoned(timeZone, day, minute)).toISOString(),
    serviceId: service.id,
  };
}

async function addStaff(page: Page, s: Salon, displayName: string, userId: string | null) {
  const member = await callApi(
    page,
    'POST',
    '/v1/staff',
    { displayName, serviceIds: [s.serviceId], ...(userId !== null && { userId }) },
    StaffMemberSchema,
  );
  await callApi(page, 'PUT', `/v1/staff/${member.id}/hours`, WEEKDAYS, {
    parse: (body: unknown) => body,
  });
  return member.id;
}

test('a staff member’s Calendar opens on My week: their visits by day, a regular’s 2/4, never a colleague’s', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  const owner = await onboardOwner(page);
  const s = await salon(page);
  const priyaEmail = `${unique('priya')}@example.test`;
  const invite = await callApi(
    page,
    'POST',
    '/v1/invites',
    { email: priyaEmail, role: 'staff' },
    CreateInviteResponseSchema,
  );
  const priya = await anotherPerson(browser, baseURL);
  await priya.setViewportSize({ width: 375, height: 812 });
  await priya.goto(`/invite#${invite.token}`);
  await priya.getByRole('link', { name: 'Create an account' }).click();
  await signUp(priya, priyaEmail, { name: 'Priya', onPage: true });
  await expect(priya).toHaveURL(/\/invite$/);
  await (await hydrated(priya.getByRole('button', { name: `Join ${owner.business}` }))).click();
  await expect(priya.getByTestId('business-role')).toHaveText('staff');
  const priyaUser =
    MembersResponseSchema.parse(await (await page.request.get('/v1/members')).json()).members.find(
      (member) => member.email === priyaEmail,
    )?.userId ?? null;
  const priyaId = await addStaff(page, s, 'Priya', priyaUser);
  const jessId = await addStaff(page, s, 'Jess', null);

  // Maria every week for 4 with Priya, from next Tuesday at 10; Dan with Jess the second Tuesday.
  const maria = await callApi(page, 'POST', '/v1/clients', { name: 'Maria Lopez' }, ClientSchema);
  const series = await callApi(
    page,
    'POST',
    '/v1/bookings/series',
    {
      clientId: maria.id,
      serviceId: s.serviceId,
      staffMemberId: priyaId,
      everyWeeks: 1,
      startsAts: [0, 7, 14, 21].map((days) => s.at(addDays(s.tuesday, days), 10 * 60)),
      notifyClient: false,
    },
    BookingSeriesResultSchema,
  );
  expect(series.bookings).toHaveLength(4);
  const dan = await callApi(page, 'POST', '/v1/clients', { name: 'Dan Cole' }, ClientSchema);
  await callApi(
    page,
    'POST',
    '/v1/bookings',
    {
      clientId: dan.id,
      serviceId: s.serviceId,
      staffMemberId: jessId,
      startsAt: s.at(addDays(s.tuesday, 7), 13 * 60),
      notifyClient: false,
    },
    BookingSchema,
  );

  // A bare Calendar opens on My week (AC-X-189).
  await priya.getByRole('link', { name: 'Calendar' }).first().click();
  await expect(priya.getByRole('heading', { level: 1, name: 'My week' })).toBeVisible();
  await expect(
    priya.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'My week' }),
  ).toHaveAttribute('aria-current', 'true');
  // This week is empty: it says so and offers New booking (AC-X-192).
  await expect(priya.getByTestId('calendar-quiet')).toHaveText(
    'Nothing booked this week yet. Tap New booking to add one.',
  );
  await expect(priya.getByRole('button', { name: 'New booking' })).toBeVisible();

  // The second week: Maria's visit 2 of 4 on Tuesday, nothing of Jess's (AC-X-190, AC-X-193).
  await priya.goto(`/calendar?date=${formatDate(addDays(s.tuesday, 7))}&view=my-week`);
  await expect(priya.getByTestId('my-week-summary')).toHaveText(
    '1 visit · 1 h booked · Sat, Sun off',
  );
  const days = priya.getByTestId('my-week-day');
  await expect(days).toHaveCount(7);
  const tuesday = days.nth(1);
  await expect(tuesday.getByTestId('my-week-hours')).toHaveText(/^9:00\s?AM\s?–\s?5:00\s?PM$/);
  await expect(days.nth(5).getByTestId('my-week-hours')).toHaveText('Off');
  await expect(days.nth(0)).toContainText('Free');
  const row = tuesday.getByTestId('booking-block');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Maria Lopez');
  await expect(row.getByTestId('booking-visit-number')).toHaveText('2/4');
  await expect(row).toHaveAccessibleName(/Haircut with Maria Lopez, visit 2 of 4$/);
  await expect(priya.getByText('Dan Cole')).toHaveCount(0);
  // Nothing wider than the phone.
  expect(await priya.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  // A row opens its booking sheet (AC-X-190).
  await (await hydrated(row)).click();
  const dialog = priya.getByRole('dialog');
  await expect(dialog.getByTestId('booking-series')).toHaveText('Visit 2 of 4 · every week');
  await priya.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // The week view's block says it too (AC-X-194); the next week is one tap away.
  await priya
    .getByRole('navigation', { name: 'View' })
    .getByRole('link', { name: 'Week', exact: true })
    .click();
  await expect(priya.getByTestId('booking-visit-number')).toHaveText('2/4');
  await priya.goto(`/calendar?date=${formatDate(addDays(s.tuesday, 7))}&view=my-week`);
  await priya.getByRole('link', { name: 'Next week' }).click();
  await expect(priya.getByTestId('booking-visit-number')).toHaveText('3/4');

  // An owner on no staff member has no My week; asking for it shows the day (AC-X-189).
  await page.goto(`/calendar?date=${formatDate(s.tuesday)}&view=my-week`);
  await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'My week' }),
  ).toHaveCount(0);
});
