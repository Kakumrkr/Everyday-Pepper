import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    // Pulling and starting containers takes a while on a cold machine.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
