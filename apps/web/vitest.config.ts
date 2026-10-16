import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Pages and layouts are covered by the Playwright smoke test (e2e/), not unit tests.
      include: ['lib/**/*.ts', 'app/**/route.ts'],
      exclude: ['**/*.test.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
