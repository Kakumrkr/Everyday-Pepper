import {
  BookingsResponseSchema,
  CurrentBusinessResponseSchema,
  ServiceSchema,
  StaffMemberSchema,
  StaffResponseSchema,
  WaitlistResponseSchema,
} from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
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

// The public booking page through the real stack (S17, W8): the owner gives the page their
// color (PCR-001); a client books with "anyone", confirms the code emailed to them (AC-W8-2,
// read from Mailpit), and reschedules and cancels through the link in the confirmation. The
// code is sent by the api at once; the other emails go through the outbox and the worker
// (ADR-0024).

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const EVERY_DAY = {
  intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
};
/** Half an hour every day: too short for an hour's service. */
const SHORT_DAYS = {
  intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '09:30' })),
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
  // Sent empty: focus goes to the first field to fix, its error its description (S43.2).
  await send.click();
  await expect(client.getByLabel('Full name')).toBeFocused();
  await expect(client.getByLabel('Full name')).toHaveAttribute('aria-invalid', 'true');
  await client.getByLabel('Full name').fill('Ana Ruiz');
  await send.click();
  await expect(client.getByLabel('Email')).toBeFocused();
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
  // D5: a cancelled booking offers the next step.
  await expect(client.getByRole('link', { name: 'Book again' })).toHaveAttribute(
    'href',
    `/book/${slug}`,
  );
  expect((await bookings())[0]?.status).toBe('cancelled');
  await expect(emailTo(email, 'is cancelled')).resolves.toContain('Hi Ana');
});

test('AC-W8-7/8/9: the page shows the contact details and policy, a remembered phone books again without a code, and each step is counted with nothing personal', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  await onboardOwner(page);
  const slug = await salon(page);

  // The owner fills in what clients see; a wrong phone is named under its field first.
  await page.goto('/services');
  const card = page.getByRole('region', { name: 'Your booking page' });
  const details = card.getByRole('form', { name: 'What clients see' });
  await hydrated(details.getByRole('button', { name: 'Save details' }));
  await details.getByLabel('Phone').fill('555 12');
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByLabel('Phone')).toBeFocused();
  await expect(details.getByLabel('Phone')).toHaveAttribute('aria-invalid', 'true');
  await details.getByLabel('Phone').fill('(512) 555-0142');
  await details.getByLabel('Address').fill('12 Main St\nAustin, TX 78701');
  await details.getByLabel('Cancellation policy').fill('Please cancel at least 24 hours ahead.');
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByText('Saved. Clients see these on your booking page.')).toBeVisible();

  // The client sees them; every step they enter is counted with a visit id and the step only.
  const client = await anotherPerson(browser, baseURL);
  const steps: unknown[] = [];
  client.on('request', (request) => {
    if (request.url().endsWith('/funnel')) steps.push(request.postDataJSON());
  });
  const email = `${unique('regular')}@example.test`;
  await client.goto(`/book/${slug}`);
  const contact = client.getByTestId('business-contact');
  await expect(contact.getByRole('link', { name: '(512) 555-0142' })).toHaveAttribute(
    'href',
    'tel:+15125550142',
  );
  await expect(contact).toContainText('12 Main St');
  await (await hydrated(client.getByRole('button', { name: /Haircut/ }))).click();
  await client.getByRole('button', { name: /Anyone available/ }).click();
  await pickTime(client, 1);
  await expect(client.getByTestId('cancellation-policy')).toContainText('24 hours ahead');
  await client.getByLabel('Full name').fill('Rae Kim');
  await client.getByLabel('Email').fill(email);
  await client.getByRole('button', { name: 'Send my code' }).click();

  // AC-W8-8: "Remember me on this phone" is on; the code proves the email once.
  await expect(client.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(client.getByLabel('Remember me on this phone')).toBeChecked();
  const code = /^ {4}(\d{6})$/m.exec(await emailTo(email, 'is your code'))?.[1] ?? '';
  await client.getByLabel('Code').fill(code);
  await client.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(client.getByRole('heading', { name: /You’re booked, Rae/ })).toBeVisible();
  await expect(client.getByTestId('cancellation-policy')).toBeVisible();
  const cookies = await client.context().cookies();
  expect(cookies.find((cookie) => cookie.name === 'pepper_device')).toMatchObject({
    httpOnly: true,
    sameSite: 'Lax',
    path: `/v1/public/businesses/${slug}`,
  });

  // AC-W8-9: one event per step entered, none carrying the client's details.
  await expect
    .poll(() => steps.map((step) => (step as { step: string }).step), { timeout: 10_000 })
    .toEqual(['service', 'staff', 'time', 'details', 'verify', 'done']);
  for (const step of steps) expect(Object.keys(step as object).sort()).toEqual(['step', 'visitId']);
  expect(JSON.stringify(steps)).not.toContain('Rae');
  expect(JSON.stringify(steps)).not.toContain(email);

  // The next booking from this phone: straight to the confirmation, no code email.
  await client.goto(`/book/${slug}`);
  await (await hydrated(client.getByRole('button', { name: /Haircut/ }))).click();
  await client.getByRole('button', { name: /Anyone available/ }).click();
  await pickTime(client, 2);
  await client.getByLabel('Full name').fill('Rae Kim');
  await client.getByLabel('Email').fill(email);
  await client.getByRole('button', { name: 'Send my code' }).click();
  await expect(client.getByRole('heading', { name: /You’re booked, Rae/ })).toBeVisible();
  await expect(client.getByText(/This phone is remembered, so no code was needed\./)).toBeVisible();
  expect((await emailsTo(email)).filter((m) => m.Subject.includes('is your code'))).toHaveLength(1);

  // Forgotten: the next booking asks for a code again.
  await client.getByRole('button', { name: 'Forget this phone' }).click();
  await expect(
    client.getByText('This phone is forgotten. Next time we’ll email you a code.'),
  ).toBeVisible();
  await client.goto(`/book/${slug}`);
  await (await hydrated(client.getByRole('button', { name: /Haircut/ }))).click();
  await client.getByRole('button', { name: /Anyone available/ }).click();
  await pickTime(client, 3);
  await client.getByLabel('Full name').fill('Rae Kim');
  await client.getByLabel('Email').fill(email);
  await client.getByRole('button', { name: 'Send my code' }).click();
  await expect(client.getByRole('heading', { name: 'Check your email' })).toBeVisible();
});

