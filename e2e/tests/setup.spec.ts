import {
  addDays,
  AvailabilityResponseSchema,
  ClientSchema,
  CreateInviteResponseSchema,
  CurrentBusinessResponseSchema,
  formatDate,
  fromZoned,
  MembersResponseSchema,
  ServiceSchema,
  StaffMemberSchema,
  toZoned,
  type CivilDate,
} from '@pepper/contracts';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  anotherPerson,
  callApi,
  goTo,
  hydrated,
  onboardOwner,
  ownClientAddress,
  signUp,
  unique,
} from './helpers.js';

// The setup screens through the real stack (S16): a new owner sets up the menu, a staff member
// with weekly hours and a booking rule without the api, and books on those hours; a staff
// member adds their own time off but cannot change hours, rules or the menu; the client list
// and profile.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

function sheet(page: Page): Locator {
  return page.getByRole('dialog');
}

/** The business's clock and a day a week ahead on it. */
async function businessClock(page: Page): Promise<{ timeZone: string; day: CivilDate }> {
  const tenant = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const { timeZone } = tenant.business;
  return { timeZone, day: addDays(toZoned(timeZone, Date.now()), 7) };
}

/** Opens a place: a tab or More on phones, the sidebar on desktops (`goTo`). */
const go = goTo;

async function fitsTheScreen(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('setup: a new owner adds a service, a staff member with weekly hours and a booking rule, then books on those hours', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  const { day } = await businessClock(page);

  // The menu.
  await go(page, 'Services');
  await expect(page.getByRole('heading', { name: 'No services yet' })).toBeVisible();
  await (await hydrated(page.getByRole('button', { name: 'Add service' }))).click();
  let dialog = sheet(page);
  await dialog.getByLabel('Name').fill('Haircut');
  await dialog.getByLabel('Category').fill('Hair');
  await dialog.getByLabel('How long it takes').fill('60');
  await dialog.getByLabel('Price from').fill('65');
  await dialog.getByRole('button', { name: 'Add service' }).click();
  await expect(dialog).toBeHidden();
  const haircut = page.getByTestId('service').filter({ hasText: 'Haircut' });
  await expect(haircut).toContainText('1 h · from $65');
  await expect(haircut).toContainText('No one offers it yet');
  await fitsTheScreen(page);

  // A price that is not an amount is caught before the api.
  await page.getByRole('button', { name: 'Edit Haircut' }).click();
  dialog = sheet(page);
  await dialog.getByLabel('Up to').fill('lots');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter prices as amounts');
  await dialog.getByLabel('Up to').fill('80');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(haircut).toContainText('$65–$80');

  // Jess, who offers it: added, then her page for the hours.
  await go(page, 'Team');
  await (await hydrated(page.getByRole('button', { name: 'Add staff member' }))).click();
  dialog = sheet(page);
  await dialog.getByLabel('Name').fill('Jess');
  await dialog.getByRole('checkbox', { name: 'Haircut' }).check();
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page).toHaveURL(/\/team\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Jess', level: 1 })).toBeVisible();

  // Every day 9 to 5, the default for a day turned on.
  const hours = await hydrated(page.getByRole('checkbox', { name: 'Monday', exact: true }));
  await hours.check();
  for (const weekday of ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
    await page.getByRole('checkbox', { name: weekday, exact: true }).check();
  }
  await expect(page.getByLabel('Monday from')).toHaveValue('09:00');
  await expect(page.getByLabel('Monday until')).toHaveValue('17:00');
  // An end before the start is refused before the api; then put right.
  await page.getByLabel('Sunday until').selectOption('08:00');
  await page.getByRole('button', { name: 'Save hours' }).click();
  // (Next.js's route announcer is an alert too.)
  await expect(
    page.getByRole('alert').filter({ hasText: 'The end must be after the start' }),
  ).toBeVisible();
  await page.getByLabel('Sunday until').selectOption('17:00');
  await page.getByRole('button', { name: 'Save hours' }).click();
  await expect(page.getByRole('status')).toContainText('Saved. New bookings follow these hours.');
  await fitsTheScreen(page);

  await go(page, 'Team');
  const jess = page.getByTestId('staff-member').filter({ hasText: 'Jess' });
  await expect(jess).toContainText('Mon–Sun 9:00 AM–5:00 PM');
  await expect(jess).toContainText('Haircut');

  // A rule: start times every 30 minutes instead of the default 15.
  await go(page, 'Services');
  await page.getByRole('link', { name: 'Booking rules' }).click();
  await expect(page.getByText('Unless you change them: every 15 minutes')).toBeVisible();
  const grid = await hydrated(page.getByLabel('Start times every'));
  await grid.selectOption('30');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByRole('status')).toContainText('Saved.');

  // The calendar offers Jess's times on the 30-minute grid.
  await page.goto(`/calendar?date=${formatDate(day)}`);
  await (await hydrated(page.getByRole('button', { name: 'New booking' }))).click();
  dialog = sheet(page);
  await dialog.getByRole('button', { name: 'New client' }).click();
  await dialog.getByLabel('Name').fill('Maria Lopez');
  await dialog.getByRole('button', { name: 'Add client' }).click();
  await expect(dialog.getByTestId('chosen-client')).toHaveText('Maria Lopez');
  const times = dialog.getByTestId('free-times').getByRole('button');
  await expect(times.first()).toHaveText('9:00 AM');
  await expect(times.nth(1)).toHaveText('9:30 AM');
  await times.nth(1).click();
  await dialog.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('region', { name: 'Jess' }).getByTestId('booking-block')).toHaveCount(
    1,
  );
});

