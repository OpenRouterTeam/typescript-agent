import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config({
  path: new URL('../../.env', import.meta.url),
});

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'json-summary', 'html'],
      // Coverage ratchet: thresholds are pinned at current levels. Any PR
      // that lowers coverage fails the unit-test job. When you raise
      // coverage, raise these floors in the same PR.
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 92,
        lines: 90,
      },
    },
    globals: true,
    environment: 'node',
    env: {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    },
    typecheck: {
      enabled: true,
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
          testTimeout: 10000,
          hookTimeout: 10000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
});
