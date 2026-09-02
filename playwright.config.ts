import { defineConfig, devices } from '@playwright/test';

const proxyPort = Number.parseInt(process.env.INDY_E2E_PROXY_PORT ?? '17691', 10);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${proxyPort}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/trusted-proxy.mjs',
    url: `http://127.0.0.1:${proxyPort}/api/health/live`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
