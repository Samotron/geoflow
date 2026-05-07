import { defineConfig } from '@playwright/test';

const PORT = 4173;
const FIXTURE = 'tests/fixtures/ags/browser_explorer.ags';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
  },
  webServer: {
    command: `cargo run -p geoflow-cli -- explore ${FIXTURE} --serve --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  },
});
