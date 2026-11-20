import { ClientSchema, TimeOffSchema, WaitlistEntrySchema } from '@pepper/contracts';
import { test, type Page } from '@playwright/test';
import { book, expect, salon } from './chat-helpers.js';
import { callApi, onboardOwner, ownClientAddress, unique } from './helpers.js';
import { checkNumberAndTextCards, daytimeZone, newPhone, textIn, textTo } from './sms-helpers.js';

// Approve by text, end to end (S63.2, AC-X-90/91, ADR-0066): the owner checks their number
// and turns on "Text me cards" on Texts and reminders; a cancelled time is offered to the
// waitlist and the card is texted to them; "Y" and the code approves exactly that card, it
// leaves Home, and Activity says it was approved by text; "N" and the code skips it instead
// (S64, AC-X-93). Texts go through the sandbox.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

async function client(page: Page, name: string) {
  const email = `${unique(name.split(' ')[0]?.toLowerCase() ?? 'client')}@example.test`;
  return callApi(page, 'POST', '/v1/clients', { name, email }, ClientSchema);
}

/**
 * A business where it is daytime now (so the card's text isn't held for the morning), an owner
 * texting cards to `phone`, and a waitlist offer waiting for their OK, texted to them. Returns
 * the text's code.
 */
async function textedWaitlistCard(page: Page, phone: string): Promise<string> {
  await onboardOwner(page, { timeZone: daytimeZone() });
  await checkNumberAndTextCards(page, phone);

  // As in waitlist.spec.ts: Maria's time with Jess is full (Marco is off), Sara and Ana wait
  // for it, and Maria cancels.
  const s = await salon(page);
  const booking = await book(page, s, s.mariaId, s.jessId, '15:00');
  await callApi(
    page,
    'POST',
    `/v1/staff/${s.marcoId}/time-off`,
    { startsAt: booking.startsAt, endsAt: booking.endsAt },
    TimeOffSchema,
  );
  for (const name of ['Sara Kim', 'Ana Ruiz']) {
    const waiting = await client(page, name);
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
  const cancelled = await page.request.fetch(`/v1/bookings/${booking.id}`, {
    method: 'PATCH',
    data: { status: 'cancelled', notifyClient: false },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(cancelled.status(), await cancelled.text()).toBe(200);

  // The worker offers the time; the card waits on Home and is texted, first names only.
  const text = await textTo(page, phone, /Reply Y \d{4}/, 180_000);
  expect(text).toMatch(
    /^Pepper: .*3pm opened with Jess\. Offer it to (Sara and Ana|Ana and Sara)\?/,
  );
  expect(text).not.toMatch(/Kim|Ruiz|@/);
  expect(text).toMatch(/ Reply Y \d{4} to OK or N \d{4} to skip, by /);
  return /Reply Y (\d{4})/.exec(text)?.[1] ?? '';
}

test('the owner approves a waitlist offer by replying to its text', async ({ page }) => {
  test.setTimeout(360_000);
  const phone = newPhone();
  const code = await textedWaitlistCard(page, phone);
  const needs = page.getByRole('region', { name: 'Needs your OK' });
  const card = needs.getByRole('article', { name: 'Waitlist offer' });
  await page.goto('/');
  await expect(card).toBeVisible();

  // Another number with the right code approves nothing (AC-X-85).
  expect(await textIn(page, newPhone(), `Y ${code}`)).toMatch(/^Pepper/);
  await page.reload();
  await expect(card).toBeVisible();

  // The owner replies from their phone: done, once.
  expect(await textIn(page, phone, `Y ${code}`)).toBe(
    'Pepper: Done. You can undo it from Activity in Pepper.',
  );
  await page.reload();
  await expect(card).toHaveCount(0);
  expect(await textIn(page, phone, `Y ${code}`)).toMatch(/already/i);

  // Activity's receipt says how it was approved (AC-X-91).
  await page.goto('/activity');
  await expect(page.getByRole('main')).toContainText('approved by text');
});

test('the owner skips a waitlist offer by replying N and its code', async ({ page }) => {
  test.setTimeout(360_000);
  const phone = newPhone();
  const code = await textedWaitlistCard(page, phone);
  const card = page
    .getByRole('region', { name: 'Needs your OK' })
    .getByRole('article', { name: 'Waitlist offer' });
  await page.goto('/');
  await expect(card).toBeVisible();

  // A bare "No" asks for the code and leaves the card (AC-X-94).
  expect(await textIn(page, phone, 'No')).toMatch(/reply N and the code/);
  await page.reload();
  await expect(card).toBeVisible();

  // "N" and the code: skipped, the card leaves Home, and the code is spent (AC-X-93).
  expect(await textIn(page, phone, `N ${code}`)).toBe('Pepper: Skipped. Nothing was done.');
  await page.reload();
  await expect(card).toHaveCount(0);
  expect(await textIn(page, phone, `Y ${code}`)).toMatch(/already/i);
  // Nothing ran: Activity has no receipt for it.
  await page.goto('/activity');
  await expect(page.getByRole('main')).not.toContainText('approved by text');
});
