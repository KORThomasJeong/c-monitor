import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'plugin', include: ['test/**/*.test.mjs'], passWithNoTests: true, testTimeout: 15_000 },
});
