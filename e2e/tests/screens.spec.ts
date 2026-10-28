import {
  ClientSchema,
  CurrentBusinessResponseSchema,
  ServiceSchema,
  StaffMemberSchema,
  addDays,
  formatDate,
  fromZoned,
  toZoned,
} from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
import { hydrated, onboardOwner, ownClientAddress } from './helpers.js';
import { expectTapTargets } from './tap-targets.js';

// The signed-in screens on the kit (S41, DESIGN.md D6; AC-X-3): Home, Chat and More (S41), and
// Calendar, Clients and a client's profile (S42, AC-X-8) at 375, 412 and 1280 px in light and
// dark, compared with the committed baselines (Linux, CI's headless shell; a diff fails CI
// unless the PR updates the baseline, ADR-0044). Home, Chat and More are a new owner's, so every
// list shows its empty state; Calendar and Clients have the S39 mockups' shop on a day a week
// ahead (its date, which moves, is masked). Names are the same every run; the email (unique per
// run) is masked. At 375 px each S42 screen also has its tap targets checked (AC-X-6).
//
// Update the baselines after a deliberate change, on Linux with CI's browser:
//   pnpm --filter @pepper/e2e exec playwright test screens --project=desktop --update-snapshots

const WIDTHS = [375, 412, 1280] as const;
const SCHEMES = ['light', 'dark'] as const;
const SHOT = { fullPage: true, animations: 'disabled', maxDiffPixelRatio: 0.01 } as const;

// The widths are set here, so one project is enough.
test.beforeEach(async ({ context }) => {
  test.skip(test.info().project.name !== 'desktop', 'the widths are set here: desktop only');
  await ownClientAddress(context);
});

/**
 * Home's briefing in the same state every run, without waiting on the clock (S42). The worker
 * briefs a business on its first pass once its morning hour has passed, so the test fixes the
 * hour away from now: the earliest hour (5 am) once it has passed in the business's zone, so the
 * worker briefs and the test puts the briefing away ("Got it"); before 5 am the latest (11 am),
 * at least six hours off. Then it hands the hour back to the template (7 am, still hours off
 * before 5 am), so the card always says "Every morning at 7:00 am". The hours are the template's
 * range (5–11, `MorningHourSchema`).
 */
async function settleBriefing(page: Page): Promise<void> {
  const { business } = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const [hour = 0] = new Intl.DateTimeFormat('en-US', {
    timeZone: business.timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  })
    .formatToParts(new Date())
    .filter((part) => part.type === 'hour')
    .map((part) => Number(part.value));
  const briefed = hour >= 5;
  const setHour = async (morningHour: number | null) => {
    const response = await page.request.patch('/v1/feed/settings', {
      data: { morningHour },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  await setHour(briefed ? 5 : 11);

  const card = page.getByTestId('daily-briefing');
  if (briefed) {
    // The worker's next pass (every 10 s in CI and the e2e stack).
    await expect(async () => {
      await page.goto('/');
      await expect(card.getByRole('heading', { name: /^Today: / })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 60_000, intervals: [2_000, 5_000] });
    await (await hydrated(card.getByRole('button', { name: 'Got it' }))).click();
    await expect(card.getByRole('heading', { name: 'Your daily briefing' })).toBeVisible();
  }
  await setHour(null);
  await page.goto('/');
  await expect(card.getByRole('heading', { name: 'Your daily briefing' })).toBeVisible();
  await expect(card).toContainText('Every morning at 7:00 am');
}

/** The page still, with its fonts, in `colorScheme`. */
async function still(page: Page, colorScheme: (typeof SCHEMES)[number]): Promise<void> {
  await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
  await page.evaluate(() => document.fonts.ready);
}

for (const width of WIDTHS) {
  test(`Home, Chat and More at ${String(width)} px, light and dark`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width, height: 900 });
    await onboardOwner(page, { business: 'Southside Cuts' });
    await settleBriefing(page);

    for (const scheme of SCHEMES) {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'To-dos' })).toBeVisible();
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`home-${String(width)}-${scheme}.png`, SHOT);

      await page.goto('/chat');
      await expect(page.getByRole('group', { name: 'Try asking' })).toBeVisible();
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`chat-${String(width)}-${scheme}.png`, SHOT);

      await page.goto('/more');
      await expect(page.getByRole('region', { name: 'Account' })).toBeVisible();
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`more-${String(width)}-${scheme}.png`, {
        ...SHOT,
        mask: [page.getByText(/@example\.test$/)],
      });
    }
  });
}

