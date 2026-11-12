import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against an already running stack: `docker compose up --build --wait`, then
 * `pnpm test:e2e`. URLs default to the Compose ports.
 */
const webUrl = process.env['WEB_URL'] ?? 'http://localhost:3000';
// Optional: a preinstalled Chromium when the bundled one is not downloaded (dev-setup.md).
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
const launchOptions = executablePath ? { executablePath } : {};

export default defineConfig({
  testDir: 'tests',
  // Screenshot baselines (S40, gallery.spec.ts): one folder per spec, named by the test's own
  // name and the OS they were made on (Linux, like CI); not per project.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{platform}{ext}',
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  // One browser per CI machine: the whole stack shares its two CPUs (ci.yml shards instead).
  ...(process.env['CI'] ? { workers: 1 } : {}),
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: webUrl,
    trace: 'retain-on-failure',
    launchOptions,
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], launchOptions } },
    // Phone first (DESIGN.md): every journey runs on the phone. The desktop project runs what
    // only a desktop shows: the screenshot and gallery specs (which set their own widths), the
    // sidebar shell and the accessibility scans of the desktop layout. A spec that checks a
    // desktop-only behaviour joins this list.
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], launchOptions },
      testMatch: ['accessibility.spec.ts', 'gallery.spec.ts', 'screens.spec.ts', 'shell.spec.ts'],
    },
  ],
});
