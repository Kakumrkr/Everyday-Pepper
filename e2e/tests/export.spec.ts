import { AxeBuilder } from '@axe-core/playwright';
import { ClientSchema } from '@pepper/contracts';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { callApi, hydrated, onboardOwner } from './helpers.js';
import { expectTapTargets } from './tap-targets.js';

// The business export through the screens (S51, ADR-0053, AC-W1-37): an owner finds "Download
// your data" under More, sees what the file holds, and saves the ZIP under the business's
// name. The ZIP's contents and their round trip through import are in the api's
// export.int.test.ts.

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('export (AC-W1-37): an owner downloads the business’s data from More', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardOwner(page, { business: 'Juniper Export Studio' });
  await callApi(
    page,
    'POST',
    '/v1/clients',
    { name: 'Dee Hart', email: 'dee.hart@example.test' },
    ClientSchema,
  );

  await page.goto('/more');
  await page.getByRole('link', { name: 'Download your data' }).click();
  await expect(page).toHaveURL(/\/more\/data$/);
  await expect(page.getByRole('heading', { name: 'Your data', level: 1 })).toBeVisible();
  await expect(page.getByText('clients.csv', { exact: true })).toBeVisible();
  await expect(page.getByText('visits.csv', { exact: true })).toBeVisible();

  const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    [],
  );
  await expectTapTargets(page, 'Your data');
  // The one action within thumb reach, above the tabs (D3).
  const bar = await page.getByTestId('export-actions').boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  expect(bar).not.toBeNull();
  expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBeGreaterThan(height - 160);

  const button = await hydrated(page.getByRole('button', { name: 'Download your data' }));
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(download.suggestedFilename()).toMatch(
    /^pepper-export-juniper-export-studio-\d{4}-\d{2}-\d{2}\.zip$/,
  );
  const path = await download.path();
  const bytes = await readFile(path);
  // A ZIP starts with "PK".
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  await expect(page.getByTestId('export-status')).toContainText(
    'Saved as pepper-export-juniper-export-studio-',
  );
});
