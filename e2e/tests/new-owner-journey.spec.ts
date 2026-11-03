import { CurrentBusinessResponseSchema } from '@pepper/contracts';
import { solidColorPhoto } from '@pepper/storage';
import { OwnerClock } from '@pepper/testing';
import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  anotherPerson,
  emailTo,
  goTo,
  hydrated,
  linkTo,
  ownClientAddress,
  pickBusinessType,
  setUpTwoFactor,
  unique,
} from './helpers.js';

// The timed new-owner journey (S47.3, AC-W1-15, AC-W8-13): a barber on a 375 px phone signs up,
// confirms the email, picks the business type, protects the account, checks what was set up,
// adds a cover and a logo and the details clients see, and copies the booking link; then a new
// client books, and books again from the same phone. Every action is charged with the owner time
// model (`@pepper/testing` owner-time.ts) as the test performs it, so the total is the same on
// any machine and grows when a screen asks for more. The wall clock is printed beside it.

/** What a real owner and client type. The test adds unique suffixes no person would type. */
const TYPED = {
  name: 'Ana Reyes',
  email: 'ana@southsidefades.com',
  business: 'Southside Fades',
  clientName: 'Rae Kim',
  clientEmail: 'rae.kim@gmail.com',
} as const;
const PHONE = '(512) 555-0142';
const ADDRESS = '12 Main St, Austin, TX 78701';
const POLICY = 'Please cancel 24 hours ahead.';

const OWNER_LIMIT_SECONDS = 10 * 60;
const CLIENT_LIMIT_SECONDS = { first: 120, remembered: 60 } as const;

// Its own client address, so its sign-up never shares Better Auth's rate limit with another
// spec's (a shared bucket answered "Too many attempts" in a full run).
test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

test.use({ viewport: { width: 375, height: 812 }, timezoneId: 'America/Chicago' });

/**
 * The words of `page`'s main area: what a person skims before acting. A closed list (the time
 * zone picker) shows only its choice, not its hundreds of options.
 */
const mainText = (page: Page) =>
  page.getByRole('main').evaluate((main: HTMLElement) => {
    let text = main.innerText;
    for (const select of main.querySelectorAll('select')) {
      text = text.replace(select.innerText, select.selectedOptions[0]?.text ?? '');
    }
    return text;
  });

