import { AxeBuilder } from '@axe-core/playwright';
import { BusinessPhotosSchema, CurrentBusinessResponseSchema } from '@pepper/contracts';
import { solidColorPhoto } from '@pepper/storage';
import { expect, test } from '@playwright/test';
import { anotherPerson, goTo, hydrated, onboardOwner, ownClientAddress } from './helpers.js';
import { expectTapTargets } from './tap-targets.js';

// Photos on the booking page through the real stack (S47.2, ADR-0048, AC-W8-10…12, AC-W1-14):
// a new barbershop owner adds a logo, a cover and their work on Services; a client sees them
// on the page with alt text, from the app's own origin; a file that isn't a usable photo is
// refused with what to fix; Home's booking link says how the page did this week.

// Its own client address, so its sign-up never shares Better Auth's rate limit with another
// spec's (a shared bucket answered "Too many attempts" in a full run).
test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('photos (AC-W8-10…12, AC-W1-14): an owner adds a logo, cover and work; a client sees them', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const owner = await onboardOwner(page, { type: 'Barbershop' });
  const { business } = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );

  // AC-W1-14: before anyone came, the link says what to do.
  await (await hydrated(page.getByRole('button', { name: 'I’ve checked these' }))).click();
  const link = page.getByRole('region', { name: 'Your booking page' });
  await expect(link.getByTestId('booking-week')).toHaveText(
    'No visits yet this week. Share your link to get your first booking.',
  );

  await goTo(page, 'Services');
  const card = page.getByTestId('photos-card');
  await expect(card.getByRole('heading', { name: 'Photos' })).toBeVisible();
  await expect(card.getByTestId('photo-gallery')).toContainText('0 of 12');

  // Wrong kind of file: refused before anything is stored, with what to fix.
  await hydrated(card.getByRole('button', { name: 'Add cover photo' }));
  await card.getByTestId('photo-input-cover').setInputFiles({
    name: 'small.jpg',
    mimeType: 'image/jpeg',
    buffer: await solidColorPhoto(800, 400),
  });
  await expect(card.getByTestId('photo-cover').getByRole('alert')).toContainText(
    'at least 600 px on its short side',
  );
  await card.getByTestId('photo-input-logo').setInputFiles({
    name: 'not-a-photo.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  await expect(card.getByTestId('photo-logo').getByRole('alert')).toContainText(
    'JPEG, PNG or WebP',
  );

  // The logo, the cover and two photos of the work.
  await card.getByTestId('photo-input-logo').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: await solidColorPhoto(400, 400, 'png', { r: 40, g: 40, b: 40 }),
  });
  await expect(
    card.getByTestId('photo-logo').getByRole('img', { name: `Logo of ${owner.business}` }),
  ).toBeVisible();
  await card.getByTestId('photo-input-cover').setInputFiles({
    name: 'shop.jpg',
    mimeType: 'image/jpeg',
    buffer: await solidColorPhoto(1600, 900, 'jpeg', { r: 120, g: 86, b: 60 }),
  });
  await expect(
    card.getByTestId('photo-cover').getByRole('img', { name: owner.business }),
  ).toBeVisible();
  await card.getByTestId('photo-input-gallery').setInputFiles([
    { name: 'fade.jpg', mimeType: 'image/jpeg', buffer: await solidColorPhoto(900, 900) },
    {
      name: 'beard.webp',
      mimeType: 'image/webp',
      buffer: await solidColorPhoto(1200, 900, 'webp', { r: 90, g: 60, b: 80 }),
    },
  ]);
  const rows = card.getByTestId('gallery-photo');
  await expect(rows).toHaveCount(2);
  await expect(card.getByTestId('photo-gallery')).toContainText('2 of 12');
  await rows.first().getByLabel('Caption').fill('Skin fade, low taper');
  await rows.first().getByRole('button', { name: 'Save caption' }).click();
  await expect(rows.first().getByRole('button', { name: 'Save caption' })).toBeHidden();
  await expect(rows.first().getByRole('img', { name: 'Skin fade, low taper' })).toBeVisible();
  // DESIGN D3 is checked on the phone (the desktop sidebar's logo link is its own case).
  if (test.info().project.name === 'mobile') await expectTapTargets(page, 'Services with photos');

  // Stored as the api remade them: two of the work, the caption kept.
  const photos = BusinessPhotosSchema.parse(
    await (await page.request.get('/v1/tenant/photos')).json(),
  );
  expect(photos.gallery.map((photo) => photo.caption)).toEqual(['Skin fade, low taper', null]);

  // A client opens the page: the cover on top, the logo beside the name, the work under the menu.
  const client = await anotherPerson(browser, baseURL);
  await client.goto(`/book/${business.slug}`);
  const cover = client.getByTestId('business-cover');
  await expect(cover).toHaveAttribute('alt', owner.business);
  await expect(client.getByTestId('business-logo')).toHaveAttribute(
    'alt',
    `Logo of ${owner.business}`,
  );
  const gallery = client.getByTestId('work-gallery');
  await expect(gallery.getByRole('img')).toHaveCount(2);
  await expect(gallery.getByRole('img', { name: 'Skin fade, low taper' })).toBeVisible();
  await expect(gallery.getByRole('img', { name: `Work at ${owner.business}` })).toBeVisible();
  // Every image loaded, from the app's own origin, as WebP, cached as unchanging.
  const src = await cover.getAttribute('src');
  expect(src).toMatch(
    new RegExp(`^/v1/public/businesses/${business.slug}/photos/[0-9a-f-]+/\\d+$`),
  );
  const image = await client.request.get(src ?? '');
  expect(image.headers()['content-type']).toBe('image/webp');
  expect(image.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  await expect
    .poll(
      () =>
        client.evaluate(() =>
          [...document.images].every((img) => img.complete && img.naturalWidth > 0),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  const { violations } = await new AxeBuilder({ page: client }).withTags(WCAG_TAGS).analyze();
  expect(violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')).toEqual(
    [],
  );
  await client.context().close();

  // AC-W1-14: that visit is this week's.
  await goTo(page, 'Home');
  await expect(page.getByTestId('booking-week')).toHaveText('1 visit, 0 booked this week', {
    timeout: 20_000,
  });

  // Removing the cover takes it off the page.
  await goTo(page, 'Services');
  await (
    await hydrated(card.getByTestId('photo-cover').getByRole('button', { name: 'Remove' }))
  ).click();
  await expect(
    card.getByTestId('photo-cover').getByRole('button', { name: 'Add cover photo' }),
  ).toBeVisible();
  await expect(await page.request.get(src ?? '')).not.toBeOK();
});
