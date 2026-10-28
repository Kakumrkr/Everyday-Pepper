import {
  CreateInviteResponseSchema,
  MembersResponseSchema,
  MemoryFactSchema,
  type MemoryFactInput,
} from '@pepper/contracts';
import { test, type Page } from '@playwright/test';
import { ask, book, changeCard, expect, expectAccessible, log, salon } from './chat-helpers.js';
import {
  anotherPerson,
  callApi,
  hydrated,
  onboardOwner,
  ownClientAddress,
  signUp,
  unique,
} from './helpers.js';

// What Pepper remembers, on the screens (S32, ADR-0038), through the real stack with only the
// model scripted: a fact told in the chat shows on "What I know" and the client's profile,
// tagged sensitive (AC-W3-1); an answer that used it carries the "Remembered" chip, and
// forgetting it there means the same chat no longer knows it (AC-W7-2); a visit note from the
// booking sheet; what a staff member sees; and the pause switch.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

async function remember(page: Page, input: MemoryFactInput): Promise<void> {
  await callApi(page, 'POST', '/v1/memory/facts', input, MemoryFactSchema);
}

test('a fact told in the chat: on "What I know" and the profile (AC-W3-1), then forgotten from the chip (AC-W7-2)', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await onboardOwner(page);
  const s = await salon(page);

  await ask(page, "Remember Maria's allergy is PPD");
  await expect(changeCard(page, 'Client note').getByText('Done', { exact: true })).toBeVisible();

  // "What I know": about Maria, sensitive, said in the chat.
  await page.goto('/memory');
  const clients = page.getByRole('region', { name: 'About clients' });
  const fact = clients.getByRole('listitem').filter({ hasText: 'Allergy: PPD' });
  await expect(fact.getByText('Maria Lopez', { exact: true })).toBeVisible();
  await expect(fact.getByText('Sensitive', { exact: true })).toBeVisible();
  await expect(fact.getByText(/^You told me in chat · /)).toBeVisible();
  await (await hydrated(page.getByRole('button', { name: /^Sensitive · 1$/ }))).click();
  await expect(page.getByRole('button', { name: /^Sensitive · 1$/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(fact).toBeVisible();
  await expectAccessible(page, 'what I know');

  // Maria's profile.
  await page.goto(`/clients/${s.mariaId}`);
  const knows = page.getByRole('region', { name: 'What Pepper knows' });
  const known = knows.getByRole('listitem').filter({ hasText: 'Allergy: PPD' });
  await expect(known.getByText('Sensitive', { exact: true })).toBeVisible();
  await expectAccessible(page, 'client profile with memory');

  // An answer that used it carries the chip; forget it there.
  await ask(page, 'What do you know about Maria?');
  await expect(log(page).getByText('About Maria: allergy: PPD.')).toBeVisible();
  const chip = log(page).getByRole('button', { name: 'Remembered' }).last();
  await (await hydrated(chip)).click();
  const used = log(page).getByRole('region', { name: 'What I remembered for this answer' }).last();
  await expect(used.getByText('PPD', { exact: false })).toBeVisible();
  await expectAccessible(page, 'chat with the Remembered chip open');
  await used.getByRole('button', { name: 'Forget Allergy' }).click();
  await expect(used.getByText('can’t be undone', { exact: false })).toBeVisible();
  await used.getByRole('button', { name: 'Forget', exact: true }).click();
  await expect(used.getByText('Forgotten. I won’t use it again.')).toBeVisible();

  // The same chat asks again: it no longer knows.
  await ask(page, 'What do you know about Maria?');
  await expect(log(page).getByText("I don't know anything about Maria yet.")).toBeVisible();
  await page.goto('/memory');
  await expect(page.getByText('Allergy: PPD')).toHaveCount(0);
  await expect(page.getByText('I don’t remember anything yet.', { exact: false })).toBeVisible();
  // The empty memory offers its next step: the chat, where Pepper learns (AC-X-7).
  await page.getByRole('link', { name: 'Tell Pepper in chat' }).click();
  await expect(page).toHaveURL(/\/chat$/);
});

test('a visit note from the booking sheet, edited on the profile; deleted from "What I know"', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  const s = await salon(page);
  await book(page, s, s.mariaId, s.jessId, '10:00');

  await page.goto(`/calendar?date=${s.day}`);
  await (
    await hydrated(page.getByRole('region', { name: 'Jess' }).getByTestId('booking-block'))
  ).click();
  const sheet = page.getByRole('dialog', { name: 'Maria Lopez' });
  const notes = sheet.getByRole('region', { name: 'Visit notes' });
  await expect(notes.getByText('No notes for this visit yet.')).toBeVisible();
  await notes.getByRole('button', { name: 'Add a visit note' }).click();
  await notes.getByLabel('About', { exact: true }).fill('Formula');
  await notes.getByLabel('Note', { exact: true }).fill('6N + 20 vol');
  await notes.getByRole('button', { name: 'Save' }).click();
  await expect(notes.getByText('6N + 20 vol', { exact: false })).toBeVisible();
  await expectAccessible(page, 'booking sheet with a visit note');
  await page.keyboard.press('Escape');

  await page.goto(`/clients/${s.mariaId}`);
  const visitNotes = page.getByRole('region', { name: 'Visit notes' });
  await expect(visitNotes.getByText('Haircut', { exact: false })).toBeVisible();
  await (await hydrated(visitNotes.getByRole('button', { name: /^Edit Formula/ }))).click();
  await visitNotes.getByLabel(/^Formula/).fill('7N + 20 vol');
  await visitNotes.getByRole('button', { name: 'Save' }).click();
  await expect(visitNotes.getByText('7N + 20 vol', { exact: false })).toBeVisible();

  await page.goto('/memory');
  const note = page.getByRole('listitem').filter({ hasText: 'Formula: 7N + 20 vol' });
  await expect(note.getByText(/Maria Lopez · visit /)).toBeVisible();
  await (await hydrated(note.getByRole('button', { name: /^Delete Formula/ }))).click();
  await note.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Formula: 7N + 20 vol')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Formula: 7N + 20 vol')).toHaveCount(0);
});

