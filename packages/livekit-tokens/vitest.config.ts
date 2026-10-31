import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TypeScript sources (no prior build needed).
    conditions: ['@voicebridge/source'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
