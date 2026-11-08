import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E against the real Worker (`wrangler dev`, local D1) serving the built web app.
 * Run: pnpm --filter @aicoach/admin-web test:e2e   (builds the web app first)
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:8787', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @aicoach/worker dev',
    url: 'http://localhost:8787/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
