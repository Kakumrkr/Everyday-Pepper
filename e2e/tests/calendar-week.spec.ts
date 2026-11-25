import {
  addDays,
  BookingSchema,
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
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  anotherPerson,
  callApi,
  emailsTo,
  emailTo,
  hydrated,
  onboardOwner,
  ownClientAddress,
  signUp,
  unique,
} from './helpers.js';

// The week view and drag to move (S69, AC-X-144…151) through the real stack: one staff
// member's week, their off hours shaded; a booking dragged with a mouse or, on a phone, after a
// long press; the drop asks once, the api decides (a taken time is refused), the client is
// emailed when ticked, and Undo moves it back. A colleague's week is busy times only.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

/** Monday to Friday, 9 to 5: the weekend is off all day. */
const WEEKDAYS = {
  intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
};
/** Pixels per hour of the grid (week-grid.tsx). */
const HOUR = 88;

interface Salon {
  timeZone: string;
  /** A Tuesday at least a week ahead: bookable, and Monday, its neighbour, in view. */
  tuesday: CivilDate;
  at: (day: CivilDate, minuteOfDay: number) => string;
  serviceId: string;
}

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
  let tuesday = addDays(toZoned(timeZone, Date.now()), 7);
  while (isoWeekday(tuesday) !== 2) tuesday = addDays(tuesday, 1);
  return {
    timeZone,
    tuesday,
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
  await callApi(page, 'PUT', `/v1/staff/${member.id}/hours`, WEEKDAYS, {
    parse: (body: unknown) => body,
  });
  return member.id;
}

async function book(
  page: Page,
  s: Salon,
  staffMemberId: string,
  client: { name: string; email?: string },
  minute: number,
): Promise<void> {
  const made = await callApi(page, 'POST', '/v1/clients', client, ClientSchema);
  await callApi(
    page,
    'POST',
    '/v1/bookings',
    {
      clientId: made.id,
      serviceId: s.serviceId,
      staffMemberId,
      startsAt: s.at(s.tuesday, minute),
      notifyClient: false,
    },
    BookingSchema,
  );
}

function day(page: Page, date: CivilDate): Locator {
  return page.locator(`[data-testid="week-day"][data-date="${formatDate(date)}"]`);
}

/** Where a drag of `block` by `minutes` onto `date`'s column lands: x, y on the page. */
async function aim(
  page: Page,
  block: Locator,
  date: CivilDate,
  minutes: number,
): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
  await block.scrollIntoViewIfNeeded();
  const box = await block.boundingBox();
  const column = await day(page, date).boundingBox();
  if (box === null || column === null) throw new Error('The block or its day is not shown');
  const from = { x: box.x + box.width / 2, y: box.y + 10 };
  return {
    from,
    to: { x: column.x + column.width / 2, y: from.y + (minutes / 60) * HOUR },
  };
}

/** A mouse drag that stops before the drop, so the test can look at the moving block. */
async function mouseDrag(page: Page, block: Locator, date: CivilDate, minutes: number) {
  const { from, to } = await aim(page, block, date, minutes);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + 6, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
}

function sheet(page: Page): Locator {
  return page.getByRole('dialog');
}

