import {
  ClientSchema,
  CurrentBusinessResponseSchema,
  ServiceSchema,
  StaffMemberSchema,
  TimeOffSchema,
  WaitlistEntrySchema,
} from '@pepper/contracts';
import { test } from '@playwright/test';
import { book, expect, salon } from './chat-helpers.js';
import {
  anotherPerson,
  callApi,
  emailTo,
  hydrated,
  onboardOwner,
  ownClientAddress,
  unique,
} from './helpers.js';
import { daytimeZone, newPhone, sentTexts, textTo, typed } from './sms-helpers.js';

// Waitlist offers by text through the real stack and the text sandbox (S79, ADR-0065 §S79,
// AC-X-222…227): a client who ticks "Text me when a time opens up" on the booking page gets
// the opt-in text; a client the team has only a number for, who told the team yes, is offered
// a freed time by text (after the owner's OK and the Undo grace), says how long it is open,
// and claims it from the link. A business where it is daytime now, so nothing waits.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const SHORT_DAYS = {
  intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '09:30' })),
};

test('AC-X-222: a client ticks the waitlist’s text box and gets the opt-in text', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await onboardOwner(page, { timeZone: daytimeZone() });
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
  const phone = newPhone();
  await client.goto(`/book/${tenant.business.slug}`);
  await (await hydrated(client.getByRole('button', { name: /Haircut/ }))).click();
  await client.getByRole('button', { name: /Jess/ }).click();
  await client.getByRole('group', { name: 'Day' }).getByRole('button').nth(1).click();
  await client.getByRole('button', { name: /^Join the waitlist for / }).click();

  await expect(client.getByRole('heading', { name: 'Join the waitlist' })).toBeVisible();
  await client.getByLabel('Full name').fill('Ana Ruiz');
  await client.getByLabel('Email').fill(email);
  await client.getByLabel('Phone (optional)').fill(typed(phone));
  // The waitlist's own words: openings, not reminders.
  const box = client.getByRole('checkbox', {
    name: /Text me when a time I'm waiting for opens up/,
  });
  await expect(box).toBeVisible();
  await expect(client.getByText(/appointment confirmations and reminders/)).toHaveCount(0);
  await box.check();
  await client.getByRole('button', { name: 'Send my code' }).click();
  await expect(client.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const code = /^\s+(\d{6})$/m.exec(await emailTo(email, 'is your code for'))?.[1];
  if (code === undefined) throw new Error('No code in the email');
  await client.getByLabel('Code').fill(code);
  await client.getByRole('button', { name: 'Join the waitlist' }).click();
  await expect(client.getByRole('heading', { name: 'You’re on the waitlist, Ana' })).toBeVisible();
  await expect(client.getByText(/or by text to .+ when the business texts/)).toBeVisible();
  await expect(client.getByText(typed(phone), { exact: true })).toBeVisible();

  const optIn = await textTo(client, phone, /You're on the waitlist for Haircut/);
  expect(optIn).toContain('Reply HELP for help, STOP to opt out.');
});

test('AC-X-223/224/227: a client the team has only a number for is offered the time by text and claims it', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(600_000);
  await onboardOwner(page, { timeZone: daytimeZone() });
  const s = await salon(page);
  const booking = await book(page, s, s.mariaId, s.jessId, '15:00');
  // Marco is off for that hour, so it is full when she joins (the waitlist takes full times).
  await callApi(
    page,
    'POST',
    `/v1/staff/${s.marcoId}/time-off`,
    { startsAt: booking.startsAt, endsAt: booking.endsAt },
    TimeOffSchema,
  );
  const phone = newPhone();
  const lena = await callApi(
    page,
    'POST',
    '/v1/clients',
    { name: 'Lena Park', phone },
    ClientSchema,
  );
  expect(lena.email).toBeNull();
  // She told the team yes to texts about openings (the add sheet's box sends the same).
  await callApi(
    page,
    'POST',
    '/v1/waitlist',
    {
      clientId: lena.id,
      serviceId: s.serviceId,
      windows: [{ date: s.day, start: '15:00', end: '16:00' }],
      smsConsent: { phone, wordingVersion: 'sms-consent-v3' },
    },
    WaitlistEntrySchema,
  );
  await textTo(page, phone, /You're on the waitlist for Haircut/);

  // Maria cancels (the owner, for her): the worker offers the time; the owner approves it.
  const cancelled = await page.request.fetch(`/v1/bookings/${booking.id}`, {
    method: 'PATCH',
    data: { status: 'cancelled', notifyClient: false },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(cancelled.status(), await cancelled.text()).toBe(200);
  const proposal = page
    .getByRole('region', { name: 'Needs your OK' })
    .getByRole('article', { name: 'Waitlist offer' });
  await expect(async () => {
    await page.goto('/');
    await expect(proposal).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 120_000, intervals: [2_000, 5_000] });
  await expect(proposal).toContainText('Lena P.');
  await (await hydrated(proposal.getByRole('button', { name: 'Approve' }))).click();
  await expect(proposal.getByRole('status')).toHaveText('Done.');

  // After the Undo grace, one text with the time, how long it is open and the link.
  const offer = await textTo(page, phone, /A time you're waiting for opened up/, 300_000);
  expect(offer).toMatch(/Open for (1 hour( \d+ minutes?)?|2 hours|\d+ minutes), until /);
  const link = /(https?:\/\/\S+\/book\/\S+\/offer#[A-Za-z0-9_-]{43})/.exec(offer)?.[1];
  if (link === undefined) throw new Error('No claim link in the offer text');
  expect(
    (await sentTexts(page, phone)).filter((text) => text.body.includes('opened up')),
  ).toHaveLength(1);

  const lenaPage = await anotherPerson(browser, baseURL);
  const url = new URL(link);
  await lenaPage.goto(url.pathname + url.hash);
  await expect(lenaPage.getByRole('heading', { name: 'A time opened up' })).toBeVisible();
  await (await hydrated(lenaPage.getByRole('button', { name: 'Claim this time' }))).click();
  await expect(lenaPage.getByRole('heading', { name: 'You’re booked' })).toBeVisible();
});
