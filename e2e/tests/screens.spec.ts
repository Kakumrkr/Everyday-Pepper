import { CurrentBusinessResponseSchema } from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
import { hydrated, onboardOwner, ownClientAddress } from './helpers.js';

// The signed-in screens on the kit (S41, DESIGN.md D6; AC-X-3): Home, Chat and More at 375,
// 412 and 1280 px in light and dark, compared with the committed baselines (Linux, CI's
// headless shell; a diff fails CI unless the PR updates the baseline, ADR-0044). The owner is
// new, so every list shows its empty state; the business has the same name every run, and the
// email (unique per run) is masked. S42 and S43 add the other screens.
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
