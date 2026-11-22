import {
  BookingSchema,
  ClientsPageSchema,
  CurrentBusinessResponseSchema,
  formatDate,
  toZoned,
} from '@pepper/contracts';
import { test } from '@playwright/test';
import { expect, salon } from './chat-helpers.js';
import {
  anotherPerson,
  callApi,
  emailTo,
  hydrated,
  onboardOwner,
  ownClientAddress,
  unique,
} from './helpers.js';
import { daytimeZone, newPhone, textIn, textTo, typed } from './sms-helpers.js';

// "Confirmed by text", end to end (S63.2, AC-X-92; AC-X-74/79, ADR-0065): Ana says yes to texts
// on the booking page; the owner books her in about an hour; the same-day reminder (an hour
// ahead) goes to her number, she replies C, and the visit's sheet says so. Texts go through the
// sandbox; a business where it is daytime now, so nothing waits for the morning.

const MINUTE = 60_000;

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

test('a client replies C to the reminder and the visit says "Confirmed by text"', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(900_000);
  await onboardOwner(page, { timeZone: daytimeZone() });
  const s = await salon(page);
  const origin = new URL(page.url()).origin;
  const lead = await page.request.fetch('/v1/reminders/settings', {
    method: 'PATCH',
    data: { sameDayLeadHours: 1 },
    headers: { origin },
  });
  expect(lead.status(), await lead.text()).toBe(200);
  // Bookable an hour ahead (the default asks for two hours' notice), on any 5 minutes, so the
  // reminder is due within minutes of the booking.
  await callApi(
    page,
    'PUT',
    '/v1/rules',
    {
      rules: [
        { type: 'minimum_notice', params: { minutes: 0 } },
        { type: 'slot_interval', params: { minutes: 5 } },
      ],
    },
    { parse: (body: unknown) => body },
  );
  const { business } = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );

  // Ana books a visit in a few days on the booking page and ticks the texts box.
  const phone = newPhone();
  const email = `${unique('ana')}@example.test`;
  const ana = await anotherPerson(browser, baseURL);
  await ana.goto(`/book/${business.slug}`);
  await (await hydrated(ana.getByRole('button', { name: /Haircut/ }))).click();
  await ana.getByRole('button', { name: /Anyone available/ }).click();
  await ana.getByRole('group', { name: 'Day' }).getByRole('button').nth(3).click();
  await ana.getByTestId('free-times').getByRole('button').first().click();
  await ana.getByLabel('Full name').fill('Ana Ruiz');
  await ana.getByLabel('Email').fill(email);
  await ana.getByLabel('Phone (optional)').fill(typed(phone));
  await ana.getByRole('checkbox', { name: /^Text me appointment confirmations/ }).check();
  await ana.getByRole('button', { name: 'Send my code' }).click();
  const code = /^ {4}(\d{6})$/m.exec(await emailTo(email, 'is your code'))?.[1] ?? '';
  await ana.getByLabel('Code').fill(code);
  await ana.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(ana.getByRole('heading', { name: /You’re booked, Ana/ })).toBeVisible();

  // The owner books her today, a little over an hour from now: the reminder is due in minutes.
  const clients = ClientsPageSchema.parse(
    await (await page.request.get(`/v1/clients?search=${encodeURIComponent(email)}`)).json(),
  );
  const clientId = clients.clients[0]?.id ?? '';
  const startsAt = new Date(Math.ceil((Date.now() + 61.5 * MINUTE) / (5 * MINUTE)) * 5 * MINUTE);
  await callApi(
    page,
    'POST',
    '/v1/bookings',
    {
      clientId,
      serviceId: s.serviceId,
      staffMemberId: s.jessId,
      startsAt: startsAt.toISOString(),
    },
    BookingSchema,
  );

  // The worker sends the same-day text when it is due (start − 1 h, 2 to 7 minutes from now;
  // its reminders are polled each minute).
  const reminder = await textTo(page, phone, /See you today at/, 600_000);
  expect(reminder).toContain('Reply C to confirm.');
  expect(await textIn(page, phone, 'C')).toMatch(/confirmed/i);

  // On the calendar: the visit's sheet says she confirmed by text.
  const today = formatDate(toZoned(business.timeZone, Date.now()));
  await page.goto(`/calendar?date=${today}`);
  await (await hydrated(page.getByTestId('booking-block').first())).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByTestId('booking-confirmed-by-text')).toContainText('Confirmed by text');

  // The sheet at 375 px in light and dark (DESIGN.md D6); the day and times move with today.
  // They are hidden, not masked: a mask is as wide as the text under it, so a longer date
  // ("Wed, Dec 23" against "Sun, Nov 1") changed the picture (S65.2's CI). Hidden on one line,
  // they keep the layout and draw nothing, whatever the date.
  if (test.info().project.name !== 'mobile') return;
  await page.setViewportSize({ width: 375, height: 812 });
  const movesWithToday = [
    '[data-testid="booking-when"]',
    '[data-testid="booking-confirmed-when"]',
    '[data-testid="calendar-day"]',
  ].join(', ');
  await page.addStyleTag({
    content: `${movesWithToday} { visibility: hidden; white-space: nowrap; }`,
  });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await expect.soft(page).toHaveScreenshot(`booking-confirmed-by-text-375-${scheme}.png`, {
      animations: 'disabled',
    });
  }
});
