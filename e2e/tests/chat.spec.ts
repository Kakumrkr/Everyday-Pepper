import {
  BookingSchema,
  BookingsResponseSchema,
  ChatStatusSchema,
  ConversationsResponseSchema,
  CreateInviteResponseSchema,
} from '@pepper/contracts';
import { test } from '@playwright/test';
import { ask, book, changeCard, expect, expectAccessible, log, salon } from './chat-helpers.js';
import {
  anotherPerson,
  callApi,
  hydrated,
  onboardOwner,
  ownClientAddress,
  signUp,
  toast,
  unique,
} from './helpers.js';

// Chat with Pepper through the real stack (S26, ADR-0031): web → api → the real loop, tools and
// trust layer → Postgres, with only the model scripted (`AI_SCRIPTED_PROVIDER=e2e`, never in
// production). The journeys: a booking at a taken time → the slot picker → Approve → Why? →
// Undo; "ask" vs "do it and tell me"; a staff member refused, and their proposal approved by
// the owner showing as their receipt; a stale approval; the model down; a dropped stream
// resumed; and axe on the chat and the Autonomy page.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

test('a taken time → the slot picker → Approve exactly as shown → Why? → Undo', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await onboardOwner(page);
  const s = await salon(page);
  await book(page, s, s.samId, s.jessId, '10:00');
  expect(ChatStatusSchema.parse(await (await page.request.get('/v1/chat/status')).json())).toEqual({
    state: 'on',
  });

  await ask(page, `Book Maria for Haircut with Jess on ${s.day} at 10:00`);
  await expect(log(page).getByText('That time is taken.', { exact: false })).toBeVisible();
  const picker = log(page).getByRole('region', { name: 'Pick a time' }).last();
  const options = picker.getByRole('button');
  await expect(options.first()).toBeVisible();
  // The member picks; the chat asks Pepper again with exactly that time.
  await options.first().click();

  // Booking asks first by default: the card shows what will happen and waits.
  const card = changeCard(page, 'New booking');
  await expect(card.getByText('Needs your OK')).toBeVisible();
  await expect(card.getByText('Emails Maria L. a confirmation.')).toBeVisible();
  await expect(card.getByText('Client')).toBeVisible();
  await expectAccessible(page, 'chat with a proposal');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card.getByText('Done', { exact: true })).toBeVisible();
  await expect(card.getByText(/goes at .*, unless you undo\./)).toBeVisible();
  await expect(card.getByText(/You can undo this until/)).toBeVisible();

  // Why? from the record: the member's own words and the setting used; focus returns after.
  const why = card.getByRole('button', { name: 'Why?' });
  await why.click();
  const sheet = page.getByRole('dialog', { name: 'Why I did this' });
  await expect(sheet.getByText('Create a booking: Ask me')).toBeVisible();
  await expect(sheet.getByText(/You wrote: “Book .* instead”/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(why).toBeFocused();

  // Undo: the booking is cancelled and the held confirmation is taken back before it leaves.
  await card.getByRole('button', { name: 'Undo' }).click();
  await expect(card.getByRole('status')).toHaveText(
    'Undone, and the email was taken back before it left.',
  );
  await expect(card.getByText('Undone', { exact: true })).toBeVisible();
  const { bookings } = BookingsResponseSchema.parse(
    await (
      await page.request.get(
        `/v1/bookings?clientId=${s.mariaId}&from=${encodeURIComponent(s.at('00:00'))}&to=${encodeURIComponent(s.at('23:59'))}`,
      )
    ).json(),
  );
  expect(bookings.every((booking) => booking.status === 'cancelled')).toBe(true);
});

test('a fact said in the chat: the receipt shows it live, a new value shows the old one, Why? names it, Undo brings it back (S30)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  await salon(page);

  // Saving to memory is "do it and tell me" by default: a receipt with Undo.
  await ask(page, "Remember Maria's usual service is Haircut with Jess");
  const first = changeCard(page, 'Client note');
  await expect(first.getByText('Done', { exact: true })).toBeVisible();
  await expect(first.getByText('Haircut with Jess')).toBeVisible();
  await expect(first.getByText('Maria L.', { exact: true })).toBeVisible();

  await ask(page, "Remember Maria's usual service is Haircut with Marco");
  const second = changeCard(page, 'Client note');
  await expect(second.getByText('Haircut with Marco')).toBeVisible();
  await expect(second.getByText('(was: Haircut with Jess)', { exact: false })).toBeVisible();
  await expectAccessible(page, 'chat with a remembered fact');

  // Why? reads the fact live from memory, by id.
  await second.getByRole('button', { name: 'Why?' }).click();
  const sheet = page.getByRole('dialog', { name: 'Why I did this' });
  await expect(sheet.getByText('What I remembered')).toBeVisible();
  await expect(sheet.getByText('Usual service: Haircut with Marco')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Undo brings the old value back.
  await second.getByRole('button', { name: 'Undo' }).click();
  await expect(second.getByRole('status')).toHaveText('Undone.');
  await page.reload();
  await expect(changeCard(page, 'Client note').getByText('Haircut with Jess')).toBeVisible();
});

