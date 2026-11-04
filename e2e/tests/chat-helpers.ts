import { AxeBuilder } from '@axe-core/playwright';
import {
  addDays,
  BookingSchema,
  ClientSchema,
  CurrentBusinessResponseSchema,
  formatDate,
  fromZoned,
  ServiceSchema,
  StaffMemberSchema,
  toZoned,
} from '@pepper/contracts';
import { expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { callApi, hydrated, unique } from './helpers.js';

// The chat journeys' shared setup (chat.spec.ts, memory.spec.ts): a small salon, sending a
// message, the transcript and its cards, and axe.

// A turn may take up to its 20 s limit (ADR-0030): assertions on what it shows wait that long,
// so a slow CI runner is never a failure (CLAUDE.md: generous limits, no retries).
export const expect = baseExpect.configure({ timeout: 20_000 });

export const EVERY_DAY = {
  intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
};

export interface Salon {
  /** A week ahead on the business's clock, `YYYY-MM-DD`. */
  day: string;
  at: (time: string) => string;
  serviceId: string;
  jessId: string;
  marcoId: string;
  mariaId: string;
  /** Maria's address, which a card that emails her names (S53). */
  mariaEmail: string;
  samId: string;
}

/** A haircut Jess and Marco offer every day, and two clients: Maria and Sam. */
export async function salon(page: Page, jessLogin: string | null = null): Promise<Salon> {
  const { business } = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const service = await callApi(
    page,
    'POST',
    '/v1/services',
    { name: 'Haircut', durationMinutes: 60 },
    ServiceSchema,
  );
  const staff = async (displayName: string, userId: string | null) => {
    const member = await callApi(
      page,
      'POST',
      '/v1/staff',
      { displayName, serviceIds: [service.id], ...(userId !== null && { userId }) },
      StaffMemberSchema,
    );
    await callApi(page, 'PUT', `/v1/staff/${member.id}/hours`, EVERY_DAY, {
      parse: (body: unknown) => body,
    });
    return member.id;
  };
  const jessId = await staff('Jess', jessLogin);
  const marcoId = await staff('Marco', null);
  const maria = await callApi(
    page,
    'POST',
    '/v1/clients',
    { name: 'Maria Lopez', email: `${unique('maria')}@example.test` },
    ClientSchema,
  );
  const sam = await callApi(page, 'POST', '/v1/clients', { name: 'Sam Ortiz' }, ClientSchema);
  const civil = addDays(toZoned(business.timeZone, Date.now()), 7);
  return {
    day: formatDate(civil),
    at: (time) => {
      const [hours = 0, minutes = 0] = time.split(':').map(Number);
      return new Date(fromZoned(business.timeZone, civil, hours * 60 + minutes)).toISOString();
    },
    serviceId: service.id,
    jessId,
    marcoId,
    mariaId: maria.id,
    mariaEmail: maria.email ?? '',
    samId: sam.id,
  };
}

export async function book(page: Page, s: Salon, clientId: string, staffId: string, time: string) {
  return callApi(
    page,
    'POST',
    '/v1/bookings',
    { clientId, serviceId: s.serviceId, staffMemberId: staffId, startsAt: s.at(time) },
    BookingSchema,
  );
}

/** Opens the chat and sends `message` once the composer is live. */
export async function ask(page: Page, message: string): Promise<void> {
  if (!page.url().endsWith('/chat')) await page.goto('/chat');
  const input = page.getByLabel('Message Pepper');
  await hydrated(input);
  await expect(input).toBeEnabled();
  await input.fill(message);
  await page.getByRole('button', { name: 'Send' }).click();
}

export function log(page: Page): Locator {
  return page.getByRole('log', { name: 'Conversation with Pepper' });
}

/** The last change card with this eyebrow (e.g. "New booking"). */
export function changeCard(page: Page, name: string): Locator {
  return log(page).getByRole('article', { name }).last();
}

export async function expectAccessible(page: Page, screen: string): Promise<void> {
  // Contrast is checked on the settled screen: a control fading back from disabled (a turn
  // just ended) reads as low contrast mid-transition (S45, CI). Endless ones (a spinner) aside.
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.playState !== 'running' ||
            animation.effect?.getTiming().iterations === Infinity,
        ),
    undefined,
    { timeout: 10_000 },
  );
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  expect(
    blocking.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target.join(' ')) })),
    screen,
  ).toEqual([]);
}
