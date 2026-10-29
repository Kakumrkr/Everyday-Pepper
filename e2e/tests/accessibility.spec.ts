import { AxeBuilder } from '@axe-core/playwright';
import {
  AvailabilityResponseSchema,
  BookingSchema,
  ClientSchema,
  CurrentBusinessResponseSchema,
  ServiceSchema,
  StaffMemberSchema,
} from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
import {
  anotherPerson,
  callApi,
  emailTo,
  enterPassword,
  freshCode,
  hydrated,
  linkTo,
  onboardOwner,
  ownClientAddress,
  PASSWORD,
  pickBusinessType,
  signOut,
  signUp,
  unique,
} from './helpers.js';

// Accessibility of the key screens (S18; testing-strategy.md: axe in Playwright, no serious
// violations): WCAG 2.2 A and AA rules, in light and dark, on phone and desktop (the two
// projects). Serious and critical violations fail; lesser ones are listed in the report.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Runs axe on the page as it is now, in both color schemes. */
async function expectAccessible(page: Page, screen: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    // Buttons fade between colors (`transition-colors`); measure once the new scheme has settled.
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished)),
    );
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    const blocking = violations.filter(
      ({ impact }) => impact === 'serious' || impact === 'critical',
    );
    for (const { id, impact, nodes } of violations) {
      if (!blocking.some((violation) => violation.id === id)) {
        test.info().annotations.push({
          type: 'axe',
          description: `${screen} (${colorScheme}): ${String(impact)} ${id} ×${String(nodes.length)}`,
        });
      }
    }
    expect(
      blocking.map(({ id, impact, help, nodes }) => ({
        id,
        impact,
        help,
        targets: nodes.map((node) => node.target.join(' ')),
      })),
      `${screen} (${colorScheme})`,
    ).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: null });
}

const EVERY_DAY = {
  intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
};

