import { CurrentBusinessResponseSchema, FeedResponseSchema } from '@pepper/contracts';
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
 * Home's briefing in the same state every run: the worker briefs a new business on its first
 * pass once its morning hour has passed on its clock, so after that hour the test waits for the
 * briefing and puts it away ("Got it"); the card then says when the next one comes, as before.
 * Within two minutes of the hour it waits the hour out first, so the worker can't brief mid-test.
 */
async function settleBriefing(page: Page): Promise<void> {
  const { business } = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const feed = FeedResponseSchema.parse(await (await page.request.get('/v1/feed')).json());
  const morning = feed.settings.morningHour ?? feed.templateMorningHour;
  const clock = () => {
    const [hour = 0, minute = 0] = new Intl.DateTimeFormat('en-US', {
      timeZone: business.timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .filter((part) => part.type === 'hour' || part.type === 'minute')
      .map((part) => Number(part.value));
    return hour * 60 + minute;
  };
  const untilMorning = morning * 60 - clock();
  if (untilMorning > 0 && untilMorning <= 2) {
    await page.waitForTimeout(untilMorning * 60_000 + 5_000);
  }
  const card = page.getByTestId('daily-briefing');
  if (clock() >= morning * 60) {
    await expect(async () => {
      await page.goto('/');
      await expect(card.getByRole('heading', { name: /^Today: / })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 60_000, intervals: [2_000, 5_000] });
    await (await hydrated(card.getByRole('button', { name: 'Got it' }))).click();
  }
  await page.goto('/');
  await expect(card.getByRole('heading', { name: 'Your daily briefing' })).toBeVisible();
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
