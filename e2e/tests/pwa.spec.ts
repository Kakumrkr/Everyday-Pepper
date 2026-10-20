import { expect, test } from '@playwright/test';
import { anotherPerson, onboardOwner, ownClientAddress } from './helpers.js';

// The installable app and its offline page (S18, ADR-0023).

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

test('the signed-in app is installable and opens to the offline page without a connection', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const owner = await onboardOwner(page);

  // The manifest is linked and complete enough to install.
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
  const manifest = (await (await page.request.get(href ?? '')).json()) as {
    display: string;
    start_url: string;
    icons: { src: string }[];
  };
  expect(manifest).toMatchObject({ display: 'standalone', start_url: '/' });
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src);
    expect(response.headers()['content-type']).toBe('image/png');
  }

  // The worker takes control of the app.
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state))
    .toBe('activated');
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  // No connection (every request fails, also the worker's own: Playwright's offline mode
  // does not reliably reach service workers): pages show the offline page, with nothing of
  // the business on it.
  await context.route('**/*', (route) => route.abort('internetdisconnected'));
  for (const path of ['/calendar', '/clients']) {
    const response = await page.goto(path);
    expect(response?.fromServiceWorker()).toBe(true);
    await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeVisible();
  }
  await expect(page.getByText(owner.business)).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeVisible();

  // Back online, "Try again" opens the page asked for.
  await context.unrouteAll();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
});

test('the public booking page and the sign-in page register no worker and link no manifest', async ({
  page,
  browser,
  baseURL,
}) => {
  await onboardOwner(page);
  const slug = await page.evaluate(async () => {
    const answer = (await (await fetch('/v1/tenant')).json()) as { business: { slug: string } };
    return answer.business.slug;
  });

  const visitor = await anotherPerson(browser, baseURL);
  for (const path of [`/book/${slug}`, '/sign-in']) {
    await visitor.goto(path);
    await expect(visitor.locator('link[rel="manifest"]')).toHaveCount(0);
    // Give a registration time to happen if one were going to.
    await visitor.waitForLoadState('networkidle');
    expect(
      await visitor.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
    ).toBe(0);
  }
});
