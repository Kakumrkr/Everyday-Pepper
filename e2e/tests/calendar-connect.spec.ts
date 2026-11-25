import {
  CalendarConnectionAnswerSchema,
  CalendarConnectStartSchema,
  MembersResponseSchema,
  ServiceSchema,
  StaffMemberSchema,
} from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
import { callApi, hydrated, onboardOwner } from './helpers.js';

// Google Calendar on screen (S70.2, AC-X-160…164, AC-X-166, ADR-0069), against the sandbox:
// its consent page is the app's own return page with `code=sandbox-ok`, so the whole journey
// runs in the browser without Google.

/** The owner takes bookings too, as a staff member linked to their own login. */
async function ownerTakesBookings(page: Page, displayName = 'Ana'): Promise<string> {
  const service = await callApi(
    page,
    'POST',
    '/v1/services',
    { name: 'Haircut', durationMinutes: 60 },
    ServiceSchema,
  );
  const members = MembersResponseSchema.parse(
    await (await page.request.get('/v1/members')).json(),
  ).members;
  const userId = members.find((member) => member.role === 'owner')?.userId;
  const staff = await callApi(
    page,
    'POST',
    '/v1/staff',
    { displayName, serviceIds: [service.id], userId },
    StaffMemberSchema,
  );
  return staff.id;
}

/** Connects through the api with a sandbox code the consent page never sends. */
async function connectWithCode(page: Page, code: string): Promise<void> {
  const started = await callApi(
    page,
    'POST',
    '/v1/calendar/google/connect',
    {},
    CalendarConnectStartSchema,
    200,
  );
  await callApi(
    page,
    'POST',
    '/v1/calendar/google/callback',
    { code, state: new URL(started.url).searchParams.get('state') },
    CalendarConnectionAnswerSchema,
    200,
  );
}

function status(page: Page) {
  return page.getByTestId('calendar-status');
}

test('a member connects their Google Calendar from More, sees it on Team, and disconnects', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);

  // Before a staff member is theirs, there's nothing of theirs to connect (AC-X-160).
  await page.goto('/more');
  await page.getByRole('link', { name: /Google Calendar/ }).click();
  await expect(page).toHaveURL(/\/more\/calendar$/);
  await expect(status(page)).toContainText('Not linked');
  await expect(status(page)).toContainText('The owner can link it on Team.');
  await expect(page.getByRole('button', { name: 'Connect Google Calendar' })).toHaveCount(0);

  await ownerTakesBookings(page);
  await page.reload();
  await hydrated(status(page));
  await expect(status(page)).toContainText('Not connected');
  await page.getByRole('button', { name: 'Connect Google Calendar' }).click();

  // The sandbox's "Google" sends the browser to the return page, which finishes once and
  // cleans the address (AC-X-161).
  await expect(page.getByRole('status').filter({ hasText: 'Connected.' })).toBeVisible();
  await expect(page).toHaveURL(/\/more\/calendar$/);
  await expect(status(page)).toContainText('Connected');
  await expect(status(page)).toContainText('calendar@sandbox.test · Read just now');
  await expect(page.getByRole('button', { name: 'Connect Google Calendar' })).toHaveCount(0);

  // More says it in a few words; Team says it for each staff member, never the email (AC-X-164).
  await page.goto('/more');
  await expect(page.getByRole('link', { name: /Google Calendar/ })).toContainText(
    'Connected · read just now',
  );
  await page.goto('/team');
  const line = page.getByTestId('staff-calendar');
  await expect(line).toHaveText('Google Calendar · read just now');
  await expect(page.getByTestId('staff-list')).not.toContainText('sandbox.test');

  // Disconnect asks first; keeping it changes nothing (AC-X-162).
  await page.goto('/more/calendar');
  await hydrated(status(page));
  await page.getByRole('button', { name: 'Disconnect' }).click();
  const sheet = page.getByRole('dialog', { name: 'Disconnect Google Calendar?' });
  await expect(sheet).toContainText('stop blocking bookings');
  await sheet.getByRole('button', { name: 'Keep it connected' }).click();
  await expect(sheet).toBeHidden();
  await expect(status(page)).toContainText('Connected');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await sheet.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Disconnected.' })).toBeVisible();
  await expect(status(page)).toContainText('Not connected');

  await page.goto('/team');
  await expect(line).toHaveText('No calendar connected');
});

test('a calendar that needs reconnecting shows on Home and Team until it is reconnected', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  await ownerTakesBookings(page);
  // Google refuses the refresh at the first read: the testing mode's 7 days, at once.
  await connectWithCode(page, 'sandbox-expired');

  await page.goto('/');
  const card = page.getByTestId('calendar-reconnect-card');
  await expect(card).toContainText('Reconnect your Google Calendar');
  await expect(card).toContainText('I’m keeping the busy times I have');
  await page.goto('/team');
  await expect(page.getByTestId('staff-calendar')).toHaveText('Needs reconnecting');

  await page.goto('/');
  await card.getByRole('link', { name: 'Reconnect' }).click();
  await expect(page).toHaveURL(/\/more\/calendar$/);
  await hydrated(status(page));
  await expect(status(page)).toContainText('Needs reconnecting');
  await page.getByRole('button', { name: 'Reconnect Google Calendar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected.' })).toBeVisible();
  await expect(status(page)).toContainText('Connected');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible();
  await expect(card).toHaveCount(0);
});

test('Google’s return page says what went wrong and connects nothing', async ({ page }) => {
  test.setTimeout(90_000);
  await onboardOwner(page);
  await ownerTakesBookings(page);

  // The member said no at Google.
  await page.goto('/more/calendar/google?error=access_denied&state=x');
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Nothing was connected: Google says you didn’t allow it.' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/more\/calendar$/);
  await expect(status(page)).toContainText('Not connected');

  // A code Google refused, with a real state: the link is spent, try again (AC-X-161).
  const started = await callApi(
    page,
    'POST',
    '/v1/calendar/google/connect',
    {},
    CalendarConnectStartSchema,
    200,
  );
  const state = new URL(started.url).searchParams.get('state') ?? '';
  await page.goto(`/more/calendar/google?code=refused&state=${state}`);
  await expect(
    page
      .getByRole('alert')
      .filter({
        hasText: 'That Google link was already used or ran out. Tap Connect to try again.',
      }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/more\/calendar$/);
  await expect(status(page)).toContainText('Not connected');
});
