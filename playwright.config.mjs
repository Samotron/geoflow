import { defineConfig } from '@playwright/test';

const PORT = 4173;
const BASE = '/geoflow/';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['**/*.spec.ts'],
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    },
  },
  webServer: {
    command: `pnpm --filter @geoflow/web preview --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}${BASE}`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  },
});
