import {
  addDays,
  BookingSchema,
  ClientSchema,
  ClientsResponseSchema,
  CreateInviteResponseSchema,
  CurrentBusinessResponseSchema,
  formatDate,
  fromZoned,
  MembersResponseSchema,
  ServiceSchema,
  StaffMemberSchema,
  StaffResponseSchema,
  toZoned,
  WaitlistResponseSchema,
  type CivilDate,
} from '@pepper/contracts';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  anotherPerson,
  callApi,
  onboardOwner,
  ownClientAddress,
  signUp,
  unique,
} from './helpers.js';

// Manual booking through the real stack (S15): the owner books from the calendar with the
// free times the engine offers, gets the nearest free times for a taken one (AC-W2-1), adds
// the client to the waitlist, moves, completes and cancels; a staff member finds a client by
// exact phone (ADR-0020) and books only for themselves, sees colleagues as busy (AC-W9-1) and
// cannot change a recorded outcome (rule b). The setup (services, staff, hours) goes through
// the api until the S16 screens.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const EVERY_DAY = {
  intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
};

interface Salon {
  timeZone: string;
  /** A week from today on the business's clock: bookable under the default 2 hours' notice. */
  day: CivilDate;
  at: (day: CivilDate, minuteOfDay: number) => string;
  serviceId: string;
}

/** A 60-minute haircut, the owner's business clock and a day a week ahead. */
async function salon(page: Page): Promise<Salon> {
  const tenant = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const { timeZone } = tenant.business;
  const service = await callApi(
    page,
    'POST',
    '/v1/services',
    { name: 'Haircut', durationMinutes: 60 },
    ServiceSchema,
  );
  return {
    timeZone,
    day: addDays(toZoned(timeZone, Date.now()), 7),
    at: (day, minute) => new Date(fromZoned(timeZone, day, minute)).toISOString(),
    serviceId: service.id,
  };
}

async function addStaff(
  page: Page,
  s: Salon,
  displayName: string,
  userId: string | null = null,
): Promise<string> {
  const member = await callApi(
    page,
    'POST',
    '/v1/staff',
    { displayName, serviceIds: [s.serviceId], ...(userId !== null && { userId }) },
    StaffMemberSchema,
  );
  await callApi(page, 'PUT', `/v1/staff/${member.id}/hours`, EVERY_DAY, {
    parse: (body: unknown) => body,
  });
  return member.id;
}

function sheet(page: Page): Locator {
  return page.getByRole('dialog');
}

async function openNewBooking(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'New booking' }).click();
  const dialog = sheet(page);
  await expect(dialog.getByRole('heading', { name: 'New booking' })).toBeVisible();
  return dialog;
}