test('an unknown booking page is not found, and a broken link says so', async ({ page }) => {
  const missing = await page.goto('/book/no-such-business-here');
  expect(missing?.status()).toBe(404);

  await onboardOwner(page);
  const slug = await salon(page);
  await page.goto(`/book/${slug}/manage#not-a-token`);
  await expect(page.getByText('This link is incomplete. Open it from your email.')).toBeVisible();
});

/** On the page: Haircut with Jess, tomorrow's first time, details, then the emailed code typed in. */
async function requestFirstTime(client: Page, slug: string, name: string): Promise<void> {
  const email = `${unique('client')}@example.test`;
  await client.goto(`/book/${slug}`);
  await (await hydrated(client.getByRole('button', { name: /Haircut/ }))).click();
  await client.getByRole('button', { name: /Jess/ }).click();
  await pickTime(client, 1);
  await client.getByLabel('Full name').fill(name);
  await client.getByLabel('Email').fill(email);
  await client.getByRole('button', { name: 'Send my code' }).click();
  await expect(client.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const code = /^ {4}(\d{6})$/m.exec(await emailTo(email, 'is your code'))?.[1] ?? '';
  expect(code).toMatch(/^\d{6}$/);
  await client.getByLabel('Code').fill(code);
}

test('AC-W8-1: two clients confirm the same last time at once; one is booked, the other is offered the nearest times', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  const slug = await salon(page);
  // Jess works one hour a day, so each day has exactly one time: the last slot.
  const [jess] = StaffResponseSchema.parse(
    await (await page.request.get('/v1/staff')).json(),
  ).staff;
  await callApi(
    page,
    'PUT',
    `/v1/staff/${jess?.id ?? ''}/hours`,
    {
      intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        start: '09:00',
        end: '10:00',
      })),
    },
    { parse: (body: unknown) => body },
  );

  const ana = await anotherPerson(browser, baseURL);
  const bea = await anotherPerson(browser, baseURL);
  await requestFirstTime(ana, slug, 'Ana Ruiz');
  await requestFirstTime(bea, slug, 'Bea Lima');

  // Both press Confirm at the same moment.
  await Promise.all(
    [ana, bea].map((client) => client.getByRole('button', { name: 'Confirm booking' }).click()),
  );
  const booked = (client: Page) => client.getByRole('heading', { name: /You’re booked/ });
  const taken = (client: Page) => client.getByRole('region', { name: 'That time was taken' });
  for (const client of [ana, bea]) {
    await expect(booked(client).or(taken(client))).toBeVisible();
  }
  const outcomes = await Promise.all([ana, bea].map((client) => booked(client).isVisible()));
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  const loser = outcomes[0] === true ? bea : ana;

  // The other is offered the nearest free times and books one with the same code.
  const alternatives = taken(loser).getByTestId('alternatives').getByRole('button');
  await expect(alternatives.first()).toBeVisible();
  await alternatives.first().click();
  await expect(booked(loser)).toBeVisible();

  // Two bookings, at different times: never a double booking.
  const range = `from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(
    new Date(Date.now() + 14 * 86_400_000).toISOString(),
  )}`;
  const { bookings } = BookingsResponseSchema.parse(
    await (await page.request.get(`/v1/bookings?${range}`)).json(),
  );
  expect(bookings).toHaveLength(2);
  expect(new Set(bookings.map((booking) => booking.startsAt)).size).toBe(2);
});

