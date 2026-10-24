import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The card tests run axe and user events in jsdom: seconds each under coverage, and more
    // on a busy CI runner (CLAUDE.md: generous limits, no retries). S32's chip tests timed out
    // at the 5 s default when every package's suite ran at once in `pnpm check`.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // Components (.tsx) have their own tests (jsdom, S26) and the Playwright journeys (e2e/);
      // the coverage gate is on the logic (.ts).
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