test('a new barber is bookable in under 10 minutes; a client books in under 2, again in under 1 (AC-W1-15, AC-W8-13)', async ({
  page,
  browser,
  baseURL,
}) => {
  // The phone journey; the desktop project adds nothing to a time on a phone.
  test.skip(test.info().project.name !== 'mobile', 'timed on the phone only');
  test.setTimeout(240_000);
  const started = Date.now();
  const clock = new OwnerClock();
  const email = `${unique('ana')}@example.test`;
  const business = `${TYPED.business} ${unique('shop')}`;

  // 1. Sign up.
  clock.step('Sign up');
  await page.goto('/sign-up');
  await hydrated(page.getByRole('button', { name: 'Create account' }));
  clock.wait('load').read(await mainText(page));
  await page.getByLabel('Your name').fill(TYPED.name);
  clock.type(TYPED.name);
  await page.getByLabel('Email').fill(email);
  clock.type(TYPED.email);
  await page.getByLabel('Password').fill(PASSWORD);
  clock.type(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  clock.tap().wait('load');

  // 2. Confirm the email: to the mail app, wait for it, tap the link.
  clock.step('Confirm email');
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible({
    timeout: 20_000,
  });
  clock
    .read(await mainText(page))
    .wait('switchApp')
    .wait('emailWait');
  await page.goto(await linkTo(email, 'Confirm your email for Pepper'));
  clock.tap().wait('load');

  // 3. The business: its type, its name (the link follows the name), the browser's zone.
  clock.step('Business type and name');
  await expect(page).toHaveURL(/\/onboarding\/business$/, { timeout: 20_000 });
  await hydrated(page.getByRole('button', { name: 'Create business' }));
  clock.read(await mainText(page));
  await pickBusinessType(page, 'Barbershop');
  clock.tap();
  await page.getByLabel('Business name').fill(business);
  clock.type(TYPED.business);
  await expect(page.getByLabel('Time zone')).toHaveValue('America/Chicago');
  await page.getByRole('button', { name: 'Create business' }).click();
  clock.tap().wait('load');

  // 4. Two-step verification, which an owner must turn on before using the business.
  clock.step('Two-step verification');
  await expect(page).toHaveURL(/\/security\/two-factor$/, { timeout: 30_000 });
  clock.read(await mainText(page));
  await setUpTwoFactor(page);
  clock
    .type(PASSWORD) // confirm the password
    .tap() // Continue
    .wait('switchApp')
    .wait('scanQrCode')
    .wait('saveBackupCodes')
    .wait('switchApp')
    .type('123456') // the 6-digit code
    .tap() // Turn on
    .wait('load');
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });

  // 5. Check what the business type set up, and say it's right.
  clock.step('Check the setup');
  const review = page.getByRole('region', { name: 'Check what I set up' });
  await expect(review).toBeVisible();
  // AC-W1-16: with no cover yet, the card suggests photos, before the check too.
  await expect(review.getByTestId('setup-tip')).toContainText('no photos yet');
  clock.read(await review.innerText());
  await (await hydrated(review.getByRole('button', { name: 'I’ve checked these' }))).click();
  clock.tap().wait('load');

  // 6. Photos: the suggestion leads to the Photos card; a cover and a logo from the camera roll.
  clock.step('Cover and logo');
  const link = page.getByRole('region', { name: 'Your booking page' });
  const tip = link.getByTestId('setup-tip');
  await expect(tip).toBeVisible();
  clock.read(await tip.innerText());
  await (await hydrated(tip.getByRole('link', { name: 'Add photos' }))).click();
  clock.tap().wait('load');
  await expect(page).toHaveURL(/\/services#photos$/);
  const photos = page.getByTestId('photos-card');
  await hydrated(photos.getByRole('button', { name: 'Add cover photo' }));
  await photos.getByTestId('photo-input-cover').setInputFiles({
    name: 'shop.jpg',
    mimeType: 'image/jpeg',
    buffer: await solidColorPhoto(1600, 900, 'jpeg', { r: 120, g: 86, b: 60 }),
  });
  clock.tap().wait('pickPhoto');
  await expect(photos.getByTestId('photo-cover').getByRole('img', { name: business })).toBeVisible({
    timeout: 20_000,
  });
  await photos.getByTestId('photo-input-logo').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: await solidColorPhoto(400, 400, 'png', { r: 40, g: 40, b: 40 }),
  });
  clock.tap().wait('pickPhoto');
  await expect(
    photos.getByTestId('photo-logo').getByRole('img', { name: `Logo of ${business}` }),
  ).toBeVisible({ timeout: 20_000 });

  // 7. What clients see: phone, address, cancellation policy.
  clock.step('Contact and policy');
  const details = page
    .getByRole('region', { name: 'Your booking page' })
    .getByRole('form', { name: 'What clients see' });
  await hydrated(details.getByRole('button', { name: 'Save details' }));
  await details.getByLabel('Phone').fill(PHONE);
  clock.type(PHONE);
  await details.getByLabel('Address').fill(ADDRESS);
  clock.type(ADDRESS);
  await details.getByLabel('Cancellation policy').fill(POLICY);
  clock.type(POLICY);
  await details.getByRole('button', { name: 'Save details' }).click();
  clock.tap();
  await expect(details.getByText('Saved. Clients see these on your booking page.')).toBeVisible();

  // 8. Back on Home: the suggestion is gone; copy the link to send to clients.
  clock.step('Copy the booking link');
  await goTo(page, 'Home');
  clock.tap().wait('load');
  const home = page.getByRole('region', { name: 'Your booking page' });
  await expect(home).toBeVisible();
  await expect(home.getByTestId('setup-tip')).toHaveCount(0);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await (await hydrated(home.getByRole('button', { name: 'Copy link' }))).click();
  clock.tap();
  await expect(home.getByRole('button', { name: 'Copied' })).toBeVisible();
  const ownerSeconds = clock.total();
  const ownerWallMs = Date.now() - started;

  // Bookable: a new client opens the link and books (AC-W8-13), timed the same way.
  const { business: tenant } = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const client = await anotherPerson(browser, baseURL);
  const clientEmail = `${unique('rae')}@example.test`;
  const clientClock = new OwnerClock();
  const clientStarted = Date.now();
  async function book(remembered: boolean) {
    clientClock.step(remembered ? 'Books again (remembered)' : 'First booking');
    await client.goto(`/book/${tenant.slug}`);
    clientClock.wait('load');
    await expect(client.getByTestId('business-cover')).toHaveAttribute('alt', business);
    const service = client.getByRole('button', { name: /^Haircut/ }).first();
    await hydrated(service);
    clientClock.read(await service.innerText());
    await service.click();
    clientClock.tap();
    await client.getByRole('button', { name: /Anyone available/ }).click();
    clientClock.tap();
    // The strip opens on the first free day (AC-W8-4): the first time is one tap away.
    const time = client.getByTestId('free-times').getByRole('button').first();
    await time.click();
    clientClock.tap();
    await client.getByLabel('Full name').fill('Rae Kim');
    clientClock.type(TYPED.clientName);
    await client.getByLabel('Email').fill(clientEmail);
    clientClock.type(TYPED.clientEmail);
    await client.getByRole('button', { name: 'Send my code' }).click();
    clientClock.tap().wait('load');
    if (!remembered) {
      await expect(client.getByRole('heading', { name: 'Check your email' })).toBeVisible();
      const code = /^ {4}(\d{6})$/m.exec(await emailTo(clientEmail, 'is your code'))?.[1] ?? '';
      clientClock.wait('switchApp').wait('emailWait').wait('switchApp');
      await client.getByLabel('Code').fill(code);
      clientClock.type(code);
      await client.getByRole('button', { name: 'Confirm booking' }).click();
      clientClock.tap().wait('load');
    }
    await expect(client.getByRole('heading', { name: /You’re booked, Rae/ })).toBeVisible();
  }
  await book(false);
  const firstSeconds = clientClock.total();
  await book(true);
  const rememberedSeconds = clientClock.total() - firstSeconds;
  await client.context().close();

  // eslint-disable-next-line no-console -- the numbers go into the session log and the scorecard
  console.info(
    `${clock.report('New owner (AC-W1-15)', ownerWallMs)}\n${clientClock.report(
      'Client (AC-W8-13)',
      Date.now() - clientStarted,
    )}`,
  );
  expect(ownerSeconds, 'owner time by the model, seconds').toBeLessThan(OWNER_LIMIT_SECONDS);
  expect(firstSeconds, 'first booking by the model, seconds').toBeLessThan(
    CLIENT_LIMIT_SECONDS.first,
  );
  expect(rememberedSeconds, 'remembered booking by the model, seconds').toBeLessThan(
    CLIENT_LIMIT_SECONDS.remembered,
  );
});
