import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { hydrated, onboardOwner, ownClientAddress } from './helpers.js';
import { expectTapTargets } from './tap-targets.js';

// The app shell (S41, AC-X-5, AC-X-6, DESIGN D3): bottom tabs on a 375 px phone (Home ·
// Calendar · Clients · Chat · More), More with the Pepper and Business groups, settings and the
// account; the desktop sidebar with the same places; every tap target ≥ 44 px; axe clean.

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// The widths are set here, so one project is enough.
test.beforeEach(async ({ context }) => {
  test.skip(test.info().project.name !== 'desktop', 'the widths are set here: desktop only');
  await ownClientAddress(context);
});

function mainNav(page: Page) {
  return page.getByRole('navigation', { name: 'Main' });
}

async function expectAccessible(page: Page): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    const blocking = violations.filter(
      ({ impact }) => impact === 'serious' || impact === 'critical',
    );
    expect(blocking.map(({ id, nodes }) => `${id} ×${String(nodes.length)}`)).toEqual([]);
  }
}

test('on a phone: five tabs, More holds the rest, and every tap target is 44 px or more', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 375, height: 812 });
  const owner = await onboardOwner(page);

  const tabs = mainNav(page).getByRole('link');
  await expect(tabs).toHaveText(['Home', 'Calendar', 'Clients', 'Chat', 'More']);
  await expect(mainNav(page).getByRole('link', { name: 'Home' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectTapTargets(page, 'Home at 375 px');

  await (await hydrated(mainNav(page).getByRole('link', { name: 'More' }))).click();
  await expect(page).toHaveURL(/\/more$/);
  await expect(page.getByRole('heading', { level: 1, name: 'More' })).toBeVisible();
  const pepper = page.getByRole('region', { name: 'Pepper' });
  await expect(pepper.getByRole('link')).toHaveText(['What I know', 'Autonomy', 'Waitlist']);
  await expect(page.getByRole('region', { name: 'Business' }).getByRole('link')).toHaveText([
    'Services',
    'Team',
  ]);
  await expect(page.getByText(owner.business)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expectTapTargets(page, 'More at 375 px');
  await expectAccessible(page);

  // A place outside the tabs is two taps from anywhere, and lights More while open.
  await pepper.getByRole('link', { name: 'Waitlist' }).click();
  await expect(page).toHaveURL(/\/waitlist$/);
  await expect(mainNav(page).getByRole('link', { name: 'More' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectTapTargets(page, 'the tab bar on Waitlist');

  // Nothing scrolls sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('on a desktop: the sidebar has the everyday places, the Pepper and Business groups, and Settings', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await onboardOwner(page);

  const nav = mainNav(page);
  await expect(nav.getByRole('link', { name: 'Pepper home' })).toBeVisible();
  await expect(nav.getByRole('listitem').getByRole('link')).toHaveText([
    'Home',
    'Calendar',
    'Clients',
    'Chat',
    'What I know',
    'Autonomy',
    'Waitlist',
    'Services',
    'Team',
    'Settings',
  ]);
  await nav.getByRole('link', { name: 'Autonomy' }).click();
  await expect(page).toHaveURL(/\/autonomy$/);
  await expect(nav.getByRole('link', { name: 'Autonomy' })).toHaveAttribute('aria-current', 'page');

  await nav.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/more$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  // The places are in the sidebar, so the page shows only settings and the account.
  await expect(page.getByRole('region', { name: 'Pepper' })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Account' })).toBeVisible();
  await expectAccessible(page);
});