test('ask vs "do it and tell me": the Autonomy page changes what the chat does', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  const s = await salon(page);

  await page.goto('/autonomy');
  const row = page.getByRole('radiogroup', { name: 'Create a booking' });
  await hydrated(row.getByRole('radio', { name: 'Do it and tell me' }));
  // The bulk lock is visible and can't be chosen.
  await expect(
    page
      .getByRole('radiogroup', { name: 'One message to more than 10 clients' })
      .getByRole('radio', {
        name: 'Just do it',
      }),
  ).toBeDisabled();
  // A learned booking rule always asks (S31): only "Ask me" can be chosen.
  const rules = page.getByRole('radiogroup', {
    name: 'Turn a preference into a booking rule or hours',
  });
  await expect(rules.getByRole('radio', { name: 'Do it and tell me' })).toBeDisabled();
  await expect(rules.getByRole('radio', { name: 'Just do it' })).toBeDisabled();
  await expect(page.getByText('Always needs your OK: a new rule changes')).toBeVisible();
  await expectAccessible(page, 'autonomy');
  await row.getByText('Do it and tell me').click();
  await expect(toast(page)).toHaveText('Saved. Create a booking: Do it and tell me.');

  await ask(page, `Book Maria for Haircut with Jess on ${s.day} at 14:00`);
  const card = changeCard(page, 'New booking');
  // Done at once, with Undo, and nothing to approve.
  await expect(card.getByText('Done', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Why?' }).click();
  await expect(
    page.getByRole('dialog').getByText('Create a booking: Do it and tell me'),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // "Ask me first for everything" overrides it.
  await page.goto('/autonomy');
  await (await hydrated(page.getByRole('switch', { name: 'Ask me first for everything' }))).check();
  await expect(toast(page)).toHaveText('Saved. I’ll ask you first for everything.');
  await ask(page, `Book Sam for Haircut with Marco on ${s.day} at 15:00`);
  await expect(changeCard(page, 'New booking').getByText('Needs your OK')).toBeVisible();
});

test('staff: refused outside their role; their proposal approved by the owner is their receipt', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const owner = await onboardOwner(page);
  // Priya joins as staff and has her own calendar.
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
  await signUp(priya, priyaEmail, { name: 'Priya Shah', onPage: true });
  await (await hydrated(priya.getByRole('button', { name: `Join ${owner.business}` }))).click();
  await expect(priya.getByTestId('business-role')).toHaveText('staff');
  const s = await salon(page);

  // Priya may not block Marco's time: Pepper says so, and nothing is proposed.
  await ask(priya, `Block ${s.day} 12:00-13:00 for Marco`);
  await expect(
    log(priya).getByText('Your role doesn’t let me do that.', { exact: false }),
  ).toBeVisible();
  await expect(log(priya).getByRole('article')).toHaveCount(0);

  // With "ask me first" on, her own reminder waits; the owner approves it from Home.
  await page.goto('/autonomy');
  await (await hydrated(page.getByRole('switch', { name: 'Ask me first for everything' }))).check();
  await expect(toast(page)).toContainText('Saved.');
  await ask(priya, 'Remind me to restock the towels');
  await expect(changeCard(priya, 'To-do').getByText('Needs your OK')).toBeVisible();

  await page.goto('/');
  const needs = page.getByRole('region', { name: 'Needs your OK' });
  const proposal = needs.getByRole('article', { name: 'To-do' });
  await expect(proposal.getByText('Restock', { exact: false }).first()).toBeVisible();
  await (await hydrated(proposal.getByRole('button', { name: 'Approve' }))).click();
  await expect(proposal.getByRole('status')).toHaveText('Done.');

  // Priya sees it done for her, approved by Ana, with Undo (S23 log).
  await priya.goto('/');
  const receipt = priya.getByRole('region', { name: 'Done for you' }).getByRole('article', {
    name: 'To-do',
  });
  await expect(receipt.getByText('Approved by Ana.')).toBeVisible();
  await expect(receipt.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expectAccessible(priya, 'home with receipts');
});

test('a stale approval shows the fresh proposal and runs nothing', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  const s = await salon(page);
  const booking = await book(page, s, s.mariaId, s.jessId, '10:00');
  // Moves ask first here.
  await callApi(
    page,
    'PUT',
    '/v1/autonomy',
    { levels: { 'booking.move': 'ask' } },
    {
      parse: (body: unknown) => body,
    },
  );

  await ask(page, `Move Maria's booking on ${s.day} to 15:00`);
  const card = changeCard(page, 'Move');
  await expect(card.getByText('Needs your OK')).toBeVisible();
  // Meanwhile the booking is moved on the calendar: the card is out of date.
  const moved = await page.request.patch(`/v1/bookings/${booking.id}`, {
    data: { startsAt: s.at('11:00') },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(moved.status()).toBe(200);

  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card.getByRole('status')).toHaveText(
    'Something changed since I showed you this, so I didn’t do it. Here is the up-to-date version.',
  );
  // The fresh proposal moves it from 11:00 now; nothing ran.
  await expect(card.getByText('11:00 am', { exact: false })).toBeVisible();
  const still = BookingSchema.parse(
    await (await page.request.get(`/v1/bookings/${booking.id}`)).json(),
  );
  expect(still.startsAt).toBe(s.at('11:00'));
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card.getByText('Done', { exact: true })).toBeVisible();
});

test('the model down: a clear message with a link, and the screens keep working (AC-X-2)', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await onboardOwner(page);
  await ask(page, 'Simulate an outage');
  const notice = log(page).getByText('can’t reach my AI', { exact: false });
  await expect(notice).toBeVisible();
  await log(page).getByRole('link', { name: 'Calendar' }).click();
  await expect(page).toHaveURL(/\/calendar/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('a dropped stream resumes from the last event, showing everything once', async ({ page }) => {
  test.setTimeout(90_000);
  await onboardOwner(page);
  // The first answer is cut after two events, as a phone losing signal would; the chat then
  // resumes from the api's event log with Last-Event-ID.
  await page.route('**/v1/chat/turns', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const kept = body
      .split('\n\n')
      .filter((block) => block.startsWith('id:'))
      .slice(0, 2);
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `${kept.join('\n\n')}\n\n`,
    });
  });
  const resumed = page.waitForRequest(
    (request) => request.url().includes('/events') && request.headers()['last-event-id'] === '2',
  );
  await ask(page, 'Remind me to order foils');
  await resumed;
  await expect(changeCard(page, 'To-do').getByText('Done', { exact: true })).toBeVisible();
  // Each event once: one reply (read out as "Pepper: Added.") and one card.
  await expect(log(page).getByText('Added.')).toHaveCount(1);
  await expect(log(page).getByRole('article', { name: 'To-do' })).toHaveCount(1);
});

