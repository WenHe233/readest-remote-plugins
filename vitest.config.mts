import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The fetched SDK has its own Node test suite. Only collect this repository's
    // Vitest tests, including when SDK source and release examples exist locally.
    include: ['tests/**/*.test.{ts,mjs}'],
  },
});
