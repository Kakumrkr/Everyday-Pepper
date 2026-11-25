import {
  addDays,
  BookingsResponseSchema,
  BookingSchema,
  CurrentBusinessResponseSchema,
  formatDate,
  fromZoned,
  ServiceSchema,
  StaffMemberSchema,
  toZoned,
} from '@pepper/contracts';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  anotherPerson,
  callApi,
  emailTo,
  emailsTo,
  hydrated,
  onboardOwner,
  ownClientAddress,
  unique,
} from './helpers.js';
import { buildPolicy, POLICY_SENTENCE, stripeSays } from './payments-helpers.js';

// The no-show fee by approval (S68, AC-X-137…143, ADR-0068 amendment), through the Stripe
// sandbox: the owner turns on a $20 no-show fee; a client books a "card to book" haircut and keeps
// a card; the visit is missed (the team moves it to yesterday, as if it had happened), and the
// owner marks it a no-show on the booking sheet. Home then shows one card with the client's own
// terms and the fee they allow, and "Charge $20" or "Waive"; nothing is charged before the tap.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const EVERY_DAY = {
  intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
};

/** A $45 "card to book" haircut Jess offers every day, payments ready, the $20 policy on. */
async function salon(page: Page): Promise<{ slug: string; timeZone: string }> {
  const tenant = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const service = await callApi(
    page,
    'POST',
    '/v1/services',
    { name: 'Haircut', durationMinutes: 60, priceFromCents: 4500, deposit: { kind: 'card' } },
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
  await callApi(page, 'POST', '/v1/payments/onboarding', {}, { parse: (body) => body }, 200);
  await stripeSays(page, 'ready');
  await page.goto('/services');
  await buildPolicy(page);
  return { slug: tenant.business.slug, timeZone: tenant.business.timeZone };
}

/** A client books the haircut two days ahead with their card kept. */
async function bookWithCard(
  browser: Browser,
  baseURL: string | undefined,
  slug: string,
  name: string,
) {
  const client = await anotherPerson(browser, baseURL);
  const email = `${unique('fee')}@example.test`;
  await client.goto(`/book/${slug}`);
  const haircut = await hydrated(client.getByRole('button', { name: /Haircut/ }));
  await expect(haircut).toContainText('Card to book');
  await haircut.click();
  await client.getByRole('button', { name: /Anyone available/ }).click();
  await client.getByRole('group', { name: 'Day' }).getByRole('button').nth(2).click();
  await client.getByTestId('free-times').getByRole('button').first().click();
  await client.getByLabel('Full name').fill(`${name} Lopez`);
  await client.getByLabel('Email').fill(email);
  await client.getByRole('button', { name: 'Send my code' }).click();
  const code = /^ {4}(\d{6})$/m.exec(await emailTo(email, 'is your code'))?.[1] ?? '';
  await client.getByLabel('Code').fill(code);
  await client.getByRole('button', { name: 'Continue' }).click();
  await expect(client.getByRole('heading', { name: 'Almost booked' })).toBeVisible();
  // The client reads the policy where the card is kept (S68): the terms a fee is held to.
  await expect(client.getByTestId('deposit-policy')).toHaveText(POLICY_SENTENCE);
  await client.getByRole('button', { name: 'Save card and book' }).click();
  await expect(client.getByRole('heading', { name: /You’re booked/ })).toBeVisible();
  await client.close();
  return { name, email };
}

/** As if the visit had happened: the team moves it to yesterday at `minute`, without telling. */
async function missedYesterday(page: Page, timeZone: string, minute: number): Promise<string> {
  const range = new URLSearchParams({
    from: new Date().toISOString(),
    to: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    status: 'confirmed',
  });
  const { bookings } = BookingsResponseSchema.parse(
    await (await page.request.get(`/v1/bookings?${range.toString()}`)).json(),
  );
  const booking = bookings.at(-1);
  if (booking === undefined) throw new Error('no booking');
  const yesterday = addDays(toZoned(timeZone, Date.now()), -1);
  const moved = await page.request.patch(`/v1/bookings/${booking.id}`, {
    data: {
      startsAt: new Date(fromZoned(timeZone, yesterday, minute)).toISOString(),
      override: true,
      notifyClient: false,
    },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(moved.status(), await moved.text()).toBe(200);
  BookingSchema.parse(await moved.json());
  return formatDate(yesterday);
}

/** The owner marks yesterday's visit a no-show on its booking sheet (AC-X-137). */
async function markNoShow(page: Page, day: string, label: RegExp): Promise<void> {
  await page.goto(`/calendar?date=${day}`);
  await (
    await hydrated(
      page
        .getByRole('region', { name: 'Jess' })
        .getByTestId('booking-block')
        .filter({ hasText: label }),
    )
  ).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'No-show' }).click();
  await expect(sheet).toBeHidden();
}

test('a missed visit brings one card with the client’s terms; the owner charges it, or waives the next', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  await onboardOwner(page);
  const { slug, timeZone } = await salon(page);

  const first = await bookWithCard(browser, baseURL, slug, 'Bea');
  const day = await missedYesterday(page, timeZone, 10 * 60);
  await markNoShow(page, day, new RegExp(first.name));

  // AC-X-138: the card says the client's own terms and the fee they allow, and the money is on
  // the button; nothing is charged yet.
  await page.goto('/');
  const needs = page.getByRole('region', { name: 'Needs your OK' });
  const card = needs.getByRole('article', { name: 'No-show fee' });
  await expect(card).toBeVisible();
  await expect(card).toContainText(
    `Charge ${first.name} L.'s $20 no-show fee for the missed haircut with Jess.`,
  );
  await expect(card).toContainText('Nothing is charged until you tap.');
  await expect(card).toContainText(POLICY_SENTENCE);
  await expect(card).toContainText('No-shows may be charged $20 · charge $20 or waive');
  await expect(card).toContainText('Card on file');
  await expect(card.getByRole('button', { name: 'Waive' })).toBeVisible();
  // For the close's walkthrough (375 px, light and dark): the card as the owner sees it.
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: test.info().outputPath('no-show-fee-card-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await card.screenshot({ path: test.info().outputPath('no-show-fee-card-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  // AC-X-139/140: the owner's tap charges it (after the grace), and the card becomes a receipt
  // with Undo.
  await card.getByRole('button', { name: 'Charge $20' }).click();
  const done = page.getByRole('article', { name: 'No-show fee' }).filter({ hasText: 'Done' });
  await expect(done.first()).toBeVisible();
  await expect(done.first().getByRole('button', { name: 'Undo' })).toBeVisible();
  // AC-X-142: once charged (after the 60-second grace), the client gets a receipt with the
  // policy they were shown.
  await expect
    .poll(
      async () =>
        (await emailsTo(first.email)).some((email) => email.Subject.includes('missed visit fee')),
      { timeout: 150_000, intervals: [2_000, 5_000] },
    )
    .toBe(true);
  const receipt = await emailTo(first.email, 'missed visit fee');
  expect(receipt.replace(/\s+/g, ' ')).toContain(POLICY_SENTENCE);
  expect(receipt).toContain('Amount: $20');

  // AC-X-143: the next no-show is waived, and nothing is charged.
  const second = await bookWithCard(browser, baseURL, slug, 'Cara');
  await missedYesterday(page, timeZone, 13 * 60);
  await markNoShow(page, day, new RegExp(second.name));
  await page.goto('/');
  const next = needs.getByRole('article', { name: 'No-show fee' });
  await expect(next).toContainText(`${second.name} L.`);
  await next.getByRole('button', { name: 'Waive' }).click();
  // The card says it was waived, with no button left that would charge.
  await expect(next).toContainText('Waived');
  await expect(next.getByRole('button', { name: /Charge/ })).toHaveCount(0);
});
