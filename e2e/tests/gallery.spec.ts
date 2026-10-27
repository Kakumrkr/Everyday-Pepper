import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// The component gallery (S40, DESIGN.md D2, D6, D12; AC-X-3, AC-X-4): screenshots of every
// component at 375, 412 and 1280 px in light and dark, compared with the committed baselines
// (Linux Chromium; a diff fails CI unless the PR updates the baseline, ADR-0044). Also axe in
// both themes and no sideways scroll on a phone. The stack runs with PEPPER_GALLERY=1.
//
// Update the baselines after a deliberate change, on Linux with CI's browser:
//   pnpm --filter @pepper/e2e exec playwright test gallery --project=desktop --update-snapshots

const WIDTHS = [375, 412, 1280] as const;
const SCHEMES = ['light', 'dark'] as const;
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// The widths are set here, so one project is enough.
test.beforeEach(() => {
  test.skip(test.info().project.name !== 'desktop', 'the widths are set here: desktop only');
});

/** The gallery at `width`, in `colorScheme`, still, with its fonts loaded. */
async function openGallery(
  page: Page,
  width: number,
  colorScheme: (typeof SCHEMES)[number],
): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
  const response = await page.goto('/dev/gallery');
  expect(response?.status(), 'the stack needs PEPPER_GALLERY=1').toBe(200);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole('heading', { level: 1, name: 'Southside Cuts' })).toBeVisible();
}

for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    test(`gallery at ${String(width)} px, ${scheme}`, async ({ page }) => {
      await openGallery(page, width, scheme);
      await expect(page).toHaveScreenshot(`gallery-${String(width)}-${scheme}.png`, {
        fullPage: true,
        animations: 'disabled',
        maxDiffPixelRatio: 0.01,
      });
    });
  }
}

for (const scheme of SCHEMES) {
  test(`the approval sheet at 375 px, ${scheme}`, async ({ page }) => {
    await openGallery(page, 375, scheme);
    await page.getByRole('button', { name: 'Review the move' }).click();
    const sheet = page.getByRole('dialog', { name: 'Move Darius Hill to 4:15?' });
    await expect(sheet).toBeVisible();
    await expect(page).toHaveScreenshot(`sheet-375-${scheme}.png`, {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    });
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('button', { name: 'Review the move' })).toBeFocused();
  });
}

test('the gallery passes axe in both themes, with the sheet closed and open', async ({ page }) => {
  for (const scheme of SCHEMES) {
    await openGallery(page, 412, scheme);
    for (const state of ['closed', 'open'] as const) {
      if (state === 'open') await page.getByRole('button', { name: 'Review the move' }).click();
      const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(
        violations.map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target.join(' ')) })),
        `${scheme}, sheet ${state}`,
      ).toEqual([]);
    }
  }
});

test('nothing scrolls sideways on a 375 px phone', async ({ page }) => {
  await openGallery(page, 375, 'light');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test('the segmented control filters the day, and keeps one choice', async ({ page }) => {
  await openGallery(page, 412, 'light');
  const day = page.getByRole('list', { name: 'Today’s visits' });
  await expect(day.getByRole('listitem')).toHaveCount(12);
  await page.getByRole('radio', { name: 'Randy' }).click();
  await expect(day.getByRole('listitem')).toHaveCount(5);
  await page.getByRole('radio', { name: 'Randy' }).click();
  await expect(page.getByRole('radio', { name: 'Randy' })).toBeChecked();
  await expect(day.getByRole('listitem')).toHaveCount(5);
});