test('a client joins the waitlist for a full day with the emailed code (S38a)', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  // Jess works half an hour a day and a haircut takes an hour: no day has a free time.
  const tenant = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
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
  await callApi(page, 'PUT', `/v1/staff/${jess.id}/hours`, SHORT_DAYS, {
    parse: (body: unknown) => body,
  });

  const client = await anotherPerson(browser, baseURL);
  const email = `${unique('waiting')}@example.test`;
  await client.goto(`/book/${tenant.business.slug}`);
  await (await hydrated(client.getByRole('button', { name: /Haircut/ }))).click();
  await client.getByRole('button', { name: /Jess/ }).click();
  // AC-W8-4: the whole strip is empty, said as such, and the waitlist stays.
  await expect(client.getByTestId('range-empty')).toHaveText(
    'No free times in the next two weeks. Join the waitlist and I’ll tell you if one opens.',
  );
  await client.getByRole('group', { name: 'Day' }).getByRole('button').nth(1).click();
  await expect(client.getByText('Nothing free that day.', { exact: true })).toBeVisible();
  await client.getByRole('button', { name: /^Join the waitlist for / }).click();

  await expect(client.getByRole('heading', { name: 'Join the waitlist' })).toBeVisible();
  await client.getByLabel('Full name').fill('Ana Ruiz');
  await client.getByLabel('Email').fill(email);
  await client.getByRole('button', { name: 'Send my code' }).click();
  await expect(client.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  // Nothing is added before the code.
  const entries = async () =>
    WaitlistResponseSchema.parse(await (await page.request.get('/v1/waitlist')).json()).entries;
  expect(await entries()).toEqual([]);
  const text = await emailTo(email, 'is your code for');
  expect(text).toContain('join the waitlist');
  const code = /^\s+(\d{6})$/m.exec(text)?.[1];
  if (code === undefined) throw new Error('No code in the email');
  await client.getByLabel('Code').fill(code);
  await client.getByRole('button', { name: 'Join the waitlist' }).click();

  await expect(client.getByRole('heading', { name: 'You’re on the waitlist, Ana' })).toBeVisible();
  const [entry] = await entries();
  expect(entry).toMatchObject({ serviceId: service.id, status: 'waiting' });
  expect(entry?.windows).toEqual([expect.objectContaining({ start: '00:00', end: '24:00' })]);
});

test('AC-W8-3/4/5: only people with hours are offered, the strip opens on the first free day, and a failed day can be tried again', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  const tenant = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const { slug, timeZone } = tenant.business;
  const service = await callApi(
    page,
    'POST',
    '/v1/services',
    { name: 'Beard trim', durationMinutes: 30 },
    ServiceSchema,
  );
  // Jess works only on the weekday four days from now; Nia has no hours at all.
  const fourDaysOn = new Date(Date.now() + 4 * 24 * 3600 * 1000);
  const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(
    fourDaysOn,
  );
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekdayName) + 1;
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(fourDaysOn);
  for (const displayName of ['Jess', 'Nia']) {
    const member = await callApi(
      page,
      'POST',
      '/v1/staff',
      { displayName, serviceIds: [service.id] },
      StaffMemberSchema,
    );
    if (displayName === 'Jess') {
      await callApi(
        page,
        'PUT',
        `/v1/staff/${member.id}/hours`,
        { intervals: [{ weekday, start: '09:00', end: '17:00' }] },
        { parse: (body: unknown) => body },
      );
    }
  }

  const client = await anotherPerson(browser, baseURL);
  // The first answer for one day fails; the strip-wide search and the retry go through.
  let failed = 0;
  await client.route('**/v1/public/businesses/*/availability?*', async (route) => {
    const url = new URL(route.request().url());
    const span =
      Date.parse(url.searchParams.get('to') ?? '') - Date.parse(url.searchParams.get('from') ?? '');
    if (span <= 25 * 3600 * 1000 && failed === 0) {
      failed += 1;
      await route.fulfill({ status: 500, json: { code: 'internal', message: 'Boom' } });
      return;
    }
    await route.continue();
  });
  await client.goto(`/book/${slug}`);
  await (await hydrated(client.getByRole('button', { name: /Beard trim/ }))).click();
  // AC-W8-3: Nia, who has no hours, is not offered.
  await expect(client.getByRole('button', { name: /Jess/ })).toBeVisible();
  await expect(client.getByRole('button', { name: /Nia/ })).toHaveCount(0);
  await client.getByRole('button', { name: /Jess/ }).click();

  // AC-W8-4: today and the next days are empty; the strip opens on Jess's day.
  const day = client.getByRole('group', { name: 'Day' }).getByRole('button', { name: label });
  await expect(day).toHaveAttribute('aria-pressed', 'true');
  // AC-W8-5: its times failed to load; "Try again" asks again for the same day.
  const problem = client.getByRole('alert').filter({ hasText: 'I couldn’t load the times' });
  await expect(problem).toContainText(`I couldn’t load the times for ${label}.`);
  await client.getByRole('button', { name: 'Try again' }).click();
  await expect(client.getByTestId('free-times').getByRole('button').first()).toBeVisible();
  await expect(day).toHaveAttribute('aria-pressed', 'true');
  await expect(problem).toHaveCount(0);
  expect(failed).toBe(1);
  await expect(client.getByText(/^Times are in /)).toBeVisible();
});
