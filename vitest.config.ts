import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // generous for cloud-DB round-trips in the integration suite
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: 'forks',
  },
});