/** A haircut Jess offers every day, a client and a booking; what the screens then show. */
async function salon(page: Page) {
  const { business } = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const service = await callApi(
    page,
    'POST',
    '/v1/services',
    { name: 'Haircut', durationMinutes: 60, priceFromCents: 6500 },
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
  const client = await callApi(
    page,
    'POST',
    '/v1/clients',
    { name: 'Maria Lopez', email: 'maria@example.test', phone: '+15555550123' },
    ClientSchema,
  );
  const from = new Date(Date.now() + 86_400_000);
  const range = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(
    new Date(from.getTime() + 7 * 86_400_000).toISOString(),
  )}`;
  const { slots } = AvailabilityResponseSchema.parse(
    await (await page.request.get(`/v1/availability?serviceId=${service.id}&${range}`)).json(),
  );
  const [slot] = slots;
  if (slot === undefined) throw new Error('No free time to book');
  await callApi(
    page,
    'POST',
    '/v1/bookings',
    {
      clientId: client.id,
      serviceId: service.id,
      staffMemberId: slot.staffMemberId,
      startsAt: slot.startsAt,
    },
    BookingSchema,
  );
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: business.timeZone }).format(
    new Date(slot.startsAt),
  );
  return { slug: business.slug, day, clientId: client.id, staffId: jess.id };
}

test('the signed-in screens have no serious accessibility violations', async ({ page }) => {
  test.setTimeout(150_000);
  await onboardOwner(page);
  const s = await salon(page);

  await page.goto('/');
  await expectAccessible(page, 'home');

  await page.goto(`/calendar?date=${s.day}`);
  await expect(page.getByTestId('booking-block')).toHaveCount(1);
  await expectAccessible(page, 'calendar');

  // The booking sheet and the new-booking sheet (Radix dialogs).
  await (await hydrated(page.getByTestId('booking-block'))).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectAccessible(page, 'booking sheet');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: 'New booking' }).click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'New booking' }),
  ).toBeVisible();
  await expectAccessible(page, 'new booking');
  await page.keyboard.press('Escape');

  for (const [screen, path] of [
    ['clients', '/clients'],
    ['client profile', `/clients/${s.clientId}`],
    ['services', '/services'],
    ['booking rules', '/services/rules'],
    ['team', '/team'],
    ['staff page', `/team/${s.staffId}`],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expectAccessible(page, screen);
  }
});

// S43.2 (AC-X-12): every account screen a new owner meets, on the kit.
test('the account screens have no serious accessibility violations', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/invite');
  await expect(page.getByRole('alert').filter({ hasText: 'incomplete' })).toBeVisible();
  await expectAccessible(page, 'invite: incomplete link');
  await page.goto('about:blank');
  await page.goto('/invite#q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C');
  await expect(page.getByRole('heading', { name: /invited to join/ })).toBeVisible();
  await expectAccessible(page, 'invite: signed out');

  // S44: "Check your inbox", then the link signs in.
  const email = `${unique('owner')}@example.test`;
  await signUp(page, email, { confirm: false });
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible({
    timeout: 20_000,
  });
  await expectAccessible(page, 'check your inbox');
  await page.goto(await linkTo(email, 'Confirm your email for Pepper'));
  await expect(page).toHaveURL(/\/onboarding\/business$/, { timeout: 20_000 });
  await hydrated(page.getByRole('button', { name: 'Create business' }));
  await expectAccessible(page, 'create business');
  await pickBusinessType(page, 'Barbershop');
  await page.getByLabel('Business name').fill('Axe Studio');
  await page.getByLabel('Booking link').fill(unique('axe'));
  await page.getByRole('button', { name: 'Create business' }).click();

  await expect(page).toHaveURL(/\/security\/two-factor$/, { timeout: 30_000 });
  await hydrated(page.getByRole('button', { name: 'Continue' }));
  await expectAccessible(page, 'two-step setup: password');
  await page.getByLabel('Confirm your password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  await expectAccessible(page, 'two-step setup: codes');

  const key = ((await page.getByTestId('totp-secret').textContent()) ?? '').replace(/\s/g, '');
  const used = new Set<string>();
  await page.getByLabel('Enter the 6-digit code').fill(await freshCode(key, used));
  await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
  await expect(page).toHaveURL(/\/$/);
  // S44: change email, its form with an error, then "Confirm it’s you".
  await page.goto('/account/email');
  const save = await hydrated(page.getByRole('button', { name: /Send/ }));
  await save.click();
  await expectAccessible(page, 'change email: error');
  await signOut(page);
  await enterPassword(page, email);
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  await expectAccessible(page, 'sign in: code');
  await page.getByRole('button', { name: 'Use a backup code instead' }).click();
  await expect(page.getByLabel('Backup code')).toBeVisible();
  await expectAccessible(page, 'sign in: backup code');
});

test('the signed-out and public screens have no serious accessibility violations', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  const s = await salon(page);

  const visitor = await anotherPerson(browser, baseURL);
  for (const [screen, path] of [
    ['sign in', '/sign-in'],
    ['sign up', '/sign-up'],
    ['forgot password', '/forgot-password'],
    ['new password', '/reset-password?token=not-a-real-token'],
    ['reset link run out', '/reset-password?error=INVALID_TOKEN'],
    ['offline page', '/offline.html'],
    ['broken booking link', `/book/${s.slug}/manage#not-a-token`],
    ['broken offer link', `/book/${s.slug}/offer`],
    ['unsubscribe link', '/unsubscribe/not-a-real-token'],
  ] as const) {
    await visitor.goto(path);
    await expect(visitor.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expectAccessible(visitor, screen);
  }

  // The public booking page, step by step up to the code.
  await visitor.goto(`/book/${s.slug}`);
  await expect(visitor.getByRole('heading', { name: 'Book a visit' })).toBeVisible();
  await expectAccessible(visitor, 'booking page: services');
  await (await hydrated(visitor.getByRole('button', { name: /Haircut/ }))).click();
  await expectAccessible(visitor, 'booking page: staff');
  await visitor.getByRole('button', { name: /Anyone available/ }).click();
  await visitor.getByRole('group', { name: 'Day' }).getByRole('button').nth(1).click();
  await expect(visitor.getByTestId('free-times').getByRole('button').first()).toBeVisible();
  await expectAccessible(visitor, 'booking page: times');
  await visitor.getByTestId('free-times').getByRole('button').first().click();
  await expect(visitor.getByRole('heading', { name: 'Your details' })).toBeVisible();
  await expectAccessible(visitor, 'booking page: details');

  // S43: the code, the booked page and the booking behind its link (AC-X-11).
  const email = `${unique('ana')}@example.test`;
  await visitor.getByLabel('Full name').fill('Ana Ruiz');
  await visitor.getByLabel('Email').fill(email);
  await visitor.getByRole('button', { name: 'Send my code' }).click();
  await expect(visitor.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expectAccessible(visitor, 'booking page: code');
  const code = /^ {4}(\d{6})$/m.exec(await emailTo(email, 'is your code'))?.[1] ?? '';
  await visitor.getByLabel('Code').fill(code);
  await visitor.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(visitor.getByRole('heading', { name: /You’re booked/ })).toBeVisible();
  await expectAccessible(visitor, 'booking page: booked');
  await visitor.getByRole('link', { name: 'Reschedule or cancel' }).click();
  await expect(visitor.getByTestId('booking-status')).toHaveText('Booked');
  await expectAccessible(visitor, 'manage booking');
  await (await hydrated(visitor.getByRole('button', { name: 'Cancel booking' }))).click();
  await expectAccessible(visitor, 'manage booking: cancel');
});
