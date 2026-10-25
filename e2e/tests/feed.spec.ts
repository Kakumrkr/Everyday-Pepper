import { CurrentBusinessResponseSchema, ServiceSchema, StaffMemberSchema } from '@pepper/contracts';
import { expect, test } from '@playwright/test';
import { callApi, hydrated, onboardOwner, ownClientAddress } from './helpers.js';

// Home as the operator feed through the real stack (S35, ADR-0039): the worker's insights job
// finds Jess's open time and Home shows it under Suggestions; Dismiss snoozes it (it does not
// come back), and "Pause suggestions" hides the rest; S36 adds the mailing address rebooking
// emails carry and the public unsubscribe page. The stack runs the job every 10 s
// (`INSIGHTS_POLL_MS` in CI).

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const EVERY_DAY = {
  intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
};

test('Home shows a gap suggestion; Dismiss snoozes it and Pause hides the rest', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await onboardOwner(page);
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
  await callApi(page, 'PUT', `/v1/staff/${jess.id}/hours`, EVERY_DAY, {
    parse: (body: unknown) => body,
  });

  // New hours ask for a run; the worker's next pass writes Jess's open days.
  const suggestions = page.getByRole('region', { name: 'Suggestions' });
  const gaps = suggestions.getByRole('article', { name: /^Jess has .* open on / });
  await expect(async () => {
    await page.goto('/');
    await expect(gaps.first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000, intervals: [2_000, 5_000] });
  await expect(page.getByRole('region', { name: 'Needs your OK' })).toContainText(
    'Nothing waiting.',
  );

  // Dismiss the first: it goes at once, with the snooze notice, and does not come back.
  const first = gaps.first();
  const title = await first.getAttribute('aria-label');
  if (title === null) throw new Error('A suggestion without a name');
  const before = await gaps.count();
  await (await hydrated(first.getByRole('button', { name: 'Dismiss' }))).click();
  await expect(suggestions.getByRole('status')).toHaveText(
    "Snoozed for 30 days. I won't suggest open gaps for this again until then.",
  );
  await expect(gaps).toHaveCount(before - 1);
  await page.reload();
  await expect(suggestions.getByRole('article', { name: title })).toHaveCount(0);

  // Pause: nothing new, and what was there is hidden; on again, the switch says so.
  const pause = suggestions.getByRole('switch', { name: 'Pause suggestions' });
  await (await hydrated(pause)).click();
  await expect(pause).toHaveAttribute('aria-checked', 'true');
  await expect(suggestions).toContainText('Suggestions are paused.');
  await expect(gaps).toHaveCount(0);
  await pause.click();
  await expect(pause).toHaveAttribute('aria-checked', 'false');
});

test('the owner gives rebooking emails their mailing address, and changes it (S36)', async ({
  page,
}) => {
  await onboardOwner(page);
  const suggestions = page.getByRole('region', { name: 'Suggestions' });
  const form = suggestions.getByRole('form', { name: 'Mailing address for rebooking emails' });
  await expect(form).toBeVisible();
  const field = form.getByLabel('Your business’s mailing address');
  await (await hydrated(field)).fill('12 Juniper Lane\nPortland, OR 97201');
  await form.getByRole('button', { name: 'Save address' }).click();
  await expect(suggestions.getByTestId('mailing-address')).toContainText(
    'Rebooking emails carry your address: 12 Juniper Lane, Portland, OR 97201.',
  );
  await page.reload();
  await expect(suggestions.getByTestId('mailing-address')).toContainText('12 Juniper Lane');

  // Something that is not an address is refused, and the old one stays.
  await (await hydrated(suggestions.getByRole('button', { name: 'Change it' }))).click();
  await form.getByLabel('Your business’s mailing address').fill('owner@example.test');
  await form.getByRole('button', { name: 'Save address' }).click();
  await expect(form.getByRole('alert')).toBeVisible();
  await page.reload();
  await expect(suggestions.getByTestId('mailing-address')).toContainText('12 Juniper Lane');
});

test('an unsubscribe link that is not valid says so, without signing in (S36)', async ({
  page,
}) => {
  await page.goto(`/unsubscribe/${'A'.repeat(66)}`);
  await expect(page.getByRole('heading', { name: 'Unsubscribe' })).toBeVisible();
  await expect(page.getByText('This unsubscribe link isn’t valid.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unsubscribe' })).toHaveCount(0);
});

test('Home shows the daily briefing or when it comes, and the owner sets its hour (S38a)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  const { business } = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  // The worker briefs a new business on its first pass once its morning hour has passed today
  // (the template's 7:00): on the real clock, the card shows today's briefing then, and when it
  // comes before.
  const localHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: business.timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(new Date()),
  );
  const card = page.getByTestId('daily-briefing');
  if (localHour >= 7) {
    await expect(async () => {
      await page.goto('/');
      await expect(card.getByRole('heading', { name: /^Today: / })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 60_000, intervals: [2_000, 5_000] });
    await (await hydrated(card.getByRole('button', { name: 'Got it' }))).click();
    await expect(card.getByRole('heading', { name: 'Your daily briefing' })).toBeVisible();
    await page.reload();
    await expect(card.getByRole('heading', { name: /^Today: / })).toHaveCount(0);
  }
  await expect(card).toContainText('Every morning at 7:00 am');

  // The owner moves it to 9:00; it stays after a reload, and back to the default.
  const hour = card.getByLabel('Briefing at');
  await (await hydrated(hour)).selectOption('9');
  await expect(card).toContainText('Every morning at 9:00 am');
  await page.reload();
  await expect(card.getByLabel('Briefing at')).toHaveValue('9');
  await card.getByLabel('Briefing at').selectOption('template');
  await expect(card).toContainText('Every morning at 7:00 am');
});