test('Stop ends a running turn, and leaving the chat cancels it', async ({ page }) => {
  test.setTimeout(90_000);
  await onboardOwner(page);
  await ask(page, 'Think slowly');
  await expect(page.getByRole('status').filter({ hasText: 'Pepper is thinking…' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(log(page).getByText('stopped', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

  // Leaving mid-turn cancels it: the conversation is free again well before the 8 s the
  // scripted model would think (a turn still running answers 409 turn_in_progress).
  await ask(page, 'Think slowly');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await page.getByRole('link', { name: 'Calendar' }).first().click();
  await expect(page).toHaveURL(/\/calendar/);
  const { conversations } = ConversationsResponseSchema.parse(
    await (await page.request.get('/v1/chat/conversations')).json(),
  );
  const conversationId = conversations[0]?.id ?? null;
  await expect
    .poll(
      async () =>
        (
          await page.request.post('/v1/chat/turns', {
            data: { clientTurnId: crypto.randomUUID(), conversationId, message: 'hello' },
            headers: { origin: new URL(page.url()).origin },
          })
        ).status(),
      // Every attempt counts towards the 20-turns-in-5-minutes limit (ADR-0030): at 250 ms a
      // slow runner used it up and got 429 (S31 CI); at 500 ms it takes at most 12.
      { timeout: 6_000, intervals: [500] },
    )
    .toBe(200);
});