/** Calls the api as the signed-in browser (the app's own origin, as the api requires). */
async function post<T>(
  page: Page,
  path: string,
  body: object,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  const response = await page.request.post(path, {
    data: body,
    headers: { origin: new URL(page.url()).origin },
  });
  expect(response.status(), `${path}: ${await response.text()}`).toBe(201);
  return schema.parse(await response.json());
}

/** Southside Cuts' day a week ahead (the S39 mockups): Dre and Randy at work 9–6, four bookings. */
async function southsideDay(page: Page): Promise<{ date: string; marcus: string; audy: string }> {
  const { business } = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const day = addDays(toZoned(business.timeZone, Date.now()), 7);
  const at = (minute: number) => new Date(fromZoned(business.timeZone, day, minute)).toISOString();
  const fade = await post(
    page,
    '/v1/services',
    { name: 'Skin fade', durationMinutes: 45 },
    ServiceSchema,
  );
  const beard = await post(
    page,
    '/v1/services',
    { name: 'Beard trim', durationMinutes: 30 },
    ServiceSchema,
  );
  const services = [fade.id, beard.id];
  const dre = await post(
    page,
    '/v1/staff',
    { displayName: 'Dre', serviceIds: services },
    StaffMemberSchema,
  );
  const randy = await post(
    page,
    '/v1/staff',
    { displayName: 'Randy', serviceIds: services },
    StaffMemberSchema,
  );
  for (const member of [dre, randy]) {
    const hours = await page.request.put(`/v1/staff/${member.id}/hours`, {
      data: {
        intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          start: '09:00',
          end: '18:00',
        })),
      },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(hours.ok(), await hours.text()).toBe(true);
  }
  const marcus = await post(
    page,
    '/v1/clients',
    { name: 'Marcus Bell', email: 'marcus@example.test', phone: '+15550104411' },
    ClientSchema,
  );
  const jay = await post(
    page,
    '/v1/clients',
    { name: 'Jay Ortiz', phone: '+15550107720' },
    ClientSchema,
  );
  const audy = await post(page, '/v1/clients', { name: 'Audy Kim' }, ClientSchema);
  const bookings = [
    { client: marcus.id, service: fade.id, staff: dre.id, minute: 9 * 60 + 30 },
    { client: jay.id, service: beard.id, staff: dre.id, minute: 11 * 60 },
    { client: audy.id, service: fade.id, staff: randy.id, minute: 10 * 60 },
    { client: jay.id, service: fade.id, staff: randy.id, minute: 14 * 60 },
  ];
  for (const booking of bookings) {
    await post(
      page,
      '/v1/bookings',
      {
        clientId: booking.client,
        serviceId: booking.service,
        staffMemberId: booking.staff,
        startsAt: at(booking.minute),
      },
      { parse: (body: unknown) => body },
    );
  }
  return { date: formatDate(day), marcus: marcus.id, audy: audy.id };
}

for (const width of WIDTHS) {
  test(`Calendar, Clients and a profile at ${String(width)} px, light and dark`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    await onboardOwner(page, { business: 'Southside Cuts' });
    const { date, audy } = await southsideDay(page);

    if (width === 375) {
      // AC-X-6 at 375 px: the calendar (with its booking blocks), the list and a profile.
      for (const path of [`/calendar?date=${date}`, '/clients', `/clients/${audy}`]) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expectTapTargets(page, path);
      }
    }

    for (const scheme of SCHEMES) {
      await page.goto(`/calendar?date=${date}`);
      await expect(page.getByTestId('booking-block')).toHaveCount(4);
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`calendar-${String(width)}-${scheme}.png`, {
        ...SHOT,
        mask: [page.getByTestId('calendar-day')],
      });

      await page.goto('/clients');
      await expect(page.getByRole('list', { name: 'Clients' }).getByRole('link')).toHaveCount(3);
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`clients-${String(width)}-${scheme}.png`, SHOT);

      // A client with no contact and only a coming visit: the empty states and their actions.
      await page.goto(`/clients/${audy}`);
      await expect(page.getByRole('button', { name: 'Add a phone or email' })).toBeVisible();
      await expect(page.getByText('No visits in the last two months.')).toBeVisible();
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`client-${String(width)}-${scheme}.png`, {
        ...SHOT,
        mask: [page.getByTestId('upcoming-visits').locator('p').first()],
      });
    }
  });
}
