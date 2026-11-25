import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Test-only helpers and the command line wrapper (its logic is in tested modules).
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/provider-contract.ts',
        'src/openai/test-fixtures.ts',
        'src/evals/eval-db.ts',
        'src/evals/test-support.ts',
        'src/evals/cli.ts',
        // The tools run domain services in database transactions; they are proven against
        // real Postgres by the integration tests (`pnpm test:integration`).
        'src/tools/catalog/**',
        'src/tools/registry.ts',
        'src/tools/runner.ts',
        'src/tools/test-support.ts',
        // The same for the one-tap win-back draft's transaction (S54.2): its words and its
        // first answer are unit-tested in `win-back-words.ts`.
        'src/drafts/win-back.ts',
        // The no-show fee card's proposal in the no-show's transaction (S68): proven against
        // Postgres in `tools/writes.int.test.ts`; its words are the contracts' (unit-tested).
        'src/drafts/no-show-fees.ts',
        // The eval subject and its seeded worlds run the loop on Postgres (evals.int.test.ts).
        'src/evals/subject.ts',
        'src/evals/world.ts',
        'src/agent/test-support.ts',
        'src/agent/index.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
