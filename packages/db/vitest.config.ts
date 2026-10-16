import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // SQL behaviour (repositories, migrations, RLS) is proven against real Postgres by the
      // integration tests (`pnpm test:integration`); unit tests cover the logic around it.
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/test-support.ts',
        'src/migrate.ts',
        'src/migrate-cli.ts',
        'src/repositories/**',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
