import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The in-process Postgres used by the tests takes a moment to start.
    hookTimeout: 30_000,
  },
});
