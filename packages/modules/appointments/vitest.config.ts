import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Services run their rules (unit-tested here) inside database transactions; they are
      // proven against real Postgres by the integration tests (`pnpm test:integration`).
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/services/**', 'src/test-support.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
