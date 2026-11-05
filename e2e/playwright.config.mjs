import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  outputDir: '../artifacts/playwright-results',
  reporter: [['list'], ['html', { outputFolder: '../artifacts/playwright-report', open: 'never' }]],
  timeout: 90_000,
  expect: { timeout: 12_000 },
  workers: process.env.CI ? 1 : undefined,
  fullyParallel: false,
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } }
  ],
  webServer: {
    command: 'pnpm exec next start --hostname 127.0.0.1 --port 3000',
    cwd: repoRoot,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ZEZO_STAGING: 'false',
      ZEZO_DATA_DIR: process.env.ZEZO_DATA_DIR || '../data-e2e'
    }
  }
});