test('an owner books from the calendar: free times, a taken time with alternatives and the waitlist, move, done and cancel', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  const s = await salon(page);
  await addStaff(page, s, 'Jess');
  await page.goto(`/calendar?date=${formatDate(s.day)}`);
  const jess = page.getByRole('region', { name: 'Jess' });

  // A new client, the first free time (09:00).
  let dialog = await openNewBooking(page);
  await dialog.getByRole('button', { name: 'New client' }).click();
  await dialog.getByLabel('Name').fill('Maria Lopez');
  await dialog.getByLabel('Email (optional)').fill('maria@example.test');
  await dialog.getByRole('button', { name: 'Add client' }).click();
  await expect(dialog.getByTestId('chosen-client')).toHaveText('Maria Lopez');
  await expect(dialog.getByLabel('With')).toHaveValue(/.+/);
  await dialog.getByTestId('free-times').getByRole('button', { name: '10:00 AM' }).click();
  await dialog.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(jess.getByTestId('booking-block')).toHaveAccessibleName(
    /^10:00\s?–\s?11:00\sAM, Haircut with Maria Lopez$/,
  );

  // 10:30 is taken: the nearest free times instead (AC-W2-1); pick the first.
  dialog = await openNewBooking(page);
  await dialog.getByLabel('Name or email').fill('maria');
  await dialog.getByRole('button', { name: 'Search' }).click();
  await dialog.getByRole('button', { name: /Maria Lopez/ }).click();
  await expect(
    dialog.getByTestId('free-times').getByRole('button', { name: '10:00 AM' }),
  ).toHaveCount(0);
  await dialog.getByLabel('Or another time').fill('10:30');
  await dialog.getByRole('button', { name: 'Book', exact: true }).click();
  const alternatives = dialog.getByTestId('alternatives').getByRole('button');
  await expect(alternatives).toHaveCount(3);
  await expect(alternatives.first()).toHaveText(/11:00 AM$/);
  await alternatives.first().click();
  await expect(dialog).toBeHidden();
  await expect(jess.getByTestId('booking-block')).toHaveCount(2);

  // A taken time once more, and this time the waitlist.
  dialog = await openNewBooking(page);
  await dialog.getByLabel('Name or email').fill('maria@example.test');
  await dialog.getByRole('button', { name: 'Search' }).click();
  await dialog.getByRole('button', { name: /Maria Lopez/ }).click();
  await dialog.getByLabel('Or another time').fill('10:30');
  await dialog.getByRole('button', { name: 'Book', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add to the waitlist' }).click();
  await expect(dialog.getByLabel('From')).toHaveValue('10:30');
  await expect(dialog.getByLabel('Until')).toHaveValue('12:30');
  await dialog.getByRole('button', { name: 'Add to the waitlist' }).click();
  await expect(dialog).toBeHidden();
  const waitlist = WaitlistResponseSchema.parse(
    await (await page.request.get('/v1/waitlist')).json(),
  );
  expect(waitlist.entries).toHaveLength(1);
  expect(waitlist.entries[0]?.windows).toEqual([
    { date: formatDate(s.day), start: '10:30', end: '12:30' },
  ]);

  // Move the 10:00 booking to 1:00 PM.
  await jess.getByRole('button', { name: /^10:00\s?–\s?11:00\sAM/ }).click();
  dialog = sheet(page);
  await expect(dialog.getByRole('heading', { name: 'Maria Lopez' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Mark done' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Move' }).click();
  await dialog.getByTestId('free-times').getByRole('button', { name: '1:00 PM' }).click();
  await dialog.getByRole('button', { name: 'Move here' }).click();
  await expect(dialog).toBeHidden();
  await expect(jess.getByRole('button', { name: /^1:00\s?–\s?2:00\sPM/ })).toBeVisible();

  // Cancel it: the time is free again.
  await jess.getByRole('button', { name: /^1:00\s?–\s?2:00\sPM/ }).click();
  await sheet(page).getByRole('button', { name: 'Cancel booking' }).click();
  await sheet(page).getByRole('button', { name: 'Cancel booking' }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(jess.getByTestId('booking-block')).toHaveCount(1);

  // Yesterday's appointment (booked with an override): done, then corrected to a no-show.
  const yesterday = addDays(toZoned(s.timeZone, Date.now()), -1);
  const [client] = ClientsResponseSchema.parse(
    await (await page.request.get('/v1/clients?search=maria')).json(),
  ).clients;
  const [jessMember] = StaffResponseSchema.parse(
    await (await page.request.get('/v1/staff')).json(),
  ).staff;
  await callApi(
    page,
    'POST',
    '/v1/bookings',
    {
      clientId: client?.id,
      serviceId: s.serviceId,
      staffMemberId: jessMember?.id,
      startsAt: s.at(yesterday, 11 * 60),
      override: true,
    },
    BookingSchema,
  );
  await page.goto(`/calendar?date=${formatDate(yesterday)}`);
  await page.getByRole('region', { name: 'Jess' }).getByTestId('booking-block').click();
  await sheet(page).getByRole('button', { name: 'Mark done' }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(page.getByTestId('booking-block')).toContainText('Done');
  await page.getByTestId('booking-block').click();
  await expect(sheet(page).getByTestId('booking-status')).toHaveText('Done');
  await sheet(page).getByRole('button', { name: 'No-show' }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(page.getByTestId('booking-block')).toContainText('No-show');
});

test('a staff member finds a client by exact phone and books for themselves; colleagues show as busy; a recorded outcome is final for them', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const owner = await onboardOwner(page);
  const s = await salon(page);

  // Priya joins as staff, linked to her own staff member.
  const priyaEmail = `${unique('priya')}@example.test`;
  const invite = await callApi(
    page,
    'POST',
    '/v1/invites',
    { email: priyaEmail, role: 'staff' },
    CreateInviteResponseSchema,
  );
  const priya = await anotherPerson(browser, baseURL);
  await priya.goto(`/invite#${invite.token}`);
  await priya.getByRole('link', { name: 'Create an account' }).click();
  await signUp(priya, priyaEmail, { name: 'Priya', onPage: true });
  await expect(priya).toHaveURL(/\/invite$/);
  await priya.getByRole('button', { name: `Join ${owner.business}` }).click();
  await expect(priya.getByTestId('business-role')).toHaveText('staff');
  const members = MembersResponseSchema.parse(
    await (await page.request.get('/v1/members')).json(),
  ).members;
  const priyaUser = members.find((member) => member.email === priyaEmail)?.userId ?? null;
  expect(priyaUser).not.toBeNull();
  const priyaStaff = await addStaff(page, s, 'Priya', priyaUser);
  const marco = await addStaff(page, s, 'Marco');

  // Marco's 10:00 appointment, and Lee, a client Priya has never seen.
  const lee = await callApi(
    page,
    'POST',
    '/v1/clients',
    { name: 'Lee Chen', phone: '+15550101234' },
    ClientSchema,
  );
  const someone = await callApi(page, 'POST', '/v1/clients', { name: 'Sam Ortiz' }, ClientSchema);
  await callApi(
    page,
    'POST',
    '/v1/bookings',
    {
      clientId: someone.id,
      serviceId: s.serviceId,
      staffMemberId: marco,
      startsAt: s.at(s.day, 600),
    },
    BookingSchema,
  );

  await priya.goto(`/calendar?date=${formatDate(s.day)}`);
  const marcoColumn = priya.getByRole('region', { name: 'Marco' });
  await expect(marcoColumn.getByTestId('busy-block')).toHaveCount(1);
  await expect(marcoColumn.getByTestId('booking-block')).toHaveCount(0);

  const dialog = await openNewBooking(priya);
  // Staff cannot search or add clients: an exact email or phone only.
  await expect(dialog.getByRole('button', { name: 'New client' })).toHaveCount(0);
  await dialog.getByLabel('Client’s email or phone').fill('555 010');
  await dialog.getByRole('button', { name: 'Find client' }).click();
  await expect(dialog.getByRole('alert')).toContainText('full email address or phone number');
  await dialog.getByLabel('Client’s email or phone').fill('(555) 010-1234');
  await dialog.getByRole('button', { name: 'Find client' }).click();
  await dialog.getByRole('button', { name: /Lee Chen/ }).click();
  await expect(dialog.getByTestId('chosen-client')).toHaveText('Lee Chen');
  // Only herself to book with.
  await expect(dialog.getByLabel('With')).toBeDisabled();
  await expect(dialog.getByLabel('With').locator('option')).toHaveText(['Priya']);
  await dialog.getByTestId('free-times').getByRole('button', { name: '10:00 AM' }).click();
  await dialog.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    priya.getByRole('region', { name: 'Priya' }).getByTestId('booking-block'),
  ).toHaveAccessibleName(/^10:00\s?–\s?11:00\sAM, Haircut with Lee Chen$/);

  // Yesterday's appointment with Lee: Priya records a no-show; then it is final for her.
  const yesterday = addDays(toZoned(s.timeZone, Date.now()), -1);
  await callApi(
    page,
    'POST',
    '/v1/bookings',
    {
      clientId: lee.id,
      serviceId: s.serviceId,
      staffMemberId: priyaStaff,
      startsAt: s.at(yesterday, 11 * 60),
      override: true,
    },
    BookingSchema,
  );
  await priya.goto(`/calendar?date=${formatDate(yesterday)}`);
  const block = priya.getByRole('region', { name: 'Priya' }).getByTestId('booking-block');
  await block.click();
  await sheet(priya).getByRole('button', { name: 'No-show' }).click();
  await expect(sheet(priya)).toBeHidden();
  await expect(block).toContainText('No-show');
  await block.click();
  await expect(sheet(priya).getByText('An owner or manager can correct it')).toBeVisible();
  await expect(sheet(priya).getByRole('button', { name: 'Mark done' })).toHaveCount(0);
  await expect(sheet(priya).getByRole('button', { name: 'Cancel booking' })).toHaveCount(0);
  await priya.context().close();
});
