import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173/katayama-test/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/serve.mjs',
    url: 'http://127.0.0.1:4173/katayama-test/',
    env: {
      BASE_PATH: '/katayama-test/',
      TEST_OFFLINE_MARKER: path.resolve('work/pwa-network-offline'),
    },
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'webkit-iphone',
      use: { ...devices['iPhone 13'], browserName: 'webkit' },
    },
    {
      name: 'chromium-android',
      use: { ...devices['Pixel 7'], browserName: 'chromium' },
    },
  ],
});
