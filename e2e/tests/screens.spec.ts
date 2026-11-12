import {
  SupportCreatedSchema,
  SupportScreenshotSchema,
  SupportSavedReplyListSchema,
  ClientSchema,
  ClientsPageSchema,
  CurrentBusinessResponseSchema,
  ServiceSchema,
  ServicesResponseSchema,
  StaffMemberSchema,
  StaffResponseSchema,
  addDays,
  formatDate,
  fromZoned,
  toZoned,
} from '@pepper/contracts';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  emailTo,
  enterPassword,
  freshCode,
  hydrated,
  IMPORT_CSV,
  importVisitsFile,
  linkTo,
  makeOperator,
  onboardOwner,
  ownClientAddress,
  PASSWORD,
  pickBusinessType,
  signOut,
  signUp,
  toast,
  unique,
  visitsCsv,
} from './helpers.js';
import { expectTapTargets } from './tap-targets.js';
import { solidColorPhoto } from '@pepper/storage';

/** Waits until every image `images` finds has loaded (S59.2.3's thumbnails). */
async function loaded(images: Locator): Promise<void> {
  await expect(images.first()).toBeVisible();
  await expect
    .poll(
      () =>
        images.evaluateAll((all) =>
          all.every(
            (img) =>
              (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
          ),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

// The signed-in screens on the kit (S41, DESIGN.md D6; AC-X-3): Home, Chat and More (S41), and
// Calendar, Clients and a client's profile (S42, AC-X-8) at 375, 412 and 1280 px in light and
// dark, compared with the committed baselines (Linux, CI's headless shell; a diff fails CI
// unless the PR updates the baseline, ADR-0044). Home, Chat and More are a new owner's, so every
// list shows its empty state; Calendar and Clients have the S39 mockups' shop on a day a week
// ahead (its date, which moves, is masked). Names are the same every run; the email (unique per
// run) is masked. At 375 px each S42 screen also has its tap targets checked (AC-X-6). S42.2 adds
// Services, Team, a staff member's page and the booking sheets (AC-X-9), and at 375 px the open
// sheets' tap targets and their main action at the bottom of the phone, in the sheet's footer.
// S42.3 adds Autonomy, What I know (empty, then with two facts) and Waitlist (empty), and their
// tap targets at 375 px, Autonomy's switch row and dial included (AC-X-10). S43 adds the public
// pages in the shop's own color (the booking page at every step, manage-booking, the offer and
// unsubscribe links), their tap targets and the sticky action at the bottom of a 375 px phone,
// and Autonomy's "Saved" toast in view on that phone (AC-X-11). Dates on them move: masked.
// S43.2 adds the account screens (sign-in and its code step, sign-up, the invite page, create
// business, two-step setup), their tap targets and the main action at the bottom of a 375 px
// phone (AC-X-12); the QR code, key, backup codes and time zone change per run: masked. S44
// adds forgot password (with its field error, and sent), a new password (with its field error),
// a run-out reset link, "Check your inbox" after sign-up and change email (the run's email
// masked), each main action at the bottom of a 375 px phone.
//
// Update the baselines after a deliberate change, on Linux with CI's browser:
//   pnpm --filter @pepper/e2e exec playwright test screens --project=desktop --update-snapshots

const WIDTHS = [375, 412, 1280] as const;
/**
 * Home without the evening wrap (S55, ADR-0058): it shows only from 5 pm in the business's zone,
 * so the shot would depend on when it runs. The gallery shoots it in a fixed state.
 */
async function withoutEveningWrap(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector('[data-testid="evening-wrap"]')?.remove();
  });
}

/** The import result's undo day, fixed for the shot: the real one is 7 days from today. */
async function fixUndoDay(page: Page): Promise<void> {
  await page.getByTestId('import-undo-until').evaluate((element) => {
    element.textContent = 'Tuesday, November 10';
  });
}

/**
 * A client's yes to texts at fixed dates for the shots (S62 CI): the real ones are the run's own,
 * and their length ("8:05 AM" or "10:05 AM", "Nov 2" or "Nov 12") decides whether the masked line
 * wraps, so the section's and the sheet's heights moved with the clock. The longest forms.
 */
async function fixConsentMoments(part: Locator): Promise<void> {
  const fixed: [RegExp, string][] = [
    [/^Said yes /, 'Said yes Nov 12, 2026 on your booking page.'],
    [/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d/, 'Wed, Nov 12, 2026, 10:08 AM'],
  ];
  for (const [pattern, text] of fixed) {
    const element = part.getByText(pattern);
    if ((await element.count()) === 0) continue;
    await element.evaluate((node, value) => {
      node.textContent = value;
    }, text);
  }
}

const SCHEMES = ['light', 'dark'] as const;
const SHOT = { fullPage: true, animations: 'disabled', maxDiffPixelRatio: 0.01 } as const;
/**
 * A part of a screen whose surroundings are shared data (S59.2.2: the team's saved replies):
 * clipped to its box at whole pixels, so where the list puts it doesn't change the image's size.
 */
/** Deletes the team's saved replies titled `title`, so reruns don't fill the list (max 100). */
async function deleteSavedReplies(page: Page, title: string): Promise<void> {
  const listed = SupportSavedReplyListSchema.parse(
    await (await page.request.get('/v1/ops/replies')).json(),
  );
  for (const reply of listed.replies.filter((row) => row.title === title)) {
    const removed = await page.request.delete(`/v1/ops/replies/${reply.id}`, {
      headers: { origin: new URL(page.url()).origin },
    });
    expect(removed.status()).toBe(204);
  }
}

async function partShot(page: Page, part: Locator, name: string): Promise<void> {
  await part.scrollIntoViewIfNeeded();
  const box = await part.boundingBox();
  if (box === null) throw new Error(`${name}: not on the screen`);
  await expect.soft(page).toHaveScreenshot(name, {
    animations: 'disabled',
    maxDiffPixelRatio: 0.01,
    clip: {
      x: Math.floor(box.x),
      y: Math.floor(box.y),
      width: Math.ceil(box.width),
      height: Math.ceil(box.height),
    },
  });
}

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

/** The S39 mockups' shop on its booking page: three priced services, Dre and Randy, every day. */
async function southsideMenu(page: Page): Promise<string> {
  const { business } = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const menu = [
    { name: 'Haircut', durationMinutes: 30, priceFromCents: 3500 },
    { name: 'Skin fade', durationMinutes: 45, priceFromCents: 4500 },
    { name: 'Beard trim', durationMinutes: 15, priceFromCents: 2000 },
  ];
  const services: string[] = [];
  for (const service of menu)
    services.push((await post(page, '/v1/services', service, ServiceSchema)).id);
  for (const displayName of ['Dre', 'Randy']) {
    const member = await post(
      page,
      '/v1/staff',
      { displayName, serviceIds: services },
      StaffMemberSchema,
    );
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
  const color = await page.request.put('/v1/tenant/booking-page', {
    data: { brandColor: '#145a55' },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(color.ok(), await color.text()).toBe(true);
  return business.slug;
}

/** The sticky bar's main action: at the bottom of the phone, within thumb reach (D3). */
async function expectStickyAtTheBottom(page: Page, name: string): Promise<void> {
  const box = await page.getByRole('button', { name, exact: true }).boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  expect(box, `${name} on the page`).not.toBeNull();
  if (box === null) return;
  expect(box.y + box.height, `${name} near the bottom`).toBeGreaterThan(height - 120);
  expect(box.y + box.height, `${name} on the screen`).toBeLessThanOrEqual(height);
}

// "Wed, Oct 29, 9:00 AM" and "Wed, Oct 29": dates that move with the run.
const DATED = /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}/;

// A well-formed invite token (the page checks it only once the visitor is signed in).
const SOME_INVITE = 'q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C';

for (const width of WIDTHS) {
  test(`The account screens at ${String(width)} px, light and dark`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    const phone = width === 375;
    const shots = async (name: string, mask: ReturnType<Page['locator']>[] = []) => {
      if (phone) {
        await expectTapTargets(page, `the ${name} screen`);
        const wide = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(wide, `${name} scrolls sideways`).toBeLessThanOrEqual(width);
      }
      for (const scheme of SCHEMES) {
        await still(page, scheme);
        await expect
          .soft(page)
          .toHaveScreenshot(`${name}-${String(width)}-${scheme}.png`, { ...SHOT, mask });
      }
      await page.emulateMedia({ colorScheme: 'light' });
    };

    await page.goto('/sign-in');
    await hydrated(page.getByRole('button', { name: 'Sign in' }));
    if (phone) await expectStickyAtTheBottom(page, 'Sign in');
    await shots('auth-sign-in');

    await page.goto('/sign-up');
    await hydrated(page.getByRole('button', { name: 'Create account' }));
    if (phone) await expectStickyAtTheBottom(page, 'Create account');
    await shots('auth-sign-up');

    // S44: password reset, each field's error under it and the main action at the bottom.
    await page.goto('/forgot-password');
    await (await hydrated(page.getByRole('button', { name: 'Send me a link' }))).click();
    await expect(page.getByLabel('Email')).toHaveAccessibleDescription(
      'Enter the email you sign in with.',
    );
    if (phone) await expectStickyAtTheBottom(page, 'Send me a link');
    await shots('auth-forgot');
    await page.getByLabel('Email').fill('ana.reyes@example.test');
    await page.getByRole('button', { name: 'Send me a link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    await shots('auth-forgot-sent');

    await page.goto('/reset-password?token=some-reset-token');
    await (await hydrated(page.getByRole('button', { name: 'Save new password' }))).click();
    await expect(page.getByLabel('New password')).toHaveAccessibleDescription(
      /Use a password of at least 10 characters/,
    );
    if (phone) await expectStickyAtTheBottom(page, 'Save new password');
    await shots('auth-reset');
    await page.goto('/reset-password?error=INVALID_TOKEN');
    await expect(page.getByRole('heading', { name: 'This link has run out' })).toBeVisible();
    await shots('auth-reset-expired');

    await page.goto('/invite');
    await expect(page.getByRole('alert').filter({ hasText: 'incomplete' })).toBeVisible();
    await shots('auth-invite-broken');
    // A new page load: a hash change alone doesn't open the page again.
    await page.goto('about:blank');
    await page.goto(`/invite#${SOME_INVITE}`);
    await expect(page.getByRole('heading', { name: /invited to join/ })).toBeVisible();
    await shots('auth-invite');

    // The same length every run, so the masked address wraps the lead the same way.
    const email = `${unique('owner').replace(/\D/g, '').padStart(24, '0').slice(-24)}@example.test`;
    await signUp(page, email, { confirm: false });
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible({
      timeout: 20_000,
    });
    if (phone) await expectStickyAtTheBottom(page, 'Send the link again');
    await shots('auth-check-inbox', [page.getByText(email, { exact: true })]);
    await page.goto(await linkTo(email, 'Confirm your email for Pepper'));
    await expect(page).toHaveURL(/\/onboarding\/business$/, { timeout: 20_000 });
    await hydrated(page.getByRole('button', { name: 'Create business' }));
    if (phone) await expectStickyAtTheBottom(page, 'Create business');
    await shots('auth-business', [page.getByLabel('Time zone')]);

    await pickBusinessType(page, 'Barbershop');
    await page.getByLabel('Business name').fill('Southside Cuts');
    await page.getByLabel('Booking link').fill(unique('shop'));
    await page.getByRole('button', { name: 'Create business' }).click();
    await expect(page).toHaveURL(/\/security\/two-factor$/, { timeout: 30_000 });
    await hydrated(page.getByRole('button', { name: 'Continue' }));
    if (phone) await expectStickyAtTheBottom(page, 'Continue');
    await shots('auth-two-factor');

    await page.getByLabel('Confirm your password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    const qr = page.getByRole('img', { name: /QR code/ });
    await expect(qr).toBeVisible();
    if (phone) await expectStickyAtTheBottom(page, 'Turn on two-step verification');
    const secret = page.getByTestId('totp-secret');
    await shots('auth-two-factor-codes', [qr, secret, page.getByTestId('backup-codes')]);

    const used = new Set<string>();
    const key = ((await secret.textContent()) ?? '').replace(/\s/g, '');
    await page.getByLabel('Enter the 6-digit code').fill(await freshCode(key, used));
    await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
    await expect(page).toHaveURL(/\/$/);
    await signOut(page);
    await enterPassword(page, email);
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    if (phone) await expectStickyAtTheBottom(page, 'Verify');
    await shots('auth-sign-in-code');

    await page.getByLabel('Code').fill(await freshCode(key, used));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/account/email');
    await (await hydrated(page.getByRole('button', { name: 'Send the link' }))).click();
    await expect(page.getByLabel('New email')).toHaveAccessibleDescription(
      'Enter the new email you want to sign in with.',
    );
    if (phone) await expectStickyAtTheBottom(page, 'Send the link');
    await shots('auth-change-email', [page.getByText(email, { exact: true })]);
  });
}

for (const width of WIDTHS) {
  test(`The public pages at ${String(width)} px, light and dark`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width, height: 900 });
    await onboardOwner(page, { business: 'Southside Cuts' });
    const slug = await southsideMenu(page);
    const phone = width === 375;
    const shots = async (name: string, mask: ReturnType<Page['locator']>[] = []) => {
      if (phone) {
        await expectTapTargets(page, `the booking page: ${name}`);
        // D12: nothing scrolls sideways (the day strip once widened the whole page).
        const wide = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(wide, `${name} scrolls sideways`).toBeLessThanOrEqual(width);
      }
      for (const scheme of SCHEMES) {
        await still(page, scheme);
        await expect
          .soft(page)
          .toHaveScreenshot(`${name}-${String(width)}-${scheme}.png`, { ...SHOT, mask });
      }
      await page.emulateMedia({ colorScheme: 'light' });
    };

    await page.goto(`/book/${slug}`);
    await expect(page.getByRole('heading', { name: 'Book a visit' })).toBeVisible();
    await hydrated(page.getByRole('button', { name: /^Skin fade/ }));
    await shots('book-services');

    await page.getByRole('button', { name: /^Skin fade/ }).click();
    await expect(page.getByRole('heading', { name: 'Who would you like?' })).toBeVisible();
    await shots('book-staff');

    await page.getByRole('button', { name: /^Anyone available/ }).click();
    // Tomorrow: a whole working day, the same times every run.
    await page.getByRole('group', { name: 'Day' }).getByRole('button').nth(1).click();
    const times = page.getByTestId('free-times');
    await expect(times.getByRole('button').first()).toBeVisible();
    await shots('book-time', [
      page.getByRole('group', { name: 'Day' }),
      page.getByRole('heading', { name: /^Times on / }),
    ]);

    await times.getByRole('button').first().click();
    await expect(page.getByRole('heading', { name: 'Your details' })).toBeVisible();
    if (phone) await expectStickyAtTheBottom(page, 'Send my code');
    await shots('book-details', [page.getByText(DATED)]);

    const email = `${unique('ana')}@example.test`;
    await page.getByLabel('Full name').fill('Ana Ruiz');
    await page.getByLabel('Email').fill(email);
    // S61.2 (AC-X-64): with a phone, the SMS box, unticked until the client ticks it.
    await page.getByLabel('Phone (optional)').fill('(555) 234-5678');
    await page.getByRole('checkbox', { name: /^Text me appointment/ }).check();
    await shots('book-details-sms', [page.getByText(DATED), page.getByText(email)]);
    await page.getByRole('button', { name: 'Send my code' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    if (phone) await expectStickyAtTheBottom(page, 'Confirm booking');
    await shots('book-code', [page.getByText(DATED), page.getByText(email)]);

    const code = /^ {4}(\d{6})$/m.exec(await emailTo(email, 'is your code'))?.[1] ?? '';
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Confirm booking' }).click();
    await expect(page.getByRole('heading', { name: 'You’re booked, Ana' })).toBeVisible();
    await shots('book-done', [page.getByText(DATED), page.getByText(email)]);

    await page.getByRole('link', { name: 'Reschedule or cancel' }).click();
    await expect(page.getByTestId('booking-status')).toHaveText('Booked');
    await hydrated(page.getByRole('button', { name: 'Reschedule' }));
    await shots('book-manage', [page.getByText(DATED)]);

    // A link opened without its secret, and an unsubscribe link that isn't valid.
    await page.goto(`/book/${slug}/offer`);
    await expect(page.getByText('This link is incomplete. Open it from your email.')).toBeVisible();
    await shots('book-offer-broken');
    await page.goto('/unsubscribe/not-a-real-token');
    await expect(
      page.getByText('This unsubscribe link isn’t valid.', { exact: false }),
    ).toBeVisible();
    await shots('unsubscribe-invalid');

    // S61.2 (AC-X-66): Ana's profile with her yes to texts, and the words she agreed to.
    const ana = ClientsPageSchema.parse(
      await (await page.request.get('/v1/clients?search=Ana')).json(),
    ).clients.find((each) => each.email === email);
    await page.goto(`/clients/${ana?.id ?? ''}`);
    const texts = page.getByTestId('client-texts');
    await expect(texts.getByText(/^Said yes /)).toBeVisible();
    // The section and the sheet alone: the profile around them shows the test's unique email,
    // whose length (and so its wrapping at 375 px) differs from run to run.
    if (phone) await expectTapTargets(page, 'a profile with texts on');
    await fixConsentMoments(texts);
    for (const scheme of SCHEMES) {
      await still(page, scheme);
      await expect.soft(texts).toHaveScreenshot(`client-texts-${String(width)}-${scheme}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: SHOT.maxDiffPixelRatio,
        mask: [texts.getByText(/^Said yes /)],
      });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await (await hydrated(texts.getByRole('button', { name: 'What they agreed to' }))).click();
    const record = page.getByRole('dialog', { name: 'What Ana Ruiz agreed to' });
    await expect(record.getByRole('blockquote')).toBeVisible();
    await fixConsentMoments(record);
    for (const scheme of SCHEMES) {
      await still(page, scheme);
      await expect
        .soft(record)
        .toHaveScreenshot(`client-texts-record-${String(width)}-${scheme}.png`, {
          animations: 'disabled',
          maxDiffPixelRatio: SHOT.maxDiffPixelRatio,
          mask: [record.getByText(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d/)],
        });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.keyboard.press('Escape');

    // S47.2 (AC-W8-12): the page with its logo, cover and three photos of the work.
    const origin = new URL(page.url()).origin;
    const add = async (kind: string, body: Buffer, type: string) => {
      const answer = await page.request.post(`/v1/tenant/photos?kind=${kind}`, {
        headers: { 'content-type': type, origin },
        data: body,
      });
      expect(answer.status()).toBe(201);
    };
    await add('logo', await solidColorPhoto(400, 400, 'png', { r: 34, g: 34, b: 34 }), 'image/png');
    await add(
      'cover',
      await solidColorPhoto(1600, 900, 'jpeg', { r: 132, g: 92, b: 64 }),
      'image/jpeg',
    );
    for (const color of [
      { r: 96, g: 64, b: 52 },
      { r: 150, g: 120, b: 96 },
      { r: 70, g: 58, b: 74 },
    ]) {
      await add('gallery', await solidColorPhoto(900, 900, 'jpeg', color), 'image/jpeg');
    }
    await page.goto(`/book/${slug}`);
    await expect(page.getByTestId('work-gallery').getByRole('img')).toHaveCount(3);
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.images].every((img) => img.complete && img.naturalWidth > 0),
        ),
      )
      .toBe(true);
    await shots('book-photos');
  });

  test(`Home, Activity, Chat, More, Your data and deleting at ${String(width)} px, light and dark`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width, height: 900 });
    await onboardOwner(page, { business: 'Southside Cuts' });
    await settleBriefing(page);

    for (const scheme of SCHEMES) {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'To-dos' })).toBeVisible();
      await still(page, scheme);
      // A new business has no visits yet, so the board is quiet (S52, AC-W4-5).
      await expect(page.getByTestId('feed-quiet')).toBeVisible();
      // Nothing done yet, so no week card (AC-W4-13).
      await expect(page.getByTestId('week-proof')).toHaveCount(0);
      await withoutEveningWrap(page);
      await expect.soft(page).toHaveScreenshot(`home-${String(width)}-${scheme}.png`, SHOT);

      // Activity (S52, AC-W7-4): nothing done yet says what will be listed.
      await page.goto('/activity');
      await expect(page.getByTestId('activity-empty')).toBeVisible();
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`activity-${String(width)}-${scheme}.png`, SHOT);

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

      // Your data (S51, ADR-0053): what the export holds and its one action.
      await page.goto('/more/data');
      await expect(page.getByRole('heading', { name: 'Your data', level: 1 })).toBeVisible();
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`your-data-${String(width)}-${scheme}.png`, SHOT);

      // Delete business and Delete account (S51.2, ADR-0054): the download first, the name or
      // the password, one danger action. The account's email is masked (it is unique per run).
      await page.goto('/more/data/delete');
      await expect(
        page.getByRole('heading', { name: 'Delete Southside Cuts', level: 1 }),
      ).toBeVisible();
      await still(page, scheme);
      await expect
        .soft(page)
        .toHaveScreenshot(`delete-business-${String(width)}-${scheme}.png`, SHOT);

      await page.goto('/account/delete');
      await expect(
        page.getByRole('heading', { name: 'Delete your account', level: 1 }),
      ).toBeVisible();
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`delete-account-${String(width)}-${scheme}.png`, {
        ...SHOT,
        mask: [page.getByText(/@example\.test/)],
      });
    }
  });
}

/** Masked dates as one full-width line each, so their text's length never moves the layout. */
const DATE_LINES_FIXED = `[data-testid="booking-when"], [data-testid="calendar-day"] {
  display: block !important; width: 100% !important; white-space: nowrap !important;
  overflow: hidden !important;
}`;

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
async function southsideDay(
  page: Page,
): Promise<{ date: string; marcus: string; audy: string; dre: string }> {
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
  return { date: formatDate(day), marcus: marcus.id, audy: audy.id, dre: dre.id };
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

      // S50: the editor with tags and birthday, and Delete waiting for the coming visit.
      const sheet = page.getByRole('dialog');
      await (await hydrated(page.getByRole('button', { name: 'Edit details' }))).click();
      await expect(sheet.getByLabel('Tags (optional)')).toBeVisible();
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`client-edit-${String(width)}-${scheme}.png`, {
        ...SHOT,
        fullPage: false,
      });
      await page.keyboard.press('Escape');
      await (await hydrated(page.getByRole('button', { name: 'Delete client' }))).click();
      await expect(sheet.getByTestId('delete-confirm')).toContainText('1 visit coming up');
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`client-delete-${String(width)}-${scheme}.png`, {
        ...SHOT,
        fullPage: false,
      });
      await page.keyboard.press('Escape');
    }
  });
}

for (const width of WIDTHS) {
  test(`Haven't been back, empty and with regulars, at ${String(width)} px, light and dark`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    await onboardOwner(page, { business: 'Southside Cuts', type: 'Barbershop' });

    // AC-W4-9: what fills it, and the import.
    await page.goto('/clients/win-back');
    await expect(page.getByRole('link', { name: 'Import past visits' })).toBeVisible();
    if (width === 375) await expectTapTargets(page, 'the empty win-back list');
    for (const scheme of SCHEMES) {
      await still(page, scheme);
      await expect
        .soft(page)
        .toHaveScreenshot(`win-back-empty-${String(width)}-${scheme}.png`, SHOT);
    }

    // Three regulars past their gap (dates from today, so the days late stay the same; the
    // dates themselves are masked), one without an email; the mailing address set.
    const { services } = ServicesResponseSchema.parse(
      await (await page.request.get('/v1/services')).json(),
    );
    const { staff } = StaffResponseSchema.parse(await (await page.request.get('/v1/staff')).json());
    const service = services.find((each) => each.active)?.name ?? '';
    const owner = staff[0]?.displayName ?? '';
    const ago = (days: number) =>
      new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    await importVisitsFile(
      page,
      [
        'Date,Time,Client,Email,Phone,Service,Staff,Length,Price,Status',
        `${ago(70)},10:00 AM,Ana Ruiz,ana.ruiz@example.com,555-010-3001,${service},${owner},45,45,done`,
        `${ago(40)},10:00 AM,Ana Ruiz,ana.ruiz@example.com,555-010-3001,${service},${owner},45,45,done`,
        `${ago(100)},11:00 AM,Ben Ito,,555-010-3002,${service},${owner},45,45,done`,
        `${ago(60)},11:00 AM,Ben Ito,,555-010-3002,${service},${owner},45,45,done`,
        `${ago(150)},1:00 PM,Cleo Hart,cleo@example.com,555-010-3003,${service},${owner},45,45,done`,
        `${ago(90)},1:00 PM,Cleo Hart,cleo@example.com,555-010-3003,${service},${owner},45,45,done`,
      ].join('\n'),
    );
    const address = await page.request.patch('/v1/feed/settings', {
      data: { mailingAddress: '12 Juniper Lane\nPortland, OR 97201' },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(address.ok(), await address.text()).toBe(true);
    await page.goto('/clients/win-back');
    await expect(page.getByTestId('win-back-row')).toHaveCount(3);
    if (width === 375) await expectTapTargets(page, 'the win-back list');
    for (const scheme of SCHEMES) {
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`win-back-${String(width)}-${scheme}.png`, {
        ...SHOT,
        mask: [page.getByTestId('win-back-meta')],
      });
    }
  });
}

/** The open sheet's main action: in its footer, at the bottom of the phone (D3, AC-X-9). */
async function expectActionAtTheBottom(page: Page, name: string): Promise<void> {
  // Measured once the sheet has slid in.
  await page
    .getByRole('dialog')
    .evaluate((sheet) => Promise.all(sheet.getAnimations().map((motion) => motion.finished)));
  const action = page
    .getByRole('dialog')
    .locator('[data-slot="sheet-footer"]')
    .getByRole('button', { name, exact: true });
  const box = await action.boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  expect(box, `${name} in the sheet's footer`).not.toBeNull();
  if (box === null) return;
  expect(box.y + box.height, `${name} near the bottom`).toBeGreaterThan(height - 120);
  expect(box.y + box.height, `${name} on the screen`).toBeLessThanOrEqual(height);
}

for (const width of WIDTHS) {
  test(`Services, Team, a staff member and the booking sheets at ${String(width)} px, light and dark`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width, height: 900 });
    await onboardOwner(page, { business: 'Southside Cuts' });
    const { date, dre } = await southsideDay(page);
    const dialog = page.getByRole('dialog');

    if (width === 375) {
      // AC-X-6 at 375 px: the screens, then each sheet open with its action in thumb reach.
      for (const path of ['/services', '/services/rules', '/team', `/team/${dre}`]) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expectTapTargets(page, path);
      }
      const sheets = [
        { path: '/services', open: 'Add service', action: 'Add service' },
        { path: '/services', open: 'Edit Skin fade', action: 'Save' },
        { path: '/team', open: 'Add staff member', action: 'Add' },
        { path: `/calendar?date=${date}`, open: 'New booking', action: 'Book' },
      ];
      for (const { path, open, action } of sheets) {
        await page.goto(path);
        await (await hydrated(page.getByRole('button', { name: open, exact: true }))).click();
        await expect(dialog).toBeVisible();
        await expectActionAtTheBottom(page, action);
        await expectTapTargets(page, `the ${open} sheet`);
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
      }
      await page.goto(`/calendar?date=${date}`);
      await (await hydrated(page.getByTestId('booking-block').first())).click();
      await expectActionAtTheBottom(page, 'Move');
      await expectTapTargets(page, 'the booking sheet');
    }

    for (const scheme of SCHEMES) {
      await page.goto('/services');
      await expect(page.getByTestId('service')).toHaveCount(2);
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`services-${String(width)}-${scheme}.png`, {
        ...SHOT,
        mask: [page.getByRole('link', { name: /^\/book\// })],
      });

      await page.goto('/team');
      await expect(page.getByTestId('staff-member')).toHaveCount(2);
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`team-${String(width)}-${scheme}.png`, {
        ...SHOT,
        mask: [page.getByTestId('members').getByText(/@example\.test$/)],
      });

      await page.goto(`/team/${dre}`);
      await expect(page.getByRole('heading', { name: 'Dre', level: 1 })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save hours' })).toBeVisible();
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`staff-${String(width)}-${scheme}.png`, SHOT);

      // The booking sheet (Marcus at 9:30 with Dre) and the new-booking sheet, on the screen.
      await page.goto(`/calendar?date=${date}`);
      await (await hydrated(page.getByTestId('booking-block').first())).click();
      await expect(dialog.getByTestId('booking-status')).toBeVisible();
      await page.addStyleTag({ content: DATE_LINES_FIXED });
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`booking-sheet-${String(width)}-${scheme}.png`, {
        ...SHOT,
        fullPage: false,
        // The day moves with today; the client row (S50.2) stays in the picture. Each masked
        // date is one full-width line, so a longer day's name can't wrap it and move the sheet
        // (S51.2: "Wednesday, November 11" wrapped at 412 px and failed the shot on that day).
        mask: [dialog.getByTestId('booking-when'), page.getByTestId('calendar-day')],
      });
      await page.keyboard.press('Escape');
      await (
        await hydrated(page.getByRole('button', { name: 'New booking', exact: true }))
      ).click();
      await expect(dialog.getByTestId('free-times')).toBeVisible();
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`new-booking-${String(width)}-${scheme}.png`, {
        ...SHOT,
        fullPage: false,
        mask: [dialog.getByLabel('Day', { exact: true }), page.getByTestId('calendar-day')],
      });
      await page.keyboard.press('Escape');
    }
  });
}

for (const width of WIDTHS) {
  test(`Autonomy, What I know and Waitlist at ${String(width)} px, light and dark`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    await onboardOwner(page, { business: 'Southside Cuts' });
    const anything = { parse: (value: unknown) => value };
    // A fact's source line ends with the day it was added, which moves.
    const addedOn = () => page.getByText(/ · [A-Z][a-z]{2} \d{1,2}$/);

    if (width === 375) {
      // AC-X-6 at 375 px: Autonomy's switch row and dial, the empty memory and waitlist.
      for (const path of ['/autonomy', '/memory', '/waitlist']) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expectTapTargets(page, path);
      }
      await expect(page.getByRole('link', { name: 'Add someone in chat' })).toBeVisible();

      // The S43 top-up: a change far down the page is confirmed in view, above the tabs.
      await page.goto('/autonomy');
      // S53: the actions are behind "Customise each action" while a preset is chosen.
      await (await hydrated(page.getByRole('button', { name: 'Customise each action' }))).click();
      await expectTapTargets(page, 'autonomy, each action open');
      const dial = page.getByRole('radiogroup', { name: 'Offering open slots to the waitlist' });
      await dial.scrollIntoViewIfNeeded();
      await hydrated(dial.getByRole('radio', { name: 'Do it and tell me' }));
      await dial.getByText('Do it and tell me').click();
      const saved = toast(page);
      await expect(saved).toContainText('Saved.');
      const box = await saved.boundingBox();
      expect(box, 'the saved toast').not.toBeNull();
      if (box !== null) {
        expect(box.y, 'the toast on the screen').toBeGreaterThanOrEqual(0);
        expect(box.y + box.height, 'the toast above the tabs').toBeLessThanOrEqual(900 - 52);
      }
      await expectTapTargets(page, 'autonomy, with the saved toast');
      // It goes by itself; then the dial goes back to "Ask me" for the shots.
      await expect(saved).toHaveCount(0, { timeout: 10_000 });
      await dial.getByText('Ask me', { exact: true }).click();
      await expect(saved).toContainText('Saved.');
      await expect(saved).toHaveCount(0, { timeout: 10_000 });
    }

    for (const scheme of SCHEMES) {
      await page.goto('/autonomy');
      await expect(page.getByRole('switch', { name: 'Ask me first for everything' })).toBeVisible();
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`autonomy-${String(width)}-${scheme}.png`, SHOT);
      // Each action open, with its 30-day count (S53).
      await (await hydrated(page.getByRole('button', { name: 'Customise each action' }))).click();
      await expect(page.getByTestId('count-booking.move')).toBeVisible();
      await still(page, scheme);
      await expect
        .soft(page)
        .toHaveScreenshot(`autonomy-custom-${String(width)}-${scheme}.png`, SHOT);

      await page.goto('/memory');
      await expect(page.getByRole('link', { name: 'Tell Pepper in chat' })).toBeVisible();
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`memory-empty-${String(width)}-${scheme}.png`, SHOT);

      await page.goto('/waitlist');
      await expect(page.getByRole('link', { name: 'Add someone in chat' })).toBeVisible();
      await still(page, scheme);
      await expect
        .soft(page)
        .toHaveScreenshot(`waitlist-empty-${String(width)}-${scheme}.png`, SHOT);
    }

    // What I know with something in it: a note about the shop and one about a client.
    const { marcus } = await southsideDay(page);
    await post(
      page,
      '/v1/memory/facts',
      { subject: { type: 'business' }, key: 'parking', value: 'Free on the street after 6 pm' },
      anything,
    );
    await post(
      page,
      '/v1/memory/facts',
      {
        subject: { type: 'client', id: marcus },
        key: 'usual_service',
        value: 'Skin fade, a #1 on the sides',
      },
      anything,
    );
    if (width === 375) {
      await page.goto('/memory');
      await expect(page.getByText('Free on the street after 6 pm')).toBeVisible();
      await expectTapTargets(page, 'what I know, with facts');
    }
    for (const scheme of SCHEMES) {
      await page.goto('/memory');
      await expect(page.getByText('Skin fade, a #1 on the sides')).toBeVisible();
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`memory-${String(width)}-${scheme}.png`, {
        ...SHOT,
        mask: [addedOn()],
      });
    }
  });
}

