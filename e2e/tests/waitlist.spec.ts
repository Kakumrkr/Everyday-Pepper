import { ClientSchema, TimeOffSchema, WaitlistEntrySchema } from '@pepper/contracts';
import { test, type Page } from '@playwright/test';
import { book, expect, salon } from './chat-helpers.js';
import {
  anotherPerson,
  callApi,
  emailsTo,
  emailTo,
  hydrated,
  onboardOwner,
  ownClientAddress,
  unique,
} from './helpers.js';

// The smart waitlist through the real stack (S37, ADR-0041, AC-W5-1): Maria's booking with
// Jess is cancelled; Sara and Ana wait for that day. The worker offers the time; at "ask" (the
// default) the owner approves it from Home, and each client is emailed their own claim link
// once the Undo grace has passed (120 s, ADR-0028). Sara claims first and is booked; Ana's
// link then says it's taken, and she is emailed so.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

/** A client with an email Mailpit receives; returns the client and the address. */
async function client(page: Page, name: string) {
  const email = `${unique(name.split(' ')[0]?.toLowerCase() ?? 'client')}@example.test`;
  return callApi(page, 'POST', '/v1/clients', { name, email }, ClientSchema);
}

/** The claim link in the newest offer email to `to`, waiting out the Undo grace. */
async function claimLink(to: string): Promise<string> {
  await expect
    .poll(async () => (await emailsTo(to)).some((m) => m.Subject.startsWith('A time opened up')), {
      timeout: 240_000,
      intervals: [5_000],
    })
    .toBe(true);
  const text = await emailTo(to, 'A time opened up');
  const link = /(https?:\/\/\S+\/book\/\S+\/offer#[A-Za-z0-9_-]{43})/.exec(text)?.[1];
  if (link === undefined) throw new Error('No claim link in the offer email');
  const url = new URL(link);
  return url.pathname + url.hash;
}

test('a cancelled time is offered to the waitlist; the first claim books it, the other is told it’s taken', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(420_000);
  await onboardOwner(page);
  const s = await salon(page);
  const booking = await book(page, s, s.mariaId, s.jessId, '15:00');
  // Marco is off for that hour, so it is full when they join (AC-W5-2: the waitlist takes only
  // full times); they wait for exactly it.
  await callApi(
    page,
    'POST',
    `/v1/staff/${s.marcoId}/time-off`,
    { startsAt: booking.startsAt, endsAt: booking.endsAt },
    TimeOffSchema,
  );
  const sara = await client(page, 'Sara Kim');
  const ana = await client(page, 'Ana Ruiz');
  for (const waiting of [sara, ana]) {
    await callApi(
      page,
      'POST',
      '/v1/waitlist',
      {
        clientId: waiting.id,
        serviceId: s.serviceId,
        windows: [{ date: s.day, start: '15:00', end: '16:00' }],
      },
      WaitlistEntrySchema,
    );
  }

  // Maria cancels (here the owner, for her): the worker offers the time within 2 minutes.
  const cancelled = await page.request.fetch(`/v1/bookings/${booking.id}`, {
    method: 'PATCH',
    data: { status: 'cancelled', notifyClient: false },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(cancelled.status(), await cancelled.text()).toBe(200);

  const needs = page.getByRole('region', { name: 'Needs your OK' });
  const proposal = needs.getByRole('article', { name: 'Waitlist offer' });
  await expect(async () => {
    await page.goto('/');
    await expect(proposal).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 120_000, intervals: [2_000, 5_000] });
  await expect(proposal).toContainText('Sara K.');
  await expect(proposal).toContainText('Ana R.');
  await (await hydrated(proposal.getByRole('button', { name: 'Approve' }))).click();
  await expect(proposal.getByRole('status')).toHaveText('Done.');

  // Each gets their own link once the Undo grace has passed.
  if (sara.email === null || ana.email === null) throw new Error('clients without email');
  const [saraLink, anaLink] = await Promise.all([claimLink(sara.email), claimLink(ana.email)]);

  // Sara claims first and is booked.
  const saraPage = await anotherPerson(browser, baseURL);
  await saraPage.goto(saraLink);
  await expect(saraPage.getByRole('heading', { name: 'A time opened up' })).toBeVisible();
  await expect(saraPage.getByText('Jess', { exact: true })).toBeVisible();
  await (await hydrated(saraPage.getByRole('button', { name: 'Claim this time' }))).click();
  await expect(saraPage.getByRole('heading', { name: 'You’re booked' })).toBeVisible();
  await expect(saraPage.getByRole('link', { name: 'Reschedule or cancel' })).toBeVisible();

  // Ana's link now says it's taken, and she is emailed so; she stays on the waitlist.
  const anaPage = await anotherPerson(browser, baseURL);
  await anaPage.goto(anaLink);
  await expect(anaPage.getByText('Sorry, someone else claimed this time first.')).toBeVisible();
  await expect(anaPage.getByRole('button', { name: 'Claim this time' })).toHaveCount(0);
  await expect
    .poll(async () => (await emailsTo(ana.email ?? '')).map((m) => m.Subject), {
      timeout: 60_000,
    })
    .toContain('That time at ' + (await businessName(page)) + ' has been taken');

  // The owner's waitlist screen shows who got it.
  await page.goto('/waitlist');
  const offers = page.getByRole('region', { name: 'Offers' });
  await expect(offers).toContainText(/1\. Sara Kim\s*Booked/);
  await expect(offers).toContainText(/2\. Ana Ruiz\s*Someone else took it/);
  // Ana is waiting again.
  await expect(page.getByRole('region', { name: 'Waiting (1)' })).toContainText('Ana Ruiz');

  // Activity's receipt says who filled it (S54, AC-W5-5).
  await page.goto('/activity');
  await expect(page.getByTestId('activity-row').first()).toContainText(/Filled .+ with Sara K\./);
});

async function businessName(page: Page): Promise<string> {
  const response = await page.request.get('/v1/tenant');
  return ((await response.json()) as { business: { name: string } }).business.name;
}
