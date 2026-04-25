import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
    globals: true,
    setupFiles: ['./setup/vitest.setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
