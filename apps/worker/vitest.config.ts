import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, '../../packages/db/migrations'),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ENV: 'test',
            APP_URL: 'http://localhost:8787',
            WEB_ORIGIN: 'http://localhost:5173',
            EMAIL_PROVIDER: 'memory',
            BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
            // Never inherit local .dev.vars secrets: captcha is off in tests, emails stay in memory.
            TURNSTILE_SECRET_KEY: '',
            RESEND_API_KEY: '',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
      // Each test signs users in (PBKDF2 + several requests); allow for slow CI machines.
      testTimeout: 20_000,
    },
  };
});