test('staff see their clients and the business’s non-sensitive facts; owners pause learning', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const owner = await onboardOwner(page);
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
  const { members } = MembersResponseSchema.parse(
    await (await page.request.get('/v1/members')).json(),
  );
  const priyaId = members.find((member) => member.email === priyaEmail)?.userId ?? null;
  expect(priyaId).not.toBeNull();

  // Jess's calendar is Priya's; Maria is her client, Sam is not.
  const s = await salon(page, priyaId);
  await book(page, s, s.mariaId, s.jessId, '11:00');
  await remember(page, {
    subject: { type: 'client', id: s.mariaId },
    key: 'allergy',
    value: 'PPD',
  });
  await remember(page, {
    subject: { type: 'client', id: s.samId },
    key: 'drink',
    value: 'Oat latte',
  });
  await remember(page, { subject: { type: 'business' }, key: 'parking', value: 'Behind the shop' });
  await remember(page, {
    subject: { type: 'business' },
    key: 'personal',
    value: 'The owner moves in spring',
  });

  await priya.goto('/memory');
  await expect(priya.getByText('Allergy: PPD')).toBeVisible();
  await expect(priya.getByText('Parking: Behind the shop')).toBeVisible();
  await expect(priya.getByText('Oat latte', { exact: false })).toHaveCount(0);
  await expect(priya.getByText('moves in spring', { exact: false })).toHaveCount(0);
  // She may change her client's facts, not the business's; she can't pause.
  await expect(priya.getByRole('button', { name: /^Edit Allergy/ })).toBeVisible();
  await expect(priya.getByRole('button', { name: /^Edit Parking/ })).toHaveCount(0);
  await expect(priya.getByRole('switch')).toHaveCount(0);
  await expect(
    priya.getByText('Owners and managers can change this.', { exact: false }),
  ).toBeVisible();
  await expectAccessible(priya, 'what I know as staff');

  // The owner pauses learning: the chat saves nothing new, screens still can.
  await page.goto('/memory');
  const learning = await hydrated(page.getByRole('switch', { name: 'Learn new things' }));
  await expect(learning).toBeChecked();
  await learning.click();
  await expect(learning).not.toBeChecked();
  await expect(
    page.getByText('I’m not saving anything new from chat.', { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Learn new things' })).not.toBeChecked();
  await ask(page, "Remember Sam's usual service is Haircut");
  await expect(log(page).getByText('I couldn’t do that. Nothing changed.')).toBeVisible();
  await page.goto('/memory');
  await expect(page.getByText('Usual service: Haircut')).toHaveCount(0);
  await expect(page.getByText('Drink: Oat latte')).toBeVisible();
});
