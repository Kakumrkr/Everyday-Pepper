import { CreateInviteResponseSchema, TasksResponseSchema } from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
import {
  anotherPerson,
  callApi,
  hydrated,
  onboardOwner,
  ownClientAddress,
  signUp,
  unique,
} from './helpers.js';

// To-dos on Home through the real stack (S21, ADR-0026): the owner adds one with a due time
// for herself and one for a staff member, ticks hers off and undoes it; the staff member sees
// only their own.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

function todos(page: Page) {
  return page.getByRole('region', { name: 'To-dos' });
}

/**
 * Tomorrow's date in the business's zone (`onboardOwner`: New York), as the date input takes it.
 * The UTC date is a day ahead of New York's each evening, which made "tomorrow" two days away.
 */
function tomorrow(): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
    new Date(),
  );
  const next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

test('the owner adds, ticks off and undoes a to-do; a staff member sees only their own', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const owner = await onboardOwner(page);

  // A staff member joins (invite), so the owner can give her a to-do.
  const jessEmail = `${unique('jess')}@example.test`;
  const invite = await callApi(
    page,
    'POST',
    '/v1/invites',
    { email: jessEmail, role: 'staff' },
    CreateInviteResponseSchema,
  );
  const jess = await anotherPerson(browser, baseURL);
  await jess.goto(`/invite#${invite.token}`);
  await jess.getByRole('link', { name: 'Create an account' }).click();
  await signUp(jess, jessEmail, { name: 'Jess', onPage: true });
  await (await hydrated(jess.getByRole('button', { name: `Join ${owner.business}` }))).click();
  await expect(jess.getByTestId('business-role')).toHaveText('staff');

  // The owner's own to-do, due tomorrow at 10:00 AM.
  await page.goto('/');
  const card = todos(page);
  await expect(card.getByText('Nothing to do.')).toBeVisible();
  await hydrated(card.getByRole('button', { name: 'Add to-do' }));
  await card.getByLabel('New to-do').fill('Order more color');
  await card.getByLabel('Due date').fill(tomorrow());
  await card.getByLabel('Time').fill('10:00');
  await card.getByRole('button', { name: 'Add to-do' }).click();
  const mine = card
    .getByTestId('open-tasks')
    .getByRole('listitem')
    .filter({ hasText: 'Order more color' });
  await expect(mine).toContainText('Tomorrow, 10:00 AM');
  await expect(mine).toContainText('You');

  // One for Jess, picked from the team.
  await card.getByLabel('New to-do').fill('Restock towels');
  await card.getByLabel('For').selectOption({ label: 'Jess' });
  await card.getByRole('button', { name: 'Add to-do' }).click();
  await expect(
    card.getByTestId('open-tasks').getByRole('listitem').filter({ hasText: 'Restock towels' }),
  ).toContainText('Jess');

  // Done, it moves to "Recently done"; Undo brings it back.
  await card.getByRole('button', { name: 'Mark done: Order more color' }).click();
  const done = card.getByRole('region', { name: 'Recently done' });
  await expect(done.getByText('Order more color')).toBeVisible();
  await expect(card.getByTestId('open-tasks')).not.toContainText('Order more color');
  await done.getByRole('button', { name: 'Undo: Order more color' }).click();
  await expect(card.getByTestId('open-tasks')).toContainText('Order more color');

  // Jess sees her own to-do only, and adds one for herself (no picker for staff).
  await jess.goto('/');
  const jessCard = todos(jess);
  await expect(jessCard.getByTestId('open-tasks')).toContainText('Restock towels');
  await expect(jessCard).not.toContainText('Order more color');
  await expect(jessCard.getByLabel('For')).toHaveCount(0);
  await hydrated(jessCard.getByRole('button', { name: 'Add to-do' }));
  await jessCard.getByLabel('New to-do').fill('Clean station 2');
  await jessCard.getByRole('button', { name: 'Add to-do' }).click();
  await expect(jessCard.getByTestId('open-tasks')).toContainText('Clean station 2');

  // The api refuses Jess a to-do for the owner, whatever the screen offers.
  const { tasks } = TasksResponseSchema.parse(await (await page.request.get('/v1/tasks')).json());
  const ownerTask = tasks.find((task) => task.title === 'Order more color');
  if (ownerTask === undefined) throw new Error('The owner’s to-do is missing');
  const refused = await jess.request.post('/v1/tasks', {
    data: { title: 'For Ana', assigneeUserId: ownerTask.assigneeUserId },
    headers: { origin: new URL(jess.url()).origin },
  });
  expect(refused.status()).toBe(403);
  const hidden = await jess.request.patch(`/v1/tasks/${ownerTask.id}`, {
    data: { status: 'done' },
    headers: { origin: new URL(jess.url()).origin },
  });
  expect(hidden.status()).toBe(404);
});
