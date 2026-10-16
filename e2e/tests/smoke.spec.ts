import { HealthReportSchema, type ServiceName } from '@floty/contracts';
import { expect, test } from '@playwright/test';

const services: Record<Exclude<ServiceName, 'web'>, string> = {
  api: process.env['API_URL'] ?? 'http://localhost:4000',
  worker: process.env['WORKER_URL'] ?? 'http://localhost:4100',
};

test.describe('smoke: the stack is up', () => {
  for (const [service, url] of Object.entries(services)) {
    test(`${service} is ready with Postgres and Redis up`, async ({ request }) => {
      const response = await request.get(`${url}/health/ready`);

      expect(response.status()).toBe(200);
      expect(HealthReportSchema.parse(await response.json())).toMatchObject({
        service,
        status: 'ok',
        checks: { database: 'up', redis: 'up' },
      });
    });
  }

  test('web is live', async ({ request }) => {
    const response = await request.get('/health/live');

    expect(response.status()).toBe(200);
    expect(HealthReportSchema.parse(await response.json())).toMatchObject({
      service: 'web',
      status: 'ok',
    });
  });

  test('home page renders and reaches the api', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.goto('/');

    await expect(page).toHaveTitle('Floty');
    await expect(page.getByRole('heading', { level: 1, name: 'floty' })).toBeVisible();
    const status = page.getByTestId('api-status');
    await expect(status).toHaveAttribute('data-state', 'ok');
    await expect(status).toContainText('ready');
    // Mobile-first: nothing overflows the viewport sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    expect(errors).toEqual([]);
  });
});
