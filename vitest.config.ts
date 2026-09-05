import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // This Vite version's table of Node builtins predates `node:sqlite`: it
      // strips the prefix and then fails to resolve a package called "sqlite".
      // Marking it external here is what would have happened automatically if
      // the table knew about it.
      name: 'externalize-node-sqlite',
      enforce: 'pre',
      resolveId(id: string) {
        if (id === 'node:sqlite' || id === 'sqlite') {
          return { id: 'node:sqlite', external: true };
        }
        return null;
      },
    },
  ],
  test: {
    // generous for the integration suite's argon2 hashing
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: 'forks',
  },
});