for (const width of WIDTHS) {
  test(`Client import's four steps at ${String(width)} px, light and dark`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    await onboardOwner(page, { business: 'Southside Cuts' });
    await post(page, '/v1/clients', { name: 'Ben Ito', phone: '+15550101002' }, ClientSchema);
    const shots = async (name: string, mask: Locator[] = []) => {
      if (width === 375) {
        await expectTapTargets(page, `the import's ${name}`);
        await expectImportActionAtTheBottom(page);
      }
      for (const scheme of SCHEMES) {
        await still(page, scheme);
        await expect
          .soft(page)
          .toHaveScreenshot(`import-${name}-${String(width)}-${scheme}.png`, { ...SHOT, mask });
      }
    };

    await page.goto('/clients/import');
    await hydrated(page.getByRole('button', { name: 'Pick a file' }));
    await shots('file');

    await page.getByTestId('import-input').setInputFiles({
      name: 'clients.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(IMPORT_CSV),
    });
    await expect(page.getByRole('heading', { name: 'Check the columns' })).toBeVisible();
    await shots('columns');

    await page.getByRole('button', { name: 'Check the clients' }).click();
    await expect(page.getByTestId('import-sentence')).toBeVisible();
    await shots('clients');

    await page.getByRole('button', { name: 'Import 3 clients' }).click();
    await expect(page.getByRole('heading', { name: 'Your clients are in' })).toBeVisible({
      timeout: 60_000,
    });
    // The undo's last day moves with today, and so would its width (a longer weekday wraps
    // the line): one fixed day of the same form, masked as well.
    await fixUndoDay(page);
    await shots('done', [page.getByTestId('import-undo-until')]);
  });
}

