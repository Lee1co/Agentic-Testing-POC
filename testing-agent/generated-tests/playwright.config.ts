import { defineConfig } from '@playwright/test';

/** Shared configuration for every generated test. Values come from the framework at run time. */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  testIgnore: ['**/_history/**'],
  timeout: Number(process.env.TEST_TIMEOUT_MS ?? 60_000),
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: process.env.PW_OUTPUT_DIR ?? '../test-results',
  reporter: [['list']],
  use: {
    baseURL: process.env.TARGET_APP_URL ?? 'http://localhost:3000',
    headless: process.env.HEADLESS !== 'false',
    screenshot: 'only-on-failure',
    trace: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
