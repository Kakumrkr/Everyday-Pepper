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
import { anotherPerson, callApi, hydrated, onboardOwner, ownClientAddress } from './helpers.js';

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
    ['offline page', '/offline.html'],
    ['broken booking link', `/book/${s.slug}/manage#not-a-token`],
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
});
