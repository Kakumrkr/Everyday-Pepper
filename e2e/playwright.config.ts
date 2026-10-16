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
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: webUrl,
    trace: 'retain-on-failure',
    launchOptions,
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], launchOptions } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions } },
  ],
});
