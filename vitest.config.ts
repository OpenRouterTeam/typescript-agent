import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config({
  path: new URL('.env', import.meta.url),
});

export default defineConfig({
  test: {
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
          include: [
            'tests/unit/**/*.test.ts',
            'src/lib/**/*.test.ts',
          ],
          testTimeout: 10000,
          hookTimeout: 10000,
        },
      },
      {
        extends: true,
        test: {
          name: 'behavior',
          include: [
            'tests/behavior/**/*.test.ts',
          ],
          testTimeout: 10000,
          hookTimeout: 10000,
        },
      },
      {
        extends: true,
        test: {
          name: 'boundaries',
          include: [
            'tests/boundaries/**/*.test.ts',
          ],
          testTimeout: 10000,
          hookTimeout: 10000,
        },
      },
      {
        extends: true,
        test: {
          name: 'composition',
          include: [
            'tests/composition/**/*.test.ts',
          ],
          testTimeout: 10000,
          hookTimeout: 10000,
        },
      },
      {
        extends: true,
        test: {
          name: 'contracts',
          include: [
            'tests/contracts/**/*.test.ts',
          ],
          testTimeout: 10000,
          hookTimeout: 10000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [
            'tests/integration/**/*.test.ts',
          ],
          testTimeout: 10000,
          hookTimeout: 10000,
        },
      },
      {
        extends: true,
        test: {
          name: 'dispatch',
          include: [
            'tests/dispatch/**/*.test.ts',
          ],
          testTimeout: 10000,
          hookTimeout: 10000,
        },
      },
      {
        extends: true,
        test: {
          name: 'pipelines',
          include: [
            'tests/pipelines/**/*.test.ts',
          ],
          testTimeout: 10000,
          hookTimeout: 10000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: [
            'tests/e2e/**/*.test.ts',
          ],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
});
