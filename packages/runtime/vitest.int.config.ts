import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.int.test.ts'],
    // Pulling and starting containers takes a while on a cold machine.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