test('clients: the owner finds a client, sees the coming visit on the profile, edits their phone and books again', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  // No clients yet: the list says what to do next and opens the add sheet (AC-X-7).
  await page.goto('/clients');
  await expect(page.getByText('No clients yet')).toBeVisible();
  await (await hydrated(page.getByRole('button', { name: 'Add your first client' }))).click();
  await expect(sheet(page).getByRole('heading', { name: 'Add a client' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add your first client' })).toBeFocused();
  await page.goto('/');

  const { timeZone, day } = await businessClock(page);
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
  await callApi(
    page,
    'PUT',
    `/v1/staff/${jess.id}/hours`,
    {
      intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        start: '09:00',
        end: '17:00',
      })),
    },
    { parse: (body: unknown) => body },
  );
  const maria = await callApi(
    page,
    'POST',
    '/v1/clients',
    { name: 'Maria Lopez', email: 'maria@example.test' },
    ClientSchema,
  );
  await callApi(page, 'POST', '/v1/clients', { name: 'Lee Chen' }, ClientSchema);
  await callApi(
    page,
    'POST',
    '/v1/bookings',
    {
      clientId: maria.id,
      serviceId: service.id,
      staffMemberId: jess.id,
      startsAt: new Date(fromZoned(timeZone, day, 10 * 60)).toISOString(),
    },
    { parse: (body: unknown) => body },
  );

  await go(page, 'Clients');
  const clients = page.getByRole('list', { name: 'Clients' }).getByRole('link');
  await expect(clients).toHaveCount(2);
  await (await hydrated(page.getByLabel('Search clients by name or email'))).fill('maria@');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(clients).toHaveCount(1);
  await fitsTheScreen(page);
  await clients.click();

  await expect(page.getByRole('heading', { name: 'Maria Lopez', level: 1 })).toBeVisible();
  await expect(page.getByTestId('client-contact')).toContainText('maria@example.test');
  await expect(page.getByTestId('upcoming-visits')).toContainText('10:00 AM');
  await expect(page.getByTestId('upcoming-visits')).toContainText('Haircut with Jess');
  await fitsTheScreen(page);

  await (await hydrated(page.getByRole('button', { name: 'Edit details' }))).click();
  let dialog = sheet(page);
  await dialog.getByLabel('Phone').fill('(555) 010-2222');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('client-contact')).toContainText('+15550102222');

  // Book from the profile: Maria is already chosen.
  await page.getByRole('button', { name: 'Book', exact: true }).click();
  dialog = sheet(page);
  await expect(dialog.getByTestId('chosen-client')).toHaveText('Maria Lopez');
  await dialog.getByLabel('Day').fill(formatDate(day));
  await dialog.getByTestId('free-times').getByRole('button', { name: '1:00 PM' }).click();
  await dialog.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('upcoming-visits').getByRole('listitem')).toHaveCount(2);
});