test('an owner drags a booking in the week view: the time it lands on, keep it, move it with an email, and Undo', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await onboardOwner(page);
  const s = await salon(page);
  const jess = await addStaff(page, s, 'Jess');
  await addStaff(page, s, 'Marco');
  const maria = `${unique('maria')}@example.test`;
  await book(page, s, jess, { name: 'Maria Lopez', email: maria }, 10 * 60);
  const monday = addDays(s.tuesday, -1);

  // Day to Week: the address says so, the first staff member is shown (AC-X-144).
  await page.goto(`/calendar?date=${formatDate(s.tuesday)}`);
  await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Week' }).click();
  await expect(page).toHaveURL(/view=week/);
  await expect(
    page.getByRole('navigation', { name: 'Staff' }).getByRole('link', { name: 'Jess' }),
  ).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('week-day')).toHaveCount(7);
  await expect(page.getByTestId('calendar-week')).toContainText('Jess');
  // The page never scrolls sideways; the week does, inside its grid.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  // The weekend is off all day: shaded (AC-X-146).
  await expect(day(page, addDays(monday, 5)).getByTestId('off-hours')).toHaveCount(1);
  // Next week and back.
  await page.getByRole('link', { name: 'Next week' }).click();
  await expect(page).toHaveURL(new RegExp(`date=${formatDate(addDays(s.tuesday, 7))}`));
  await page.getByRole('link', { name: 'Previous week' }).click();
  const block = day(page, s.tuesday).getByTestId('booking-block');
  await expect(block).toHaveAccessibleName(/^10:00\s?–\s?11:00\sAM, Haircut with Maria Lopez$/);
  await hydrated(block);

  // An hour up is 8 am: outside her hours, marked before the drop; Escape puts it back.
  await mouseDrag(page, block, s.tuesday, -120);
  const ghost = page.getByTestId('drag-ghost');
  await expect(ghost).toHaveAttribute('data-problem', 'off');
  await expect(ghost).toContainText('Tue 8:00 AM');
  await expect(ghost).toContainText('Not working then');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(ghost).toHaveCount(0);
  await expect(sheet(page)).toHaveCount(0);

  // Onto Monday at noon: the time is said aloud (AC-X-147); kept where it was, nothing changes.
  await mouseDrag(page, block, monday, 120);
  await expect(ghost).toContainText('Mon 12:00 PM');
  await expect(ghost).toHaveAttribute('data-problem', '');
  await expect(page.getByTestId('drag-live')).toHaveText('Mon 12:00 PM');
  await page.mouse.up();
  const dialog = sheet(page);
  await expect(dialog.getByRole('heading', { name: 'Move Maria Lopez?' })).toBeVisible();
  await expect(dialog.getByTestId('move-to')).toHaveText(/^Mon, \w+ \d+, 12:00\sPM – 1:00\sPM$/);
  await expect(dialog.getByLabel('Email the client the new time')).toBeChecked();
  await dialog.getByRole('button', { name: 'Keep it where it was' }).click();
  await expect(dialog).toBeHidden();
  await expect(day(page, s.tuesday).getByTestId('booking-block')).toHaveCount(1);

  // Now moved, with the email (AC-X-148, AC-X-149).
  await mouseDrag(page, block, monday, 120);
  await page.mouse.up();
  await sheet(page).getByRole('button', { name: 'Move', exact: true }).click();
  await expect(sheet(page)).toBeHidden();
  const moved = day(page, monday).getByTestId('booking-block');
  await expect(moved).toHaveAccessibleName(/^12:00\s?–\s?1:00\sPM, Haircut with Maria Lopez$/);
  await expect(day(page, s.tuesday).getByTestId('booking-block')).toHaveCount(0);
  const receipt = page.getByTestId('move-receipt');
  await expect(receipt).toContainText(
    /Moved Maria Lopez to Mon, \w+ \d+, 12:00\sPM, and emailed them\./,
  );
  expect(await emailTo(maria, 'has moved')).toMatch(/at 12:00\sPM\./);
  // Keep it sent nothing: one "has moved" email only.
  expect(
    (await emailsTo(maria)).filter((email) => email.Subject.includes('has moved')),
  ).toHaveLength(1);

  // Undo: she was told, so it asks whether to tell her again; not this time (AC-X-150).
  await receipt.getByRole('button', { name: /^Undo/ }).click();
  await expect(sheet(page).getByRole('heading', { name: 'Move Maria Lopez back?' })).toBeVisible();
  await sheet(page).getByLabel('Email the client the original time').uncheck();
  await sheet(page).getByRole('button', { name: 'Move back' }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(day(page, s.tuesday).getByTestId('booking-block')).toHaveAccessibleName(
    /^10:00\s?–\s?11:00\sAM, Haircut with Maria Lopez$/,
  );
  await expect(receipt).toContainText(/Maria Lopez is back at Tue, \w+ \d+, 10:00\sAM\./);
  await expect(receipt.getByRole('button', { name: /^Undo/ })).toHaveCount(0);
  await page.waitForTimeout(3000);
  expect(
    (await emailsTo(maria)).filter((email) => email.Subject.includes('has moved')),
  ).toHaveLength(1);

  // A tap still opens the sheet (no drag).
  await day(page, s.tuesday).getByTestId('booking-block').click();
  await expect(sheet(page).getByRole('heading', { name: 'Maria Lopez' })).toBeVisible();
});

test('a drop on a taken time is marked, then refused by the api with the nearest free times; nothing moves', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  const s = await salon(page);
  const jess = await addStaff(page, s, 'Jess');
  await book(page, s, jess, { name: 'Maria Lopez' }, 10 * 60);
  await book(page, s, jess, { name: 'Sam Ortiz' }, 12 * 60);
  await page.goto(`/calendar?date=${formatDate(s.tuesday)}&view=week`);
  const block = day(page, s.tuesday).getByRole('button', { name: /^10:00\s?–\s?11:00\sAM/ });
  await hydrated(block);

  // 11:30 overlaps Sam's noon visit.
  await mouseDrag(page, block, s.tuesday, 90);
  await expect(page.getByTestId('drag-ghost')).toHaveAttribute('data-problem', 'taken');
  await expect(page.getByTestId('drag-ghost')).toContainText('Booked then');
  await expect(page.getByTestId('drag-live')).toHaveText('Tue 11:30 AM, Booked then');
  await page.mouse.up();
  const dialog = sheet(page);
  await expect(dialog.getByText('Booked then, it looks like.')).toBeVisible();
  // The api decides, never with an override (AC-X-149).
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'That time is taken' })).toBeVisible();
  await expect(dialog.getByTestId('alternatives').getByRole('button').first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep it where it was' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    day(page, s.tuesday).getByRole('button', { name: /^10:00\s?–\s?11:00\sAM/ }),
  ).toBeVisible();
  await expect(day(page, s.tuesday).getByTestId('booking-block')).toHaveCount(2);
});

