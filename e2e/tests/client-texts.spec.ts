import { ClientsPageSchema, CurrentBusinessResponseSchema } from '@pepper/contracts';
import { test } from '@playwright/test';
import { expect, salon } from './chat-helpers.js';
import {
  anotherPerson,
  emailTo,
  hydrated,
  onboardOwner,
  ownClientAddress,
  unique,
} from './helpers.js';
import { daytimeZone, newPhone, sentTexts, textIn, textTo, typed } from './sms-helpers.js';

// A client's text kept, end to end (S80, ADR-0072, AC-X-229, AC-X-232…234): Ana says yes to
// texts on the booking page and gets the confirmation text; she texts back a question; the
// owner sees it on Home's "Texts from clients" card with her visit, replies, Undo takes the
// first reply back, the second goes to her number as a text from the business, and her
// profile shows both. Texts go through the sandbox, in a business where it is daytime now.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

test('a client texts back and the owner replies from the card', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(600_000);
  await onboardOwner(page, { timeZone: daytimeZone() });
  await salon(page);
  const { business } = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );

  // Ana books on the booking page and ticks the texts box: her confirmation goes by text.
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
  await textTo(page, phone, /Reply STOP/);

  // She texts back: kept for this business, answered by no automatic text.
  expect(await textIn(page, phone, 'Can I bring my daughter along?')).toBeNull();

  await page.goto('/');
  const section = page.getByRole('region', { name: 'Texts from clients' });
  const card = section.getByTestId('client-text-card');
  await expect(card.getByTestId('client-text-quote')).toHaveText('Can I bring my daughter along?');
  await expect(card).toContainText('Ana Ruiz texted at');
  await expect(card).toContainText('Likely about their next visit');

  // The card at 375 px, light and dark (DESIGN.md D6): the walkthrough's pictures.
  if (test.info().project.name === 'mobile') {
    await page.setViewportSize({ width: 375, height: 812 });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await card.screenshot({ path: test.info().outputPath(`client-text-card-375-${scheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }

  // A first reply, taken back with Undo before it goes: the card is open again.
  await (await hydrated(card.getByRole('button', { name: 'Reply' }))).click();
  await card.getByRole('textbox', { name: 'Your reply to Ana Ruiz' }).fill('Oops, wrong client');
  await card.getByRole('button', { name: 'Send reply' }).click();
  await expect(card.getByRole('status')).toContainText('Reply to Ana Ruiz goes by text');
  await card.getByRole('button', { name: /Undo/ }).click();
  await expect(card.getByRole('button', { name: 'Reply' })).toBeVisible();

  // The real reply goes as a text from the business.
  await card.getByRole('button', { name: 'Reply' }).click();
  await card
    .getByRole('textbox', { name: 'Your reply to Ana Ruiz' })
    .fill('Of course, see you then');
  await card.getByRole('button', { name: 'Send reply' }).click();
  await expect(card.getByRole('status')).toContainText('Reply to Ana Ruiz goes by text');
  const reply = await textTo(page, phone, /Of course, see you then/);
  expect(reply).toBe(`${business.name} via Pepper: Of course, see you then`);
  expect((await sentTexts(page, phone)).some((text) => text.body.includes('Oops'))).toBe(false);

  // Her profile shows the texts, newest first, and what she said yes to.
  const clients = ClientsPageSchema.parse(
    await (await page.request.get(`/v1/clients?search=${encodeURIComponent(email)}`)).json(),
  );
  await page.goto(`/clients/${clients.clients[0]?.id ?? ''}`);
  const thread = page.getByTestId('client-text-thread');
  await expect(thread.getByRole('listitem')).toHaveCount(2);
  await expect(thread.getByRole('listitem').first()).toContainText('Of course, see you then');
  await expect(thread.getByRole('listitem').last()).toContainText('Can I bring my daughter along?');
  await page.getByRole('button', { name: 'What they agreed to' }).click();
  await expect(page.getByRole('dialog').getByTestId('client-texts-consent')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('Appointment texts');
  if (test.info().project.name === 'mobile') {
    await page.keyboard.press('Escape');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await thread.screenshot({
        path: test.info().outputPath(`client-text-thread-375-${scheme}.png`),
      });
    }
  }
});
