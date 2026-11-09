import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectTapTargets } from './tap-targets.js';

// The terms and the privacy policy (S59.5, ADR-0064, AC-X-54…56): public, reached from sign-up
// and the help centre, and the AI disclosure's link in a client email lands on the AI section.

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page: Page): Promise<void> {
  const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    [],
  );
}

test('the policies (AC-X-54): from sign-up, a draft, and each section a jump away', async ({
  page: signUp,
  context,
}) => {
  test.setTimeout(60_000);
  await signUp.goto('/sign-up');
  await signUp.getByLabel('Your name').fill('Dana Reyes');
  // A new tab: what the visitor typed in the form stays.
  const [page] = await Promise.all([
    context.waitForEvent('page'),
    signUp.getByRole('link', { name: /^privacy policy/ }).click(),
  ]);
  await expect(signUp.getByLabel('Your name')).toHaveValue('Dana Reyes');
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { name: 'Privacy policy', level: 1 })).toBeVisible();
  await expect(page.getByTestId('legal-draft')).toContainText('isn’t in force yet');
  await expectAccessible(page);
  await expectTapTargets(page, 'the privacy policy');

  await page.getByText('On this page').click();
  await page
    .getByRole('navigation', { name: 'On this page' })
    .getByRole('link', { name: 'What Pepper remembers' })
    .click();
  await expect(page).toHaveURL(/\/privacy#memory$/);
  await expect(page.getByRole('heading', { name: 'What Pepper remembers' })).toBeInViewport();

  await page
    .getByRole('navigation', { name: 'More' })
    .getByRole('link', { name: 'Terms of service' })
    .click();
  await expect(page.getByRole('heading', { name: 'Terms of service', level: 1 })).toBeVisible();
  await expectAccessible(page);
  await expectTapTargets(page, 'the terms');

  await page.goto('/help');
  await expect(
    page.getByRole('contentinfo').getByRole('link', { name: 'Privacy policy' }),
  ).toHaveAttribute('href', '/privacy');
});

test('the email’s link (AC-X-56): lands on the AI section, highlighted, with the line it quotes', async ({
  page,
}) => {
  await page.goto('/privacy#ai');
  const heading = page.getByRole('heading', { name: 'Pepper, the AI assistant' });
  await expect(heading).toBeInViewport();
  const section = page.locator('section#ai');
  await expect
    .poll(() => section.evaluate((el) => el.matches(':target')), { timeout: 10_000 })
    .toBe(true);
  await expect(
    section.getByText('If you got an email from a business that uses Pepper'),
  ).toBeVisible();
  await expect(section.locator('blockquote')).toHaveText(
    'Written with help from Pepper, the AI assistant [the business] uses.',
  );
});