test("a staff member opens on their own week; a colleague's week is busy times only, nothing drags", async ({
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
  await priya.goto(`/invite#${invite.token}`);
  await priya.getByRole('link', { name: 'Create an account' }).click();
  await signUp(priya, priyaEmail, { name: 'Priya', onPage: true });
  await expect(priya).toHaveURL(/\/invite$/);
  await (await hydrated(priya.getByRole('button', { name: `Join ${owner.business}` }))).click();
  await expect(priya.getByTestId('business-role')).toHaveText('staff');
  const members = MembersResponseSchema.parse(
    await (await page.request.get('/v1/members')).json(),
  ).members;
  const priyaUser = members.find((member) => member.email === priyaEmail)?.userId ?? null;
  const jess = await addStaff(page, s, 'Jess');
  await addStaff(page, s, 'Priya', priyaUser);
  await book(page, s, jess, { name: 'Maria Lopez' }, 10 * 60);

  await priya.goto(`/calendar?date=${formatDate(s.tuesday)}&view=week`);
  await expect(
    priya.getByRole('navigation', { name: 'Staff' }).getByRole('link', { name: 'Priya' }),
  ).toHaveAttribute('aria-current', 'true');
  await expect(priya.getByTestId('calendar-quiet')).toHaveText(
    'Nothing booked this week yet. Tap New booking to add one.',
  );

  await priya
    .getByRole('navigation', { name: 'Staff' })
    .getByRole('link', { name: 'Jess' })
    .click();
  await expect(priya).toHaveURL(new RegExp(`staff=${jess}`));
  const busy = day(priya, s.tuesday).getByTestId('busy-block');
  await expect(busy).toHaveCount(1);
  await expect(priya.getByTestId('booking-block')).toHaveCount(0);
  await expect(priya.locator('[data-draggable]')).toHaveCount(0);
  // A drag on it does nothing (AC-X-145).
  await mouseDrag(priya, busy, s.tuesday, 120);
  await priya.mouse.up();
  await expect(priya.getByTestId('drag-ghost')).toHaveCount(0);
  await expect(sheet(priya)).toHaveCount(0);
});

test.describe('on a 375 px phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('a long press lifts a booking to drag it; a swipe scrolls instead', async ({ page }) => {
    test.setTimeout(120_000);
    await onboardOwner(page);
    const s = await salon(page);
    const jess = await addStaff(page, s, 'Jess');
    await book(page, s, jess, { name: 'Maria Lopez' }, 10 * 60);
    const monday = addDays(s.tuesday, -1);
    await page.goto(`/calendar?date=${formatDate(s.tuesday)}&view=week`);
    const block = day(page, s.tuesday).getByTestId('booking-block');
    await hydrated(block);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number, y?: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: x === undefined || y === undefined ? [] : [{ x, y }],
      });

    // A quick swipe: nothing lifts.
    let { from } = await aim(page, block, s.tuesday, 0);
    await touch('touchStart', from.x, from.y);
    for (let step = 1; step <= 5; step += 1) await touch('touchMove', from.x, from.y + step * 12);
    await touch('touchEnd');
    await page.waitForTimeout(700);
    await expect(page.getByTestId('drag-ghost')).toHaveCount(0);
    await expect(sheet(page)).toHaveCount(0);

    // Press and hold, then drag onto Monday at noon.
    const aimed = await aim(page, block, monday, 120);
    from = aimed.from;
    await touch('touchStart', from.x, from.y);
    await page.waitForTimeout(700);
    const steps = 12;
    for (let step = 1; step <= steps; step += 1) {
      await touch(
        'touchMove',
        from.x + ((aimed.to.x - from.x) * step) / steps,
        from.y + ((aimed.to.y - from.y) * step) / steps,
      );
    }
    await expect(page.getByTestId('drag-ghost')).toContainText('Mon 12:00 PM');
    await touch('touchEnd');
    await expect(sheet(page).getByRole('heading', { name: 'Move Maria Lopez?' })).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Move', exact: true }).click();
    await expect(sheet(page)).toBeHidden();
    await expect(day(page, monday).getByTestId('booking-block')).toHaveAccessibleName(
      /^12:00\s?–\s?1:00\sPM, Haircut with Maria Lopez$/,
    );
  });
});