test('a staff member adds their own time off; hours, rules and the menu are read-only for them', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const owner = await onboardOwner(page);
  const { timeZone, day } = await businessClock(page);
  const service = await callApi(
    page,
    'POST',
    '/v1/services',
    { name: 'Haircut', durationMinutes: 60 },
    ServiceSchema,
  );

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
  await (await hydrated(priya.getByRole('button', { name: `Join ${owner.business}` }))).click();
  await expect(priya.getByTestId('business-role')).toHaveText('staff');

  // The owner links Priya's login on the Team screen.
  await page.goto('/team');
  await (await hydrated(page.getByRole('button', { name: 'Add staff member' }))).click();
  const dialog = sheet(page);
  await dialog.getByLabel('Name').fill('Priya');
  await dialog.getByLabel('Their Pepper login').selectOption({ label: `Priya (${priyaEmail})` });
  await dialog.getByRole('checkbox', { name: 'Haircut' }).check();
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page).toHaveURL(/\/team\/[0-9a-f-]{36}$/);
  const members = MembersResponseSchema.parse(
    await (await page.request.get('/v1/members')).json(),
  ).members;
  expect(members.some((m) => m.email === priyaEmail)).toBe(true);
  const priyaStaffId = page.url().split('/').pop() ?? '';
  await callApi(
    page,
    'PUT',
    `/v1/staff/${priyaStaffId}/hours`,
    {
      intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        start: '09:00',
        end: '17:00',
      })),
    },
    { parse: (body: unknown) => body },
  );
  const marco = await callApi(
    page,
    'POST',
    '/v1/staff',
    { displayName: 'Marco', serviceIds: [service.id] },
    StaffMemberSchema,
  );

  // Priya's own page: her hours to read, her time off to add.
  await priya.goto('/team');
  await expect(priya.getByRole('button', { name: 'Add staff member' })).toHaveCount(0);
  await priya.getByTestId('staff-member').filter({ hasText: 'Priya' }).click();
  await expect(priya.getByRole('heading', { name: /Priya/, level: 1 })).toBeVisible();
  await expect(priya.getByTestId('hours')).toHaveText('Mon–Sun 9:00 AM–5:00 PM');
  await expect(priya.getByRole('button', { name: 'Save hours' })).toHaveCount(0);
  await expect(priya.getByRole('button', { name: 'Save details' })).toHaveCount(0);
  await (await hydrated(priya.getByLabel('First day', { exact: true }))).fill(formatDate(day));
  await priya.getByRole('button', { name: 'Add time off' }).click();
  await expect(priya.getByRole('status')).toContainText('Added.');
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${formatDate(day)}T12:00:00Z`));
  await expect(priya.getByTestId('time-off')).toHaveText(new RegExp(`^${label}`));
  await fitsTheScreen(priya);

  // That day she cannot be booked.
  const query = new URLSearchParams({
    serviceId: service.id,
    staffMemberId: priyaStaffId,
    from: new Date(fromZoned(timeZone, day, 0)).toISOString(),
    to: new Date(fromZoned(timeZone, addDays(day, 1), 0)).toISOString(),
  });
  const availability = AvailabilityResponseSchema.parse(
    await (await page.request.get(`/v1/availability?${query.toString()}`)).json(),
  );
  expect(availability.slots).toEqual([]);

  // Not on a colleague's page.
  await priya.goto(`/team/${marco.id}`);
  await expect(priya.getByRole('heading', { name: 'Marco', level: 1 })).toBeVisible();
  await expect(priya.getByRole('button', { name: 'Add time off' })).toHaveCount(0);

  // The menu and the rules: read-only.
  await go(priya, 'Services');
  await expect(priya.getByTestId('service')).toContainText('Haircut');
  await expect(priya.getByRole('button', { name: 'Add service' })).toHaveCount(0);
  await expect(priya.getByRole('button', { name: 'Edit Haircut' })).toHaveCount(0);
  await priya.getByRole('link', { name: 'Booking rules' }).click();
  await expect(priya.getByLabel('Start times every')).toBeDisabled();
  await expect(priya.getByRole('button', { name: 'Save rules' })).toHaveCount(0);

  // Her clients: none yet, and no way to add one.
  await go(priya, 'Clients');
  await expect(priya.getByText('Clients you have appointments with show here.')).toBeVisible();
  await expect(priya.getByRole('button', { name: 'Add client' })).toHaveCount(0);
  await priya.context().close();
});
