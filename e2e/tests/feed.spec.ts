import { ServiceSchema, StaffMemberSchema } from '@pepper/contracts';
import { expect, test } from '@playwright/test';
import { callApi, hydrated, onboardOwner, ownClientAddress } from './helpers.js';

// Home as the operator feed through the real stack (S35, ADR-0039): the worker's insights job
// finds Jess's open time and Home shows it under Suggestions; Dismiss snoozes it (it does not
// come back), and "Pause suggestions" hides the rest. The stack runs the job every 10 s
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
