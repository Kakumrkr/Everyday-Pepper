import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The S3 adapter is proven against SeaweedFS by the contract test (`pnpm test:integration`).
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/s3.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
