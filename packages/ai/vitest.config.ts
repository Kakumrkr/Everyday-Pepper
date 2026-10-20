import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Test-only helpers and the command line wrapper (its logic is in tested modules).
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/provider-contract.ts',
        'src/openai/test-fixtures.ts',
        'src/evals/test-support.ts',
        'src/evals/cli.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