for (const width of WIDTHS) {
  test(`A visits import, its new clients and a profile at ${String(width)} px, light and dark`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    await onboardOwner(page, { business: 'Southside Cuts', type: 'Barbershop' });
    const { services } = ServicesResponseSchema.parse(
      await (await page.request.get('/v1/services')).json(),
    );
    const { staff } = StaffResponseSchema.parse(await (await page.request.get('/v1/staff')).json());
    const service = services.find((each) => each.active)?.name ?? '';
    const owner = staff[0]?.displayName ?? '';
    const shots = async (name: string, mask: Locator[] = [], action = true) => {
      if (width === 375) {
        await expectTapTargets(page, `the ${name}`);
        if (action) await expectImportActionAtTheBottom(page);
      }
      for (const scheme of SCHEMES) {
        await still(page, scheme);
        await expect
          .soft(page)
          .toHaveScreenshot(`${name}-${String(width)}-${scheme}.png`, { ...SHOT, mask });
      }
    };

    await page.goto('/clients/import');
    await hydrated(page.getByRole('button', { name: 'Pick a file' }));
    await page.getByTestId('import-input').setInputFiles({
      name: 'appointments.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(visitsCsv({ service, staff: owner })),
    });
    await expect(page.getByRole('heading', { name: 'Check the columns' })).toBeVisible();
    await shots('import-visits-columns');

    await page.getByRole('button', { name: 'Check the visits' }).click();
    await expect(page.getByTestId('import-notice').first()).toBeVisible();
    await shots('import-visits');

    await page.getByRole('button', { name: 'Import 4 visits' }).click();
    await expect(page.getByRole('heading', { name: 'Your visits are in' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId('import-taken')).toBeVisible();
    // The undo's last day moves with today, and so would its width (a longer weekday wraps
    // the line): one fixed day of the same form, masked as well.
    await fixUndoDay(page);
    await shots('import-visits-done', [page.getByTestId('import-undo-until')]);

    await page.getByTestId('import-see-clients').click();
    await expect(page.getByTestId('clients-import-filter')).toBeVisible();
    await shots('clients-imported', [], false);

    await page.getByRole('link', { name: /Ana Ruiz/ }).click();
    await expect(page.getByTestId('client-birthday')).toBeVisible();
    await shots('client-imported', [], false);
  });
}

/** The step's main action sits at the bottom, above the tabs, within thumb reach (D3). */
async function expectImportActionAtTheBottom(page: Page): Promise<void> {
  const box = await page.getByTestId('import-actions').boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  expect(box, 'the import step’s actions').not.toBeNull();
  if (box === null) return;
  expect(box.y + box.height, 'the actions near the bottom').toBeGreaterThan(height - 160);
  expect(box.y + box.height, 'the actions on the screen').toBeLessThanOrEqual(height);
}

for (const width of WIDTHS) {
  test(`The help centre and support at ${String(width)} px, light and dark`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width, height: 900 });
    const phone = width === 375;
    const shots = async (name: string, mask: ReturnType<Page['locator']>[] = []) => {
      if (phone) {
        await expectTapTargets(page, name);
        const wide = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(wide, `${name} scrolls sideways`).toBeLessThanOrEqual(width);
      }
      for (const scheme of SCHEMES) {
        await still(page, scheme);
        await expect
          .soft(page)
          .toHaveScreenshot(`${name}-${String(width)}-${scheme}.png`, { ...SHOT, mask });
      }
      await page.emulateMedia({ colorScheme: 'light' });
    };

    // Signed out (S59, AC-X-13/17): the help centre, an article and the public form.
    await page.goto('/help');
    await expect(page.getByRole('heading', { name: 'How can we help?', level: 1 })).toBeVisible();
    await shots('help');
    await page.goto('/help/import-clients');
    await expect(page.getByRole('heading', { name: 'Still stuck?' })).toBeVisible();
    await shots('help-article');
    await page.goto('/help/contact');
    await hydrated(page.getByRole('button', { name: 'Send to Pepper' }));
    await shots('help-contact');

    // Signed out (S59.5, AC-X-54/56): the policies, and the privacy policy where the AI
    // disclosure's link lands, highlighted (the screen, not the whole page).
    await page.goto('/terms');
    await expect(page.getByRole('heading', { name: 'Terms of service', level: 1 })).toBeVisible();
    await shots('terms');
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { name: 'Privacy policy', level: 1 })).toBeVisible();
    await shots('privacy');
    await page.goto('/privacy#ai');
    await expect(page.getByRole('heading', { name: 'Pepper, the AI assistant' })).toBeInViewport();
    for (const scheme of SCHEMES) {
      await still(page, scheme);
      await expect.soft(page).toHaveScreenshot(`privacy-ai-${String(width)}-${scheme}.png`, {
        ...SHOT,
        fullPage: false,
      });
    }
    await page.emulateMedia({ colorScheme: 'light' });

    // Signed in (AC-X-14/15): no requests yet, the form, then a request's thread and the list.
    const owner = await onboardOwner(page, { business: 'Southside Cuts' });
    await page.goto('/support');
    await expect(page.getByText('No requests yet')).toBeVisible();
    await shots('support-empty');
    await page.goto('/support/new?from=%2Fmore');
    await hydrated(page.getByRole('button', { name: 'Send to Pepper' }));
    await shots('support-new', [page.getByText(/@example\.test/)]);
    // One screenshot with it (S59.2.3): a fixed image, so the thumbnails shoot the same each run.
    const uploaded = await page.request.post('/v1/support/screenshots', {
      data: await solidColorPhoto(1170, 2532, 'png', { r: 214, g: 196, b: 176 }),
      headers: { origin: new URL(page.url()).origin, 'content-type': 'image/png' },
    });
    expect(uploaded.status()).toBe(201);
    const created = await post(
      page,
      '/v1/support/threads',
      {
        kind: 'question',
        message: 'Can Randy have his own hours on Saturdays?',
        context: { page: '/team' },
        screenshotIds: [SupportScreenshotSchema.parse(await uploaded.json()).id],
      },
      SupportCreatedSchema,
    );
    await page.goto(`/support/${created.id ?? ''}`);
    await expect(page.getByText('Waiting on Pepper')).toBeVisible();
    await loaded(page.getByTestId('message-screenshots').getByRole('img'));
    // The reference and the times change every run.
    await shots('support-thread', [
      page.getByTestId('support-thread-reference'),
      page.getByText(/^Today, /),
      page.getByText(/@example\.test/),
    ]);
    await page.goto('/support');
    await expect(page.getByRole('link', { name: /Can Randy have his own hours/ })).toBeVisible();
    await shots('support-list', [page.getByText(/^PEP-/), page.getByText(/^· Today, /)]);

    // The support console (S59.2, AC-X-21): this owner is made a Pepper operator for the shots.
    makeOperator(owner.email);
    await page.goto(`/ops/threads/${created.id ?? ''}`);
    await hydrated(page.getByRole('button', { name: 'Save note' }));
    await loaded(page.getByTestId('message-screenshots').getByRole('img'));
    await shots('ops-thread', [
      page.getByTestId('ops-thread-reference'),
      page.getByText(/^Today, .*UTC$/),
      page.getByText(/^· Southside Cuts$/),
    ]);
    // S59.2.2 (AC-X-26): solved by the team, the requester is asked whether it helped.
    const solved = await page.request.patch(`/v1/ops/threads/${created.id ?? ''}`, {
      data: { status: 'solved' },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(solved.status()).toBe(200);
    await page.goto(`/support/${created.id ?? ''}`);
    await hydrated(page.getByRole('button', { name: 'Not helpful', exact: true }));
    await shots('support-thread-solved', [
      page.getByTestId('support-thread-reference'),
      page.getByText(/^Today, /),
      page.getByTestId('support-thread-seen'),
    ]);
    // The team's saved replies (AC-X-23) are shared by every operator, so only the form and
    // this test's own reply are shot, not the list around them.
    await page.goto('/ops/replies');
    await hydrated(page.getByRole('button', { name: 'Save reply' }));
    const addForm = page.getByRole('region', { name: 'Add a saved reply' });
    for (const scheme of SCHEMES) {
      await still(page, scheme);
      await partShot(page, addForm, `ops-replies-add-${String(width)}-${scheme}.png`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    // Titled to sort first, above anything the team (or another test) has saved.
    await page.getByLabel('Title', { exact: true }).fill('A barber’s own hours');
    await page
      .getByLabel('Reply', { exact: true })
      .fill('Hi {first name}, open Team, pick the barber and set their hours.');
    await page.getByRole('button', { name: 'Save reply' }).click();
    await expect(page.getByRole('status')).toContainText('Saved “A barber’s own hours”.');
    if (phone) {
      await expectTapTargets(page, 'ops-replies');
      const wide = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(wide, 'ops-replies scrolls sideways').toBeLessThanOrEqual(width);
    }
    const ownReply = page.getByRole('listitem').first();
    await expect(ownReply).toContainText('A barber’s own hours');
    for (const scheme of SCHEMES) {
      await still(page, scheme);
      await partShot(page, ownReply, `ops-replies-item-${String(width)}-${scheme}.png`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await deleteSavedReplies(page, 'A barber’s own hours');
    const signedOut = await page.request.post('/v1/public/support', {
      // Its own address each run: the form takes 3 an hour per email (AC-X-17).
      data: {
        email: `locked-out-${unique('mo')}@example.test`,
        name: 'Mo',
        message: 'I can’t sign in to Pepper.',
      },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(signedOut.status()).toBe(201);
    const { reference } = SupportCreatedSchema.parse(await signedOut.json());
    await page.goto('/ops');
    await page
      .getByRole('link', { name: new RegExp(reference) })
      .first()
      .click();
    await hydrated(page.getByRole('button', { name: 'Save note' }));
    await shots('ops-request', [
      page.getByText(reference),
      page.getByText(/UTC$/),
      page.getByText(/^locked-out-.*@example\.test$/),
    ]);
  });
}
