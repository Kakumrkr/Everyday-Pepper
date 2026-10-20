import {
  BookingsResponseSchema,
  CurrentBusinessResponseSchema,
  ServiceSchema,
  StaffMemberSchema,
} from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
import {
  anotherPerson,
  callApi,
  emailTo,
  hydrated,
  onboardOwner,
  ownClientAddress,
  unique,
} from './helpers.js';

// The public booking page through the real stack (S17, W8): the owner gives the page their
// color (PCR-001); a client books with "anyone", confirms the code emailed to them (AC-W8-2,
// read from Mailpit), and reschedules and cancels through the link in the confirmation.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const EVERY_DAY = {
  intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
};

/** A 60-minute haircut that Jess offers every day; returns the page's slug. */
async function salon(page: Page): Promise<string> {
  const tenant = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const service = await callApi(
    page,
    'POST',
    '/v1/services',
    { name: 'Haircut', durationMinutes: 60, priceFromCents: 6500 },
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
  return tenant.business.slug;
}

/** Picks the `nth` day of the strip (0: today) and its first free time; returns its label. */
async function pickTime(page: Page, nth: number): Promise<string> {
  await page.getByRole('group', { name: 'Day' }).getByRole('button').nth(nth).click();
  const first = page.getByTestId('free-times').getByRole('button').first();
  const label = (await first.locator('span').first().textContent()) ?? '';
  await first.click();
  return label;
}

test('a client books on the page in the business’s color, confirms the emailed code, then reschedules and cancels by the link', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  const slug = await salon(page);

  // The owner gives the page their color.
  await page.goto('/services');
  const card = page.getByRole('region', { name: 'Your booking page' });
  await expect(card.getByRole('link', { name: `/book/${slug}` })).toBeVisible();
  await hydrated(card.getByRole('button', { name: 'Save color' }));
  await card.getByLabel('Color').fill('#7a3b8f');
  await card.getByRole('button', { name: 'Save color' }).click();
  await expect(card.getByText('Color saved.')).toBeVisible();

  // A client books with anyone, tomorrow at the first free time.
  const client = await anotherPerson(browser, baseURL);
  const email = `${unique('client')}@example.test`;
  await client.goto(`/book/${slug}`);
  await expect(client.getByRole('heading', { name: 'Book a visit' })).toBeVisible();
  await (await hydrated(client.getByRole('button', { name: /Haircut/ }))).click();
  await client.getByRole('button', { name: /Anyone available/ }).click();
  await expect(client.getByRole('heading', { name: 'Pick a time' })).toBeVisible();
  await pickTime(client, 1);

  await expect(client.getByRole('heading', { name: 'Your details' })).toBeVisible();
  const send = client.getByRole('button', { name: 'Send my code' });
  // PCR-001: the page's buttons are in the business's color, not Pepper's green.
  await expect(send).toHaveCSS('background-color', 'rgb(122, 59, 143)');
  await client.getByLabel('Full name').fill('Ana Ruiz');
  await client.getByLabel('Email').fill(email);
  await send.click();

  // AC-W8-2: nothing is booked before the code.
  await expect(client.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const owner = page;
  const range = `from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(
    new Date(Date.now() + 14 * 86_400_000).toISOString(),
  )}`;
  const bookings = async () =>
    BookingsResponseSchema.parse(await (await owner.request.get(`/v1/bookings?${range}`)).json())
      .bookings;
  expect(await bookings()).toEqual([]);

  const codeEmail = await emailTo(email, 'is your code');
  const code = /^ {4}(\d{6})$/m.exec(codeEmail)?.[1] ?? '';
  expect(code).toMatch(/^\d{6}$/);
  // A wrong code first: the client is told how many tries are left.
  await client.getByLabel('Code').fill(code === '000000' ? '111111' : '000000');
  await client.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(client.getByText(/That code isn’t right. 4 tries left./)).toBeVisible();
  await client.getByLabel('Code').fill(code);
  await client.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(client.getByRole('heading', { name: /You’re booked, Ana/ })).toBeVisible();

  const [booked] = await bookings();
  expect(booked).toMatchObject({ source: 'booking_page', status: 'confirmed' });

  // The confirmation carries the link, scoped to this booking.
  const confirmation = await emailTo(email, 'booked at');
  const link = /(https?:\/\/\S+\/book\/\S+\/manage#[A-Za-z0-9_-]{43})/.exec(confirmation)?.[1];
  expect(link).toBeDefined();
  await client.goto(new URL(link ?? '').pathname + new URL(link ?? '').hash);
  await expect(client.getByRole('heading', { name: 'Your booking' })).toBeVisible();
  await expect(client.getByTestId('booking-status')).toHaveText('Booked');

  // Reschedule to two days ahead.
  await (await hydrated(client.getByRole('button', { name: 'Reschedule' }))).click();
  await pickTime(client, 2);
  await expect(client.getByText(/^Moved to /)).toBeVisible();
  await expect(emailTo(email, 'has moved')).resolves.toContain('/manage#');
  const [moved] = await bookings();
  expect(moved?.startsAt).not.toBe(booked?.startsAt);

  // Cancel.
  await client.getByRole('button', { name: 'Cancel booking' }).click();
  await client.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(client.getByText('Your booking is cancelled.')).toBeVisible();
  await expect(client.getByTestId('booking-status')).toHaveText('Cancelled');
  expect((await bookings())[0]?.status).toBe('cancelled');
});

test('an unknown booking page is not found, and a broken link says so', async ({ page }) => {
  const missing = await page.goto('/book/no-such-business-here');
  expect(missing?.status()).toBe(404);

  await onboardOwner(page);
  const slug = await salon(page);
  await page.goto(`/book/${slug}/manage#not-a-token`);
  await expect(page.getByText('This link is incomplete. Open it from your email.')).toBeVisible();
});
