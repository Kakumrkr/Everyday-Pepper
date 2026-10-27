import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { hydrated, onboardOwner, ownClientAddress } from './helpers.js';

// Notifications on this device (S21, ADR-0026) through the real stack. A test browser cannot
// reach a real push service (and the headless shell cannot grant notifications), so the
// permission and the browser's subscription are stand-ins (the endpoint and
// keys a browser would give, kept across reloads like a real one); everything from the app to
// the api and Postgres is real. Sending pushes is proven in apps/worker and packages/core.

/** Gives the context notification permission and a stand-in push subscription (and permission). */
async function fakePush(context: BrowserContext): Promise<void> {
  await context.grantPermissions(['notifications']);
  await context.addInitScript(() => {
    const KEY = 'pepper-e2e-push';
    const make = (endpoint: string) => ({
      endpoint,
      toJSON: () => ({
        endpoint,
        expirationTime: null,
        keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
      }),
      unsubscribe: () => Promise.resolve(true),
    });
    // The headless shell reports notifications as denied whatever is granted: stand in for
    // the permission a person gives, as for the subscription.
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    Notification.requestPermission = () => Promise.resolve('granted');
    const stored = () => localStorage.getItem(KEY);
    PushManager.prototype.getSubscription = function () {
      const endpoint = stored();
      return Promise.resolve(endpoint === null ? null : make(endpoint)) as never;
    };
    PushManager.prototype.subscribe = function () {
      const endpoint = stored() ?? `https://fcm.googleapis.com/fcm/send/e2e-${crypto.randomUUID()}`;
      localStorage.setItem(KEY, endpoint);
      return Promise.resolve(make(endpoint)) as never;
    };
  });
}

function card(page: Page) {
  return page.getByRole('region', { name: 'Notifications on this device' });
}

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

test('an owner turns notifications on for this device, keeps them across reloads, and turns them off', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await fakePush(context);
  await onboardOwner(page);
  await page.goto('/more');

  const state = card(page).getByTestId('push-state');
  await expect(state).toHaveAttribute('data-state', 'off');
  await (await hydrated(card(page).getByRole('button', { name: 'Turn on notifications' }))).click();
  await expect(state).toHaveAttribute('data-state', 'on');
  await expect(state).toHaveText('This device gets notifications from this business.');

  // The api has the device for this business: still on after a reload.
  await page.reload();
  await expect(card(page).getByTestId('push-state')).toHaveAttribute('data-state', 'on');

  await card(page).getByRole('button', { name: 'Turn off' }).click();
  await expect(card(page).getByTestId('push-state')).toHaveAttribute('data-state', 'off');
  await page.reload();
  await expect(card(page).getByTestId('push-state')).toHaveAttribute('data-state', 'off');
});

test('a browser where notifications are blocked says how to allow them', async ({
  page,
  context,
}) => {
  await onboardOwner(page);
  await context.clearPermissions();
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'denied' });
  });
  await page.goto('/more');
  await expect(card(page).getByTestId('push-state')).toHaveAttribute('data-state', 'blocked');
  await expect(card(page).getByRole('button')).toHaveCount(0);
});

test('the api refuses a device off the push services, or saved from another site', async ({
  page,
}) => {
  await onboardOwner(page);
  const origin = new URL(page.url()).origin;
  const keys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
  const save = (body: object, from = origin) =>
    page.request.put('/v1/push/subscription', { data: body, headers: { origin: from } });
  expect((await save({ endpoint: 'http://push.example.test/x', keys })).status()).toBe(400);
  // A member cannot make the worker call anything but a push service.
  expect((await save({ endpoint: 'https://internal.example.test/admin', keys })).status()).toBe(
    400,
  );
  expect(
    (
      await save({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys }, 'https://evil.test')
    ).status(),
  ).toBe(403);
});
